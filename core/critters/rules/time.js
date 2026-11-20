/*
 * Local-midnight helpers. "Local" is the bot process's time zone (UTC on the server). Daily drops, give caps,
 * cookies, the couple bonus and lottery draws all reset at local midnight; dailies and luck rolls are rolling.
 */

export function lastLocalMidnight(now = new Date()) {
    const d = new Date(now.getTime());
    d.setHours(0, 0, 0, 0);
    return d;
}

export function nextLocalMidnight(now = new Date()) {
    const d = lastLocalMidnight(now);
    d.setDate(d.getDate() + 1);
    return d;
}

export function msUntilNextMidnight(now = new Date()) {
    return nextLocalMidnight(now).getTime() - now.getTime();
}

/** True when `stamp` (Date or null) is before the last local midnight, i.e. belongs to an earlier day. */
export function isBeforeToday(stamp, now = new Date()) {
    if (!stamp) return true;
    const t = stamp instanceof Date ? stamp.getTime() : new Date(stamp).getTime();
    if (!Number.isFinite(t)) return true;
    return t < lastLocalMidnight(now).getTime();
}

export const toDate = (v) => (v == null ? null : v instanceof Date ? v : new Date(v));
