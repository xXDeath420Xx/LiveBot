/*
 * NSFW protection — the live side (decisions in core/nsfw-logic.js, the local models in
 * core/nsfw-classifier.js + core/nsfw-worker.js). Two surfaces, each plugged into the pipeline that already
 * downloads the images rather than beside it:
 *
 *   avatars       core/avatar-protection.js checkMember (join, server-avatar change, global-avatar change)
 *                 hands every checked member here (in the background: a join is never held up by a
 *                 model). Downloads go through avatar protection's own rate-limited fetch. Actions:
 *                 log (review queue) | flag (the "Flagged Avatar" role) | kick | ban. scanMembers() is
 *                 the backfill: every member's avatars, review-only, within the daily cap.
 *   chat images   a stage of PhishingDetectionManager.checkMessage (after the ignore list), reading each
 *                 image through core/message-images.js fetchImageBytes (the one shared download). Actions:
 *                 alert (evidence card: the verdict behind a spoiler + jump link, never the image) | delete
 *                 | delete + timeout, carried out by core/message-threats.js enforce (holds, staff, cards,
 *                 "manual action needed"). Age-restricted channels are skipped.
 *
 * Two-stage: an action needs both models at or above the act threshold on the image and its mirror;
 * anything else at or above the review threshold is borderline and only logged / queued. Every action
 * goes through protectionHold. Everything is off until a server switches it on.
 *
 * Storage (migrations/330_nsfw_cleanup.js), all existing tables:
 *   settings       join_gate_config nsfw_avatar_* (via avatar protection) and phishing_config nsfw_img_*
 *                  (via message threats)
 *   review queue   name_filter_reviews kind 'nsfw_avatar' / 'nsfw_image': status 'pending' (borderline or
 *                  log-only: Ban / Kick / Not NSFW / Skip) or 'actioned' (the bot acted: Overturn — unbans,
 *                  lifts the timeout or the flag, and remembers the picture as safe). Thumbnail-free: an
 *                  avatar row keeps Discord's CDN URL, an image row nothing that shows the picture.
 *   safe pictures  blocked_images kind 'nsfw_safe' (exact_sha = the classifier's imageKey)
 *   outcomes       join_gate_events nsfw_* (avatars), phishing_detections source 'nsfw_image' (chat)
 *   metering       server_stats nsfw_* columns, per server per UTC day; the daily cap per surface stops
 *                  scanning (counted as skipped) once reached
 *
 * Suspected CSAM (a model label suggesting minors): nothing is stored — no row, no hash, no URL. The image
 * is removed (the message deleted; the member kicked, or banned when the avatar action is ban) and staff
 * are told to report it to Discord Trust & Safety.
 */
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import { protectionHold, isExempt, isPaused } from './protection-exempt.js';
import { isStaff } from './spammer-guard.js';
import { whyCannot, whyFailed, reportManualAction } from './manual-action.js';
import aiJudge from './ai-judge.js';
import { avatarTargets, avatarKeyHash } from './avatar-match-logic.js';
import { imageAttachments, fetchImageBytes } from './message-images.js';
import classifier from './nsfw-classifier.js';
import {
    decide, scoreLine, pct, avatarSettingsFrom, imageSettingsFrom, cleanNsfwPatch, dayKey, emptyMeter, capCheck,
    statsIncrements, overturnPlan, avatarEventAction, nsfwReason, isAgeRestricted, evidenceDetail, REVIEW_KINDS,
    MAX_IMAGES_PER_MESSAGE, AVATAR_ACTIONS, IMAGE_ACTIONS, ALL_STATS_COLUMNS, MODELS, modelHasMinorLabels,
} from './nsfw-logic.js';

// avatar-protection imports this module lazily; importing it back lazily keeps the cycle out of module load.
const avatarProtection = () => import('./avatar-protection.js');
const messageThreats = () => import('./message-threats.js');

const VERDICT_CACHE_MAX = 3000;
const VERDICT_TTL_MS = 12 * 3600_000;
const URL_KEY_MAX = 6000;
const SAFE_TTL_MS = 5 * 60_000;
const FLUSH_MS = 60_000;
const SCAN_CAP_MEMBERS = 20_000;
const REPORT_URL = 'https://dis.gd/request';
const SOURCE = { avatar: 'NSFW avatar protection', image: 'NSFW image protection' };
const DONE = { ban: 'banned', kick: 'kicked', flag: 'flagged', log: 'logged' };
const NEEDS = {
    ban: [PermissionFlagsBits.BanMembers, 'Ban Members'],
    kick: [PermissionFlagsBits.KickMembers, 'Kick Members'],
    flag: [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
};
const TRIGGER_LABEL = { join: 'On joining', server_avatar: 'Changed their server avatar', global_avatar: 'Changed their avatar', scan: 'Member scan' };

// ── settings ─────────────────────────────────────────────────────────────────

export async function getAvatarSettings(guildId) {
    const { getConfig } = await import('./join-gate.js');
    return avatarSettingsFrom(await getConfig(guildId));
}

export async function getImageSettings(guildId) {
    const mt = await messageThreats();
    return (await mt.getSettings(guildId)).settings.nsfw;
}

/**
 * Save one surface's settings. patch: see cleanNsfwPatch. Avatars write join_gate_config through
 * join-gate's setConfig, chat images phishing_config through message threats (which logs the change).
 */
export async function saveSettings(guild, surface, patch, by = null) {
    const current = surface === 'avatar' ? await getAvatarSettings(guild.id) : await getImageSettings(guild.id);
    const check = cleanNsfwPatch(surface, patch, current);
    if (!check.ok) return check;
    const cols = Object.keys(check.values);
    if (!cols.length) return { ok: true, changed: [] };
    if (surface === 'avatar') {
        const { setConfig, invalidate } = await import('./join-gate.js');
        await setConfig(guild.id, check.values);
        invalidate(guild.id);
        logger.info(`[NSFW] avatar settings changed in ${guild.id} by ${by}: ${cols.join(', ')}`);
        void logFeatureEvent(() => (guild), 'join-gate.avatarSettings', () => ({
            title: '⚙️ NSFW Avatar Settings Changed',
            fields: [['Changed', cols.map(c => c.replace(/^nsfw_avatar_/, '').replace(/_/g, ' ')).join(', '), false], ['By', userLabel(by)]],
        }));
    } else {
        const mt = await messageThreats();
        const out = await mt.saveSettings(guild, check.values, by);
        if (!out.ok) return out;
    }
    return { ok: true, changed: cols };
}

// ── metering + the daily cap ─────────────────────────────────────────────────

const meters = new Map();   // guildId -> { day, used:{avatar,image}, inflight:{avatar,image}, pending:{avatar,image}, live:{avatar,image}, loaded }
let flushTimer = null;

function freshMeter(day) {
    return { day, used: { avatar: 0, image: 0 }, inflight: { avatar: 0, image: 0 }, pending: { avatar: emptyMeter(), image: emptyMeter() },
        live: { avatar: emptyMeter(), image: emptyMeter() }, loaded: false };
}

async function meterFor(guildId) {
    const day = dayKey();
    let m = meters.get(guildId);
    if (m && m.day !== day) {
        await flushOne(guildId, m).catch(() => {});
        m = null;
    }
    if (!m) {
        m = freshMeter(day);
        meters.set(guildId, m);
    }
    if (!m.loaded) {
        m.loaded = true;
        try {
            const [[row]] = await pool.execute('SELECT nsfw_avatar_scans, nsfw_image_scans FROM server_stats WHERE guild_id = ? AND date = ?', [guildId, day]);
            m.used.avatar += Number(row?.nsfw_avatar_scans ?? 0);
            m.used.image += Number(row?.nsfw_image_scans ?? 0);
        } catch { /* columns not there yet: count from zero */ }
    }
    if (!flushTimer) {
        flushTimer = setInterval(() => { flushAll().catch(() => {}); }, FLUSH_MS);
        flushTimer.unref?.();
    }
    return m;
}

function count(m, surface, field, n = 1) {
    m.pending[surface][field] += n;
    m.live[surface][field] += n;
}

async function flushOne(guildId, m) {
    const add = statsIncrements(m.pending);
    const cols = Object.keys(add);
    if (!cols.length) return;
    const taken = m.pending;
    m.pending = { avatar: emptyMeter(), image: emptyMeter() };
    try {
        await pool.execute(
            `INSERT INTO server_stats (guild_id, date, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})
             ON DUPLICATE KEY UPDATE ${cols.map(c => `${c} = ${c} + VALUES(${c})`).join(', ')}`,
            [guildId, m.day, ...cols.map(c => add[c])]);
    } catch (err) {
        // Keep the counts for the next try (the migration may not have run yet).
        for (const s of Object.keys(taken)) for (const f of Object.keys(taken[s])) m.pending[s][f] += taken[s][f];
        logger.debug(`[NSFW] meter flush failed for ${guildId}: ${err.message}`);
    }
}

export async function flushAll() {
    for (const [guildId, m] of meters) await flushOne(guildId, m);
}

/** Reserve one scan under the cap. false = over today's cap (counted as skipped). */
function reserve(m, surface, dailyCap) {
    const c = capCheck(m.used[surface] + m.inflight[surface], dailyCap);
    if (!c.allowed) { count(m, surface, 'capped'); return false; }
    m.inflight[surface]++;
    return true;
}

// ── caches: verdicts, avatar URLs, pictures remembered as safe ───────────────

const verdicts = new Map();   // imageKey -> { at, scores, review }
const urlKeys = new Map();    // avatar URL -> imageKey
const safeCache = new Map();  // guildId -> { at, keys:Set }

function cacheVerdict(key, scores, review) {
    verdicts.delete(key);
    verdicts.set(key, { at: Date.now(), scores, review });
    if (verdicts.size > VERDICT_CACHE_MAX) verdicts.delete(verdicts.keys().next().value);
}

function cachedVerdict(key, review) {
    const hit = verdicts.get(key);
    if (!hit || Date.now() - hit.at > VERDICT_TTL_MS) return null;
    // Scored under a higher review threshold, at a screen score this server would have judged: score again.
    if (hit.scores.judge == null && review < hit.review && hit.scores.screen >= review) return null;
    return hit.scores;
}

async function safeKeys(guildId) {
    const hit = safeCache.get(guildId);
    if (hit && Date.now() - hit.at < SAFE_TTL_MS) return hit.keys;
    let keys = new Set();
    try {
        const [rows] = await pool.execute("SELECT exact_sha FROM blocked_images WHERE guild_id = ? AND kind = 'nsfw_safe' AND removed_at IS NULL", [guildId]);
        keys = new Set(rows.map(r => r.exact_sha));
    } catch { /* migration not run: nothing remembered */ }
    safeCache.set(guildId, { at: Date.now(), keys });
    return keys;
}

/** Remember a picture as safe for this server (a review "Not NSFW" or an overturn). */
async function rememberSafe(guildId, key, label, by) {
    if (!/^[0-9a-f]{64}$/.test(String(key || ''))) return false;
    await pool.execute(
        `INSERT INTO blocked_images (guild_id, kind, dhash, bits_set, colour_sig, exact_sha, label, added_by, source_type)
         VALUES (?, 'nsfw_safe', '0000000000000000', 0, ?, ?, ?, ?, 'review')
         ON DUPLICATE KEY UPDATE removed_at = NULL, label = VALUES(label)`,
        [guildId, '0'.repeat(96), key, String(label || 'Marked not NSFW').slice(0, 200), by ? String(by).slice(0, 20) : null]);
    safeCache.delete(guildId);
    return true;
}

export async function listSafe(guildId) {
    const [rows] = await pool.execute(
        "SELECT id, label, added_by, created_at FROM blocked_images WHERE guild_id = ? AND kind = 'nsfw_safe' AND removed_at IS NULL ORDER BY id DESC LIMIT 500",
        [guildId]).catch(() => [[]]);
    return rows;
}

export async function forgetSafe(guild, id, by = null) {
    const [r] = await pool.execute("DELETE FROM blocked_images WHERE id = ? AND guild_id = ? AND kind = 'nsfw_safe'", [id, guild.id]);
    safeCache.delete(guild.id);
    if (r.affectedRows) logger.info(`[NSFW] safe picture #${id} forgotten in ${guild.id} by ${by}`);
    return r.affectedRows > 0;
}

// ── one picture ──────────────────────────────────────────────────────────────

/**
 * Score one picture for a server. Never throws.
 * @returns {Promise<{ status:'clean'|'nsfw'|'review'|'minor'|'safe'|'capped'|'skipped', scores?:object, decision?:object, key?:string, why?:string }>}
 */
async function scanBuffer(guildId, surface, buf, settings, { priority = false, ignoreCap = false, knownKey = null } = {}) {
    let key = knownKey;
    if (!key) {
        try { key = await classifier.imageKey(buf); } catch (err) { return { status: 'skipped', why: `not readable as an image (${err.message})` }; }
    }
    if ((await safeKeys(guildId)).has(key)) return { status: 'safe', key, why: 'remembered as safe' };
    const m = await meterFor(guildId);
    let scores = cachedVerdict(key, settings.review);
    if (scores) {
        count(m, surface, 'cached');
    } else if (!buf) {
        return null;   // only the key was known (an avatar seen before) and its verdict has expired: download it
    } else {
        if (!ignoreCap && !reserve(m, surface, settings.dailyCap)) return { status: 'capped', key, why: `over today's cap of ${settings.dailyCap} scans` };
        if (ignoreCap) m.inflight[surface]++;
        const res = await classifier.classify(buf, { priority, review: settings.review });
        m.inflight[surface]--;
        if (!res.ok) {
            count(m, surface, res.skipped === 'overloaded' ? 'dropped' : 'errors');
            return { status: 'skipped', key, why: res.skipped === 'not_installed' ? 'model not installed' : res.skipped === 'overloaded' ? 'classifier busy' : res.error || 'error', skipped: res.skipped };
        }
        m.used[surface]++;
        count(m, surface, 'scanned');
        scores = res.scores;
        if (!scores.minor) cacheVerdict(key, scores, settings.review);
    }
    const decision = decide(scores, settings);
    if (decision.verdict === 'nsfw' || decision.verdict === 'minor') count(m, surface, 'nsfw');
    else if (decision.verdict === 'review') count(m, surface, 'review');
    return { status: decision.verdict, scores, decision, key };
}

/**
 * One avatar URL. A URL seen before (the same global avatar in another server, a re-check) is answered
 * from its key and the verdict cache without downloading it again. null when it cannot be read.
 */
async function scanAvatarUrl(guildId, url, settings, opts) {
    const known = urlKeys.get(url);
    if (known) {
        const r = await scanBuffer(guildId, 'avatar', null, settings, { ...opts, knownKey: known });
        if (r) return r;
    }
    const ap = await avatarProtection();
    const buf = await ap.downloadAvatar(url, { priority: !!opts.priority }).catch(() => null);
    if (!buf) return null;
    const r = await scanBuffer(guildId, 'avatar', buf, settings, opts);
    if (r?.key) {
        urlKeys.delete(url);
        urlKeys.set(url, r.key);
        if (urlKeys.size > URL_KEY_MAX) urlKeys.delete(urlKeys.keys().next().value);
    }
    return r;
}

const RANK = { minor: 4, nsfw: 3, review: 2, clean: 1, safe: 0, capped: 0, skipped: 0 };
const worst = (a, b) => (!a || (RANK[b.status] ?? 0) > (RANK[a.status] ?? 0) ? b : a);

// ── the review queue (name_filter_reviews kind nsfw_avatar / nsfw_image) ─────

async function queueRow(guildId, user, member, kind, { status, field, namesHash = null, url = null, result, action = null, detail, detectionId = null }) {
    await pool.execute(
        `INSERT INTO name_filter_reviews (guild_id, user_id, kind, username, display_name, nickname, filter_id, filter_label, field,
                names_hash, status, detail, found_at, decided_by, decided_at, image_id, score, judge_score, avatar_url, avatar_fp, avatar_sha,
                avatar_thumb, action_taken)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NULL, NULL, NULL, ?, ?, ?, NULL, ?, NULL, ?)
         ON DUPLICATE KEY UPDATE username = VALUES(username), display_name = VALUES(display_name), nickname = VALUES(nickname),
           filter_id = VALUES(filter_id), filter_label = VALUES(filter_label), field = VALUES(field), names_hash = VALUES(names_hash),
           status = VALUES(status), detail = VALUES(detail), found_at = NOW(), decided_by = NULL, decided_at = NULL, score = VALUES(score),
           judge_score = VALUES(judge_score), avatar_url = VALUES(avatar_url), avatar_sha = VALUES(avatar_sha), avatar_thumb = NULL,
           action_taken = VALUES(action_taken)`,
        [guildId, user.id, kind, String(user.username ?? '').slice(0, 100) || null, user.globalName ? String(user.globalName).slice(0, 100) : null,
            member?.nickname ? String(member.nickname).slice(0, 100) : null, detectionId, kind === REVIEW_KINDS.avatar ? 'NSFW avatar' : 'NSFW image',
            String(field || '').slice(0, 12) || null, namesHash, status, String(detail || '').slice(0, 255) || null,
            result?.scores?.screen != null ? Number(Number(result.scores.screen).toFixed(4)) : null,
            result?.scores?.judge != null ? Number(Math.min(result.scores.judge, result.scores.judgeFlip ?? result.scores.judge).toFixed(4)) : null,
            url ? String(url).slice(0, 300) : null, result?.key ?? null, action]);
}

/** Staff (or the bot) already settled this member's entry for this same picture: do not queue it again. */
async function decidedBefore(guildId, userId, kind, key) {
    if (!key) return false;
    const [[row]] = await pool.execute(
        'SELECT status, avatar_sha FROM name_filter_reviews WHERE guild_id = ? AND user_id = ? AND kind = ?', [guildId, userId, kind]).catch(() => [[null]]);
    return !!row && row.avatar_sha === key && ['actioned', 'skipped', 'banned', 'kicked', 'overturned', 'safe'].includes(row.status);
}

async function recordEvent(guildId, user, action, detail) {
    await pool.execute(
        `INSERT INTO join_gate_events (guild_id, user_id, username, action, account_age_hours, dm_delivered, detail, created_at)
         VALUES (?, ?, ?, ?, NULL, 0, ?, NOW())`,
        [guildId, user.id, user.username?.slice(0, 100) ?? null, action, detail?.slice(0, 255) ?? null],
    ).catch(err => logger.warn(`[NSFW] could not record ${action} for ${user.id}: ${err.message}`));
}

// ── avatars ──────────────────────────────────────────────────────────────────

function avatarDM(guild, action) {
    const title = action === 'ban' ? `You were banned from ${guild.name}` : `You were removed from ${guild.name}`;
    const next = action === 'kick' ? 'Change your profile picture and you are welcome to join again.' : "If this is a mistake, contact the server's staff.";
    return {
        embeds: [new EmbedBuilder().setColor(0xC0392B).setTitle(title)
            .setDescription(`This is automatic.\n\n**Why:** your profile picture was detected as not safe for work.\n\n**What now:** ${next}`)],
    };
}

async function flagRoleFor(guild) {
    const ap = await avatarProtection();
    return ap.ensureFlagRole(guild);
}

async function punishMember(member, action, reason) {
    try {
        if (action === 'ban') await member.ban({ reason, deleteMessageSeconds: 3600 });
        else if (action === 'kick') await member.kick(reason);
        else if (action === 'flag') await member.roles.add(await flagRoleFor(member.guild), reason);
        return { ok: true };
    } catch (err) {
        return { ok: false, problem: err.message, err };
    }
}

function actionable(member, action) {
    if (action === 'ban') return member.bannable;
    if (action === 'kick') return member.kickable;
    return true;
}

/** A label suggesting minors: remove, alert, store nothing. */
async function handleMinorAvatar(member, settings, trigger) {
    const guild = member.guild;
    const action = settings.action === 'ban' ? 'ban' : 'kick';
    let done = 'not removed';
    const held = await protectionHold(member, action, SOURCE.avatar);
    const cannot = held ? null : whyCannot(guild, action, { member });
    if (!held && !cannot) {
        const r = await punishMember(member, action, nsfwReason('minor'));
        done = r.ok ? DONE[action] : `could not ${action}: ${r.problem}`;
        const cause = r.ok ? null : whyFailed(r.err, guild, action, { member });
        if (cause) await reportManualAction(guild, { action, member, source: SOURCE.avatar, problem: cause });
    } else if (held) done = `held (${held.text})`;
    else {
        done = `could not ${action}: ${cannot.text.replace(/\*\*/g, '')}`;
        await reportManualAction(guild, { action, member, source: SOURCE.avatar, problem: cannot });
    }
    logger.warn(`[NSFW] possible CSAM avatar in ${guild.id} (${TRIGGER_LABEL[trigger] ?? trigger}): ${done}; nothing stored`);
    void logFeatureEvent(() => (guild), 'join-gate.nsfwAvatar', () => ({
        title: '🚨 Avatar Flagged as Possible Child Sexual Abuse Material',
        description: 'A model labelled this avatar as possibly showing a minor. Nothing about it was stored. '
            + `Report the account to Discord Trust & Safety now: ${REPORT_URL} (Child safety). Do not download or share the picture.`,
        fields: [['Member', userLabel(member)], ['User ID', member.id], ['Done', done]],
    }));
    return action === 'ban' || action === 'kick' ? (done === DONE[action] ? 'removed' : 'failed') : 'failed';
}

async function enforceAvatar(member, target, result, settings, trigger) {
    const guild = member.guild;
    const kind = REVIEW_KINDS.avatar;
    const namesHash = avatarKeyHash(target.key);
    const base = { field: target.scope, namesHash, url: target.url, result };
    const fields = [['Member', userLabel(member)], ['Scores', scoreLine(result.scores), false],
        ['Avatar', target.scope === 'server' ? 'Server avatar' : 'Avatar'], ['When', TRIGGER_LABEL[trigger] ?? trigger]];
    const action = result.status === 'nsfw' && trigger !== 'scan' ? settings.action : null;

    if (!action || action === 'log') {
        const review = result.status === 'review' || trigger === 'scan';
        if (await decidedBefore(guild.id, member.id, kind, result.key)) return null;
        await queueRow(guild.id, member.user, member, kind, { ...base, status: 'pending',
            detail: evidenceDetail({ scores: result.scores, decision: result.decision, action: review ? null : 'log' }) });
        await recordEvent(guild.id, member.user, avatarEventAction(review ? 'queue' : 'log'), scoreLine(result.scores));
        if (result.status === 'review') {
            void aiThirdOpinion(guild, member.user.id, kind, result, async () => (await avatarProtection()).downloadAvatar(target.url).catch(() => null));
        }
        void logFeatureEvent(() => (guild), 'join-gate.nsfwReview', () => ({
            title: review ? '🔎 Avatar Might Be NSFW' : '👀 NSFW Avatar (Log Only)',
            description: review
                ? 'Borderline (or found by a member scan): nothing was done. Decide in the NSFW review queue.'
                : 'Both models agree, but the action is log only, so nothing was done. It is in the NSFW review queue.',
            fields: [...fields, ['Decide', 'Dashboard: NSFW Protection, or `/avatarfilter nsfw review`', false]],
        }));
        return review ? 'queued' : 'logged';
    }

    const held = await protectionHold(member, action, SOURCE.avatar);
    if (held) {
        await queueRow(guild.id, member.user, member, kind, { ...base, status: 'pending', detail: evidenceDetail({ scores: result.scores, decision: result.decision, action, outcome: 'held' }) });
        return 'held';
    }
    const cannot = whyCannot(guild, action, { member });
    if (cannot) {
        const problem = cannot.text.replace(/\*\*/g, '');
        await queueRow(guild.id, member.user, member, kind, { ...base, status: 'failed', action, detail: evidenceDetail({ scores: result.scores, action, outcome: problem }) });
        await reportManualAction(guild, { action, member, source: SOURCE.avatar, problem: cannot });
        return 'failed';
    }
    let delivered = false;
    if (settings.dm && action !== 'flag') {
        try { await member.send(avatarDM(guild, action)); delivered = true; } catch { delivered = false; }
    }
    const r = await punishMember(member, action, nsfwReason('avatar', `${pct(result.decision.confidence)} on two models`));
    if (!r.ok) {
        await queueRow(guild.id, member.user, member, kind, { ...base, status: 'failed', action, detail: evidenceDetail({ scores: result.scores, action, outcome: r.problem }) });
        const cause = whyFailed(r.err, guild, action, { member });
        if (cause) await reportManualAction(guild, { action, member, source: SOURCE.avatar, problem: cause });
        else {
            void logFeatureEvent(() => (guild), 'join-gate.failed', () => ({
                title: '⚠️ NSFW Avatar Protection Could Not Act', fields: [...fields, ['Tried to', action], ['Problem', r.problem, false]],
            }));
        }
        return 'failed';
    }
    await queueRow(guild.id, member.user, member, kind, { ...base, status: 'actioned', action, detail: evidenceDetail({ scores: result.scores, decision: result.decision, action, outcome: DONE[action] }) });
    await recordEvent(guild.id, member.user, avatarEventAction(action), scoreLine(result.scores));
    logger.info(`[NSFW] ${DONE[action]} ${member.user.tag} in ${guild.id}: NSFW avatar (${scoreLine(result.scores)})`);
    void logFeatureEvent(() => (guild), 'join-gate.nsfwAvatar', () => ({
        title: { ban: '🔨 Banned — NSFW Avatar', kick: '🚪 Removed — NSFW Avatar', flag: '🚩 Flagged — NSFW Avatar' }[action],
        description: 'Both models agree at high confidence. Wrong? Overturn it in the NSFW review queue: that '
            + (action === 'ban' ? 'unbans them' : action === 'flag' ? 'takes the role off' : 'cannot undo a kick, but') + ' and remembers the picture as safe.',
        fields: [...fields, ['They were told', action !== 'flag' && settings.dm ? (delivered ? 'Yes, by DM' : 'No, their DMs are closed') : null]],
    }));
    return action === 'flag' ? 'acted' : 'removed';
}

async function unflagIfCleared(member) {
    const [[row]] = await pool.execute(
        "SELECT status, action_taken FROM name_filter_reviews WHERE guild_id = ? AND user_id = ? AND kind = 'nsfw_avatar'",
        [member.guild.id, member.id]).catch(() => [[null]]);
    if (!row || row.status !== 'actioned' || row.action_taken !== 'flag') return;
    const ap = await avatarProtection();
    const roleId = (await ap.getSettings(member.guild.id)).flagRoleId;
    const role = roleId ? member.guild.roles.cache.get(roleId) : null;
    if (role?.editable && member.roles.cache.has(role.id)) await member.roles.remove(role, 'NSFW avatar protection: their new avatar is clean').catch(() => {});
    await pool.execute(
        "UPDATE name_filter_reviews SET status = 'gone', detail = 'changed to a clean avatar' WHERE guild_id = ? AND user_id = ? AND kind = 'nsfw_avatar'",
        [member.guild.id, member.id]).catch(() => {});
}

/**
 * Check a member's avatars (core/avatar-protection.js checkMember calls this without waiting).
 * @returns {Promise<'removed'|'acted'|'queued'|'logged'|'held'|'failed'|null>} never throws
 */
export async function checkAvatar(member, trigger = 'join', { settings = null, priority = true } = {}) {
    try {
        if (!member?.guild || member.user?.bot) return null;
        const s = settings || await getAvatarSettings(member.guild.id);
        if (!s.enabled) return null;
        if (isStaff(member) || (await isExempt(member)).exempt) return null;
        const targets = avatarTargets({ userId: member.id, guildId: member.guild.id, userAvatar: member.user?.avatar ?? null, guildAvatar: member.avatar ?? null }, 256);
        if (!targets.length) return null;
        let found = null;
        let foundTarget = null;
        for (const t of targets) {
            const r = await scanAvatarUrl(member.guild.id, t.url, s, { priority });
            if (!r) continue;
            if (worst(found, r) === r) { found = r; foundTarget = t; }
        }
        if (!found) return null;
        if (found.status === 'minor') return handleMinorAvatar(member, s, trigger);
        if (found.status === 'nsfw' || found.status === 'review') return enforceAvatar(member, foundTarget, found, s, trigger);
        if (found.status === 'clean' && trigger !== 'join' && trigger !== 'scan') await unflagIfCleared(member);
        if (found.status === 'skipped' && found.skipped === 'overloaded') {
            logger.debug(`[NSFW] avatar check skipped for ${member.id} in ${member.guild.id}: classifier busy`);
        }
        return null;
    } catch (err) {
        logger.error(`[NSFW] avatar check failed for ${member?.id} in ${member?.guild?.id}: ${err.message}`);
        return null;
    }
}

// ── member scan (backfill, review-only) ──────────────────────────────────────

const scans = new Map();   // guildId -> { running, by, startedAt, finishedAt, checked, total, found, capped, skipped, error }

export function scanStatus(guildId) {
    return scans.get(guildId) || { running: false };
}

/** Check every member's avatars in the background. Never acts: findings go to the review queue. */
export function startScan(guild, actorId = null) {
    const cur = scans.get(guild.id);
    if (cur?.running) return { ok: false, error: 'An NSFW avatar scan is already running for this server.' };
    const job = { running: true, by: actorId, startedAt: Date.now(), checked: 0, total: null, found: 0, capped: false, skipped: 0 };
    scans.set(guild.id, job);
    (async () => {
        const s = await getAvatarSettings(guild.id);
        if (!(await classifier.available())) throw new Error('The NSFW model is not installed.');
        const nf = (await import('./name-filters.js')).default;
        const { members } = await nf.allMembers(guild);
        const humans = members.filter(m => !m.user.bot && (m.user.avatar || m.avatar)).slice(0, SCAN_CAP_MEMBERS);
        job.total = humans.length;
        let next = 0;
        const worker = async () => {
            while (next < humans.length && !job.capped) {
                const m = humans[next++];
                const before = (await meterFor(guild.id)).live.avatar.capped;
                const out = await checkAvatar(m, 'scan', { settings: s, priority: false });
                if ((await meterFor(guild.id)).live.avatar.capped > before) job.capped = true;
                if (out === 'queued' || out === 'logged' || out === 'removed') job.found++;
                job.checked++;
            }
        };
        await Promise.all([worker(), worker()]);
        logger.info(`[NSFW] avatar scan in ${guild.id} by ${actorId}: ${job.checked}/${job.total} checked, ${job.found} queued${job.capped ? ', stopped at the daily cap' : ''}`);
        void logFeatureEvent(() => (guild), 'join-gate.nsfwReview', () => ({
            title: '🧹 NSFW Avatar Scan Finished',
            fields: [['Run by', userLabel(actorId)], ['Members checked', `${job.checked} of ${job.total}`], ['Queued for review', String(job.found)],
                ['Stopped early', job.capped ? 'Reached the daily scan cap' : null]],
        }));
    })().catch(err => {
        job.error = err.message;
        logger.warn(`[NSFW] avatar scan failed in ${guild.id}: ${err.message}`);
    }).finally(() => {
        job.running = false;
        job.finishedAt = Date.now();
    });
    return { ok: true };
}

// ── chat images ──────────────────────────────────────────────────────────────

/**
 * The chat-image stage of PhishingDetectionManager.checkMessage (after the ignore list).
 * @param {object} settings  message-threat settings (settings.nsfw is this stage's)
 * @returns {Promise<boolean>} true when the message was removed. Never throws.
 */
export async function imageStage(message, settings) {
    try {
        const s = settings?.nsfw;
        if (!s?.enabled || !message.guild || message.author?.bot) return false;
        if (isAgeRestricted(message.channel)) return false;
        const atts = imageAttachments(message).slice(0, MAX_IMAGES_PER_MESSAGE);
        if (!atts.length) return false;
        let found = null;
        for (const att of atts) {
            let buf;
            try { buf = await fetchImageBytes(att.url, { maxBytes: 16 * 1024 * 1024 }); } catch { continue; }
            const r = await scanBuffer(message.guild.id, 'image', buf, s, { priority: false });
            // A borderline picture keeps its bytes for the AI third opinion (dropped with `found`).
            if (r?.status === 'review') r.buf = buf;
            found = worst(found, r);
            if (found.status === 'minor') break;
        }
        if (!found) return false;
        if (found.status === 'minor') return handleMinorImage(message);
        if (found.status !== 'nsfw' && found.status !== 'review') return false;
        return enforceImage(message, found, s);
    } catch (err) {
        logger.error(`[NSFW] image stage failed in ${message?.guild?.id}: ${err.message}`);
        return false;
    }
}

async function handleMinorImage(message) {
    const guild = message.guild;
    const removed = await message.delete().then(() => true).catch(() => false);
    logger.warn(`[NSFW] possible CSAM image in ${guild.id} #${message.channel?.id}: ${removed ? 'deleted' : 'could not delete'}; nothing stored`);
    void logFeatureEvent(() => (guild), 'automod.threatRemoved', () => ({
        title: '🚨 Image Flagged as Possible Child Sexual Abuse Material',
        description: 'A model labelled an image as possibly showing a minor. Nothing about it was stored. '
            + `Report the account to Discord Trust & Safety now: ${REPORT_URL} (Child safety).`,
        fields: [['Member', userLabel(message.author)], ['User ID', message.author.id], ['Channel', `${message.channel}`],
            ['Message', removed ? 'Deleted' : `Could not delete it: delete it by hand. ${message.url}`, false]],
    }));
    return removed;
}

async function enforceImage(message, found, s) {
    const mt = await messageThreats();
    const borderline = found.status === 'review';
    const action = borderline ? (s.reviewAlerts ? 'review' : 'log') : ({ alert: 'review', delete: 'delete', timeout: 'timeout' }[s.action] || 'review');
    const out = await mt.enforce({
        guild: message.guild, member: message.member, user: message.author, message, channel: message.channel,
        source: 'nsfw_image', action, timeoutMinutes: s.timeoutMinutes, reasonKind: 'nsfw', reasonExtra: pct(found.decision.confidence),
        label: borderline ? 'NSFW image (borderline)' : 'NSFW image', content: null,
        reasons: [`||${borderline ? 'Borderline' : 'NSFW'} image: ${scoreLine(found.scores)}||`,
            borderline ? 'Below the act threshold on one of the models: nothing was done.' : 'Both models agree at high confidence.',
            'Decide or overturn: dashboard NSFW Protection, or `/avatarfilter nsfw review`.'],
        score: Math.round(found.decision.confidence * 100),
        evidence: { nsfw: { scores: found.scores, verdict: found.status, why: found.decision.why } },
        queue: false, sweep: false, quiet: action === 'log',
    });
    const status = ['deleted', 'timeout'].includes(out.outcome) ? 'actioned' : out.outcome === 'failed' ? 'failed' : 'pending';
    const taken = out.outcome === 'timeout' ? 'timeout' : out.outcome === 'deleted' ? 'delete' : null;
    // Staff are only ever logged (enforce), and need no queue entry of their own; an entry staff already
    // settled for this same picture (Skip) is not reopened by a borderline repost.
    const settled = status === 'pending' && await decidedBefore(message.guild.id, message.author.id, REVIEW_KINDS.image, found.key);
    if (out.outcome !== 'skipped' && out.outcome !== 'staff' && !settled) {
        await queueRow(message.guild.id, message.author, message.member, REVIEW_KINDS.image, {
            status, field: 'image', result: found, action: taken, detectionId: out.detectionId,
            detail: evidenceDetail({ scores: found.scores, decision: found.decision, action: s.action, outcome: out.outcome }),
        }).catch(err => logger.warn(`[NSFW] image review row not queued: ${err.message}`));
        if (status === 'pending' && borderline && found.buf) {
            const bytes = found.buf;
            void aiThirdOpinion(message.guild, message.author.id, REVIEW_KINDS.image, found, async () => bytes);
        }
    }
    return out.removed;
}

// ── AI third opinion (core/ai-judge.js) ──────────────────────────────────────

/**
 * Borderline review-queue items only, when the server has the NSFW third opinion on: the verdict goes on the
 * queue row and the log. Advice only: it never acts. Never sent for anything a model labelled as possibly
 * showing a minor (those are never queued anyway), nor from age-restricted channels (never scanned).
 */
async function aiThirdOpinion(guild, userId, kind, result, getBytes) {
    try {
        if (result?.scores?.minor || !aiJudge.isConfigured()) return;
        const ai = await aiJudge.getSettings(guild.id);
        if (!ai.nsfw.advise) return;
        const buffer = await getBytes();
        if (!buffer) return;
        const r = await aiJudge.judgeNsfw(guild.id, { buffer, minorSuspected: !!result?.scores?.minor });
        if (!r.verdict) return;
        await aiJudge.saveReviewVerdict(guild.id, userId, kind, 'nsfw', r.verdict);
        aiJudge.logVerdict(guild, 'nsfw', { userId, verdict: r.verdict, outcome: 'advise', detail: kind === REVIEW_KINDS.avatar ? 'NSFW avatar (borderline)' : 'NSFW chat image (borderline)' });
    } catch (err) {
        logger.debug(`[NSFW] AI third opinion failed in ${guild?.id}: ${err.message}`);
    }
}

// ── review: list, decide, overturn ──────────────────────────────────────────

export async function listReviews(guildId, { kind = 'all', status = 'open', limit = 200 } = {}) {
    const kinds = kind === 'avatar' ? [REVIEW_KINDS.avatar] : kind === 'image' ? [REVIEW_KINDS.image] : Object.values(REVIEW_KINDS);
    const statuses = status === 'all' ? null : status === 'open' ? ['pending', 'actioned', 'failed'] : String(status).split(',');
    const args = [guildId, ...kinds, ...(statuses ?? [])];
    const [rows] = await pool.execute(
        `SELECT user_id, kind, username, display_name, nickname, filter_id, field, status, detail, found_at, decided_by, decided_at,
                score, judge_score, avatar_url, avatar_sha, action_taken, names_hash, ai_verdict, ai_confidence, ai_reason, ai_at
           FROM name_filter_reviews
          WHERE guild_id = ? AND kind IN (${kinds.map(() => '?').join(',')}) ${statuses ? `AND status IN (${statuses.map(() => '?').join(',')})` : ''}
          ORDER BY found_at DESC LIMIT ${Math.min(1000, Math.max(1, Number(limit) || 200))}`, args);
    return rows;
}

export async function reviewCounts(guildId) {
    const [rows] = await pool.execute(
        "SELECT kind, status, COUNT(*) AS n FROM name_filter_reviews WHERE guild_id = ? AND kind IN ('nsfw_avatar','nsfw_image') GROUP BY kind, status",
        [guildId]).catch(() => [[]]);
    const out = { avatar: {}, image: {} };
    for (const r of rows) out[r.kind === 'nsfw_avatar' ? 'avatar' : 'image'][r.status] = Number(r.n);
    return out;
}

async function setStatus(guildId, userId, kind, status, by, detail = undefined, action = undefined) {
    await pool.execute(
        `UPDATE name_filter_reviews SET status = ?, decided_by = ?, decided_at = NOW()${detail !== undefined ? ', detail = ?' : ''}${action !== undefined ? ', action_taken = ?' : ''}
          WHERE guild_id = ? AND user_id = ? AND kind = ?`,
        [status, by, ...(detail !== undefined ? [detail ? String(detail).slice(0, 255) : null] : []), ...(action !== undefined ? [action] : []), guildId, userId, kind]);
}

async function undo(guild, row, plan, actorId) {
    const reason = nsfwReason('overturn', `by ${actorId}`);
    if (plan.undo === 'unban') {
        await guild.bans.remove(row.user_id, reason).catch(err => { if (!/Unknown Ban/i.test(err.message)) throw err; });
        return 'unbanned';
    }
    const member = await guild.members.fetch(row.user_id).catch(() => null);
    if (!member) return 'they are no longer here';
    if (plan.undo === 'untimeout') {
        if ((member.communicationDisabledUntilTimestamp ?? 0) > Date.now()) await member.timeout(null, reason);
        return 'timeout lifted';
    }
    if (plan.undo === 'unflag') {
        const ap = await avatarProtection();
        const roleId = (await ap.getSettings(guild.id)).flagRoleId;
        const role = roleId ? guild.roles.cache.get(roleId) : null;
        if (role && member.roles.cache.has(role.id)) await member.roles.remove(role, reason);
        return 'flag role removed';
    }
    return null;
}

/**
 * Decide queue entries. decision: 'ban' | 'kick' | 'safe' (Not NSFW: remembers the picture) | 'skip'
 * | 'overturn' (undo an automatic action + remember the picture).
 * @param {'avatar'|'image'} surface
 * @returns {Promise<{ done:number, failed:Array<{id,problem}>, skipped:number, notes:string[] }>}
 */
export async function decideReviews(guild, surface, userIds, decision, actorId) {
    const kind = surface === 'avatar' ? REVIEW_KINDS.avatar : REVIEW_KINDS.image;
    const out = { done: 0, failed: [], skipped: 0, notes: [] };
    if (!['ban', 'kick', 'safe', 'skip', 'overturn'].includes(decision)) { out.failed.push({ id: '*', problem: 'Unknown decision.' }); return out; }
    if (decision === 'ban' || decision === 'kick') {
        const [perm, permName] = NEEDS[decision];
        if (!guild.members.me?.permissions?.has(perm)) { out.failed.push({ id: '*', problem: `The bot is missing the ${permName} permission` }); return out; }
        if (await isPaused(guild.id, guild)) { out.failed.push({ id: '*', problem: 'Protections are paused in this server. Resume them first.' }); return out; }
    }
    const ids = [...new Set(userIds.map(String))].slice(0, 500);
    const [rows] = ids.length ? await pool.execute(
        `SELECT * FROM name_filter_reviews WHERE guild_id = ? AND kind = ? AND user_id IN (${ids.map(() => '?').join(',')})`,
        [guild.id, kind, ...ids]) : [[]];
    const byId = new Map(rows.map(r => [r.user_id, r]));
    for (const id of ids) {
        const row = byId.get(id);
        if (!row) { out.skipped++; continue; }
        try {
            if (decision === 'skip') { await setStatus(guild.id, id, kind, 'skipped', actorId); out.done++; continue; }
            if (decision === 'safe' || decision === 'overturn') {
                const plan = decision === 'overturn' ? overturnPlan(row) : { ok: true, undo: null };
                if (!plan.ok) { out.failed.push({ id, problem: plan.error }); continue; }
                const did = decision === 'overturn' ? await undo(guild, row, plan, actorId) : null;
                await rememberSafe(guild.id, row.avatar_sha, `${kind === REVIEW_KINDS.avatar ? 'Avatar' : 'Image'} of ${row.username ?? id}: ${decision === 'overturn' ? 'overturned' : 'not NSFW'}`, actorId);
                await setStatus(guild.id, id, kind, decision === 'overturn' ? 'overturned' : 'safe', actorId,
                    [decision === 'overturn' ? 'overturned' : 'not NSFW', did, plan.note].filter(Boolean).join('; '));
                if (kind === REVIEW_KINDS.avatar && decision === 'overturn') await recordEvent(guild.id, { id, username: row.username }, avatarEventAction('overturn'), did || 'remembered as safe');
                if (plan.note) out.notes.push(plan.note);
                out.done++;
                continue;
            }
            // ban / kick
            const member = await guild.members.fetch(id).catch(() => null);
            if (!member) {
                if (decision === 'ban') {
                    await guild.members.ban(id, { reason: nsfwReason('review', `by ${actorId}`), deleteMessageSeconds: 3600 });
                    await setStatus(guild.id, id, kind, 'banned', actorId, 'banned after leaving', 'ban');
                    out.done++;
                } else {
                    await setStatus(guild.id, id, kind, 'gone', actorId, 'left the server');
                    out.skipped++;
                }
                continue;
            }
            if (kind === REVIEW_KINDS.avatar && row.names_hash) {
                const now = avatarTargets({ userId: id, guildId: guild.id, userAvatar: member.user.avatar, guildAvatar: member.avatar }, 256);
                if (!now.some(t => avatarKeyHash(t.key) === row.names_hash)) {
                    await setStatus(guild.id, id, kind, 'gone', actorId, 'changed their avatar since');
                    out.skipped++;
                    continue;
                }
            }
            if (member.user.bot || isStaff(member)) { await setStatus(guild.id, id, kind, 'skipped', actorId, 'staff'); out.skipped++; continue; }
            if (await protectionHold(member, decision, `${SOURCE[surface]} review`)) { out.skipped++; continue; }
            if (!actionable(member, decision)) { out.failed.push({ id, problem: 'Their highest role is above the bot' }); continue; }
            const r = await punishMember(member, decision, nsfwReason('review', `by ${actorId}`));
            if (!r.ok) { out.failed.push({ id, problem: r.problem }); continue; }
            await setStatus(guild.id, id, kind, decision === 'ban' ? 'banned' : 'kicked', actorId, undefined, decision);
            if (kind === REVIEW_KINDS.avatar) await recordEvent(guild.id, member.user, avatarEventAction(decision), 'NSFW review');
            out.done++;
        } catch (err) {
            out.failed.push({ id, problem: err.message });
        }
    }
    logger.info(`[NSFW] review decision ${decision} (${surface}) in ${guild.id} by ${actorId}: ${out.done} done, ${out.failed.length} failed`);
    if (out.done) {
        const title = { ban: '🔨 NSFW Review: Banned', kick: '🚪 NSFW Review: Kicked', safe: '✅ NSFW Review: Not NSFW', skip: '⏭️ NSFW Review: Skipped',
            overturn: '↩️ NSFW Action Overturned' }[decision];
        const fields = [['By', userLabel(actorId)], ['Members', ids.slice(0, 20).map(i => `<@${i}>`).join(', '), false], ['Done', String(out.done)]];
        if (surface === 'avatar') void logFeatureEvent(() => (guild), 'join-gate.nsfwOverturned', () => ({ title, fields }));
        else void logFeatureEvent(() => (guild), 'automod.threatLogged', () => ({ title, fields }));
    }
    return out;
}

// ── test, recent, usage, overview ────────────────────────────────────────────

/**
 * Score a member's avatars or an uploaded image (nothing stored, cap not applied but counted).
 * @returns {Promise<{ installed:boolean, results:Array<{ scope, url, status, scores, verdict, why }>, notes:string[] }>}
 */
export async function testImage(guild, { member = null, buffer = null, surface = 'avatar' } = {}) {
    const st = await classifier.status();
    const s = surface === 'avatar' ? await getAvatarSettings(guild.id) : await getImageSettings(guild.id);
    const out = { installed: st.installed || st.partial, missing: st.missing, thresholds: { act: s.act, review: s.review }, results: [], notes: [] };
    if (!out.installed) return out;
    const items = [];
    if (member) {
        const ap = await avatarProtection();
        for (const t of avatarTargets({ userId: member.id, guildId: guild.id, userAvatar: member.user?.avatar, guildAvatar: member.avatar }, 256)) {
            items.push({ scope: t.scope, url: t.url, buf: await ap.downloadAvatar(t.url).catch(() => null) });
        }
        if (!items.length) out.notes.push('They use a default avatar.');
        if (isStaff(member)) out.notes.push('Staff are never acted on.');
        const ex = await isExempt(member);
        if (ex.exempt) out.notes.push(`Exempt from automatic protections: ${ex.text}.`);
    } else if (buffer) {
        items.push({ scope: 'upload', url: null, buf: buffer });
    }
    for (const it of items) {
        if (!it.buf) { out.results.push({ scope: it.scope, url: it.url, status: 'skipped', why: 'could not download it' }); continue; }
        const r = await scanBuffer(guild.id, surface, it.buf, s, { priority: true, ignoreCap: true });
        out.results.push({
            scope: it.scope, url: it.url, status: r.status, why: r.decision?.why ?? r.why ?? null,
            scores: r.scores ? { screen: r.scores.screen, screenFlip: r.scores.screenFlip, judge: r.scores.judge, judgeFlip: r.scores.judgeFlip, frames: r.scores.frames } : null,
            line: r.scores ? scoreLine(r.scores) : null,
        });
    }
    return out;
}

/** Recent outcomes, newest first: avatar events (join_gate_events) and chat-image detections. */
export async function recent(guildId, limit = 60) {
    const lim = Math.min(200, Math.max(1, Number(limit) || 60));
    const [avatars] = await pool.execute(
        `SELECT id, user_id, username, action, detail, created_at FROM join_gate_events
          WHERE guild_id = ? AND action LIKE 'nsfw\\_%' ORDER BY id DESC LIMIT ${lim}`, [guildId]).catch(() => [[]]);
    const [images] = await pool.execute(
        `SELECT id, user_id, channel_id, message_id, action_taken, score, created_at FROM phishing_detections
          WHERE guild_id = ? AND source = 'nsfw_image' ORDER BY id DESC LIMIT ${lim}`, [guildId]).catch(() => [[]]);
    return [
        ...avatars.map(r => ({ surface: 'avatar', id: `a${r.id}`, userId: r.user_id, username: r.username, outcome: r.action.replace(/^nsfw_/, ''), detail: r.detail, at: r.created_at })),
        ...images.map(r => ({ surface: 'image', id: `i${r.id}`, userId: r.user_id, channelId: r.channel_id, messageId: r.message_id, outcome: r.action_taken, score: r.score, at: r.created_at })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, lim);
}

/** Daily usage for the last `days` days (server_stats) plus today's live counters. */
export async function usage(guildId, days = 14) {
    const since = dayKey(Date.now() - (Math.max(1, days) - 1) * 86_400_000);
    const [rows] = await pool.execute(
        `SELECT date, ${ALL_STATS_COLUMNS.join(', ')} FROM server_stats WHERE guild_id = ? AND date >= ? ORDER BY date`,
        [guildId, since]).catch(() => [[]]);
    const m = await meterFor(guildId);
    return {
        days: rows.map(r => ({ date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
            ...Object.fromEntries(ALL_STATS_COLUMNS.map(c => [c, Number(r[c] ?? 0)])) })),
        today: { day: m.day, used: { ...m.used }, sinceRestart: { avatar: { ...m.live.avatar }, image: { ...m.live.image } } },
    };
}

/** Everything the dashboard's NSFW Protection page and `/avatarfilter nsfw status` show. */
export async function overview(guild) {
    const [avatar, image, model, counts, use] = await Promise.all([
        getAvatarSettings(guild.id), getImageSettings(guild.id), classifier.status(), reviewCounts(guild.id), usage(guild.id),
    ]);
    return {
        avatar, image, model, counts, usage: use,
        cap: {
            avatar: { used: use.today.used.avatar, limit: avatar.dailyCap, ...capCheck(use.today.used.avatar, avatar.dailyCap) },
            image: { used: use.today.used.image, limit: image.dailyCap, ...capCheck(use.today.used.image, image.dailyCap) },
        },
        scan: scanStatus(guild.id),
        models: [MODELS.screen, MODELS.judge].map(m => ({ id: m.id, name: m.name, licence: m.licence, minorLabels: modelHasMinorLabels(m) })),
        actions: { avatar: AVATAR_ACTIONS, image: IMAGE_ACTIONS },
    };
}

export { AVATAR_ACTIONS, IMAGE_ACTIONS };

export default {
    getAvatarSettings, getImageSettings, saveSettings, checkAvatar, startScan, scanStatus, imageStage, listReviews, reviewCounts,
    decideReviews, testImage, recent, usage, overview, listSafe, forgetSafe, flushAll,
};
