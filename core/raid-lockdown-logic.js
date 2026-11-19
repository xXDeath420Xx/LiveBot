/*
 * Raid lockdown, auto-trigger, same-name join floods and Discord incident actions — the pure rules
 * (no Discord or DB access, unit-tested in tests/raid-lockdown.test.js). The live side is
 * core/raid-lockdown.js; the join tracker that feeds it is core/raid-detection-manager.js.
 *
 *   lockdown        while a row in raid_lockdowns is 'active' and its end time is in the future,
 *                   every new join is kicked / banned / timed out / quarantined / logged. The row
 *                   IS the state, so a restart resumes it and an expired one is ended by the
 *                   minute sweep (jobs/timed-moderation-job.js) or by the first join to see it.
 *   auto-trigger    N joins inside a window of S seconds starts a lockdown (Hashbot's defaults:
 *                   20 joins in 10 s, settable 3-100 joins, 5 s - 5 min, for 1 min - 24 h).
 *   same-name flood N or more joins in the window whose usernames or display names fold to the
 *                   same text (utils/text-fold.js, trailing digits ignored) are acted on as a group.
 *   incident actions Discord's own "pause invites" / "pause DMs" (PUT /guilds/{id}/incident-actions).
 *                   Discord caps both at 24 hours ahead, so a "keep disabled" switch is renewed by
 *                   the hourly housekeeping long before it runs out. We only ever clear a pause we
 *                   set ourselves: ownership is the exact time we last wrote, compared with what
 *                   Discord reports now.
 */

import { foldConfusables, foldLeet } from '../utils/text-fold.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** What a lockdown (or a same-name flood) does to a join. 'log' records and touches nobody. */
export const LOCKDOWN_ACTIONS = Object.freeze(['kick', 'ban', 'timeout', 'quarantine', 'log']);
export const ACTION_LABEL = Object.freeze({
    kick: 'Kick', ban: 'Ban', timeout: 'Timeout', quarantine: 'Quarantine', log: 'Log only',
});

export const LIMITS = Object.freeze({
    autoJoins: [3, 100],
    autoWindowSeconds: [5, 300],
    autoDurationMinutes: [1, 1440],
    manualDurationMs: [MINUTE, 7 * DAY],
    sameNameCount: [3, 50],
    sameNameWindowSeconds: [30, 600],
});

export const DEFAULTS = Object.freeze({
    lockdownAction: 'kick',
    lockdownDurationMinutes: 60,
    autoJoins: 20,
    autoWindowSeconds: 10,
    autoDurationMinutes: 60,
    autoAction: 'kick',
    sameNameCount: 5,
    sameNameWindowSeconds: 300,
    sameNameAction: 'ban',
});

/** Discord refuses an incident-action time more than 24 hours ahead. */
export const INCIDENT_MAX_MS = DAY;
/** Renew a kept pause once less than this is left (the hourly sweep then always has 11 h of slack). */
export const INCIDENT_RENEW_BEFORE_MS = 12 * HOUR;
/** Discord may round the time it stores; two times this close are the same pause. */
export const INCIDENT_TOLERANCE_MS = 2 * MINUTE;

const clampInt = (value, [min, max], fallback) => {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
};

/** Any unknown action reads as the given default. */
export function normaliseAction(value, fallback = 'kick') {
    const v = String(value ?? '').toLowerCase();
    return LOCKDOWN_ACTIONS.includes(v) ? v : fallback;
}

/** raid_detection_config row (or nothing) -> every lockdown-related setting, clamped to the limits. */
export function lockdownSettings(row = {}) {
    const r = row || {};
    let channelIds = [];
    try {
        const parsed = typeof r.lockdown_channel_ids === 'string' ? JSON.parse(r.lockdown_channel_ids) : r.lockdown_channel_ids;
        if (Array.isArray(parsed)) channelIds = parsed.filter(id => /^\d{15,25}$/.test(String(id))).map(String).slice(0, 25);
    } catch { channelIds = []; }
    return {
        lockdownAction: normaliseAction(r.lockdown_action, DEFAULTS.lockdownAction),
        lockdownDurationMinutes: clampInt(r.lockdown_duration_minutes, [1, 7 * 1440], DEFAULTS.lockdownDurationMinutes),
        lockdownPauseInvites: r.lockdown_pause_invites == null ? true : !!Number(r.lockdown_pause_invites),
        lockdownLockChannels: !!Number(r.lockdown_lock_channels ?? 0),
        lockdownChannelIds: channelIds,
        lockdownDm: r.lockdown_dm == null ? true : !!Number(r.lockdown_dm),
        autoEnabled: !!Number(r.auto_lockdown_enabled ?? 0),
        autoJoins: clampInt(r.auto_lockdown_joins, LIMITS.autoJoins, DEFAULTS.autoJoins),
        autoWindowSeconds: clampInt(r.auto_lockdown_window_seconds, LIMITS.autoWindowSeconds, DEFAULTS.autoWindowSeconds),
        autoDurationMinutes: clampInt(r.auto_lockdown_duration_minutes, LIMITS.autoDurationMinutes, DEFAULTS.autoDurationMinutes),
        autoAction: normaliseAction(r.auto_lockdown_action, DEFAULTS.autoAction),
        autoPauseInvites: r.auto_lockdown_pause_invites == null ? true : !!Number(r.auto_lockdown_pause_invites),
        autoLockChannels: !!Number(r.auto_lockdown_lock_channels ?? 0),
        sameNameEnabled: !!Number(r.same_name_enabled ?? 0),
        sameNameCount: clampInt(r.same_name_count, LIMITS.sameNameCount, DEFAULTS.sameNameCount),
        sameNameWindowSeconds: clampInt(r.same_name_window_seconds, LIMITS.sameNameWindowSeconds, DEFAULTS.sameNameWindowSeconds),
        sameNameAction: normaliseAction(r.same_name_action, DEFAULTS.sameNameAction),
        keepDmsDisabled: !!Number(r.keep_dms_disabled ?? 0),
        keepInvitesDisabled: !!Number(r.keep_invites_disabled ?? 0),
    };
}

/**
 * Validate a lockdown length. `trigger` 'auto' is held to Hashbot's 1 min - 24 h; a manual one may
 * run up to 7 days (incident-action invite pauses are renewed for as long as it lasts).
 * @returns {{ ok:true, ms:number } | { ok:false, error:string }}
 */
export function checkDuration(ms, trigger = 'manual') {
    const n = Number(ms);
    const [min, max] = trigger === 'auto'
        ? [LIMITS.autoDurationMinutes[0] * MINUTE, LIMITS.autoDurationMinutes[1] * MINUTE]
        : LIMITS.manualDurationMs;
    if (!Number.isFinite(n) || n < min) return { ok: false, error: 'The shortest lockdown is 1 minute.' };
    if (n > max) return { ok: false, error: trigger === 'auto' ? 'An automatic lockdown lasts at most 24 hours.' : 'The longest lockdown is 7 days.' };
    return { ok: true, ms: Math.round(n) };
}

const UNIT_MS = { s: 1000, m: MINUTE, h: HOUR, d: DAY, w: 7 * DAY };

/**
 * '30m', '2h', '1d', '1h30m', '90' (minutes) -> milliseconds, held to checkDuration's limits.
 * @returns {{ ok:true, ms:number } | { ok:false, error:string }}
 */
export function parseLength(text, trigger = 'manual') {
    const s = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '');
    if (!s) return { ok: false, error: 'Give a length like 30m, 2h or 1d.' };
    let total = 0;
    if (/^\d+$/.test(s)) {
        total = Number(s) * MINUTE;
    } else {
        const parts = [...s.matchAll(/(\d+)(w|d|h|m|s)/g)];
        const consumed = parts.reduce((n, p) => n + p[0].length, 0);
        if (!parts.length || consumed !== s.length) return { ok: false, error: 'Use a length like 30m, 2h, 1d or 1h30m.' };
        for (const p of parts) total += Number(p[1]) * UNIT_MS[p[2]];
    }
    return checkDuration(total, trigger);
}

const ms = (d) => (d == null ? null : d instanceof Date ? d.getTime() : typeof d === 'number' ? d : new Date(d).getTime());

/**
 * Where a raid_lockdowns row stands at `now`: 'active' (enforce), 'expired' (still marked active but
 * its time is up: end it, enforce nothing) or 'none'.
 */
export function lockdownState(row, now = Date.now()) {
    if (!row || row.status !== 'active') return 'none';
    const end = ms(row.ends_at);
    if (!Number.isFinite(end) || end <= now) return 'expired';
    return 'active';
}

export function remainingMs(row, now = Date.now()) {
    return lockdownState(row, now) === 'active' ? ms(row.ends_at) - now : 0;
}

/**
 * Was this member's arrival during the lockdown? A join replayed after a restart is enforced only
 * when the member really joined after the lockdown began (members who were already here are never
 * swept up by it).
 */
export function joinedDuring(row, joinedAt, now = Date.now()) {
    if (lockdownState(row, now) !== 'active') return false;
    const at = ms(joinedAt);
    if (!Number.isFinite(at)) return true;           // unknown join time: it is a live join event
    return at >= ms(row.started_at) - 5_000;         // a little slack for clock skew between Discord and us
}

/** Joins at or after `since` (ms) within the last `windowSeconds`. */
export function joinsInWindow(joins, now, windowSeconds, since = 0) {
    const cutoff = Math.max(now - windowSeconds * 1000, since || 0);
    return (joins || []).filter(j => j.timestamp >= cutoff && j.timestamp <= now);
}

/**
 * The auto-trigger: enough distinct people joined inside the window.
 * @returns {{ fire:boolean, count:number, userIds:string[] }}
 */
export function autoTrigger(joins, now, { autoJoins, autoWindowSeconds }, since = 0) {
    const recent = joinsInWindow(joins, now, autoWindowSeconds, since);
    const userIds = [...new Set(recent.map(j => j.userId))];
    return { fire: userIds.length >= autoJoins, count: userIds.length, userIds };
}

/**
 * The text a name is grouped by: lookalikes folded, separators gone, trailing digits dropped
 * ("JohnSmith_4821" and "johnsmith 77" both -> "johnsmith"), then leetspeak folded. Under three
 * characters there is too little to group on, so it gives null.
 */
export function nameKey(name) {
    if (name == null) return null;
    // Leet symbols survive the first pass so "j0hn_sm1th_88" still folds to "johnsmith".
    let s = foldConfusables(String(name)).replace(/[^a-z0-9@$!|]+/g, '');
    s = s.replace(/\d+$/, '');
    s = foldLeet(s, { folded: true }).replace(/[^a-z0-9]+/g, '');
    return s.length >= 3 ? s : null;
}

/** The distinct name keys of one member: username and global display name. */
export function memberNameKeys({ username, globalName, displayName } = {}) {
    const keys = new Set();
    for (const n of [username, globalName, displayName]) {
        const k = nameKey(n);
        if (k) keys.add(k);
    }
    return [...keys];
}

/**
 * Same-name join floods: joins in the window grouped by name key. A group of `sameNameCount` or more
 * distinct people is a flood. A person whose two names both flood is in both groups; a group whose
 * members were all in a bigger one already is dropped.
 * @param joins  [{ userId, timestamp, nameKeys: string[] }]
 * @returns {Array<{ key:string, userIds:string[] }>}  biggest first
 */
export function sameNameGroups(joins, now, { sameNameCount, sameNameWindowSeconds }) {
    const recent = joinsInWindow(joins, now, sameNameWindowSeconds);
    const byKey = new Map();
    for (const j of recent) {
        for (const k of j.nameKeys || []) {
            if (!byKey.has(k)) byKey.set(k, new Set());
            byKey.get(k).add(j.userId);
        }
    }
    const groups = [...byKey.entries()]
        .filter(([, ids]) => ids.size >= sameNameCount)
        .map(([key, ids]) => ({ key, userIds: [...ids] }))
        .sort((a, b) => b.userIds.length - a.userIds.length || a.key.localeCompare(b.key));
    const seen = new Set();
    const out = [];
    for (const g of groups) {
        const fresh = g.userIds.filter(id => !seen.has(id));
        fresh.forEach(id => seen.add(id));
        if (fresh.length) out.push({ key: g.key, userIds: g.userIds });
    }
    return out;
}

/**
 * A raid detected by the join-rate + new-account rule stays "hot" while raiders keep arriving: every
 * join until `tail` after the latest one belongs to it and is actioned — but never for more than an
 * hour from detection, so a busy server can't keep it hot forever (a longer siege is what the
 * lockdown is for). After that the incident stays open for the alert's buttons, but new joins are
 * judged afresh.
 */
export const RAID_MAX_HOT_MS = HOUR;

export function raidTailMs(timeframeSeconds) {
    return Math.max(10 * MINUTE, 2 * Number(timeframeSeconds || 0) * 1000);
}

export function raidStillHot(activeRaid, now, timeframeSeconds) {
    if (!activeRaid || activeRaid.status !== 'active') return false;
    if (now - activeRaid.startTime > RAID_MAX_HOT_MS) return false;
    const last = activeRaid.lastJoinAt ?? activeRaid.startTime;
    return now - last <= raidTailMs(timeframeSeconds);
}

// ── Discord incident actions ─────────────────────────────────────────────────

/**
 * What to send to PUT /guilds/{id}/incident-actions, if anything.
 *
 * @param now
 * @param keepDms, keepInvites   the server's "keep disabled" switches
 * @param lockdownInvitesUntil   end of an active lockdown that pauses invites (ms), else null
 * @param current  { dms, invites }  what Discord reports now (ms or null)
 * @param owned    { dms, invites }  the time we last wrote for each (ms or null)
 * @param lift     { dms, invites }  true: a staff member just switched this off, so lift a running pause now
 *                                   even if it is not ours, unless a running lockdown still wants it (H-660:
 *                                   the one off switch that replaces /lockdown discord clear)
 * @returns {{
 *   changed:boolean,
 *   body:{ dms:number|null, invites:number|null },   both fields, as they should be after the call
 *   owned:{ dms:number|null, invites:number|null },  what to store as ours afterwards
 *   humanCleared:{ dms:boolean, invites:boolean },   a pause we set was lifted by hand before its end
 *   humanSet:{ dms:boolean, invites:boolean },       a pause is running that is not ours
 * }}
 */
export function planIncidentActions({ now, keepDms = false, keepInvites = false, lockdownInvitesUntil = null, current = {}, owned = {}, lift = {} }) {
    const out = { changed: false, body: {}, owned: {}, humanCleared: {}, humanSet: {} };
    for (const kind of ['dms', 'invites']) {
        const rawCur = ms(current[kind]);
        const cur = Number.isFinite(rawCur) && rawCur > now ? rawCur : null;
        const own = Number.isFinite(ms(owned[kind])) ? ms(owned[kind]) : null;
        const ours = own != null && cur != null && Math.abs(cur - own) <= INCIDENT_TOLERANCE_MS;
        // We had a pause that should still be running and Discord says there is none: a person lifted it.
        const cleared = own != null && cur == null && own > now + INCIDENT_TOLERANCE_MS;
        const keep = kind === 'dms' ? keepDms : keepInvites;
        const lockUntil = kind === 'invites' ? ms(lockdownInvitesUntil) : null;

        let want = null;
        if (!cleared) {
            if (keep) want = now + INCIDENT_MAX_MS;
            else if (Number.isFinite(lockUntil) && lockUntil > now) want = Math.min(lockUntil, now + INCIDENT_MAX_MS);
        }

        let next = cur;
        let nextOwned = ours ? cur : null;
        if (want != null) {
            const enough = cur != null && (cur >= want - INCIDENT_TOLERANCE_MS || cur - now > INCIDENT_RENEW_BEFORE_MS);
            if (!enough) {
                next = want;
                nextOwned = want;
            }
        } else if (ours || (lift[kind] && cur != null)) {
            next = null;           // nothing wants it any more and it is ours (or staff just switched it off): lift it
            nextOwned = null;
        }

        if (next !== cur) out.changed = true;
        out.body[kind] = next;
        out.owned[kind] = nextOwned;
        out.humanCleared[kind] = cleared;
        out.humanSet[kind] = cur != null && !ours && next === cur;
    }
    return out;
}

// ── summaries ────────────────────────────────────────────────────────────────

/** Counts for a lockdown row, plus the list of recorded joins grouped by outcome. */
export function summarise(row) {
    let users = [];
    try {
        const parsed = typeof row?.blocked_users === 'string' ? JSON.parse(row.blocked_users) : row?.blocked_users;
        if (Array.isArray(parsed)) users = parsed;
    } catch { users = []; }
    const n = (v) => Number(v) || 0;
    const byOutcome = {};
    for (const u of users) (byOutcome[u.r] ??= []).push(u);
    return {
        blocked: n(row?.joins_blocked),
        held: n(row?.joins_held),
        failed: n(row?.joins_failed),
        logged: n(row?.joins_logged),
        total: n(row?.joins_blocked) + n(row?.joins_held) + n(row?.joins_failed) + n(row?.joins_logged),
        users,
        byOutcome,
    };
}

/** Which counter an enforcement outcome goes on. */
export function counterFor(outcome) {
    if (['banned', 'kicked', 'timed_out', 'quarantined'].includes(outcome)) return 'joins_blocked';
    if (outcome === 'held' || outcome === 'paused') return 'joins_held';
    if (outcome === 'logged') return 'joins_logged';
    return 'joins_failed';
}

/** Plain-ASCII audit-log reason (Discord shows it in the audit log; the brief forbids anything else). */
export function asciiReason(text) {
    return String(text ?? '')
        .normalize('NFKD')
        .replace(/[–—]/g, '-')
        .replace(/[^\x20-\x7E]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 400);
}

/** 'YYYY-MM-DD HH:MM UTC' — for audit-log reasons, which can't render Discord timestamps. */
export function utcStamp(at) {
    const d = new Date(ms(at));
    return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export default {
    LOCKDOWN_ACTIONS, ACTION_LABEL, LIMITS, DEFAULTS, normaliseAction, lockdownSettings, checkDuration,
    parseLength, lockdownState, remainingMs, joinedDuring, joinsInWindow, autoTrigger, nameKey, memberNameKeys,
    sameNameGroups, raidTailMs, raidStillHot, planIncidentActions, summarise, counterFor, asciiReason, utcStamp,
};
