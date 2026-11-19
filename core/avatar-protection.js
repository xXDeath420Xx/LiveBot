/*
 * Avatar protection — the live side (the rules and the scoring are in core/avatar-match-logic.js, the
 * image decoding in core/image-fingerprint.js avatarFingerprint()).
 *
 * Catches impersonators who copy a staff member's avatar (or the server icon, or any uploaded image),
 * and the ticket-scam kit's solid-black and fully-transparent avatars:
 *
 *   on join        checkAvatarOnJoin(), called by core/join-gate.js checkJoin right after the name filters
 *   on change      onMemberUpdate() (server avatar, events/guildMemberUpdate.js) and onUserUpdate() (global
 *                  avatar, events/userUpdate.js — a global event, so every server the member shares with the
 *                  bot that serves it is checked)
 *   scoring        at or above the server's act threshold: its action (log / flag / timeout / kick / ban);
 *                  between the review and act thresholds: the review queue plus a log alert. An exact scam
 *                  avatar uses its own action. A log-only result is queued too, so staff can still decide.
 *   protected      addProtected(): a member's global and/or server avatar, every member of a role, the server
 *                  icon, an uploaded image. Adding one starts a background review scan of the members.
 *   scam avatars   the built-in black / transparent entries, plus exact entries learned from review bans or
 *                  uploaded by staff; matched on canonical pixels, on by default once protection is on.
 *   cleanse        startCleanse(): every member's avatars, downloaded once each (cached by URL, four at a
 *                  time), into the review queue; force mode acts on near-exact and scam matches at once.
 *   review         decideReviews(): Ban / Kick / Not a match / Skip. "Not a match" remembers that avatar
 *                  against that image (blocked_images.suppress) and the member's current avatar; a review
 *                  ban learns the avatar as an exact scam avatar for this server.
 *   Auto-Pilot     syncAutoPilot(): with Auto-Pilot on (core/name-filters.js — one Auto-Pilot, one coverage
 *                  setting) and its avatar part on, keeps a protected image for every covered staff member's
 *                  avatars, follows avatar changes, remembers deletions, skips default avatars.
 *   NSFW avatars   every checked member is also handed to core/nsfw-protection.js checkAvatar when its own
 *                  switch (nsfw_avatar_enabled) is on — in the background, so a model never holds up a join.
 *                  It downloads through downloadAvatar() below (the same rate-limited fetch).
 *
 * Storage (migrations/326_avatar_protection.js): protected images and scam avatars are blocked_images rows
 * (kind 'avatar' / 'scam_avatar'), the review queue is name_filter_reviews kind 'avatar', settings are the
 * avatar_* columns of join_gate_config (read through join-gate's cached getConfig), outcomes go to
 * join_gate_events (the Recent hits list).
 *
 * Every automatic action goes through protectionHold (allowlist, managers, pause). Staff (owner or a
 * moderation permission), the people whose avatars are protected and members marked "not a match" for
 * their current avatar are never touched. Off until a server switches it on; the action defaults to
 * log-only. Unable to act, or unable to download an avatar, fails open and says so.
 */
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import { protectionHold, isExempt, isPaused, getState as protectionState } from './protection-exempt.js';
import { isStaff } from './spammer-guard.js';
import { whyCannot, whyFailed, reportManualAction } from './manual-action.js';
import aiJudge from './ai-judge.js';
import { avatarFingerprint } from './image-fingerprint.js';
import nf from './name-filters.js';
import { avatarSettingsFrom as nsfwSettingsFrom } from './nsfw-logic.js';
import {
    AVATAR_ACTIONS, normaliseAvatarAction, normaliseThresholds, decide, usableFingerprint, bestMatch, scoreAgainst,
    canonicalHash, flatKind, exactScamMatch, BUILTIN_SCAM_AVATARS, avatarTargets, serverIconUrl, avatarKeyHash, pickScopes,
    planAvatarCleanse, splitAvatarForce, planAvatarDownloads, planAvatarAutoPilot, avatarReason, avatarEventAction,
    fpToString, fpFromString, variantToString, addSuppression, scoreText, MAX_PROTECTED, VARIANT_LABELS, buildAvatarExport, planAvatarImport,
    DEFAULT_AUTO, DEFAULT_REVIEW, MIN_THRESHOLD,
} from './avatar-match-logic.js';

export const FLAG_ROLE_NAME = 'Flagged Avatar';
const CACHE_MS = 5 * 60_000;
const SCAN_CAP = 1000;                 // most members one decision / force cleanse acts on
const ROLE_ADD_CAP = 200;              // most members one "protect a role" adds
const MAX_BYTES = 4 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 8000;
const DOWNLOADS_AT_ONCE = 4;
const FP_CACHE_MAX = 6000;
const AUTOPILOT_DEBOUNCE_MS = 20_000;
const AUTOPILOT_REFRESH_MS = 6 * 3600_000;
const AUTOPILOT_SCAN_GAP_MS = 30 * 60_000;

const NEEDS = {
    ban: [PermissionFlagsBits.BanMembers, 'Ban Members'],
    kick: [PermissionFlagsBits.KickMembers, 'Kick Members'],
    timeout: [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
    flag: [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
};
const DONE = { ban: 'banned', kick: 'kicked', timeout: 'timed out', flag: 'flagged', log: 'logged' };
const SOURCE_LABEL = { upload: 'Uploaded', member: 'Member avatar', role: 'Role member', server_icon: 'Server icon',
    autopilot: 'Auto-Pilot', learned: 'Learned from a ban', seed: 'Built in', import: 'Imported' };
const TRIGGER_LABEL = { join: 'On joining', server_avatar: 'Changed their server avatar', global_avatar: 'Changed their avatar',
    cleanse: 'Cleanse', review: 'Review queue' };

// join-gate imports this module; importing it back lazily keeps the cycle out of module load.
const gate = () => import('./join-gate.js');
// core/nsfw-protection.js imports this module (downloadAvatar, ensureFlagRole); lazily back for the same reason.
const nsfw = () => import('./nsfw-protection.js');

// ── settings ─────────────────────────────────────────────────────────────────

/** The avatar_* columns of a join_gate_config row (and Auto-Pilot's shared name_autopilot_* ones). */
export function settingsFrom(cfg) {
    const c = cfg || {};
    const t = normaliseThresholds(c.avatar_auto_threshold ?? DEFAULT_AUTO, c.avatar_review_threshold ?? DEFAULT_REVIEW);
    const names = nf.settingsFrom(c);
    return {
        enabled: !!Number(c.avatar_enabled ?? 0),
        autoThreshold: t.auto,
        reviewThreshold: t.review,
        action: normaliseAvatarAction(c.avatar_action),
        flagRoleId: c.avatar_flag_role_id || null,
        timeoutMinutes: Math.min(40320, Math.max(1, Number(c.avatar_timeout_minutes ?? 60) || 60)),
        dm: c.avatar_dm == null ? true : !!Number(c.avatar_dm),
        scam: {
            enabled: c.avatar_scam_enabled == null ? true : !!Number(c.avatar_scam_enabled),
            action: normaliseAvatarAction(c.avatar_scam_action),
        },
        autopilot: {
            enabled: names.autopilot.enabled,
            managers: names.autopilot.managers,
            roles: names.autopilot.roles,
            avatars: c.avatar_autopilot == null ? true : !!Number(c.avatar_autopilot),
        },
        // NSFW avatars (core/nsfw-protection.js): its own switch, thresholds and action on the same row.
        nsfw: nsfwSettingsFrom(c),
    };
}

export async function getSettings(guildId) {
    const { getConfig } = await gate();
    return settingsFrom(await getConfig(guildId));
}

/**
 * Save settings (any subset of the settingsFrom shape). Auto-Pilot's on/off, managers and roles are
 * the name filters' Auto-Pilot settings and are saved through core/name-filters.js.
 */
export async function saveSettings(guild, patch, by = null) {
    const { setConfig } = await gate();
    const cur = await getSettings(guild.id);
    const row = {};
    const changed = [];
    const set = (col, value, label) => { row[col] = value; changed.push(label); };
    if (patch.enabled !== undefined) set('avatar_enabled', patch.enabled ? 1 : 0, `avatar checks ${patch.enabled ? 'on' : 'off'}`);
    if (patch.autoThreshold !== undefined || patch.reviewThreshold !== undefined) {
        const t = normaliseThresholds(patch.autoThreshold ?? cur.autoThreshold, patch.reviewThreshold ?? cur.reviewThreshold);
        set('avatar_auto_threshold', t.auto, `act from ${scoreText(t.auto)}`);
        set('avatar_review_threshold', t.review, `review from ${scoreText(t.review)}`);
    }
    if (patch.action !== undefined) set('avatar_action', normaliseAvatarAction(patch.action), `action ${normaliseAvatarAction(patch.action)}`);
    if (patch.flagRoleId !== undefined) set('avatar_flag_role_id', patch.flagRoleId || null, 'flag role');
    if (patch.timeoutMinutes !== undefined) {
        set('avatar_timeout_minutes', Math.min(40320, Math.max(1, Math.round(Number(patch.timeoutMinutes) || 60))), 'timeout length');
    }
    if (patch.dm !== undefined) set('avatar_dm', patch.dm ? 1 : 0, `DM ${patch.dm ? 'on' : 'off'}`);
    if (patch.scam) {
        if (patch.scam.enabled !== undefined) set('avatar_scam_enabled', patch.scam.enabled ? 1 : 0, `scam avatars ${patch.scam.enabled ? 'on' : 'off'}`);
        if (patch.scam.action !== undefined) set('avatar_scam_action', normaliseAvatarAction(patch.scam.action), 'scam-avatar action');
    }
    let autopilotChanged = false;
    if (patch.autopilot) {
        const a = patch.autopilot;
        if (a.avatars !== undefined) set('avatar_autopilot', a.avatars ? 1 : 0, `Auto-Pilot avatars ${a.avatars ? 'on' : 'off'}`);
        const shared = {};
        for (const k of ['enabled', 'managers', 'roles']) if (a[k] !== undefined) shared[k] = a[k];
        if (Object.keys(shared).length) await nf.saveSettings(guild, { autopilot: shared }, by);
        autopilotChanged = true;
    }
    if (Object.keys(row).length) await setConfig(guild.id, row);
    const next = await getSettings(guild.id);
    if (autopilotChanged || patch.enabled !== undefined) scheduleAutoPilot(guild, 0);
    if (changed.length) {
        logger.info(`[AvatarProtection] settings changed in ${guild.id} by ${by}: ${changed.join(', ')}`);
        void logFeatureEvent(() => (guild), 'join-gate.avatarSettings', () => ({
            title: '⚙️ Avatar Protection Settings Changed',
            fields: [['Changed', changed.join(', '), false], ['By', userLabel(by)]],
        }));
    }
    return next;
}

// ── protected images and scam avatars (blocked_images) ───────────────────────

const entryCache = new Map();   // guildId -> { at, protected, scam, protectedUsers }

export function invalidate(guildId) {
    if (guildId) entryCache.delete(guildId);
    else entryCache.clear();
}

const parseList = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

/** Active protected images and scam avatars for a guild. Never throws. */
export async function loadEntries(guild) {
    const guildId = guild.id ?? guild;
    const hit = entryCache.get(guildId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit;
    let rows = [];
    try {
        [rows] = await pool.execute(
            `SELECT id, guild_id, kind, label, avatar_fp, exact_sha, protected_user_id, suppress
               FROM blocked_images
              WHERE guild_id IN ('0', ?) AND kind IN ('avatar', 'scam_avatar') AND removed_at IS NULL
              ORDER BY id`, [guildId]);
    } catch (err) {
        logger.warn(`[AvatarProtection] could not load protected images for ${guildId}: ${err.message}`);
        return { at: Date.now(), protected: [], scam: [], protectedUsers: new Set() };
    }
    const protectedRows = rows.filter(r => r.kind === 'avatar').map(r => ({
        id: r.id, label: r.label, protectedUserId: r.protected_user_id || null,
        variants: fpFromString(r.avatar_fp), suppressed: fpFromString(parseList(r.suppress).join(',')),
    })).filter(e => e.variants.length);
    const entry = {
        at: Date.now(),
        protected: protectedRows,
        scam: rows.filter(r => r.kind === 'scam_avatar' && r.exact_sha).map(r => ({ id: r.id, sha: r.exact_sha, label: r.label })),
        protectedUsers: new Set(protectedRows.map(e => e.protectedUserId).filter(Boolean)),
    };
    entryCache.set(guildId, entry);
    if (typeof guild === 'object' && Date.now() - (autoSyncedAt.get(guildId) || 0) > AUTOPILOT_REFRESH_MS) {
        getSettings(guildId).then(s => {
            if (s.enabled && s.autopilot.enabled && s.autopilot.avatars) scheduleAutoPilot(guild);
        }).catch(() => {});
    }
    return entry;
}

// ── downloading and fingerprinting avatars ───────────────────────────────────

const fpCache = new Map();   // url -> described fingerprint (insertion-ordered: oldest evicted first)
let active = 0;
const waiting = [];

async function slot() {
    if (active < DOWNLOADS_AT_ONCE) { active++; return; }
    await new Promise(resolve => waiting.push(resolve));
    active++;
}
function release() {
    active--;
    const next = waiting.shift();
    if (next) next();
}

/** Live checks (a join, an avatar change) pass `priority` and skip the queue a background scan builds up. */
async function download(url, { priority = false } = {}) {
    if (priority) active++;
    else await slot();
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        return buf.length && buf.length <= MAX_BYTES ? buf : null;
    } finally {
        release();
    }
}

/** The bytes of an avatar through the same rate-limited fetch (core/nsfw-protection.js). null when unreadable. */
export async function downloadAvatar(url, { priority = false } = {}) {
    return download(url, { priority });
}

/** Fingerprint plus what the rules need from it. */
export async function describeImage(buffer) {
    const fp = await avatarFingerprint(buffer);
    return {
        variants: fp.variants,
        usable: usableFingerprint(fp),
        bits: fp.bits,
        contrast: fp.contrast,
        sha: canonicalHash(fp.canonical),
        flat: flatKind(fp.canonical),
        thumb: fp.thumb,
        legacy: fp.legacy,
        v0: variantToString(fp.variants[0]),
    };
}

/** A described fingerprint for an avatar URL, downloaded once per URL. null when it cannot be read. */
export async function fingerprintUrl(url, { priority = false } = {}) {
    if (fpCache.has(url)) return fpCache.get(url);
    let out = null;
    try {
        const buf = await download(url, { priority });
        if (buf) out = await describeImage(buf);
    } catch (err) {
        logger.debug(`[AvatarProtection] could not read ${url}: ${err.message}`);
    }
    if (out) {
        fpCache.set(url, out);
        if (fpCache.size > FP_CACHE_MAX) fpCache.delete(fpCache.keys().next().value);
    }
    return out;
}

export function targetsOf(member, size = 128) {
    return avatarTargets({
        userId: member.id, guildId: member.guild.id, userAvatar: member.user?.avatar ?? null, guildAvatar: member.avatar ?? null,
    }, size);
}

// ── matching ─────────────────────────────────────────────────────────────────

/**
 * The strongest finding for a member's avatars: an exact scam avatar first, else the best protected
 * image at or above the review threshold. null = nothing.
 */
async function evaluate(member, settings, entries, { targets = null, priority = false } = {}) {
    let best = null;
    for (const t of targets ?? targetsOf(member)) {
        const fp = await fingerprintUrl(t.url, { priority });
        if (!fp) continue;
        if (settings.scam.enabled) {
            const s = exactScamMatch(fp.sha, entries.scam);
            if (s) return { kind: 'scam', builtinKey: s.key ?? null, imageId: s.id ?? null, label: s.label, score: 1, decision: 'auto', key: t.key, scope: t.scope, url: t.url, fp };
        }
        if (!fp.usable || !entries.protected.length) continue;
        const m = bestMatch(fp.variants, entries.protected, { review: settings.reviewThreshold, memberId: member.id });
        if (m && (!best || m.score > best.score)) {
            best = {
                kind: 'image', imageId: m.entry.id, label: m.entry.label, score: m.score, variant: m.variant,
                decision: decide(m.score, { auto: settings.autoThreshold, review: settings.reviewThreshold }),
                key: t.key, scope: t.scope, url: t.url, fp,
            };
        }
    }
    return best;
}

const matchText = (m) => (m.kind === 'scam'
    ? `known scam avatar: ${m.label}`
    : `${scoreText(m.score)} like protected image #${m.imageId}${m.label ? ` (${m.label})` : ''}${m.variant ? `, ${VARIANT_LABELS[m.variant]}` : ''}`);

async function bumpHit(imageId) {
    if (!imageId) return;
    await pool.execute('UPDATE blocked_images SET hits = hits + 1, last_hit_at = NOW() WHERE id = ?', [imageId]).catch(() => {});
}

async function recordEvent(guildId, user, action, detail) {
    await pool.execute(
        `INSERT INTO join_gate_events (guild_id, user_id, username, action, account_age_hours, dm_delivered, detail, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, NOW())`,
        [guildId, user.id, user.username?.slice(0, 100) ?? null, action, 0, detail?.slice(0, 255) ?? null],
    ).catch(err => logger.error(`[AvatarProtection] could not record ${action} for ${user.id}: ${err.message}`));
}

async function safeKeyOf(guildId, userId) {
    const [[row]] = await pool.execute(
        "SELECT names_hash FROM name_filter_reviews WHERE guild_id = ? AND user_id = ? AND kind = 'avatar' AND status = 'safe'",
        [guildId, userId]).catch(() => [[null]]);
    return row?.names_hash ?? null;
}

async function queueReview(guildId, member, match) {
    await pool.execute(
        `INSERT INTO name_filter_reviews (guild_id, user_id, kind, username, display_name, nickname, filter_id, filter_label, field,
                names_hash, status, detail, found_at, decided_by, decided_at, image_id, score, avatar_url, avatar_fp, avatar_sha, avatar_thumb)
         VALUES (?, ?, 'avatar', ?, ?, ?, NULL, ?, ?, ?, 'pending', ?, NOW(), NULL, NULL, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE username = VALUES(username), display_name = VALUES(display_name), nickname = VALUES(nickname),
           filter_label = VALUES(filter_label), field = VALUES(field), names_hash = VALUES(names_hash), status = 'pending',
           detail = VALUES(detail), found_at = NOW(), decided_by = NULL, decided_at = NULL, image_id = VALUES(image_id),
           score = VALUES(score), avatar_url = VALUES(avatar_url), avatar_fp = VALUES(avatar_fp), avatar_sha = VALUES(avatar_sha),
           avatar_thumb = VALUES(avatar_thumb)`,
        [guildId, member.id, member.user.username?.slice(0, 100) ?? null, member.user.globalName?.slice(0, 100) ?? null,
            member.nickname?.slice(0, 100) ?? null, String(match.label ?? '').slice(0, 200) || null, match.scope,
            avatarKeyHash(match.key), match.kind === 'scam' ? 'scam avatar' : null, match.imageId ?? null,
            Number(match.score.toFixed(4)), match.url.slice(0, 300), match.fp.v0, match.fp.sha, match.fp.thumb]);
}

// ── acting ───────────────────────────────────────────────────────────────────

/** The flag role (made and saved the first time), for core/nsfw-protection.js's flag action. */
export async function ensureFlagRole(guild) {
    return flagRole(guild, await getSettings(guild.id));
}

async function flagRole(guild, settings) {
    const existing = settings.flagRoleId ? guild.roles.cache.get(settings.flagRoleId) : null;
    if (existing) return existing;
    const byName = guild.roles.cache.find(r => r.name === FLAG_ROLE_NAME && !r.managed);
    const role = byName || await guild.roles.create({
        name: FLAG_ROLE_NAME, color: 0xE67E22, permissions: [], mentionable: false,
        reason: 'Avatar protection: role for members whose avatars matched a protected image',
    });
    const { setConfig } = await gate();
    await setConfig(guild.id, { avatar_flag_role_id: role.id });
    return role;
}

function actionable(member, action, role) {
    if (action === 'ban') return member.bannable;
    if (action === 'kick') return member.kickable;
    if (action === 'timeout') return member.moderatable;
    if (action === 'flag') return !role || role.editable;
    return true;
}

function alreadyDone(member, action, settings) {
    if (action === 'flag') return !!settings.flagRoleId && member.roles.cache.has(settings.flagRoleId);
    if (action === 'timeout') return (member.communicationDisabledUntilTimestamp ?? 0) > Date.now();
    return false;
}

function avatarDM(guild, action, settings) {
    const title = { ban: `You were banned from ${guild.name}`, kick: `You were removed from ${guild.name}`,
        timeout: `You were timed out in ${guild.name}` }[action];
    const next = action === 'timeout'
        ? `Change your avatar and the timeout can be lifted by the server's staff; it ends by itself in ${settings.timeoutMinutes} minute(s).`
        : action === 'kick' ? 'Change your avatar and you are welcome to join again.'
            : "If this is a mistake, contact the server's staff.";
    return {
        embeds: [new EmbedBuilder().setColor(0xC0392B).setTitle(title)
            .setDescription('This is automatic.\n\n**Why:** your profile picture matches one this server protects (a staff '
                + 'member\'s avatar, the server icon, or a picture used by scam accounts).\n\n'
                + `**What now:** ${next}`)],
    };
}

async function punish(member, action, settings, reason) {
    try {
        if (action === 'ban') await member.ban({ reason, deleteMessageSeconds: 3600 });
        else if (action === 'kick') await member.kick(reason);
        else if (action === 'timeout') await member.timeout(settings.timeoutMinutes * 60_000, reason);
        else if (action === 'flag') await member.roles.add(await flagRole(member.guild, settings), reason);
        return { ok: true };
    } catch (err) {
        return { ok: false, problem: err.message, err };
    }
}

function fieldsFor(member, match, trigger) {
    return [['Member', userLabel(member)], ['Matched', matchText(match), false],
        ['Avatar', match.scope === 'server' ? 'Server avatar' : 'Avatar'], ['When', TRIGGER_LABEL[trigger] ?? trigger]];
}

/**
 * Act on one member's match with `action`. Returns 'removed' (kicked / banned), 'acted' (flag / timeout),
 * 'held', 'skipped' or 'failed'.
 */
async function enforce(member, match, action, settings, { source = 'auto', trigger = 'join', actorId = null } = {}) {
    const guild = member.guild;
    const fields = fieldsFor(member, match, trigger);
    if (alreadyDone(member, action, settings)) return 'skipped';
    if (await protectionHold(member, action, 'Avatar protection')) return 'held';

    const role = action === 'flag' && settings.flagRoleId ? guild.roles.cache.get(settings.flagRoleId) : null;
    const cannot = whyCannot(guild, action, { member, role });
    if (cannot) {
        await recordEvent(guild.id, member.user, 'failed', `avatar protection: ${cannot.text.replace(/\*\*/g, '')}`);
        await reportManualAction(guild, { action, member, source: 'Avatar protection', problem: cannot });
        return 'failed';
    }

    let delivered = false;
    if (settings.dm && action !== 'flag') {
        try { await member.send(avatarDM(guild, action, settings)); delivered = true; } catch { delivered = false; }
    }
    const result = await punish(member, action, settings, avatarReason(match, source));
    if (!result.ok) {
        await recordEvent(guild.id, member.user, 'failed', `avatar protection: ${result.problem}`);
        logger.error(`[AvatarProtection] ${action} failed for ${member.user.tag} in ${guild.id}: ${result.problem}`);
        const cause = whyFailed(result.err, guild, action, { member, role });
        if (cause) await reportManualAction(guild, { action, member, source: 'Avatar protection', problem: cause });
        else {
            void logFeatureEvent(() => (guild), 'join-gate.failed', () => ({
                title: '⚠️ Avatar Protection Could Not Act',
                fields: [...fields, ['Tried to', action], ['Problem', result.problem, false]],
                thumbnail: match.url,
            }));
        }
        return 'failed';
    }
    await recordEvent(guild.id, member.user, avatarEventAction(action), matchText(match));
    logger.info(`[AvatarProtection] ${DONE[action]} ${member.user.tag} in ${guild.id}: ${matchText(match)}`);
    void logFeatureEvent(() => (guild), 'join-gate.avatarFilter', () => ({
        title: { ban: '🔨 Banned — Avatar Protection', kick: '🚪 Removed — Avatar Protection',
            timeout: '⏱️ Timed Out — Avatar Protection', flag: '🚩 Flagged — Avatar Protection' }[action],
        fields: [...fields,
            ['They were told', settings.dm && action !== 'flag' ? (delivered ? 'Yes — by DM' : 'No — their DMs are closed') : null],
            ['By', actorId ? userLabel(actorId) : null]],
        thumbnail: match.url,
    }));
    return action === 'ban' || action === 'kick' ? 'removed' : 'acted';
}

/**
 * What a match leads to: the act threshold (or an exact scam avatar) carries out the configured action;
 * log-only and the review band go to the review queue with a log entry.
 */
async function handleMatch(member, match, settings, { trigger = 'join', source = 'auto', actorId = null } = {}) {
    const guild = member.guild;
    const action = match.kind === 'scam' ? settings.scam.action : match.decision === 'auto' ? settings.action : null;
    void bumpHit(match.imageId);
    if (action && action !== 'log') {
        const outcome = await enforce(member, match, action, settings, { source, trigger, actorId });
        if (outcome === 'failed') await queueReview(guild.id, member, match).catch(() => {});
        return outcome;
    }
    // Allowlisted / manager members are not queued either (protectionHold would hold any action on them).
    if ((await isExempt(member)).exempt) return 'held';
    await queueReview(guild.id, member, match);
    const review = action === null;
    await recordEvent(guild.id, member.user, review ? 'avatar_queued' : 'avatar_logged', matchText(match));
    logger.info(`[AvatarProtection] ${member.user.tag} in ${guild.id} ${review ? 'queued for review' : 'matched (log only)'}: ${matchText(match)}`);
    const fields = [...fieldsFor(member, match, trigger), ['Decide', 'Dashboard: Avatar Protection review queue, or `/avatarfilter decide`', false]];
    if (review) {
        void logFeatureEvent(() => (guild), 'join-gate.avatarReview', () => ({
            title: '🔎 Avatar Looks Like a Protected Image',
            description: 'Close to a protected image but below the act threshold, so it is waiting in the review queue.',
            fields, thumbnail: match.url,
        }));
        // AI second opinion (core/ai-judge.js), in the background: a join is never held up by it.
        if (match.kind === 'image') void aiAvatarStep(member, match, settings, trigger);
    } else {
        void logFeatureEvent(() => (guild), 'join-gate.avatarObserved', () => ({
            title: '👀 Avatar Protection Match (Log Only)',
            description: 'This matched, but the action is log only, so nothing was done. It is in the review queue.',
            fields, thumbnail: match.url,
        }));
    }
    return review ? 'queued' : 'logged';
}

/**
 * The AI second opinion on a review-band match (between the review and act thresholds). advise: the verdict
 * goes on the review row and the log. act: the server's action when the AI agrees at or above the configured
 * confidence and the row is still waiting. No verdict (off, capped, error) changes nothing. Never throws.
 */
async function aiAvatarStep(member, match, settings, trigger) {
    try {
        const guild = member.guild;
        const ai = await aiJudge.getSettings(guild.id);
        if (ai.avatar.mode === 'off' || !aiJudge.isConfigured() || !match.fp?.thumb || !match.imageId) return;
        const [[img]] = await pool.execute("SELECT thumb FROM blocked_images WHERE id = ? AND kind = 'avatar'", [match.imageId]);
        if (!img?.thumb) return;
        const r = await aiJudge.judgeAvatar(guild.id, { memberImage: match.fp.thumb, protectedImage: img.thumb, cacheKey: `${match.fp.sha}:${match.imageId}` });
        if (!r.verdict) return;
        await aiJudge.saveReviewVerdict(guild.id, member.id, 'avatar', 'avatar', r.verdict);
        const decision = aiJudge.decide({ mode: ai.avatar.mode, verdict: r.verdict, confidence: ai.avatar.confidence, eligible: match.score >= settings.reviewThreshold });
        const action = settings.action;
        const acting = decision === 'act' && action && action !== 'log';
        aiJudge.logVerdict(guild, 'avatar', { member, verdict: r.verdict, outcome: acting ? 'act' : 'advise', detail: matchText(match) });
        if (!acting) return;
        const [[row]] = await pool.execute(
            "SELECT status FROM name_filter_reviews WHERE guild_id = ? AND user_id = ? AND kind = 'avatar'", [guild.id, member.id]);
        if (row?.status !== 'pending') return;   // staff already decided
        const fresh = await guild.members.fetch(member.id).catch(() => null);
        if (!fresh) return;
        const outcome = await enforce(fresh, match, action, settings, { source: 'ai', trigger });
        if (outcome === 'removed' || outcome === 'acted') {
            await pool.execute(
                `UPDATE name_filter_reviews SET status = ?, action_taken = ?, decided_by = ?, decided_at = NOW()
                  WHERE guild_id = ? AND user_id = ? AND kind = 'avatar' AND status = 'pending'`,
                [action === 'ban' ? 'banned' : action === 'kick' ? 'kicked' : 'actioned', action, guild.client.user?.id ?? null, guild.id, member.id]);
        }
    } catch (err) {
        logger.warn(`[AvatarProtection] AI second opinion failed for ${member?.id} in ${member?.guild?.id}: ${err.message}`);
    }
}

/** Ask the AI about one queued row (the dashboard's "Ask AI" button). Advice only; never acts. */
export async function askAiAboutReview(guild, userId) {
    if (!aiJudge.isConfigured()) return { ok: false, error: 'No AI key is configured for this bot.' };
    const [[row]] = await pool.execute(
        "SELECT image_id, avatar_thumb, avatar_sha FROM name_filter_reviews WHERE guild_id = ? AND user_id = ? AND kind = 'avatar'", [guild.id, String(userId)]);
    if (!row?.avatar_thumb || !row.image_id) return { ok: false, error: 'That entry has no picture to compare (a scam-avatar match, or an older entry).' };
    const [[img]] = await pool.execute("SELECT thumb FROM blocked_images WHERE id = ? AND kind = 'avatar'", [row.image_id]);
    if (!img?.thumb) return { ok: false, error: 'The protected image it matched has no stored picture (imported fingerprints carry none).' };
    const r = await aiJudge.judgeAvatar(guild.id, { memberImage: row.avatar_thumb, protectedImage: img.thumb, cacheKey: `${row.avatar_sha}:${row.image_id}` });
    if (!r.verdict) return { ok: false, error: { capped: "Today's AI cap is used up.", rate_limited: 'Too many AI checks this minute; try again shortly.' }[r.status] || 'The AI gave no usable answer.' };
    await aiJudge.saveReviewVerdict(guild.id, String(userId), 'avatar', 'avatar', r.verdict);
    return { ok: true, verdict: r.verdict, line: aiJudge.verdictLine('avatar', r.verdict) };
}

async function unflag(member, settings) {
    if (!settings.flagRoleId || !member.roles.cache.has(settings.flagRoleId)) return;
    const role = member.guild.roles.cache.get(settings.flagRoleId);
    if (!role?.editable) return;
    await member.roles.remove(role, 'Avatar protection: their avatar no longer matches').catch(() => {});
    logger.info(`[AvatarProtection] took the flag role off ${member.user.tag} in ${member.guild.id}: avatar no longer matches`);
}

/**
 * The live check, for a join or an avatar change. Returns 'avatar_removed' when the member was kicked
 * or banned, otherwise null. Never throws.
 */
export async function checkMember(member, trigger, cfg = null) {
    try {
        if (!member?.guild || member.user?.bot) return null;
        const settings = cfg ? settingsFrom(cfg) : await getSettings(member.guild.id);
        // NSFW avatars run on a model, so off this path's clock: a kick or ban from it lands a moment later.
        if (settings.nsfw.enabled) {
            void nsfw().then(m => m.checkAvatar(member, trigger, { settings: settings.nsfw }))
                .catch(err => logger.warn(`[AvatarProtection] NSFW check failed for ${member.id}: ${err.message}`));
        }
        if (!settings.enabled) return null;
        const entries = await loadEntries(member.guild);
        if (!entries.protected.length && !settings.scam.enabled) return null;
        if (entries.protectedUsers.has(member.id)) return null;
        const match = await evaluate(member, settings, entries, { priority: true });
        if (!match) {
            if (trigger !== 'join') await unflag(member, settings);
            return null;
        }
        if (isStaff(member)) return null;
        const safe = await safeKeyOf(member.guild.id, member.id);
        if (safe && safe === avatarKeyHash(match.key)) return null;
        const outcome = await handleMatch(member, match, settings, { trigger });
        return outcome === 'removed' ? 'avatar_removed' : null;
    } catch (err) {
        logger.error(`[AvatarProtection] check failed for ${member?.id} in ${member?.guild?.id}: ${err.message}`);
        return null;
    }
}

/** Called by checkJoin. */
export async function checkAvatarOnJoin(member, cfg) {
    return checkMember(member, 'join', cfg);
}

async function relevantToAutoPilot(member, settings, before = null) {
    if (!(settings.enabled && settings.autopilot.enabled && settings.autopilot.avatars)) return false;
    const entries = entryCache.get(member.guild.id);
    if (entries?.protectedUsers?.has(member.id)) return true;
    const state = await protectionState(member.guild.id);
    if (nf.autoPilotCovers(member, settings.autopilot, state)) return true;
    return !!before && nf.autoPilotCovers(before, settings.autopilot, state);
}

/** events/guildMemberUpdate.js: server-avatar changes, and staff changes Auto-Pilot follows. Never throws. */
export async function onMemberUpdate(oldMember, newMember) {
    try {
        if (newMember.user?.bot) return;
        const avatarChanged = !oldMember.partial && oldMember.avatar !== newMember.avatar;
        const rolesChanged = oldMember.roles?.cache && !oldMember.roles.cache.equals?.(newMember.roles.cache);
        if (!avatarChanged && !rolesChanged) return;
        const { getConfig } = await gate();
        const cfg = await getConfig(newMember.guild.id);
        if (!cfg || !(Number(cfg.avatar_enabled) || Number(cfg.nsfw_avatar_enabled))) return;
        const settings = settingsFrom(cfg);
        if (avatarChanged) await checkMember(newMember, 'server_avatar', cfg);
        if (await relevantToAutoPilot(newMember, settings, rolesChanged ? oldMember : null)) scheduleAutoPilot(newMember.guild);
    } catch (err) {
        logger.warn(`[AvatarProtection] member update handling failed: ${err.message}`);
    }
}

/** events/userUpdate.js: global-avatar changes, checked in every server this bot serves. Never throws. */
export async function onUserUpdate(oldUser, newUser) {
    try {
        if (newUser.bot || oldUser.avatar === newUser.avatar) return;
        const { getConfig } = await gate();
        for (const guild of newUser.client.guilds.cache.values()) {
            const cfg = await getConfig(guild.id);
            if (!cfg || !(Number(cfg.avatar_enabled) || Number(cfg.nsfw_avatar_enabled))) continue;
            if (!(await nf.servesGuild(newUser.client, guild.id))) continue;
            const member = guild.members.cache.get(newUser.id) || await guild.members.fetch(newUser.id).catch(() => null);
            if (!member) continue;
            await checkMember(member, 'global_avatar', cfg);
            if (await relevantToAutoPilot(member, settingsFrom(cfg))) scheduleAutoPilot(guild);
        }
    } catch (err) {
        logger.warn(`[AvatarProtection] user update handling failed: ${err.message}`);
    }
}

// ── protected images: add / remove / list ────────────────────────────────────

const hex16 = (dhash) => dhash.toString(16).padStart(16, '0');
const sigHex = (sig) => Buffer.from(sig).toString('hex');

async function activeCount(guildId) {
    const [[row]] = await pool.execute(
        "SELECT COUNT(*) AS n FROM blocked_images WHERE guild_id = ? AND kind = 'avatar' AND removed_at IS NULL", [guildId]);
    return Number(row?.n ?? 0);
}

/**
 * Store one described image. kind 'avatar' (protected, needs a usable fingerprint) or 'scam_avatar'
 * (exact). @returns {{ ok:true, id, existing?:boolean } | { ok:false, error }}
 */
async function insertImage(guildId, img, { kind = 'avatar', label = null, sourceType, protectedUserId = null, avatarKey = null, sourceUrl = null, by = null }) {
    if (kind === 'avatar' && !img.usable) {
        return { ok: false, error: `too plain to compare safely (${img.flat ? `${img.flat} image` : `${img.bits}/256 bits of detail, contrast ${img.contrast.toFixed(1)}`}); it would match unrelated avatars` };
    }
    if (kind === 'scam_avatar' && BUILTIN_SCAM_AVATARS.some(b => b.sha === img.sha)) {
        return { ok: false, error: 'that is already a built-in scam avatar' };
    }
    try {
        const [r] = await pool.execute(
            `INSERT INTO blocked_images (guild_id, kind, dhash, bits_set, colour_sig, exact_sha, avatar_fp, label, added_by, source_url,
                    source_type, protected_user_id, avatar_key, thumb)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [guildId, kind, hex16(img.legacy.dhash), img.legacy.bitsSet, sigHex(img.legacy.colourSig), img.sha,
                kind === 'avatar' ? fpToString(img.variants) : null, label ? String(label).slice(0, 200) : null, by ? String(by).slice(0, 20) : null,
                sourceUrl ? String(sourceUrl).slice(0, 500) : null, sourceType, protectedUserId, avatarKey ? String(avatarKey).slice(0, 100) : null, img.thumb]);
        invalidate(guildId);
        return { ok: true, id: r.insertId };
    } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY') throw err;
        const [[row]] = await pool.execute(
            'SELECT id, removed_at FROM blocked_images WHERE guild_id = ? AND kind = ? AND dhash = ? AND exact_sha = ?',
            [guildId, kind, hex16(img.legacy.dhash), img.sha]);
        if (row?.removed_at && sourceType !== 'autopilot') {
            await pool.execute('UPDATE blocked_images SET removed_at = NULL WHERE id = ?', [row.id]);
            invalidate(guildId);
        }
        return { ok: true, id: row?.id ?? null, existing: true };
    }
}

async function describeUrl(url) {
    const buf = await download(url).catch(() => null);
    if (!buf) return { error: 'could not download the image' };
    try { return { img: await describeImage(buf) }; } catch (err) { return { error: `could not read that as an image (${err.message})` }; }
}

/**
 * Add protected images.
 * spec: { source: 'member', userId, scope } | { source: 'role', roleId, scope } | { source: 'server_icon' }
 *     | { source: 'upload', buffer, label } | { source: 'url', url, label }
 * Starts a background review scan when anything new was added.
 * @returns {Promise<{ ok:boolean, error?:string, added:Array<{id,label}>, existing:number, skipped:Array<{label,why}> }>}
 */
export async function addProtected(guild, spec, by = null) {
    const out = { ok: true, added: [], existing: 0, skipped: [] };
    const items = [];   // { label, url?, buffer?, protectedUserId?, avatarKey?, sourceType }
    if (spec.source === 'member') {
        const member = await guild.members.fetch(String(spec.userId)).catch(() => null);
        if (!member) return { ...out, ok: false, error: 'They are not in this server.' };
        const targets = pickScopes(targetsOf(member, 256), spec.scope || 'both');
        if (!targets.length) return { ...out, ok: false, error: 'They use the default avatar (or not the one you picked), so there is nothing to protect.' };
        for (const t of targets) items.push({ label: `${member.displayName} (${t.scope === 'server' ? 'server avatar' : 'avatar'})`, url: t.url, protectedUserId: member.id, avatarKey: t.key, sourceType: 'member' });
    } else if (spec.source === 'role') {
        const role = guild.roles.cache.get(String(spec.roleId));
        if (!role) return { ...out, ok: false, error: 'That role is not in this server.' };
        await nf.allMembers(guild);
        const members = [...role.members.values()].filter(m => !m.user.bot);
        if (!members.length) return { ...out, ok: false, error: 'Nobody (other than bots) has that role.' };
        if (members.length > ROLE_ADD_CAP) out.skipped.push({ label: `@${role.name}`, why: `only the first ${ROLE_ADD_CAP} of ${members.length} members are added` });
        for (const m of members.slice(0, ROLE_ADD_CAP)) {
            const targets = pickScopes(targetsOf(m, 256), spec.scope || 'both');
            if (!targets.length) { out.skipped.push({ label: m.displayName, why: 'default avatar' }); continue; }
            for (const t of targets) items.push({ label: `${m.displayName} (@${role.name})`, url: t.url, protectedUserId: m.id, avatarKey: t.key, sourceType: 'role' });
        }
    } else if (spec.source === 'server_icon') {
        const url = serverIconUrl(guild.id, guild.icon, 256);
        if (!url) return { ...out, ok: false, error: 'This server has no icon.' };
        items.push({ label: 'Server icon', url, avatarKey: `icon:${guild.icon}`, sourceType: 'server_icon' });
    } else if (spec.source === 'upload' && spec.buffer) {
        items.push({ label: spec.label || 'Uploaded image', buffer: spec.buffer, sourceType: 'upload' });
    } else if (spec.source === 'url' && spec.url) {
        items.push({ label: spec.label || 'Uploaded image', url: spec.url, sourceType: 'upload', sourceUrl: spec.url });
    } else {
        return { ...out, ok: false, error: 'Pick a member, a role, the server icon or an image.' };
    }

    let room = MAX_PROTECTED - await activeCount(guild.id);
    for (const it of items) {
        if (room <= 0) { out.skipped.push({ label: it.label, why: `this server already protects ${MAX_PROTECTED} images` }); continue; }
        let img;
        if (it.buffer) {
            try { img = await describeImage(it.buffer); } catch (err) { out.skipped.push({ label: it.label, why: `could not read that as an image (${err.message})` }); continue; }
        } else {
            const d = await describeUrl(it.url);
            if (d.error) { out.skipped.push({ label: it.label, why: d.error }); continue; }
            img = d.img;
        }
        const saved = await insertImage(guild.id, img, {
            kind: 'avatar', label: spec.label && spec.source !== 'role' ? spec.label : it.label, sourceType: it.sourceType,
            protectedUserId: it.protectedUserId ?? null, avatarKey: it.avatarKey ?? null, sourceUrl: it.sourceUrl ?? null, by,
        });
        if (!saved.ok) { out.skipped.push({ label: it.label, why: saved.error }); continue; }
        if (saved.existing) { out.existing++; continue; }
        out.added.push({ id: saved.id, label: it.label });
        room--;
    }
    if (out.added.length) {
        logger.info(`[AvatarProtection] ${out.added.length} protected image(s) added in ${guild.id} by ${by} (${spec.source})`);
        void logFeatureEvent(() => (guild), 'join-gate.avatarSettings', () => ({
            title: '➕ Protected Image Added',
            fields: [['Images', out.added.slice(0, 10).map(a => `#${a.id} ${a.label}`).join('\n') + (out.added.length > 10 ? `\n…${out.added.length - 10} more` : ''), false],
                ['By', userLabel(by)]],
        }));
        scanAfterChange(guild, by, 'new protected image');
    }
    if (!out.added.length && !out.existing) {
        out.ok = false;
        out.error = out.skipped[0]?.why ? `Nothing added: ${out.skipped[0].why}.` : 'Nothing added.';
    }
    return out;
}

/** Add an exact scam avatar for this server (an upload or an attachment URL). */
export async function addScamAvatar(guild, { buffer = null, url = null, label = null }, by = null) {
    let img;
    if (buffer) {
        try { img = await describeImage(buffer); } catch (err) { return { ok: false, error: `Could not read that as an image (${err.message}).` }; }
    } else {
        const d = await describeUrl(url);
        if (d.error) return { ok: false, error: `Could not use that image: ${d.error}.` };
        img = d.img;
    }
    const saved = await insertImage(guild.id, img, { kind: 'scam_avatar', label: label || 'Scam avatar (added by staff)', sourceType: 'upload', sourceUrl: url, by });
    if (!saved.ok) return { ok: false, error: `Not added: ${saved.error}.` };
    if (!saved.existing) {
        void logFeatureEvent(() => (guild), 'join-gate.avatarSettings', () => ({
            title: '➕ Scam Avatar Added', fields: [['Entry', `#${saved.id} ${label || 'Scam avatar'}`], ['By', userLabel(by)]],
        }));
        scanAfterChange(guild, by, 'new scam avatar');
    }
    return { ok: true, id: saved.id, existing: !!saved.existing };
}

// ── export / import (fingerprints only) ──────────────────────────────────────

/** This server's protected images and scam avatars as a versioned JSON export, without any picture. */
export async function exportProtected(guild) {
    const [rows] = await pool.execute(
        `SELECT kind, label, dhash, bits_set, colour_sig, exact_sha, avatar_fp, removed_at FROM blocked_images
          WHERE guild_id = ? AND kind IN ('avatar', 'scam_avatar') AND removed_at IS NULL ORDER BY id`, [guild.id]);
    return buildAvatarExport(rows, { guildId: guild.id, guildName: guild.name });
}

/**
 * Preview (apply = false) or carry out an import of an avatar-protection export. Removed entries that come back
 * are restored; nothing is downloaded. A review scan of the members follows when anything was added.
 */
export async function importProtected(guild, input, { apply = false } = {}, by = null) {
    const [rows] = await pool.execute(
        "SELECT kind, dhash, exact_sha, removed_at FROM blocked_images WHERE guild_id = ? AND kind IN ('avatar', 'scam_avatar')", [guild.id]);
    const live = rows.filter(r => !r.removed_at);
    const room = Math.max(0, MAX_PROTECTED - await activeCount(guild.id));
    const plan = planAvatarImport(input, live, { room });
    if (!plan.ok || !apply) return plan;
    let added = 0;
    for (const e of plan.add) {
        try {
            await pool.execute(
                `INSERT INTO blocked_images (guild_id, kind, dhash, bits_set, colour_sig, exact_sha, avatar_fp, label, added_by, source_type)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'import')
                 ON DUPLICATE KEY UPDATE removed_at = NULL, label = COALESCE(label, VALUES(label))`,
                [guild.id, e.kind, e.dhash, e.bits, e.colour, e.sha, e.fingerprint, e.label, by ? String(by).slice(0, 20) : null]);
            added++;
        } catch (err) {
            plan.rejected.push({ kind: e.kind === 'scam_avatar' ? 'scam' : 'protected', label: e.label, why: `not stored (${err.code || err.message})` });
        }
    }
    invalidate(guild.id);
    logger.info(`[AvatarProtection] import in ${guild.id} by ${by}: ${added} added, ${plan.duplicates.length} duplicates, ${plan.rejected.length} rejected`);
    void logFeatureEvent(() => (guild), 'join-gate.avatarSettings', () => ({
        title: '📥 Avatar Protection List Imported',
        fields: [['Added', String(added)], ['Skipped (already there)', plan.duplicates.length ? String(plan.duplicates.length) : null],
            ['Rejected', plan.rejected.length ? String(plan.rejected.length) : null], ['Over the limit', plan.overCap.length ? String(plan.overCap.length) : null],
            ['By', userLabel(by)]],
    }));
    if (added) scanAfterChange(guild, by, 'imported protected images');
    return { ...plan, added };
}

async function ownedImage(guildId, id) {
    const [[row]] = await pool.execute(
        "SELECT * FROM blocked_images WHERE id = ? AND guild_id = ? AND kind IN ('avatar', 'scam_avatar')", [id, guildId]);
    return row || null;
}

/** Remove a protected image or one of this server's scam avatars. Auto-Pilot images are kept as removed. */
export async function removeImage(guild, id, by = null) {
    const row = await ownedImage(guild.id, id);
    if (!row) return false;
    if (row.source_type === 'autopilot') {
        await pool.execute('UPDATE blocked_images SET removed_at = NOW() WHERE id = ? AND guild_id = ?', [id, guild.id]);
    } else {
        await pool.execute('DELETE FROM blocked_images WHERE id = ? AND guild_id = ?', [id, guild.id]);
    }
    invalidate(guild.id);
    logger.info(`[AvatarProtection] image #${id} removed in ${guild.id} by ${by}`);
    void logFeatureEvent(() => (guild), 'join-gate.avatarSettings', () => ({
        title: row.kind === 'scam_avatar' ? '➖ Scam Avatar Removed' : '➖ Protected Image Removed',
        fields: [['Image', `#${id} ${row.label ?? ''}`, false], ['By', userLabel(by)]],
    }));
    return true;
}

export async function restoreImage(guild, id, by = null) {
    const [r] = await pool.execute(
        "UPDATE blocked_images SET removed_at = NULL WHERE id = ? AND guild_id = ? AND kind = 'avatar' AND removed_at IS NOT NULL", [id, guild.id]);
    invalidate(guild.id);
    if (r.affectedRows) {
        void logFeatureEvent(() => (guild), 'join-gate.avatarSettings', () => ({ title: '↩️ Protected Image Restored', fields: [['Image', `#${id}`], ['By', userLabel(by)]] }));
    }
    return r.affectedRows > 0;
}

/** Every protected image of a guild (removed ones too), for the list views. */
export async function listProtected(guildId) {
    const [rows] = await pool.execute(
        `SELECT id, label, source_type, protected_user_id, avatar_key, thumb, suppress, removed_at, hits, last_hit_at, added_by, created_at
           FROM blocked_images WHERE guild_id = ? AND kind = 'avatar' ORDER BY removed_at IS NOT NULL, id`, [guildId]);
    return rows.map(r => ({
        id: r.id, label: r.label, source: r.source_type, sourceLabel: SOURCE_LABEL[r.source_type] ?? r.source_type,
        protectedUserId: r.protected_user_id, avatarKey: r.avatar_key, thumb: r.thumb, notMatches: parseList(r.suppress).length,
        removed: !!r.removed_at, hits: Number(r.hits), lastHitAt: r.last_hit_at, addedBy: r.added_by, createdAt: r.created_at,
    }));
}

/** The built-in scam avatars plus the central ('0') and this server's exact entries. */
export async function listScam(guildId) {
    const [rows] = await pool.execute(
        `SELECT id, guild_id, label, source_type, thumb, hits, last_hit_at, created_at FROM blocked_images
          WHERE guild_id IN ('0', ?) AND kind = 'scam_avatar' AND removed_at IS NULL ORDER BY id`, [guildId]);
    return [
        ...BUILTIN_SCAM_AVATARS.map(b => ({ id: null, key: b.key, label: b.label, builtin: true, central: true })),
        ...rows.map(r => ({ id: r.id, label: r.label, builtin: false, central: r.guild_id === '0', source: r.source_type,
            sourceLabel: SOURCE_LABEL[r.source_type] ?? r.source_type, thumb: r.thumb, hits: Number(r.hits), lastHitAt: r.last_hit_at, createdAt: r.created_at })),
    ];
}

// ── test ─────────────────────────────────────────────────────────────────────

/**
 * Score a member's avatars (or an image) against every protected image and the scam list.
 * @returns {Promise<object>}
 */
export async function testAvatar(guild, { member = null, buffer = null }) {
    const settings = await getSettings(guild.id);
    const entries = await loadEntries(guild);
    const subjects = [];
    if (member) {
        for (const t of targetsOf(member)) subjects.push({ scope: t.scope, url: t.url, key: t.key, img: await fingerprintUrl(t.url) });
    } else if (buffer) {
        subjects.push({ scope: 'upload', url: null, key: null, img: await describeImage(buffer) });
    }
    const out = {
        settings: { enabled: settings.enabled, autoThreshold: settings.autoThreshold, reviewThreshold: settings.reviewThreshold, action: settings.action, scam: settings.scam },
        protectedCount: entries.protected.length,
        avatars: [],
        notes: [],
    };
    const labels = new Map((await listProtected(guild.id)).map(p => [p.id, p]));
    for (const s of subjects) {
        if (!s.img) { out.avatars.push({ scope: s.scope, url: s.url, error: 'Could not download this avatar.' }); continue; }
        const scam = exactScamMatch(s.img.sha, entries.scam);
        const scores = s.img.usable ? entries.protected
            .filter(e => !(member && e.protectedUserId === member.id))
            .map(e => ({ id: e.id, ...scoreAgainst(s.img.variants, e.variants) }))
            .sort((a, b) => b.score - a.score).slice(0, 8)
            .map(r => ({ id: r.id, score: r.score, variantLabel: VARIANT_LABELS[r.variant], label: labels.get(r.id)?.label ?? null,
                thumb: labels.get(r.id)?.thumb ?? null, decision: decide(r.score, { auto: settings.autoThreshold, review: settings.reviewThreshold }) })) : [];
        out.avatars.push({
            scope: s.scope, url: s.url, thumb: s.img.thumb, usable: s.img.usable, flat: s.img.flat, bits: s.img.bits,
            contrast: Number(s.img.contrast.toFixed(1)),
            scam: scam ? { label: scam.label, builtin: scam.builtin, enabled: settings.scam.enabled, action: settings.scam.action } : null,
            scores,
        });
    }
    if (member) {
        if (!subjects.length) out.notes.push('They use the default avatar; that is left to the join gate\'s default-avatar rule.');
        if (member.user.bot) out.notes.push('Bots are never checked.');
        if (isStaff(member)) out.notes.push('Staff (owner or a moderation permission) are never acted on.');
        if (entries.protectedUsers.has(member.id)) out.notes.push('Their own avatar is protected, so they are never matched.');
        const ex = await isExempt(member);
        if (ex.exempt) out.notes.push(`Exempt from automatic protections: ${ex.text}.`);
        const safe = await safeKeyOf(guild.id, member.id);
        if (safe) out.notes.push(subjects.some(s => s.key && avatarKeyHash(s.key) === safe) ? 'Marked "not a match" for this avatar.' : 'Was marked "not a match", but has changed avatar since.');
    }
    return out;
}

// ── cleanse ──────────────────────────────────────────────────────────────────

const jobs = new Map();   // guildId -> { running, mode, by, reason, startedAt, finishedAt, checked, total, downloads, result, error, again }

export function cleanseStatus(guildId) {
    const j = jobs.get(guildId);
    if (!j) return { running: false };
    const { again, ...rest } = j;
    return rest;
}

/**
 * Scan every member's avatars. mode 'review' queues every finding; 'force' acts at once on near-exact
 * and scam matches whose action is not log-only. Runs in the background; cleanseStatus() reports it.
 */
export function startCleanse(guild, { mode = 'review', reason = null } = {}, actorId = null) {
    const cur = jobs.get(guild.id);
    if (cur?.running) return { ok: false, error: 'An avatar scan is already running for this server.' };
    const job = { running: true, mode: mode === 'force' ? 'force' : 'review', by: actorId, reason, startedAt: Date.now(), checked: 0, total: null, downloads: 0 };
    jobs.set(guild.id, job);
    runCleanse(guild, job).catch(err => {
        job.error = err.message;
        logger.error(`[AvatarProtection] cleanse failed in ${guild.id}: ${err.message}`);
    }).finally(() => {
        job.running = false;
        job.finishedAt = Date.now();
        if (job.again) setTimeout(() => startCleanse(guild, { mode: 'review', reason: 'images changed during the last scan' }, actorId), 5000);
    });
    return { ok: true };
}

/** Adding an image re-checks everyone in the background (review mode); a running scan runs again after. */
function scanAfterChange(guild, by, reason) {
    const cur = jobs.get(guild.id);
    if (cur?.running) { cur.again = true; return; }
    startCleanse(guild, { mode: 'review', reason }, by);
}

async function runCleanse(guild, job) {
    const settings = await getSettings(guild.id);
    invalidate(guild.id);
    const entries = await loadEntries(guild);
    if (!entries.protected.length && !settings.scam.enabled) throw new Error('This server has no protected images, and the scam-avatar check is off.');
    const { members, complete } = await nf.allMembers(guild);
    job.total = members.length;
    const [safeRows] = await pool.execute(
        "SELECT user_id, names_hash FROM name_filter_reviews WHERE guild_id = ? AND kind = 'avatar' AND status = 'safe'", [guild.id]);
    const safe = new Map(safeRows.map(r => [r.user_id, r.names_hash]));
    const humans = members.filter(m => !m.user.bot);
    job.downloads = planAvatarDownloads(humans.map(m => targetsOf(m)), new Set(fpCache.keys())).jobs.length;

    const candidates = members.filter(m => m.user.bot).map(m => ({ id: m.id, bot: true }));
    let next = 0;
    const worker = async () => {
        while (next < humans.length) {
            const m = humans[next++];
            let match = null;
            try {
                if (!entries.protectedUsers.has(m.id)) match = await evaluate(m, settings, entries);
            } catch (err) {
                logger.debug(`[AvatarProtection] cleanse could not check ${m.id}: ${err.message}`);
            }
            candidates.push({
                id: m.id, member: m, match, owner: guild.ownerId === m.id, staff: match ? isStaff(m) : false,
                protectedSelf: entries.protectedUsers.has(m.id), exempt: match ? (await isExempt(m)).exempt : false,
                safeHash: safe.get(m.id) ?? null,
            });
            job.checked++;
        }
    };
    await Promise.all(Array.from({ length: DOWNLOADS_AT_ONCE }, worker));
    job.checked = members.length;

    const plan = planAvatarCleanse(candidates);
    const { act, review } = job.mode === 'force'
        ? splitAvatarForce(plan.queue, { action: settings.action, scamAction: settings.scam.action })
        : { act: [], review: plan.queue };
    for (const c of review) await queueReview(guild.id, c.member, c.match).catch(err => logger.warn(`[AvatarProtection] could not queue ${c.id}: ${err.message}`));

    // Pending rows for members who no longer match (changed avatar, or left) are closed — only after a full list.
    let closed = 0;
    if (complete) {
        const still = new Set(plan.queue.map(c => c.id));
        const [pending] = await pool.execute("SELECT user_id FROM name_filter_reviews WHERE guild_id = ? AND kind = 'avatar' AND status = 'pending'", [guild.id]);
        const stale = pending.map(r => r.user_id).filter(id => !still.has(id));
        if (stale.length) {
            await pool.execute(
                `UPDATE name_filter_reviews SET status = 'gone', detail = 'no longer matches, or left'
                  WHERE guild_id = ? AND kind = 'avatar' AND status = 'pending' AND user_id IN (${stale.map(() => '?').join(',')})`,
                [guild.id, ...stale]);
            closed = stale.length;
        }
    }

    const acted = { done: 0, failed: 0, held: 0 };
    for (const c of act.slice(0, SCAN_CAP)) {
        const action = c.match.kind === 'scam' ? settings.scam.action : settings.action;
        void bumpHit(c.match.imageId);
        const outcome = await enforce(c.member, c.match, action, settings, { source: 'cleanse', trigger: 'cleanse', actorId: job.by });
        if (outcome === 'removed' || outcome === 'acted') acted.done++;
        else if (outcome === 'failed') { acted.failed++; await queueReview(guild.id, c.member, c.match).catch(() => {}); }
        else acted.held++;
    }

    job.result = {
        total: members.length, complete, matched: plan.queue.length, queued: review.length, acted, closed,
        scam: plan.queue.filter(c => c.match.kind === 'scam').length,
        skipped: Object.fromEntries(Object.entries(plan.skipped).map(([k, ids]) => [k, ids.length])),
    };
    logger.info(`[AvatarProtection] cleanse (${job.mode}) in ${guild.id} by ${job.by}: ${plan.queue.length} matched, ${review.length} queued, ${acted.done} acted, ${job.downloads} downloads`);
    if (plan.queue.length || job.mode === 'force' || !job.reason) {
        void logFeatureEvent(() => (guild), 'join-gate.avatarCleanse', () => ({
            title: job.mode === 'force' ? '🧹 Avatar Cleanse (Force) Finished' : '🧹 Avatar Scan Finished',
            fields: [
                ['Run by', userLabel(job.by)],
                ['Why', job.reason],
                ['Members checked', `${members.length}${complete ? '' : ' (member list incomplete)'}`],
                ['Matched', String(plan.queue.length)],
                ['Queued for review', String(review.length)],
                ['Acted on', job.mode === 'force' ? String(acted.done) : null],
                ['Could not act', acted.failed ? String(acted.failed) : null],
            ],
        }));
    }
}

// ── review ───────────────────────────────────────────────────────────────────

/** The avatar review queue (and decided rows, for the history tabs), with the matched image. */
export async function listReviews(guildId, { status = 'pending', limit = 200, minScore = null } = {}) {
    const statuses = status === 'all' ? null : String(status).split(',');
    const args = [guildId, ...(statuses ?? [])];
    let extra = '';
    if (minScore != null && Number.isFinite(Number(minScore))) { extra = ' AND (r.score IS NULL OR r.score >= ? OR r.detail = \'scam avatar\')'; args.push(Number(minScore)); }
    const [rows] = await pool.execute(
        `SELECT r.user_id, r.username, r.display_name, r.nickname, r.filter_label, r.field, r.status, r.detail, r.found_at, r.decided_by,
                r.decided_at, r.image_id, r.score, r.avatar_url, r.avatar_thumb, r.ai_verdict, r.ai_confidence, r.ai_reason, r.ai_at, b.thumb AS image_thumb, b.label AS image_label,
                b.source_type AS image_source, b.kind AS image_kind
           FROM name_filter_reviews r
           LEFT JOIN blocked_images b ON b.id = r.image_id
          WHERE r.guild_id = ? AND r.kind = 'avatar' ${statuses ? `AND r.status IN (${statuses.map(() => '?').join(',')})` : ''}${extra}
          ORDER BY r.score DESC, r.found_at DESC LIMIT ${Math.min(1000, Math.max(1, Number(limit) || 200))}`, args);
    return rows;
}

export async function reviewCounts(guildId) {
    const [rows] = await pool.execute(
        "SELECT status, COUNT(*) AS n FROM name_filter_reviews WHERE guild_id = ? AND kind = 'avatar' GROUP BY status", [guildId]);
    return Object.fromEntries(rows.map(r => [r.status, Number(r.n)]));
}

async function setReview(guildId, userId, status, by, detail = null) {
    await pool.execute(
        `UPDATE name_filter_reviews SET status = ?, detail = ?, decided_by = ?, decided_at = NOW()
          WHERE guild_id = ? AND user_id = ? AND kind = 'avatar'`,
        [status, detail ? String(detail).slice(0, 255) : null, by, guildId, userId]);
}

/** "Not a match": remember this avatar against the image it was matched to. */
async function suppressPair(guildId, imageId, variantString) {
    if (!imageId || !variantString) return;
    const [[row]] = await pool.execute("SELECT suppress FROM blocked_images WHERE id = ? AND guild_id = ? AND kind = 'avatar'", [imageId, guildId]);
    if (!row) return;
    const next = addSuppression(parseList(row.suppress), variantString);
    await pool.execute('UPDATE blocked_images SET suppress = ? WHERE id = ?', [JSON.stringify(next), imageId]);
    invalidate(guildId);
}

/** A review ban: the exact avatar becomes one of this server's scam avatars, so its next account is caught too. */
async function learnFromBan(guild, row, by) {
    if (!row.avatar_sha || BUILTIN_SCAM_AVATARS.some(b => b.sha === row.avatar_sha)) return;
    const [r] = await pool.execute(
        `INSERT IGNORE INTO blocked_images (guild_id, kind, dhash, bits_set, colour_sig, exact_sha, label, added_by, source_type, thumb)
         VALUES (?, 'scam_avatar', '0000000000000000', 0, ?, ?, ?, ?, 'learned', ?)`,
        [guild.id, '0'.repeat(96), row.avatar_sha, `Learned: banned from review (matched ${String(row.filter_label ?? 'a protected image').slice(0, 120)})`,
            by ? String(by).slice(0, 20) : null, row.avatar_thumb]).catch(() => [{}]);
    if (r?.affectedRows) invalidate(guild.id);
}

/**
 * Decide queued members: 'ban' | 'kick' | 'safe' (Not a match) | 'skip'. Bans and kicks re-check that
 * the member is still here with the same avatar, and go through protectionHold.
 * @returns {Promise<{ done:number, failed:Array<{id,problem}>, skipped:number, decision:string }>}
 */
export async function decideReviews(guild, userIds, decision, actorId) {
    const out = { done: 0, failed: [], skipped: 0, decision };
    if (!['ban', 'kick', 'safe', 'skip'].includes(decision)) { out.failed.push({ id: '*', problem: 'Unknown decision.' }); return out; }
    const settings = await getSettings(guild.id);
    if (decision === 'ban' || decision === 'kick') {
        const [perm, permName] = NEEDS[decision];
        if (!guild.members.me?.permissions?.has(perm)) { out.failed.push({ id: '*', problem: `The bot is missing the ${permName} permission` }); return out; }
        if (await isPaused(guild.id, guild)) { out.failed.push({ id: '*', problem: 'Protections are paused in this server. Resume them first.' }); return out; }
    }
    const ids = [...new Set(userIds.map(String))].slice(0, SCAN_CAP);
    const [rows] = ids.length ? await pool.execute(
        `SELECT * FROM name_filter_reviews WHERE guild_id = ? AND kind = 'avatar' AND user_id IN (${ids.map(() => '?').join(',')})`,
        [guild.id, ...ids]) : [[]];
    const byId = new Map(rows.map(r => [r.user_id, r]));
    for (const id of ids) {
        const row = byId.get(id);
        if (!row) { out.skipped++; continue; }
        if (decision === 'skip') { await setReview(guild.id, id, 'skipped', actorId); out.done++; continue; }
        if (decision === 'safe') {
            await setReview(guild.id, id, 'safe', actorId, 'not a match');
            await suppressPair(guild.id, row.image_id, row.avatar_fp);
            out.done++;
            continue;
        }
        const member = await guild.members.fetch(id).catch(() => null);
        if (!member) { await setReview(guild.id, id, 'gone', actorId, 'left the server'); out.skipped++; continue; }
        if (!targetsOf(member).some(t => avatarKeyHash(t.key) === row.names_hash)) {
            await setReview(guild.id, id, 'gone', actorId, 'changed their avatar since');
            out.skipped++;
            continue;
        }
        if (member.user.bot || isStaff(member)) { await setReview(guild.id, id, 'skipped', actorId, 'staff'); out.skipped++; continue; }
        if (await protectionHold(member, decision, 'Avatar protection review')) { out.skipped++; continue; }
        if (!actionable(member, decision, null)) {
            await setReview(guild.id, id, 'failed', actorId, 'their highest role is above the bot');
            out.failed.push({ id, problem: 'Their highest role is above the bot' });
            continue;
        }
        const match = { kind: row.detail === 'scam avatar' ? 'scam' : 'image', imageId: row.image_id, score: Number(row.score ?? 0) };
        let delivered = false;
        if (settings.dm) { try { await member.send(avatarDM(guild, decision, settings)); delivered = true; } catch { delivered = false; } }
        const result = await punish(member, decision, settings, avatarReason(match, 'review'));
        if (!result.ok) {
            await setReview(guild.id, id, 'failed', actorId, result.problem);
            out.failed.push({ id, problem: result.problem });
            continue;
        }
        await setReview(guild.id, id, decision === 'ban' ? 'banned' : 'kicked', actorId, delivered ? 'told by DM' : null);
        await recordEvent(guild.id, member.user, avatarEventAction(decision), `review: ${row.filter_label ?? 'avatar protection'}`);
        if (decision === 'ban') await learnFromBan(guild, row, actorId);
        out.done++;
    }
    logger.info(`[AvatarProtection] review decision ${decision} in ${guild.id} by ${actorId}: ${out.done} done, ${out.failed.length} failed`);
    if (out.done || out.failed.length) {
        void logFeatureEvent(() => (guild), 'join-gate.avatarCleanse', () => ({
            title: { ban: '🔨 Avatar Review: Banned', kick: '🚪 Avatar Review: Kicked', safe: '✅ Avatar Review: Not a Match', skip: '⏭️ Avatar Review: Skipped' }[decision],
            fields: [['By', userLabel(actorId)], ['Done', String(out.done)], ['Failed', out.failed.length ? String(out.failed.length) : null]],
        }));
    }
    return out;
}

/** The latest avatar-protection outcomes (join_gate_events), newest first. */
export async function recentHits(guildId, limit = 50) {
    const [rows] = await pool.execute(
        `SELECT id, user_id, username, action, detail, created_at FROM join_gate_events
          WHERE guild_id = ? AND (action LIKE 'avatar\\_%' OR (action = 'failed' AND detail LIKE 'avatar protection%'))
          ORDER BY id DESC LIMIT ${Math.min(200, Math.max(1, Number(limit) || 50))}`, [guildId]);
    return rows;
}

// ── Auto-Pilot ───────────────────────────────────────────────────────────────

const autoTimers = new Map();
const autoSyncedAt = new Map();
const autoScanAt = new Map();

export function scheduleAutoPilot(guild, delay = AUTOPILOT_DEBOUNCE_MS) {
    clearTimeout(autoTimers.get(guild.id));
    autoTimers.set(guild.id, setTimeout(() => {
        autoTimers.delete(guild.id);
        syncAutoPilot(guild).catch(err => logger.warn(`[AvatarProtection] Auto-Pilot sync failed in ${guild.id}: ${err.message}`));
    }, delay));
}

/**
 * Create / retire the protected images for covered staff avatars. With protection, Auto-Pilot or its
 * avatar part off, the active Auto-Pilot images are removed (staff deletions stay remembered).
 * @returns {Promise<{ created:number, retired:number, protected:number, skipped:number }>}
 */
export async function syncAutoPilot(guild, { fetch = false } = {}) {
    const settings = await getSettings(guild.id);
    autoSyncedAt.set(guild.id, Date.now());
    if (!(settings.enabled && settings.autopilot.enabled && settings.autopilot.avatars)) {
        const [r] = await pool.execute(
            "DELETE FROM blocked_images WHERE guild_id = ? AND kind = 'avatar' AND source_type = 'autopilot' AND removed_at IS NULL", [guild.id]);
        if (r.affectedRows) invalidate(guild.id);
        return { created: 0, retired: r.affectedRows, protected: 0, skipped: 0 };
    }
    const members = fetch ? (await nf.allMembers(guild)).members : [...guild.members.cache.values()];
    const state = await protectionState(guild.id);
    const covered = members.filter(m => nf.autoPilotCovers(m, settings.autopilot, state));
    const protectedMembers = covered.map(m => ({ id: m.id, member: m, targets: targetsOf(m, 256) }));
    const [rows] = await pool.execute(
        "SELECT id, protected_user_id, avatar_key, removed_at FROM blocked_images WHERE guild_id = ? AND kind = 'avatar' AND source_type = 'autopilot'",
        [guild.id]);
    // Only members still in the cache can be judged; a staff member missing from it keeps their images.
    const present = new Set(members.map(m => m.id));
    const existing = rows.filter(r => present.has(r.protected_user_id))
        .map(r => ({ id: r.id, userId: r.protected_user_id, key: r.avatar_key, removed: !!r.removed_at }));
    const plan = planAvatarAutoPilot({ protectedMembers, existing });
    let room = MAX_PROTECTED - await activeCount(guild.id) + plan.retire.length;
    if (plan.retire.length) {
        await pool.execute(`DELETE FROM blocked_images WHERE guild_id = ? AND source_type = 'autopilot' AND id IN (${plan.retire.map(() => '?').join(',')})`,
            [guild.id, ...plan.retire]);
    }
    let created = 0;
    let skipped = 0;
    const byId = new Map(protectedMembers.map(p => [p.id, p.member]));
    for (const c of plan.create) {
        if (room <= 0) { skipped++; continue; }
        const img = await fingerprintUrl(c.url);
        if (!img || !img.usable) { skipped++; continue; }
        const m = byId.get(c.userId);
        const saved = await insertImage(guild.id, img, {
            kind: 'avatar', label: `${m?.displayName ?? c.userId} (${c.scope === 'server' ? 'server avatar' : 'avatar'})`, sourceType: 'autopilot',
            protectedUserId: c.userId, avatarKey: c.key, by: 'autopilot',
        }).catch(err => ({ ok: false, error: err.message }));
        if (saved.ok && !saved.existing) { created++; room--; } else skipped++;
    }
    if (created || plan.retire.length) {
        invalidate(guild.id);
        logger.info(`[AvatarProtection] Auto-Pilot in ${guild.id}: +${created} -${plan.retire.length} (${covered.length} covered, ${skipped} skipped)`);
    }
    if (created && Date.now() - (autoScanAt.get(guild.id) || 0) > AUTOPILOT_SCAN_GAP_MS) {
        autoScanAt.set(guild.id, Date.now());
        scanAfterChange(guild, null, 'Auto-Pilot protected new staff avatars');
    }
    return { created, retired: plan.retire.length, protected: covered.length, skipped };
}

// ── overview ─────────────────────────────────────────────────────────────────

/** Numbers for the dashboard and `/avatarfilter status`. */
export async function overview(guild) {
    const settings = await getSettings(guild.id);
    const [bySource] = await pool.execute(
        `SELECT source_type, SUM(removed_at IS NULL) AS active, SUM(removed_at IS NOT NULL) AS removed
           FROM blocked_images WHERE guild_id = ? AND kind = 'avatar' GROUP BY source_type`, [guild.id]);
    const [[scam]] = await pool.execute(
        "SELECT COUNT(*) AS n FROM blocked_images WHERE guild_id IN ('0', ?) AND kind = 'scam_avatar' AND removed_at IS NULL", [guild.id]);
    const [[hits]] = await pool.execute(
        `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM join_gate_events
          WHERE guild_id = ? AND action LIKE 'avatar\\_%' AND created_at > NOW() - INTERVAL 30 DAY`, [guild.id]);
    const sources = Object.fromEntries(bySource.map(r => [r.source_type, { active: Number(r.active), removed: Number(r.removed) }]));
    return {
        settings,
        protected: {
            active: Object.values(sources).reduce((n, s) => n + s.active, 0),
            autopilot: sources.autopilot?.active ?? 0,
            removed: Object.values(sources).reduce((n, s) => n + s.removed, 0),
            limit: MAX_PROTECTED,
            bySource: sources,
        },
        scamAvatars: BUILTIN_SCAM_AVATARS.length + Number(scam?.n ?? 0),
        hits30d: Number(hits?.n ?? 0),
        lastHitAt: hits?.last ?? null,
        reviews: await reviewCounts(guild.id),
        cleanse: cleanseStatus(guild.id),
        autoPilotSyncedAt: autoSyncedAt.get(guild.id) ?? null,
    };
}

export { AVATAR_ACTIONS, MIN_THRESHOLD, VARIANT_LABELS };

export default {
    FLAG_ROLE_NAME, settingsFrom, getSettings, saveSettings, loadEntries, invalidate, describeImage, fingerprintUrl, targetsOf,
    downloadAvatar, ensureFlagRole,
    checkMember, checkAvatarOnJoin, onMemberUpdate, onUserUpdate, addProtected, addScamAvatar, removeImage, restoreImage,
    listProtected, listScam, testAvatar, startCleanse, cleanseStatus, listReviews, reviewCounts, decideReviews, recentHits,
    scheduleAutoPilot, syncAutoPilot, overview, askAiAboutReview, exportProtected, importProtected,
};
