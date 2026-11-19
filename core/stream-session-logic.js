/*
 * Pure rules for stream session history (stream_uptime) — see core/stream-session-recorder.js.
 * Kept free of the database so tests/stream-sessions.test.js can exercise the edge cases:
 * offline flickers, platforms reporting odd start times, a quick end-and-restart.
 */

/** Offline this long (since the last live sighting) before a session is closed. A full stream
 *  check cycle can take ~10 minutes, so anything shorter would split a stream on one flicker. */
export const OFFLINE_CLOSE_MS = 20 * 60_000;

/** Open sessions with no live sighting for this long are closed by the periodic sweep (the bot was
 *  down, or the streamer stopped being tracked mid-stream). */
export const STALE_SESSION_MS = 2 * 60 * 60_000;

/** A reported start this much later than the open session's start is a new broadcast. */
export const NEW_BROADCAST_GAP_MS = 10 * 60_000;

/** A closed session whose start is within this of a newly reported start is the same broadcast. */
export const REOPEN_MATCH_MS = 10 * 60_000;

/** Don't rewrite last_seen_at more often than this per session unless something else changed. */
export const WRITE_THROTTLE_MS = 45_000;

/** Identity of a channel across platforms: lower-cased so "Foo" and "foo" are one session. */
export function sessionKey(platform, username) {
    return `${String(platform || '').toLowerCase()}:${String(username || '').toLowerCase()}`.slice(0, 191);
}

/**
 * The platform's own "started at", if it is believable: not in the future (beyond clock skew) and
 * not more than two days old. Otherwise null and the first sighting is used.
 */
export function parseStartedAt(raw, nowMs) {
    if (raw == null || raw === '') return null;
    let t;
    if (raw instanceof Date) t = raw.getTime();
    else if (typeof raw === 'number') t = raw < 1e12 ? raw * 1000 : raw;
    else {
        const s = String(raw).trim();
        // "2026-10-05 13:00:00" (no zone) is UTC on the platforms that send it.
        t = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
    }
    if (!Number.isFinite(t)) return null;
    if (t > nowMs + 5 * 60_000) return null;
    if (nowMs - t > 48 * 60 * 60_000) return null;
    return t;
}

export function isNewBroadcast({ openStartMs, reportedStartMs }) {
    if (!Number.isFinite(openStartMs) || !Number.isFinite(reportedStartMs)) return false;
    return reportedStartMs - openStartMs > NEW_BROADCAST_GAP_MS;
}

export function shouldClose({ lastSeenMs, nowMs, graceMs = OFFLINE_CLOSE_MS }) {
    if (!Number.isFinite(lastSeenMs)) return true;
    return nowMs - lastSeenMs >= graceMs;
}

export function viewerCount(streamData) {
    const v = Number(streamData?.viewer_count ?? streamData?.viewers ?? streamData?.viewerCount);
    return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

export function clampText(value, max = 255) {
    if (value == null) return null;
    const s = String(value).trim();
    if (!s) return null;
    return s.length > max ? s.slice(0, max) : s;
}

/** "3h 05m" / "42m" — for history listings. */
export function formatSessionDuration(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

export default {
    OFFLINE_CLOSE_MS, STALE_SESSION_MS, NEW_BROADCAST_GAP_MS, REOPEN_MATCH_MS, WRITE_THROTTLE_MS,
    sessionKey, parseStartedAt, isNewBroadcast, shouldClose, viewerCount, clampText, formatSessionDuration,
};
