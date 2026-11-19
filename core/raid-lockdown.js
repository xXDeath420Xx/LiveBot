/*
 * Raid lockdown — the live side (the rules are in core/raid-lockdown-logic.js).
 *
 * Part of the raid system, not beside it: the settings are columns on raid_detection_config (the
 * row core/raid-detection-manager.js already reads), the join tracker that auto-triggers a lockdown
 * and spots same-name floods is that manager's, and the history is raid_lockdowns
 * (migrations/325_raid_lockdown.js).
 *
 *   join lockdown     startLockdown / endLockdown / extendLockdown. While a row is active every new
 *                     join is kicked, banned, timed out, quarantined (the existing quarantine role
 *                     and quarantined_users, so the normal release works) or only logged. Called from
 *                     events/guildMemberAdd.js via enforceJoin() BEFORE the stale-event guard, so a
 *                     join replayed after a restart is still caught when it happened mid-lockdown.
 *                     Start and end post a summary (who, how many, how) to the raid alert channel
 *                     and the server log. The row is the state: a restart resumes it, the minute
 *                     sweep (jobs/timed-moderation-job.js) ends it when its time is up.
 *   same-name floods  actOnGroup() — the group the tracker found, each member once.
 *   incident actions  syncIncidents() — Discord's own invite / DM pause
 *                     (guild.setIncidentActions = PUT /guilds/{id}/incident-actions). Driven by the
 *                     "keep disabled" switches and by a lockdown that pauses invites; renewed hourly;
 *                     on its own it only lifts a pause this bot set (ownership = the time we last
 *                     wrote). These switches (/lockdown dms|invites, the dashboard's Raid lockdown
 *                     panel) are the server's one DM / invite pause control: switching one off lifts a
 *                     running pause at once, whoever set it, unless a running lockdown holds invites
 *                     (H-660; /lockdown dm-pause and /lockdown discord were retired for it).
 *
 * Every action on a member goes through protectionHold (core/protection-exempt.js) first: bots, the
 * owner, the allowlist and bot-manager roles are exempt, and a paused server is logged, not acted on.
 *
 * "Is raid protection on?" has one answer, raidProtectionState() (detection or the auto-lockdown
 * trigger), and one switch for the setup wizard and the takeover, enableRaidDetection(). The old
 * anti_raid_config table is no longer written or read (migrations/330_nsfw_cleanup.js); nothing ever
 * enforced it.
 */
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import configCache from '../utils/configCache.js';
import { protectionHold } from './protection-exempt.js';
import { whyCannot, whyFailed, reportManualAction } from './manual-action.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import { lockChannel, unlockChannel } from './lockdown-manager.js';
import { formatDuration } from './protection-exempt-logic.js';
import {
    ACTION_LABEL, MINUTE, DAY, lockdownSettings, normaliseAction, checkDuration, lockdownState, joinedDuring,
    planIncidentActions, summarise, counterFor, asciiReason, utcStamp,
} from './raid-lockdown-logic.js';

const SETTINGS_COLUMNS = [
    'lockdown_action', 'lockdown_duration_minutes', 'lockdown_pause_invites', 'lockdown_lock_channels',
    'lockdown_channel_ids', 'lockdown_dm',
    'auto_lockdown_enabled', 'auto_lockdown_joins', 'auto_lockdown_window_seconds', 'auto_lockdown_duration_minutes',
    'auto_lockdown_action', 'auto_lockdown_pause_invites', 'auto_lockdown_lock_channels',
    'same_name_enabled', 'same_name_count', 'same_name_window_seconds', 'same_name_action',
    'keep_dms_disabled', 'keep_invites_disabled', 'alert_channel_id',
];
const BLOCKED = new Set(['banned', 'kicked', 'timed_out', 'quarantined']);
const OUTCOME_WORD = {
    banned: 'banned', kicked: 'kicked', timed_out: 'timed out', quarantined: 'quarantined', logged: 'logged only',
    held: 'exempt', paused: 'paused (logged only)', failed: 'could not act',
};
const START_VERB = { kick: 'kicked', ban: 'banned', timeout: 'timed out', quarantine: 'quarantined', log: 'logged (log-only lockdown)' };
const MAX_RECORDED_USERS = 300;
const MAX_DMS_PER_LOCKDOWN = 25;
const MAX_TIMEOUT_MS = 28 * DAY;

// ── config ───────────────────────────────────────────────────────────────────

/** raid_detection_config row (shared cache key with core/raid-detection-manager.js), or null. */
export async function getRaidConfig(guildId) {
    try {
        return await configCache.get('raid_detection_config', guildId, async () => {
            const [rows] = await pool.execute('SELECT * FROM raid_detection_config WHERE guild_id = ?', [guildId]);
            return rows[0] || null;
        });
    } catch (err) {
        logger.error(`[RaidLockdown] config read failed for ${guildId}: ${err.message}`);
        return null;
    }
}

export function invalidateRaidConfig(guildId) {
    configCache.invalidate('raid_detection_config', guildId);
}

/** Save lockdown-related settings (only the columns this feature owns, plus the shared alert channel). */
export async function saveSettings(guildId, patch) {
    const cols = SETTINGS_COLUMNS.filter(c => patch[c] !== undefined);
    if (cols.length) {
        await pool.execute(
            `INSERT INTO raid_detection_config (guild_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
             ON DUPLICATE KEY UPDATE ${cols.map(c => `${c} = VALUES(${c})`).join(', ')}`,
            [guildId, ...cols.map(c => patch[c])]);
    }
    invalidateRaidConfig(guildId);
    return getRaidConfig(guildId);
}

/**
 * Switch raid detection on (the setup wizard's and the takeover's "anti-raid"). Its action stays what the
 * server chose — 'alert' (post Kick All / Ban All buttons, act on nobody) for a new row.
 */
export async function enableRaidDetection(guildId) {
    await pool.execute(
        'INSERT INTO raid_detection_config (guild_id, enabled) VALUES (?, 1) ON DUPLICATE KEY UPDATE enabled = 1', [guildId]);
    invalidateRaidConfig(guildId);
    return 'raid_detection_config.enabled = on';
}

/** What raid protection is on: detection, the auto-lockdown trigger, either (`on`). Never throws. */
export async function raidProtectionState(guildId) {
    const row = await getRaidConfig(guildId);
    const detection = !!Number(row?.enabled ?? 0);
    const autoLockdown = !!Number(row?.auto_lockdown_enabled ?? 0);
    return { detection, autoLockdown, on: detection || autoLockdown, action: row?.action ?? null, configured: !!row };
}

// ── active lockdown state ────────────────────────────────────────────────────

// guildId -> { row|null, at }. Everything (bots + dashboard) is one process, so writes here keep it exact;
// the TTL only covers a row changed by hand in the database.
const activeCache = new Map();
const ACTIVE_TTL = 30_000;
// lockdown id -> Map(userId -> outcome): each joiner is acted on once, however many paths see them.
const handledByLockdown = new Map();
const dmsSent = new Map();
const starting = new Set();

function handled(lockId) {
    let m = handledByLockdown.get(lockId);
    if (!m) {
        m = new Map();
        handledByLockdown.set(lockId, m);
        if (handledByLockdown.size > 200) handledByLockdown.delete(handledByLockdown.keys().next().value);
    }
    return m;
}

/** The active lockdown row for a guild, or null. An expired one is ended in the background. */
export async function getActive(guildId, { fresh = false } = {}) {
    const hit = activeCache.get(guildId);
    let row;
    if (!fresh && hit && Date.now() - hit.at < ACTIVE_TTL) {
        row = hit.row;
    } else {
        try {
            const [rows] = await pool.execute(
                "SELECT * FROM raid_lockdowns WHERE guild_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", [guildId]);
            row = rows[0] || null;
        } catch (err) {
            // Table missing (migration not run) or DB blip: no lockdown — the join pipeline carries on.
            logger.warn(`[RaidLockdown] active lookup failed for ${guildId}: ${err.message}`);
            return null;
        }
        activeCache.set(guildId, { row, at: Date.now() });
    }
    const state = lockdownState(row);
    if (state === 'expired') {
        const guild = resolveGuild(guildId);
        if (guild) void endLockdown(guild, { why: 'expired', id: row.id }).catch(err => logger.error(`[RaidLockdown] lazy end failed: ${err.message}`));
        return null;
    }
    return state === 'active' ? row : null;
}

function resolveGuild(guildId) {
    const client = global.botManager?.getClientForGuild?.(guildId);
    return client?.isReady?.() ? client.guilds.cache.get(guildId) || null : null;
}

// ── acting on one member ─────────────────────────────────────────────────────

const HOLD_VERB = { ban: 'ban', kick: 'kick', timeout: 'timeout', quarantine: 'flag' };

async function quarantineConfig(guildId) {
    try {
        const [[row]] = await pool.execute('SELECT is_enabled, quarantine_role_id FROM quarantine_config WHERE guild_id = ?', [guildId]);
        return row || null;
    } catch { return null; }
}

/**
 * Do `action` to a member who just joined. Never throws.
 * @param {object} opts  source (for protectionHold and the log), reason (audit log, made ASCII),
 *                       timeoutUntil (ms, for 'timeout'), dm (content to DM before a kick, or null)
 * @returns {Promise<{ outcome:'banned'|'kicked'|'timed_out'|'quarantined'|'logged'|'held'|'paused'|'failed', problem?:string }>}
 */
export async function actOnMember(member, action, { source, reason, timeoutUntil = null, dm = null } = {}) {
    const act = normaliseAction(action);
    if (act === 'log') return { outcome: 'logged' };
    try {
        const held = await protectionHold(member, HOLD_VERB[act], source);
        if (held) return { outcome: held.why === 'paused' ? 'paused' : 'held', problem: held.text };
        const why = asciiReason(reason || source);
        const guild = member.guild;
        let cannot = null;
        // "Manual action needed" (core/manual-action.js): one alert per server per cause, however many joins.
        const manual = async (verb, problem) => {
            await reportManualAction(guild, { action: verb, member, source: source || 'Raid lockdown', problem });
            return { outcome: 'failed', problem: problem.text.replace(/\*\*/g, '') };
        };
        switch (act) {
            case 'ban':
                if ((cannot = whyCannot(guild, 'ban', { member }))) return manual('ban', cannot);
                await member.ban({ reason: why, deleteMessageSeconds: 3600 });
                return { outcome: 'banned' };
            case 'kick':
                if ((cannot = whyCannot(guild, 'kick', { member }))) return manual('kick', cannot);
                if (dm) {
                    // DM first: Discord only reliably delivers while a mutual server exists. Never wait long.
                    await Promise.race([member.send(dm).catch(() => null), new Promise(r => setTimeout(r, 1500))]);
                }
                await member.kick(why);
                return { outcome: 'kicked' };
            case 'timeout': {
                if ((cannot = whyCannot(guild, 'timeout', { member }))) return manual('timeout', cannot);
                const len = Math.min(MAX_TIMEOUT_MS, Math.max(MINUTE, (timeoutUntil ?? Date.now() + 60 * MINUTE) - Date.now()));
                await member.timeout(len, why);
                return { outcome: 'timed_out' };
            }
            case 'quarantine': {
                const q = await quarantineConfig(guild.id);
                const role = q?.is_enabled && q.quarantine_role_id ? guild.roles.cache.get(q.quarantine_role_id) : null;
                if (!role) return { outcome: 'failed', problem: 'Quarantine is not set up (Security page: quarantine role)' };
                if ((cannot = whyCannot(guild, 'quarantine', { member, role }))) return manual('quarantine', cannot);
                // Same record /admin mod quarantine keeps, so the normal release gives nothing back but works.
                await pool.execute(
                    `INSERT INTO quarantined_users (guild_id, user_id, previous_roles, reason, quarantined_by)
                     VALUES (?, ?, '[]', ?, ?)
                     ON DUPLICATE KEY UPDATE reason = VALUES(reason), quarantined_by = VALUES(quarantined_by)`,
                    [guild.id, member.id, why.slice(0, 255), guild.client.user?.id ?? null]);
                await member.roles.add(role, why);
                return { outcome: 'quarantined' };
            }
            default:
                return { outcome: 'logged' };
        }
    } catch (err) {
        const cause = member?.guild ? whyFailed(err, member.guild, act === 'quarantine' ? 'quarantine' : act, { member }) : null;
        if (cause) await reportManualAction(member.guild, { action: act, member, source: source || 'Raid lockdown', problem: cause });
        return { outcome: 'failed', problem: err.message };
    }
}

// ── the lockdown ─────────────────────────────────────────────────────────────

function lockdownDm(guild, row) {
    return {
        content: `**${guild.name}** is in lockdown and is not accepting new members right now. `
            + `Please try again <t:${Math.floor(new Date(row.ends_at).getTime() / 1000)}:R>. This is automatic, not personal.`,
    };
}

async function recordJoin(row, member, outcome) {
    const counter = counterFor(outcome);
    await pool.execute(
        `UPDATE raid_lockdowns SET ${counter} = ${counter} + 1,
             blocked_users = IF(JSON_LENGTH(COALESCE(blocked_users, '[]')) < ?,
                 JSON_ARRAY_APPEND(COALESCE(blocked_users, '[]'), '$', JSON_OBJECT('id', ?, 'n', ?, 'r', ?, 't', ?)), blocked_users)
         WHERE id = ?`,
        [MAX_RECORDED_USERS, member.id, member.user?.username ?? null, outcome, Date.now(), row.id]).catch(err => logger.warn(`[RaidLockdown] could not count a join: ${err.message}`));
}

/**
 * The lockdown's say on one join. Returns null when no lockdown applies to this member, else
 * `{ outcome, stop }` — `stop` true means the join pipeline should go no further (they were removed,
 * timed out or quarantined). `burst`: one of the joins that set off an auto-lockdown — they arrived
 * seconds before it began, so the joined-during check is skipped for them.
 */
export async function enforceJoin(member, row = null, { burst = false } = {}) {
    const guild = member.guild;
    const lock = row || await getActive(guild.id);
    if (!lock || lockdownState(lock) !== 'active') return null;
    if (!burst && !joinedDuring(lock, member.joinedTimestamp ?? null)) return null;
    const seen = handled(lock.id);
    if (seen.has(member.id)) {
        const prev = seen.get(member.id);
        return { outcome: prev, stop: BLOCKED.has(prev) || prev === 'pending' };
    }
    seen.set(member.id, 'pending');

    const settings = lockdownSettings(await getRaidConfig(guild.id));
    let dm = null;
    if (lock.action === 'kick' && settings.lockdownDm) {
        const n = dmsSent.get(lock.id) || 0;
        if (n < MAX_DMS_PER_LOCKDOWN) { dmsSent.set(lock.id, n + 1); dm = lockdownDm(guild, lock); }
    }
    const res = await actOnMember(member, lock.action, {
        source: 'Raid lockdown',
        reason: `Raid lockdown: not accepting new members until ${utcStamp(lock.ends_at)}`,
        timeoutUntil: new Date(lock.ends_at).getTime(),
        dm,
    });
    seen.set(member.id, res.outcome);
    await recordJoin(lock, member, res.outcome);
    logger.info(`[RaidLockdown] ${res.outcome} ${member.user?.tag ?? member.id} in ${guild.id} (lockdown #${lock.id})${res.problem ? ` — ${res.problem}` : ''}`);

    if (res.outcome !== 'held' && res.outcome !== 'paused') {   // protectionHold already logged those
        void logFeatureEvent(() => (guild), 'moderation.lockdownJoin', () => ({
            title: res.outcome === 'failed' ? '⚠️ Lockdown Could Not Act' : `🚧 Lockdown: Join ${OUTCOME_WORD[res.outcome]}`,
            fields: [
                ['Member', userLabel(member)],
                ['Account created', `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`],
                ['Lockdown ends', `<t:${Math.floor(new Date(lock.ends_at).getTime() / 1000)}:R>`],
                ['Problem', res.problem || null, false],
            ],
            // A raid is hundreds of joins: one post a minute per lockdown, the end summary has the full list.
            throttle: { key: `lockdown-join:${guild.id}:${lock.id}:${res.outcome === 'failed' ? 'f' : 'a'}`, ms: 60_000 },
        }));
    }
    return { outcome: res.outcome, stop: BLOCKED.has(res.outcome) };
}

/**
 * Start a lockdown.
 * @param {import('discord.js').Guild} guild
 * @param {{ action?:string, durationMs?:number, trigger?:'manual'|'auto', by?:import('discord.js').User|null,
 *           reason?:string|null, triggerDetail?:string|null, pauseInvites?:boolean, lockChannels?:boolean,
 *           burstUserIds?:string[] }} opts
 * @returns {Promise<{ ok:true, row:object, burst:Map<string,string> } | { ok:false, error:string, row?:object }>}
 */
export async function startLockdown(guild, opts = {}) {
    const trigger = opts.trigger === 'auto' ? 'auto' : 'manual';
    const cfgRow = await getRaidConfig(guild.id);
    const s = lockdownSettings(cfgRow);
    const action = normaliseAction(opts.action, trigger === 'auto' ? s.autoAction : s.lockdownAction);
    const dur = checkDuration(opts.durationMs ?? (trigger === 'auto' ? s.autoDurationMinutes : s.lockdownDurationMinutes) * MINUTE, trigger);
    if (!dur.ok) return { ok: false, error: dur.error };
    if (starting.has(guild.id)) return { ok: false, error: 'A lockdown is already being started.' };
    starting.add(guild.id);
    try {
        const existing = await getActive(guild.id, { fresh: true });
        if (existing) return { ok: false, error: 'A lockdown is already running.', row: existing };

        const now = new Date();
        const ends = new Date(now.getTime() + dur.ms);
        const pauseInvites = opts.pauseInvites ?? (trigger === 'auto' ? s.autoPauseInvites : s.lockdownPauseInvites);
        const lockChannels = opts.lockChannels ?? (trigger === 'auto' ? s.autoLockChannels : s.lockdownLockChannels);
        const [res] = await pool.execute(
            `INSERT INTO raid_lockdowns (guild_id, status, action, trigger_kind, trigger_detail, reason, started_by,
                 started_at, ends_at, pause_invites, blocked_users)
             VALUES (?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, '[]')`,
            [guild.id, action, trigger, opts.triggerDetail?.slice(0, 255) ?? null, opts.reason?.slice(0, 255) ?? null,
                opts.by?.id ?? null, now, ends, pauseInvites ? 1 : 0]);
        const [[row]] = await pool.execute('SELECT * FROM raid_lockdowns WHERE id = ?', [res.insertId]);
        activeCache.set(guild.id, { row, at: Date.now() });
        logger.warn(`[RaidLockdown] STARTED #${row.id} in ${guild.id}: ${action} until ${ends.toISOString()} (${trigger}${opts.triggerDetail ? `: ${opts.triggerDetail}` : ''})`);

        // Invites: Discord's own pause, for the lockdown's length (renewed past 24h by the hourly sync).
        let incidentNote = null;
        if (pauseInvites) {
            const sync = await syncIncidents(guild, { why: 'lockdown start' });
            incidentNote = sync.error ? `Could not pause invites: ${sync.error}` : sync.invitesPausedByUs ? 'Invites paused' : 'Invites already paused';
            if (sync.invitesPausedByUs) {
                await pool.execute('UPDATE raid_lockdowns SET invites_paused = 1 WHERE id = ?', [row.id]).catch(() => {});
                row.invites_paused = 1;
            }
        }

        // Channels: the existing channel lock (core/lockdown-manager.js), on the channels picked in settings.
        const locked = [];
        const lockProblems = [];
        if (lockChannels && s.lockdownChannelIds.length) {
            const me = guild.client.user;
            for (const id of s.lockdownChannelIds) {
                const ch = guild.channels.cache.get(id);
                if (!ch?.permissionOverwrites) { lockProblems.push(`<#${id}> not found`); continue; }
                try {
                    const r = await lockChannel(ch, me, `Raid lockdown #${row.id}`);
                    if (r.status === 'locked') locked.push(id);
                } catch (err) { lockProblems.push(`<#${id}>: ${err.message}`); }
            }
            if (locked.length) {
                await pool.execute('UPDATE raid_lockdowns SET channels_locked = ? WHERE id = ?', [JSON.stringify(locked), row.id]).catch(() => {});
                row.channels_locked = JSON.stringify(locked);
            }
        }

        await announceStart(guild, cfgRow, row, { incidentNote, locked, lockProblems });

        // An auto-trigger's burst: the joins that set it off are the raid, so the lockdown applies to them too.
        const burst = new Map();
        for (const userId of opts.burstUserIds || []) {
            const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
            if (!member) continue;
            const out = await enforceJoin(member, row, { burst: true });
            if (out) burst.set(userId, out.outcome);
        }
        return { ok: true, row, burst };
    } catch (err) {
        logger.error(`[RaidLockdown] start failed in ${guild.id}: ${err.message}`);
        return { ok: false, error: err.message };
    } finally {
        starting.delete(guild.id);
    }
}

/**
 * End the active lockdown (by hand or because its time is up). Lifts the invite pause it set, unlocks
 * the channels it locked and posts the summary. Ending twice is harmless: only the call that flips the
 * row does the rest.
 */
export async function endLockdown(guild, { by = null, why = 'manual', id = null } = {}) {
    // `id`: end that row (an expired one), never a newer lockdown started since.
    const [rows] = id
        ? await pool.execute("SELECT * FROM raid_lockdowns WHERE id = ? AND guild_id = ? AND status = 'active'", [id, guild.id])
        : await pool.execute("SELECT * FROM raid_lockdowns WHERE guild_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", [guild.id]);
    const row = rows[0];
    if (!row) { activeCache.delete(guild.id); return { ok: false, error: 'No lockdown is running.' }; }
    const [res] = await pool.execute(
        "UPDATE raid_lockdowns SET status = 'ended', ended_at = ?, ended_by = ?, end_reason = ? WHERE id = ? AND status = 'active'",
        [new Date(), by?.id ?? null, why === 'expired' ? 'expired' : 'manual', row.id]);
    activeCache.delete(guild.id);
    if (!res.affectedRows) return { ok: false, error: 'That lockdown has already ended.' };
    logger.warn(`[RaidLockdown] ENDED #${row.id} in ${guild.id} (${why})`);

    let incidentNote = null;
    if (row.pause_invites || row.invites_paused) {
        const sync = await syncIncidents(guild, { why: 'lockdown end' });
        incidentNote = sync.error ? `Could not restore invites: ${sync.error}`
            : sync.invitesLiftedByUs ? 'Invites resumed' : sync.invitesKept ? 'Invites stay paused (kept by another switch or set by hand)' : null;
    }
    const unlocked = [];
    let lockedIds = [];
    try { lockedIds = JSON.parse(row.channels_locked || '[]'); } catch { lockedIds = []; }
    for (const id of lockedIds) {
        const ch = guild.channels.cache.get(id);
        if (!ch?.permissionOverwrites) continue;
        try { await unlockChannel(ch, guild.client.user); unlocked.push(id); } catch (err) {
            logger.warn(`[RaidLockdown] unlock of ${id} failed: ${err.message}`);
        }
    }
    const [[final]] = await pool.execute('SELECT * FROM raid_lockdowns WHERE id = ?', [row.id]);
    handledByLockdown.delete(row.id);
    dmsSent.delete(row.id);
    await announceEnd(guild, await getRaidConfig(guild.id), final, { by, why, incidentNote, unlocked });
    return { ok: true, row: final };
}

/** Move the end of the active lockdown. `untilMs` absolute. */
export async function extendLockdown(guild, untilMs, by = null) {
    const row = await getActive(guild.id, { fresh: true });
    if (!row) return { ok: false, error: 'No lockdown is running.' };
    const dur = checkDuration(untilMs - new Date(row.started_at).getTime(), 'manual');
    if (!dur.ok) return dur;
    if (untilMs <= Date.now() + MINUTE) return { ok: false, error: 'The new end must be at least a minute from now.' };
    const ends = new Date(untilMs);
    await pool.execute("UPDATE raid_lockdowns SET ends_at = ? WHERE id = ? AND status = 'active'", [ends, row.id]);
    const updated = { ...row, ends_at: ends };
    activeCache.set(guild.id, { row: updated, at: Date.now() });
    if (row.pause_invites) await syncIncidents(guild, { why: 'lockdown extended' });
    void logFeatureEvent(() => (guild), 'moderation.raidLockdown', () => ({
        title: '⏱️ Lockdown Changed',
        fields: [['Ends', `<t:${Math.floor(untilMs / 1000)}:F> (<t:${Math.floor(untilMs / 1000)}:R>)`], ['By', userLabel(by)]],
    }));
    return { ok: true, row: updated };
}

// ── summaries ────────────────────────────────────────────────────────────────

async function postAlert(guild, cfgRow, embed) {
    const id = cfgRow?.alert_channel_id;
    if (!id) return null;
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (!ch?.isTextBased?.()) return null;
    await ch.send({ embeds: [embed] }).catch(err => logger.warn(`[RaidLockdown] alert post failed: ${err.message}`));
    return id;
}

const unix = (d) => Math.floor(new Date(d).getTime() / 1000);

async function announceStart(guild, cfgRow, row, { incidentNote, locked, lockProblems }) {
    const fields = [
        ['Action on every join', ACTION_LABEL[row.action] || row.action],
        ['Ends', `<t:${unix(row.ends_at)}:F> (<t:${unix(row.ends_at)}:R>)`],
        ['Started by', row.trigger_kind === 'auto' ? 'Auto-trigger' : userLabel(row.started_by)],
        ['Trigger', row.trigger_detail || null, false],
        ['Reason', row.reason || null, false],
        ['Discord invites', incidentNote],
        ['Channels locked', locked.length ? locked.map(id => `<#${id}>`).join(' ') : null, false],
        ['Channel problems', lockProblems.length ? lockProblems.join('\n').slice(0, 1000) : null, false],
    ];
    const embed = new EmbedBuilder().setColor(0xC0392B).setTitle(`🚨 Server Lockdown Started (#${row.id})`)
        .setDescription(`Every new member is being ${START_VERB[row.action] || row.action} until it ends. `
            + 'Allowlisted users, bot managers and bots are exempt.')
        .addFields(fields.filter(([, v]) => v).map(([name, value, inline = true]) => ({ name, value: String(value).slice(0, 1024), inline })))
        .setTimestamp();
    const alertId = await postAlert(guild, cfgRow, embed);
    void logFeatureEvent(() => (guild), 'moderation.raidLockdown', () => ({
        title: `🚨 Server Lockdown Started (#${row.id})`,
        description: embed.data.description,
        fields,
        avoidChannelIds: [alertId],
    }));
}

async function announceEnd(guild, cfgRow, row, { by, why, incidentNote, unlocked }) {
    const sum = summarise(row);
    const list = (outcome) => (sum.byOutcome[outcome] || []).slice(0, 15).map(u => `<@${u.id}>`).join(' ');
    const lasted = formatDuration(new Date(row.ended_at || Date.now()).getTime() - new Date(row.started_at).getTime());
    const fields = [
        ['Joins blocked', String(sum.blocked)],
        ['Exempt / paused', String(sum.held)],
        ['Logged only', sum.logged ? String(sum.logged) : null],
        ['Failed', sum.failed ? String(sum.failed) : null],
        ['Action', ACTION_LABEL[row.action] || row.action],
        ['Lasted', lasted],
        ['Ended', why === 'expired' ? 'Time ran out' : `By ${userLabel(by)}`],
        ['Discord invites', incidentNote],
        ['Channels unlocked', unlocked.length ? unlocked.map(id => `<#${id}>`).join(' ') : null, false],
        ['Banned', list('banned') || null, false],
        ['Kicked', list('kicked') || null, false],
        ['Timed out', list('timed_out') || null, false],
        ['Quarantined', list('quarantined') || null, false],
        ['Could not act on', list('failed') || null, false],
    ];
    const embed = new EmbedBuilder().setColor(0x2ECC71).setTitle(`✅ Server Lockdown Ended (#${row.id})`)
        .setDescription(`${sum.total} join(s) during the lockdown${sum.users.length < sum.total ? ` (first ${sum.users.length} listed on the dashboard)` : ''}. New members can join again.`)
        .addFields(fields.filter(([, v]) => v).map(([name, value, inline = true]) => ({ name, value: String(value).slice(0, 1024), inline })))
        .setTimestamp();
    const alertId = await postAlert(guild, cfgRow, embed);
    void logFeatureEvent(() => (guild), 'moderation.raidLockdown', () => ({
        title: `✅ Server Lockdown Ended (#${row.id})`,
        description: embed.data.description,
        fields,
        avoidChannelIds: [alertId],
    }));
}

// ── same-name floods ─────────────────────────────────────────────────────────

/**
 * Act on a same-name group the tracker found. `already` (Set) holds the user ids acted on for this
 * guild recently, so a group that grows is only acted on for its new members.
 * @returns {Promise<{ results: Array<{id:string, outcome:string, problem?:string}>, incidentId:number|null }>}
 */
export async function actOnGroup(guild, cfgRow, group, already) {
    const s = lockdownSettings(cfgRow);
    const results = [];
    for (const userId of group.userIds) {
        if (already.has(userId)) continue;
        already.add(userId);
        const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
        if (!member) { results.push({ id: userId, outcome: 'gone' }); continue; }
        const out = await actOnMember(member, s.sameNameAction, {
            source: 'Same-name join flood',
            reason: `Same-name join flood: ${group.userIds.length} accounts named like "${group.key}"`,
            timeoutUntil: Date.now() + 60 * MINUTE,
        });
        results.push({ id: userId, outcome: out.outcome, problem: out.problem });
    }
    if (!results.length) return { results, incidentId: null };

    // The flood goes on the raid incident history, beside the join-rate raids.
    let incidentId = null;
    try {
        const [r] = await pool.execute(
            'INSERT INTO raid_incidents (guild_id, join_count, new_account_count, action_taken, affected_users, notes) VALUES (?, ?, 0, ?, ?, ?)',
            [guild.id, group.userIds.length, `Same-name flood: ${s.sameNameAction}`.slice(0, 50), JSON.stringify(group.userIds),
                `Name "${group.key}"`.slice(0, 500)]);
        incidentId = r.insertId;
    } catch (err) { logger.warn(`[RaidLockdown] same-name incident not recorded: ${err.message}`); }

    const done = results.filter(r => BLOCKED.has(r.outcome));
    logger.warn(`[RaidLockdown] same-name flood "${group.key}" in ${guild.id}: ${group.userIds.length} accounts, ${done.length} ${s.sameNameAction}`);
    const fields = [
        ['Name', `\`${group.key}\``],
        ['Accounts', String(group.userIds.length)],
        ['Action', ACTION_LABEL[s.sameNameAction]],
        ['Acted on', results.map(r => `<@${r.id}> ${OUTCOME_WORD[r.outcome] || r.outcome}`).join('\n').slice(0, 1000), false],
        ['Incident', incidentId ? `#${incidentId}` : null],
    ];
    const embed = new EmbedBuilder().setColor(0xC0392B).setTitle('👥 Same-Name Join Flood')
        .setDescription(`${group.userIds.length} accounts with the same name joined within ${s.sameNameWindowSeconds}s.`)
        .addFields(fields.filter(([, v]) => v).map(([name, value, inline = true]) => ({ name, value, inline })))
        .setTimestamp();
    const alertId = await postAlert(guild, cfgRow, embed);
    void logFeatureEvent(() => (guild), 'moderation.sameNameFlood', () => ({
        title: '👥 Same-Name Join Flood',
        description: embed.data.description,
        fields,
        avoidChannelIds: [alertId],
        throttle: { key: `samename:${guild.id}:${group.key}`, ms: 30_000 },
    }));
    return { results, incidentId };
}

// ── Discord incident actions ─────────────────────────────────────────────────

/** What Discord says now: { dms, invites, raidDetectedAt, dmSpamDetectedAt } as Dates or null. */
export async function readIncidents(guild, { fetch = true } = {}) {
    if (fetch) {
        // GET /guilds/{id} carries incidents_data; discord.js patches guild.incidentsData from it.
        await guild.client.guilds.fetch({ guild: guild.id, force: true, cache: true }).catch(() => null);
    }
    const d = guild.incidentsData || {};
    return {
        dms: d.dmsDisabledUntil ?? null,
        invites: d.invitesDisabledUntil ?? null,
        raidDetectedAt: d.raidDetectedAt ?? null,
        dmSpamDetectedAt: d.dmSpamDetectedAt ?? null,
    };
}

const toMs = (d) => (d ? new Date(d).getTime() : null);

/**
 * Bring Discord's invite / DM pause in line with what this server wants. Never throws.
 * @returns {Promise<{ changed:boolean, error?:string, invitesPausedByUs?:boolean, invitesLiftedByUs?:boolean,
 *                     invitesKept?:boolean, state?:object }>}
 */
export async function syncIncidents(guild, { why = 'sync', lift = {} } = {}) {
    try {
        const cfgRow = await getRaidConfig(guild.id);
        const s = lockdownSettings(cfgRow);
        const lock = await getActive(guild.id, { fresh: true });
        const current = await readIncidents(guild);
        const plan = planIncidentActions({
            now: Date.now(),
            keepDms: s.keepDmsDisabled,
            keepInvites: s.keepInvitesDisabled,
            lockdownInvitesUntil: lock?.pause_invites ? toMs(lock.ends_at) : null,
            current: { dms: toMs(current.dms), invites: toMs(current.invites) },
            owned: { dms: toMs(cfgRow?.incident_dms_owned_until), invites: toMs(cfgRow?.incident_invites_owned_until) },
            lift,
        });

        // Someone lifted a pause we set: that is a decision, so stop re-applying it.
        const switchesOff = {};
        if (plan.humanCleared.dms && s.keepDmsDisabled) switchesOff.keep_dms_disabled = 0;
        if (plan.humanCleared.invites && s.keepInvitesDisabled) switchesOff.keep_invites_disabled = 0;
        if (plan.humanCleared.invites && lock?.pause_invites) {
            await pool.execute('UPDATE raid_lockdowns SET pause_invites = 0 WHERE id = ?', [lock.id]).catch(() => {});
            activeCache.delete(guild.id);
        }
        if (plan.humanCleared.dms || plan.humanCleared.invites) {
            void logFeatureEvent(() => (guild), 'moderation.incidentActions', () => ({
                title: '✋ Pause Lifted By Hand',
                description: 'A pause this bot set was turned off in Discord before it ran out, so the bot will not put it back.',
                fields: [['DMs', plan.humanCleared.dms ? 'Lifted by hand' : null], ['Invites', plan.humanCleared.invites ? 'Lifted by hand' : null]],
            }));
        }

        let error = null;
        if (plan.changed) {
            if (!guild.members.me?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
                error = 'The bot needs the Manage Server permission';
            } else {
                try {
                    await guild.setIncidentActions({
                        invitesDisabledUntil: plan.body.invites ? new Date(plan.body.invites) : null,
                        dmsDisabledUntil: plan.body.dms ? new Date(plan.body.dms) : null,
                    });
                } catch (err) { error = err.message; }
            }
        }
        const owned = error ? { dms: toMs(cfgRow?.incident_dms_owned_until), invites: toMs(cfgRow?.incident_invites_owned_until) } : plan.owned;
        if (error && plan.changed) {
            // Unchanged on Discord: keep the ownership we had, only dropping what Discord says is gone.
            if (!current.dms) owned.dms = null;
            if (!current.invites) owned.invites = null;
        }
        await pool.execute(
            `INSERT INTO raid_detection_config (guild_id, incident_dms_owned_until, incident_invites_owned_until, incident_checked_at, incident_error
                 ${switchesOff.keep_dms_disabled !== undefined ? ', keep_dms_disabled' : ''}${switchesOff.keep_invites_disabled !== undefined ? ', keep_invites_disabled' : ''})
             VALUES (?, ?, ?, ?, ?${switchesOff.keep_dms_disabled !== undefined ? ', 0' : ''}${switchesOff.keep_invites_disabled !== undefined ? ', 0' : ''})
             ON DUPLICATE KEY UPDATE incident_dms_owned_until = VALUES(incident_dms_owned_until),
                 incident_invites_owned_until = VALUES(incident_invites_owned_until),
                 incident_checked_at = VALUES(incident_checked_at), incident_error = VALUES(incident_error)
                 ${switchesOff.keep_dms_disabled !== undefined ? ', keep_dms_disabled = 0' : ''}${switchesOff.keep_invites_disabled !== undefined ? ', keep_invites_disabled = 0' : ''}`,
            [guild.id, owned.dms ? new Date(owned.dms) : null, owned.invites ? new Date(owned.invites) : null, new Date(), error?.slice(0, 255) ?? null]);
        invalidateRaidConfig(guild.id);

        const before = { dms: toMs(current.dms), invites: toMs(current.invites) };
        const pausedNow = (k) => !error && plan.changed && plan.body[k] && (!before[k] || plan.body[k] > before[k]);
        const liftedNow = (k) => !error && plan.changed && !plan.body[k] && before[k];
        if (plan.changed && !error) {
            logger.info(`[RaidLockdown] incident actions set in ${guild.id} (${why}): dms=${plan.body.dms ? new Date(plan.body.dms).toISOString() : 'off'} invites=${plan.body.invites ? new Date(plan.body.invites).toISOString() : 'off'}`);
            // Routine renewals of a kept pause are not news; turning something on or off is.
            const news = (k) => (!before[k]) !== (!plan.body[k]);
            if (news('dms') || news('invites')) {
                void logFeatureEvent(() => (guild), 'moderation.incidentActions', () => ({
                    title: '🛑 Discord Invite / DM Pause Changed',
                    fields: [
                        ['DMs between members', plan.body.dms ? `Paused until <t:${Math.floor(plan.body.dms / 1000)}:R>` : 'Allowed'],
                        ['Invites', plan.body.invites ? `Paused until <t:${Math.floor(plan.body.invites / 1000)}:R>` : 'Allowed'],
                        ['Why', why],
                    ],
                }));
            }
        } else if (error) {
            logger.warn(`[RaidLockdown] incident actions failed in ${guild.id} (${why}): ${error}`);
            void logFeatureEvent(() => (guild), 'moderation.incidentActions', () => ({
                title: '⚠️ Could Not Change Discord Invite / DM Pause',
                fields: [['Problem', error, false], ['Why', why]],
                throttle: { key: `incident-err:${guild.id}`, ms: 6 * 3600_000 },
            }));
        }
        return {
            changed: plan.changed && !error,
            error: error || undefined,
            invitesPausedByUs: pausedNow('invites') || (!!plan.owned.invites && !error),
            invitesLiftedByUs: !!liftedNow('invites'),
            invitesKept: !error && !!plan.body.invites,
            state: { dms: plan.body.dms, invites: plan.body.invites },
        };
    } catch (err) {
        logger.error(`[RaidLockdown] incident sync failed in ${guild.id}: ${err.message}`);
        return { changed: false, error: err.message };
    }
}

// ── jobs (jobs/timed-moderation-job.js) ──────────────────────────────────────

let bootLogged = false;

/** Every minute: end lockdowns whose time is up. A restart resumes the rest simply by their rows. */
export async function sweepExpiredLockdowns() {
    const [rows] = await pool.execute("SELECT id, guild_id, ends_at FROM raid_lockdowns WHERE status = 'active'");
    if (!bootLogged) {
        bootLogged = true;
        if (rows.length) logger.warn(`[RaidLockdown] ${rows.length} lockdown(s) active after start-up — resumed: ${rows.map(r => `#${r.id}@${r.guild_id}`).join(', ')}`);
    }
    let ended = 0;
    for (const r of rows) {
        if (new Date(r.ends_at).getTime() > Date.now()) continue;
        const guild = resolveGuild(r.guild_id);
        if (!guild) {
            // No bot serves it right now. Keep it until one does (to unlock channels and post the
            // summary), unless it is a week overdue.
            if (Date.now() - new Date(r.ends_at).getTime() > 7 * DAY) {
                await pool.execute("UPDATE raid_lockdowns SET status = 'ended', ended_at = ?, end_reason = 'expired' WHERE id = ? AND status = 'active'", [new Date(), r.id]);
            }
            continue;
        }
        const out = await endLockdown(guild, { why: 'expired', id: r.id }).catch(err => ({ ok: false, error: err.message }));
        if (out.ok) ended++;
    }
    return ended;
}

/**
 * Hourly: renew kept pauses (renewed once under 12 h is left, so they never lapse) and settle any
 * pause we own that nothing wants any more.
 */
export async function renewIncidentActions() {
    const [rows] = await pool.execute(
        `SELECT guild_id FROM raid_detection_config
          WHERE keep_dms_disabled = 1 OR keep_invites_disabled = 1
             OR incident_dms_owned_until IS NOT NULL OR incident_invites_owned_until IS NOT NULL
         UNION
         SELECT guild_id COLLATE utf8mb4_unicode_ci FROM raid_lockdowns WHERE status = 'active' AND pause_invites = 1`);
    let synced = 0;
    for (const r of rows) {
        const guild = resolveGuild(r.guild_id);
        if (!guild) continue;
        const out = await syncIncidents(guild, { why: 'scheduled renewal' });
        if (out.changed) synced++;
    }
    return synced;
}

// ── reads for the dashboard and /lockdown ────────────────────────────────────

export async function history(guildId, limit = 20) {
    const [rows] = await pool.execute(
        `SELECT id, status, action, trigger_kind, trigger_detail, reason, started_by, started_at, ends_at, ended_at, ended_by,
                end_reason, pause_invites, invites_paused, channels_locked, joins_blocked, joins_held, joins_failed, joins_logged, blocked_users
           FROM raid_lockdowns WHERE guild_id = ? ORDER BY id DESC LIMIT ${Math.max(1, Math.min(100, Number(limit) || 20))}`,
        [guildId]);
    return rows;
}

export { summarise, lockdownSettings };

export default {
    getRaidConfig, invalidateRaidConfig, saveSettings, enableRaidDetection, raidProtectionState, getActive, enforceJoin, actOnMember, startLockdown, endLockdown,
    extendLockdown, actOnGroup, readIncidents, syncIncidents, sweepExpiredLockdowns, renewIncidentActions, history,
};
