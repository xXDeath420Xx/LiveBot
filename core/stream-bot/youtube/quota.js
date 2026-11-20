/*
 * Stream bot, YouTube: the daily quota guard (design §13.3).
 *
 * Google gives a project 10,000 units a day (YOUTUBE_STREAM_BOT_DAILY_UNITS when the project has more), reset at midnight
 * Pacific time. Every call is priced (config.js QUOTA_COST) and counted here before it is made, per day and per profile, and
 * written to stream_bot_youtube_quota every 30 seconds so a restart does not forget what was spent.
 *
 *   level   share of the day used   what changes
 *   normal  under 60 %               chat is read continuously (a stream connection right after the last)
 *   slow    60 % to 85 %             a 20 s pause between chat connections (about a third of the cost; chat arrives in bursts)
 *   critical 85 % to 97 %            a 60 s pause; bans and timeouts (200 units each) are refused
 *   exhausted 97 % or Google said quotaExceeded   nothing is called until the reset; the dashboard says when that is
 *
 *   createQuotaGuard({ dailyUnits, now, persist? })
 *     .allow(method)            → { ok, level, reason? }      without spending
 *     .spend(method, profileId) → { ok, level, reason? }      counts it when allowed
 *     .markExhausted()          Google answered quotaExceeded
 *     .level() / .gapMs() / .pollFloorMs() / .status(profileId) / .load() / .flush()
 *   pacificDay(ms) → 'YYYY-MM-DD';  nextPacificMidnight(ms) → ms
 */
import { QUOTA_COST } from './config.js';

export const LEVELS = Object.freeze({ slow: 0.60, critical: 0.85, exhausted: 0.97 });
const GAP_MS = Object.freeze({ normal: 0, slow: 20_000, critical: 60_000, exhausted: 5 * 60_000 });
const POLL_FLOOR_MS = Object.freeze({ normal: 10_000, slow: 30_000, critical: 60_000, exhausted: 5 * 60_000 });
const FLUSH_MS = 30_000;

const pacific = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
/** The Pacific calendar day a moment falls on (Google's quota day). */
export function pacificDay(ms = Date.now()) { return pacific.format(new Date(ms)); }

/** The next midnight in Los Angeles after `ms` (the quota reset), found by stepping (DST-safe). */
export function nextPacificMidnight(ms = Date.now()) {
    const today = pacificDay(ms);
    let lo = ms;
    let hi = ms + 26 * 3600_000;
    while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (pacificDay(mid) === today) lo = mid; else hi = mid;
    }
    return hi;   // the first millisecond of the next Pacific day
}

export const EXPLAIN = Object.freeze({
    normal: 'Chat is read continuously.',
    slow: 'More than 60% of today\'s YouTube allowance is used, so chat is read in bursts with a 20-second pause between them. Replies may be a little slower.',
    critical: 'More than 85% of today\'s YouTube allowance is used: chat is read once a minute, and bans and timeouts are paused until the reset.',
    exhausted: 'Today\'s YouTube allowance is used up. CertiFried stops calling YouTube until it resets at midnight Pacific time; Twitch and Kick are not affected.',
});

export function createQuotaGuard({ dailyUnits = 10_000, now = () => Date.now(), persist = null, logger = null } = {}) {
    let day = pacificDay(now());
    let used = 0;
    let exhaustedDay = null;
    const byProfile = new Map();     // profileId -> { units, calls }
    let pending = new Map();         // profileId -> { units, calls } not yet written
    let timer = null;

    function roll() {
        const d = pacificDay(now());
        if (d !== day) {
            day = d;
            used = 0;
            byProfile.clear();
            pending = new Map();
        }
    }
    function level() {
        roll();
        if (exhaustedDay === day) return 'exhausted';
        const share = used / dailyUnits;
        if (share >= LEVELS.exhausted) return 'exhausted';
        if (share >= LEVELS.critical) return 'critical';
        if (share >= LEVELS.slow) return 'slow';
        return 'normal';
    }
    function allow(method) {
        const cost = QUOTA_COST[method];
        if (cost == null) return { ok: false, level: level(), reason: 'unknown_method' };
        const lv = level();
        if (lv === 'exhausted') return { ok: false, level: lv, reason: 'exhausted' };
        if (method === 'liveChatBans.insert' && lv === 'critical') return { ok: false, level: lv, reason: 'critical' };
        if (used + cost > dailyUnits) return { ok: false, level: lv, reason: 'exhausted' };
        return { ok: true, level: lv };
    }
    function spend(method, profileId = 0) {
        const a = allow(method);
        if (!a.ok) return a;
        const cost = QUOTA_COST[method];
        used += cost;
        const pid = Number(profileId) || 0;
        for (const map of [byProfile, pending]) {
            const row = map.get(pid) || { units: 0, calls: 0 };
            row.units += cost;
            row.calls += 1;
            map.set(pid, row);
        }
        return { ok: true, level: level() };
    }
    async function flush() {
        if (!persist || !pending.size) return;
        const batch = pending;
        const d = day;
        pending = new Map();
        try {
            await persist.add(d, [...batch.entries()].map(([profileId, r]) => ({ profileId, ...r })));
        } catch (err) {
            // Put it back: counted in memory either way; the table only survives restarts.
            for (const [pid, r] of batch) {
                const row = pending.get(pid) || { units: 0, calls: 0 };
                row.units += r.units;
                row.calls += r.calls;
                pending.set(pid, row);
            }
            try { logger?.warn?.('[StreamBotYouTube] quota log write failed', { error: err?.message }); } catch { /* ignore */ }
        }
    }
    async function load() {
        if (!persist) return;
        roll();
        try {
            const rows = await persist.load(day);
            used = 0;
            byProfile.clear();
            for (const r of rows || []) {
                used += Number(r.units) || 0;
                byProfile.set(Number(r.profileId) || 0, { units: Number(r.units) || 0, calls: Number(r.calls) || 0 });
            }
            // What this process spent before load() finished is still in `pending`.
            for (const [pid, r] of pending) {
                used += r.units;
                const row = byProfile.get(pid) || { units: 0, calls: 0 };
                byProfile.set(pid, { units: row.units + r.units, calls: row.calls + r.calls });
            }
        } catch { /* table missing: memory only */ }
    }

    return {
        allow, spend, level, load, flush,
        markExhausted() { roll(); exhaustedDay = day; },
        gapMs: () => GAP_MS[level()],
        pollFloorMs: () => POLL_FLOOR_MS[level()],
        status(profileId = null) {
            const lv = level();
            const mine = profileId == null ? null : (byProfile.get(Number(profileId)) || { units: 0, calls: 0 });
            return {
                day, used, limit: dailyUnits, share: Math.min(1, used / dailyUnits), level: lv, explanation: EXPLAIN[lv],
                resetAt: new Date(nextPacificMidnight(now())).toISOString(), profileUnits: mine ? mine.units : null, profileCalls: mine ? mine.calls : null,
            };
        },
        start() { if (!timer && persist) { timer = setInterval(() => { flush().catch(() => {}); }, FLUSH_MS); timer.unref?.(); } },
        stop() { if (timer) clearInterval(timer); timer = null; },
    };
}

/** stream_bot_youtube_quota as the guard's persistence (prefix for tests). */
export function quotaTable(db, prefix = 'stream_bot_') {
    const T = `\`${prefix}youtube_quota\``;
    return {
        async load(d) {
            const [rows] = await db.query(`SELECT profile_id AS profileId, units, calls FROM ${T} WHERE day = ?`, [d]);
            return rows;
        },
        async add(d, rows) {
            for (const r of rows) {
                await db.query(`INSERT INTO ${T} (day, profile_id, units, calls) VALUES (?, ?, ?, ?)
                                ON DUPLICATE KEY UPDATE units = units + VALUES(units), calls = calls + VALUES(calls)`, [d, r.profileId, r.units, r.calls]);
            }
        },
    };
}

export default { createQuotaGuard, quotaTable, pacificDay, nextPacificMidnight, LEVELS, EXPLAIN };
