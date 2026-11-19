/*
 * Inactivity prune — the live side (the rules are in core/inactivity-prune-logic.js; who was active when
 * comes from core/member-activity.js). Part of auto-prune: same settings row, same page, same reaper.
 *
 *   settings   join_gate_config.inactive_* (migration 332), beside auto-prune's prune_*: two rules —
 *              "never active" (nothing within N days of joining) and "gone quiet" (nothing for N days) —
 *              each off / log only / kick; exempt roles, boosters, staff, minimum days in the server, the
 *              warning DM, kicks per sweep and per day. Everything off for every server until switched on.
 *   sweep      every 6 hours per server, driven by the one member reaper (jobs/temp-access-reaper.js,
 *              sweepInactivityDue), or "Run now" from the dashboard. One member list per sweep: the cache
 *              when it is complete, otherwise ONE chunked gateway fetch (guild.members.fetch()), reused for
 *              10 minutes by previews. Every kick re-fetches that one member and re-checks them against
 *              fresh activity first, goes through protectionHold (allowlist, bot managers, the pause) and
 *              actOrReport ("Manual action needed" when the bot cannot), and is spaced out; kicks per
 *              sweep and per day are capped.
 *   gate       members still in the hands of verification (Unverified role, CAPTCHA clock) or on the
 *              auto-prune queue are left to those — this only judges people who got in.
 *   records    join_gate_events prune_inactive_kicked / _warned / _logged / _held (and 'failed'), shown with
 *              the verification history; the last sweep's summary on the config row; one log post per sweep.
 */
import { PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import { protectionHold } from './protection-exempt.js';
import { actOrReport } from './manual-action.js';
import { getConfig as getJoinGateConfig, setConfig as setJoinGateConfig, invalidate as invalidateJoinGate } from './join-gate.js';
import { hasDeadline } from './temp-access-manager.js';
import { getVerifyConfig, recordEvent } from './verification.js';
import { VERIFY_EVENT_LABEL } from './verification-logic.js';
import { CATEGORY_SQL } from './verification-log-logic.js';
import { activityFor, activityOf, markInactivity, trackingSince, flushActivity } from './member-activity.js';
import {
    normaliseInactivityConfig, validateInactivitySettings, evaluateMember, planSweep, summarise, previewRows,
    kickReason, warningText, kickDmText, warningPayload, kickPayload, describeInactivity, ruleText, SWEEP_INTERVAL_MS, MANUAL_RUN_COOLDOWN_MS, DAY_MS,
} from './inactivity-prune-logic.js';

/** A problem the person can fix; its message is shown to them as-is. */
export class InactivityError extends Error {}

const SOURCE = 'Inactivity prune';
const MEMBER_SNAPSHOT_MS = 10 * 60_000;
const EVAL_CACHE_MS = 2 * 60_000;
const KICK_SPACING_MS = 1500;
const FETCH_TIMEOUT_MS = 120_000;
/** Moderation permissions: holders count as staff (exempt unless switched off). */
const STAFF_PERMS = [
    PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers, PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels,
];
export const EVENT_ACTIONS = ['prune_inactive_kicked', 'prune_inactive_warned', 'prune_inactive_logged', 'prune_inactive_held'];

const snapshots = new Map();     // guildId -> { at, members: compact[] }
const inflight = new Map();      // guildId -> Promise<compact[]>
const evalCache = new Map();     // guildId -> { at, result }
const running = new Set();       // guildIds being swept
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function getInactivityConfig(guildId) {
    return normaliseInactivityConfig(await getJoinGateConfig(guildId));
}

/** Roles that hold a moderation permission: suggested as exempt roles on the dashboard. */
export function staffRoleIds(guild) {
    return [...guild.roles.cache.values()]
        .filter(r => r.id !== guild.id && STAFF_PERMS.some(p => r.permissions.has(p)))
        .sort((a, b) => b.position - a.position)
        .map(r => r.id);
}

/** Save settings (validated); posts the change to the server log. */
export async function saveInactivitySettings(guild, input, actor = null) {
    const { patch, errors } = validateInactivitySettings(input);
    if (errors.length) throw new InactivityError(errors.join(' '));
    if (Object.keys(patch).length) await setJoinGateConfig(guild.id, patch);
    dropGuildCache(guild.id);
    const cfg = await getInactivityConfig(guild.id);
    void logFeatureEvent(() => (guild), 'join-gate.inactivitySettings', () => ({
        title: '⚙️ Inactivity Prune Settings Changed',
        description: describeInactivity(cfg),
        fields: [
            ['By', actor?.id ? userLabel(actor) : 'Dashboard'],
            ['Exempt roles', cfg.exemptRoleIds.length ? cfg.exemptRoleIds.map(id => `<@&${id}>`).join(' ') : 'none'],
            ['Boosters / staff', `${cfg.exemptBoosters ? 'exempt' : 'judged'} / ${cfg.exemptStaff ? 'exempt' : 'judged'}`],
            ['Minimum days in server', String(cfg.minMemberDays)],
            ['Caps', `${cfg.maxPerSweep} per sweep, ${cfg.dailyCap} per day`],
        ],
    }));
    return cfg;
}

// ── members ──────────────────────────────────────────────────────────────────

function compact(guild, m) {
    const perms = m.permissions;
    return {
        id: m.id,
        username: m.user?.username ?? null,
        displayName: m.displayName ?? m.user?.username ?? null,
        avatar: m.displayAvatarURL?.({ size: 64 }) ?? null,
        isBot: !!m.user?.bot,
        isOwner: m.id === guild.ownerId,
        isElevated: !!perms?.has(PermissionFlagsBits.Administrator) || !!perms?.has(PermissionFlagsBits.ManageGuild),
        isStaff: STAFF_PERMS.some(p => perms?.has(p)),
        isBooster: !!m.premiumSinceTimestamp,
        roleIds: [...m.roles.cache.keys()],
        joinedAtMs: m.joinedTimestamp ?? null,
    };
}

/**
 * Every member, compact. The cache when it holds the whole server; otherwise one chunked gateway fetch
 * (the returned collection is complete even though the cache is capped), shared by concurrent callers
 * and reused for 10 minutes.
 */
async function loadMembers(guild, { maxAgeMs = MEMBER_SNAPSHOT_MS } = {}) {
    const snap = snapshots.get(guild.id);
    if (snap && Date.now() - snap.at < maxAgeMs) return snap.members;
    if (inflight.has(guild.id)) return inflight.get(guild.id);
    const p = (async () => {
        let list;
        if (guild.members.cache.size >= (guild.memberCount || Infinity)) list = [...guild.members.cache.values()];
        else list = [...(await guild.members.fetch({ time: FETCH_TIMEOUT_MS })).values()];
        const members = list.map(m => compact(guild, m));
        snapshots.set(guild.id, { at: Date.now(), members });
        return members;
    })().finally(() => inflight.delete(guild.id));
    inflight.set(guild.id, p);
    return p;
}

/** What tells "still at the gate" for this server. */
async function gateContext(guild) {
    const verify = await getVerifyConfig(guild.id).catch(() => null);
    return {
        unverifiedRoleId: verify?.enabled ? verify.unverifiedRoleId : null,
        verifiedRoleId: verify?.enabled && !verify.unverifiedRoleId ? verify.verifiedRoleId : null,
    };
}

function gatePending(guild, m, gate) {
    if (hasDeadline(guild.id, m.id, 'prune') || hasDeadline(guild.id, m.id, 'verify')) return true;
    if (gate.unverifiedRoleId && m.roleIds.includes(gate.unverifiedRoleId)) return true;
    if (gate.verifiedRoleId && !m.roleIds.includes(gate.verifiedRoleId)) return true;
    return false;
}

/**
 * Judge the whole server against `cfg`. Cached for 2 minutes per settings (paging the preview does not
 * refetch); `fresh` skips both caches (a sweep).
 */
async function evaluateGuild(guild, cfg, { fresh = false, cacheKey = 'saved', memberMaxAgeMs = null } = {}) {
    const key = `${guild.id}:${cacheKey}`;
    const hit = evalCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < EVAL_CACHE_MS) return hit.result;
    await flushActivity().catch(() => {});
    const [members, activity, since, gate] = await Promise.all([
        loadMembers(guild, memberMaxAgeMs != null ? { maxAgeMs: memberMaxAgeMs } : fresh ? { maxAgeMs: 0 } : {}),
        activityFor(guild.id), trackingSince(guild.id), gateContext(guild),
    ]);
    const now = Date.now();
    const ctx = { now, trackingSinceMs: since, botJoinedAtMs: guild.joinedTimestamp ?? null, exemptRoleSet: new Set(cfg.exemptRoleIds), exemptUserSet: new Set(cfg.exemptUserIds || []) };
    const evals = members.map(m => {
        const e = evaluateMember({
            ...m, inVoice: !!guild.voiceStates.cache.get(m.id)?.channelId, gatePending: gatePending(guild, m, gate),
        }, activity.get(m.id) || {}, cfg, ctx);
        return { userId: m.id, member: m, ...e };
    });
    const result = { cfg, evals, now, trackingSinceMs: since, botJoinedAtMs: ctx.botJoinedAtMs, memberCount: members.length };
    if (evalCache.size > 200) evalCache.clear();
    evalCache.set(key, { at: Date.now(), result });
    return result;
}

const dropGuildCache = (guildId) => { for (const k of evalCache.keys()) if (k.startsWith(`${guildId}:`)) evalCache.delete(k); };

const userOut = (m) => ({ id: m.id, username: m.username, displayName: m.displayName, avatar: m.avatar, inServer: true });

/**
 * Who each rule would remove right now (and who is warned / coming up), paged. `settings` (optional,
 * the same shape as a save) previews unsaved settings; with no rule on, both rules are judged as if on,
 * so the preview works before anything is switched on.
 * @returns {{ summary, rows, page, pages, total, trackingSinceMs, rulesOn: boolean, asIfOn: boolean, memberCount }}
 */
export async function previewInactivity(guild, { page = 1, pageSize = 50, fresh = false, settings = null } = {}) {
    const row = await getJoinGateConfig(guild.id);
    let patch = {};
    if (settings && typeof settings === 'object') {
        const v = validateInactivitySettings(settings);
        if (v.errors.length) throw new InactivityError(v.errors.join(' '));
        patch = v.patch;
    }
    let cfg = normaliseInactivityConfig({ ...(row || {}), ...patch });
    const asIfOn = !cfg.enabled;
    if (asIfOn) cfg = { ...cfg, enabled: true, never: { ...cfg.never, enabled: true }, quiet: { ...cfg.quiet, enabled: true } };
    // "Refresh" re-reads activity at once, but the member list at most once a minute (a gateway fetch).
    const r = await evaluateGuild(guild, cfg, { fresh, cacheKey: JSON.stringify(patch) + (asIfOn ? ':asif' : ''), memberMaxAgeMs: fresh ? 60_000 : null });
    const rows = previewRows(r.evals, { now: r.now });
    const size = Math.max(10, Math.min(100, Number(pageSize) || 50));
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const p = Math.max(1, Math.min(pages, Number(page) || 1));
    return {
        summary: summarise(r.evals, { now: r.now }),
        rulesOn: !asIfOn, asIfOn, describe: describeInactivity(cfg),
        total: rows.length, page: p, pages, pageSize: size,
        trackingSinceMs: r.trackingSinceMs, memberCount: r.memberCount, at: r.now,
        rows: rows.slice((p - 1) * size, p * size).map(e => ({
            user: userOut(e.member), status: e.status, rule: e.rule, action: e.action,
            lastActiveAt: e.lastActiveMs, joinedAt: e.member.joinedAtMs, dueAt: e.dueAtMs, kickAt: e.kickAtMs,
            inactiveDays: e.inactiveDays,
        })),
    };
}

// ── sweeping ─────────────────────────────────────────────────────────────────

async function kickedToday(guildId) {
    const [[r]] = await pool.execute(
        `SELECT COUNT(*) AS n FROM join_gate_events
          WHERE guild_id = ? AND action = 'prune_inactive_kicked' AND created_at > NOW() - INTERVAL 1 DAY`, [guildId]);
    return Number(r?.n) || 0;
}

const ruleDays = (cfg, rule) => (rule === 'never' ? cfg.never.days : cfg.quiet.days);

/** What the DM embeds show about the server. */
const guildCard = (guild) => ({ id: guild.id, name: guild.name, iconUrl: guild.iconURL?.({ size: 128 }) || null });

/**
 * A rejoin link for a kicked member: the vanity URL when the server has one, otherwise a one-use
 * invite that lasts 7 days, made in the system, rules or first text channel the bot can invite to.
 * Null when the bot cannot make one (the kick DM then has no button).
 */
async function rejoinInvite(guild) {
    if (guild.vanityURLCode) return `https://discord.gg/${guild.vanityURLCode}`;
    const me = guild.members.me;
    if (!me) return null;
    const usable = (c) => c?.isTextBased?.() && !c.isThread?.() && c.permissionsFor?.(me)?.has(PermissionFlagsBits.CreateInstantInvite);
    const channel = [guild.systemChannel, guild.rulesChannel].find(usable)
        || guild.channels.cache.filter(usable).sort((a, b) => a.rawPosition - b.rawPosition).first();
    if (!channel) return null;
    try {
        const invite = await guild.invites.create(channel, { maxAge: 7 * 86400, maxUses: 1, unique: true, reason: 'Rejoin link for an inactivity prune kick' });
        return invite.url;
    } catch (err) {
        logger.debug(`[InactivityPrune] no rejoin invite in ${guild.id}: ${err.message}`);
        return null;
    }
}

/**
 * Re-check one planned kick against the live member and fresh activity, then kick (or hold / report).
 * @returns {Promise<'kicked'|'held'|'failed'|'skipped'>}
 */
async function kickOne(guild, cfg, planned, ctxBase, gate) {
    const member = await guild.members.fetch(planned.userId).catch(() => null);
    if (!member) return 'skipped';
    const m = compact(guild, member);
    const act = await activityOf(guild.id, member.id).catch(() => null) || {};
    const again = evaluateMember({ ...m, inVoice: !!member.voice?.channelId, gatePending: gatePending(guild, m, gate) },
        act, cfg, { ...ctxBase, now: Date.now() });
    if (again.status !== 'due' || again.action !== 'kick') return 'skipped';
    const days = ruleDays(cfg, again.rule);

    const held = await protectionHold(member, 'kick', SOURCE);
    if (held) {
        // Once per inactivity episode, not every 6 hours (the logged marker; activity since resets it).
        const last = Math.max(act.lastMessageMs ?? 0, act.lastVoiceMs ?? 0);
        if (!(act.loggedAtMs > last)) {
            await recordEvent(guild.id, member.user, 'prune_inactive_held', `kick held (${held.why})`);
            await markInactivity(guild.id, member.id, 'logged').catch(() => {});
        }
        return 'held';
    }
    // Made before the kick, while the member can still be reached; null leaves the DM without a button.
    const inviteUrl = await rejoinInvite(guild);
    let dm = false;
    const done = await actOrReport(guild, 'kick', { member, source: SOURCE }, async () => {
        dm = await member.send(kickPayload(guildCard(guild), { rule: again.rule, days, inviteUrl })).then(() => true).catch(() => false);
        await member.kick(kickReason(again.rule, days));
    });
    if (!done) {
        await recordEvent(guild.id, member.user, 'failed', `Auto-prune: inactive: could not kick (${again.rule}, ${days} d)`, dm);
        return 'failed';
    }
    await recordEvent(guild.id, member.user, 'prune_inactive_kicked', ruleText(again.rule, days), dm);
    return 'kicked';
}

/**
 * One sweep of one server: warn, log, kick (capped). Never throws.
 * @returns {Promise<object|null>} the summary stored as inactive_last_result
 */
export async function sweepGuild(guild, { manual = false, actor = null } = {}) {
    if (running.has(guild.id)) return null;
    running.add(guild.id);
    const started = Date.now();
    const result = { at: started, manual, by: actor?.username ?? null, kicked: 0, warned: 0, logged: 0, held: 0, failed: 0,
        skipped: 0, deferredKicks: 0, deferredWarnings: 0, capReached: null, due: 0, error: null, names: [] };
    try {
        const cfg = await getInactivityConfig(guild.id);
        if (!cfg.enabled) { result.error = 'off'; return result; }
        const r = await evaluateGuild(guild, cfg, { fresh: true });
        const gate = await gateContext(guild);
        const today = await kickedToday(guild.id);
        const evals = r.evals;
        const plan = planSweep(evals, { maxPerSweep: cfg.maxPerSweep, kickedToday: today, dailyCap: cfg.dailyCap });
        result.due = evals.filter(e => e.status === 'due').length;
        result.deferredKicks = plan.deferredKicks;
        result.deferredWarnings = plan.deferredWarnings;
        result.capReached = plan.capReached;

        for (const e of plan.warn) {
            const days = ruleDays(cfg, e.rule);
            const member = await guild.members.fetch(e.userId).catch(() => null);
            if (!member) continue;
            const dm = await member.send(warningPayload(guildCard(guild), { rule: e.rule, days, kickAtMs: e.kickAtMs })).then(() => true).catch(() => false);
            // Recorded whether or not the DM arrived (closed DMs): the warning period runs either way.
            await markInactivity(guild.id, e.userId, 'warned');
            await recordEvent(guild.id, member.user, 'prune_inactive_warned',
                `${ruleText(e.rule, days)}; removal ${new Date(e.kickAtMs).toISOString().slice(0, 10)}${dm ? '' : ' (DMs closed)'}`, dm);
            result.warned++;
        }
        for (const e of plan.log) {
            const days = ruleDays(cfg, e.rule);
            await markInactivity(guild.id, e.userId, 'logged');
            await recordEvent(guild.id, { id: e.userId, username: e.member.username }, 'prune_inactive_logged', `log only: ${ruleText(e.rule, days)}`);
            result.logged++;
            if (result.names.length < 15) result.names.push(`<@${e.userId}>`);
        }
        const ctxBase = { trackingSinceMs: r.trackingSinceMs, botJoinedAtMs: r.botJoinedAtMs, exemptRoleSet: new Set(cfg.exemptRoleIds) };
        let attempts = 0;
        for (const e of plan.kickQueue) {
            if (result.kicked >= plan.budget || attempts >= plan.maxAttempts) break;
            attempts++;
            const outcome = await kickOne(guild, cfg, e, ctxBase, gate).catch(err => {
                logger.error(`[InactivityPrune] ${guild.id}/${e.userId} failed: ${err.message}`);
                return 'failed';
            });
            result[outcome === 'kicked' ? 'kicked' : outcome === 'held' ? 'held' : outcome === 'failed' ? 'failed' : 'skipped']++;
            if (outcome === 'kicked' && result.names.length < 15) result.names.push(`<@${e.userId}>`);
            if (outcome === 'kicked') await sleep(KICK_SPACING_MS);
        }
        result.deferredKicks = Math.max(0, plan.kickQueue.length - attempts);
        result.capReached = result.deferredKicks ? plan.capReached || 'sweep' : null;
    } catch (err) {
        result.error = String(err.message).slice(0, 200);
        logger.error(`[InactivityPrune] sweep of ${guild.id} failed: ${err.message}`, { stack: err.stack });
    } finally {
        running.delete(guild.id);
        dropGuildCache(guild.id);
        result.ms = Date.now() - started;
        if (result.error !== 'off') {
            await pool.execute('UPDATE join_gate_config SET inactive_last_sweep_at = NOW(), inactive_last_result = ? WHERE guild_id = ?',
                [JSON.stringify(result), guild.id]).catch(err => logger.warn(`[InactivityPrune] could not store the sweep result: ${err.message}`));
            invalidateJoinGate(guild.id);
        }
    }
    if (result.kicked || result.warned || result.logged || result.held || result.failed || result.error) {
        logger.info(`[InactivityPrune] ${guild.id}: kicked=${result.kicked} warned=${result.warned} logged=${result.logged} held=${result.held} failed=${result.failed} deferred=${result.deferredKicks}`);
        void logFeatureEvent(() => (guild), 'join-gate.inactivityPrune', () => ({
            title: result.kicked ? '🧹 Inactive Members Removed' : '🧹 Inactivity Prune',
            description: result.error ? `The sweep stopped: ${result.error}` : null,
            fields: [
                ['Removed', result.kicked ? String(result.kicked) : null],
                ['Warned by DM', result.warned ? String(result.warned) : null],
                ['Would be removed (log only)', result.logged ? String(result.logged) : null],
                ['Held (exempt or paused)', result.held ? String(result.held) : null],
                ['Could not remove', result.failed ? String(result.failed) : null],
                ['Waiting for the next sweep', result.deferredKicks ? `${result.deferredKicks} (${result.capReached === 'daily' ? 'daily' : 'per-sweep'} cap)` : null],
                ['Members', result.names.length ? result.names.join(' ') : null, false],
                ['Run', manual ? `by hand${actor?.username ? ` (${actor.username})` : ''}` : 'scheduled'],
            ],
        }));
    }
    return result;
}

/** The reaper's entry point: every server with a rule on whose last sweep is 6+ hours old, one at a time. */
export async function sweepInactivityDue(resolveGuild) {
    let rows;
    try {
        [rows] = await pool.execute(
            `SELECT guild_id FROM join_gate_config
              WHERE (inactive_never_enabled = 1 OR inactive_quiet_enabled = 1)
                AND (inactive_last_sweep_at IS NULL OR inactive_last_sweep_at < NOW() - INTERVAL ? SECOND)`,
            [Math.round(SWEEP_INTERVAL_MS / 1000)]);
    } catch (err) {
        if (err?.code !== 'ER_BAD_FIELD_ERROR') logger.error(`[InactivityPrune] could not list due servers: ${err.message}`);
        return;
    }
    for (const { guild_id: guildId } of rows) {
        const guild = resolveGuild(guildId);
        if (!guild) continue;
        await sweepGuild(guild);
    }
}

/** "Run now" (dashboard): starts a sweep in the background. */
export async function runInactivityNow(guild, actor = null) {
    const cfg = await getInactivityConfig(guild.id);
    if (!cfg.enabled) throw new InactivityError('Switch on at least one inactivity rule first.');
    if (running.has(guild.id)) throw new InactivityError('A sweep is already running.');
    if (cfg.lastSweepAt && Date.now() - cfg.lastSweepAt < MANUAL_RUN_COOLDOWN_MS) {
        const mins = Math.ceil((MANUAL_RUN_COOLDOWN_MS - (Date.now() - cfg.lastSweepAt)) / 60_000);
        throw new InactivityError(`The last sweep was moments ago. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
    }
    void sweepGuild(guild, { manual: true, actor });
    return { started: true };
}

/** Settings + live state for the dashboard / status embed. */
export async function inactivityStatus(guild) {
    const cfg = await getInactivityConfig(guild.id);
    const since = await trackingSince(guild.id).catch(() => null);
    const today = await kickedToday(guild.id).catch(() => 0);
    return {
        ...cfg,
        describe: describeInactivity(cfg),
        running: running.has(guild.id),
        trackingSinceMs: since,
        judgedFromMs: Math.max(since ?? 0, guild.joinedTimestamp ?? 0) || null,
        kickedToday: today,
        nextSweepAt: cfg.enabled ? (cfg.lastSweepAt ? cfg.lastSweepAt + SWEEP_INTERVAL_MS : Date.now()) : null,
    };
}

/** Inactivity prune outcomes, newest first. */
export async function inactivityHistory(guildId, limit = 100) {
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    const [rows] = await pool.execute(
        `SELECT id, user_id, username, action, detail, dm_delivered, created_at FROM join_gate_events
          WHERE guild_id = ? AND ${CATEGORY_SQL.inactivity}
          ORDER BY id DESC LIMIT ${n}`, [guildId]);
    return rows.map(r => ({ ...r, label: VERIFY_EVENT_LABEL[r.action] || r.action }));
}

export { DAY_MS };
export default {
    getInactivityConfig, saveInactivitySettings, staffRoleIds, previewInactivity, sweepGuild, sweepInactivityDue,
    runInactivityNow, inactivityStatus, inactivityHistory, InactivityError, EVENT_ACTIONS,
};
