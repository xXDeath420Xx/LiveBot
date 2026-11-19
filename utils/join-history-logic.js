/*
 * The join gate's rejoin limit: the pure rules (no DB, no Discord), so they are unit-tested.
 *
 * A "join" is one arrival in a server. The same arrival can reach us from up to four places — our own
 * live record, Discord's "X joined" system message, audit_logs and invite_tracker_logs — each stamped a
 * few seconds apart, so times within TOLERANCE_MS of one another are the same join.
 */
export const TOLERANCE_MS = 2 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

/** What the limit can do. `none` observes and logs only, for trialling the rule before arming it. */
export const REJOIN_ACTIONS = Object.freeze(['ban', 'kick', 'apply', 'none']);

export function normaliseAction(value) {
    const v = String(value ?? '').toLowerCase();
    return REJOIN_ACTIONS.includes(v) ? v : 'ban';
}

export function toMs(value) {
    if (value == null) return NaN;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    return Date.parse(value);
}

/**
 * Join times from `candidates` that are not already known: not within `toleranceMs` of an `existing`
 * time, nor of an earlier candidate. Candidates are taken oldest first, so where sources disagree by
 * a few seconds the earliest stamp (normally Discord's own join message) is the one kept.
 * @returns {number[]} epoch ms, ascending
 */
export function newJoins(existing, candidates, toleranceMs = TOLERANCE_MS) {
    const known = existing.map(toMs).filter(Number.isFinite);
    const fresh = [];
    for (const t of candidates.map(toMs).filter(Number.isFinite).sort((a, b) => a - b)) {
        if (known.some(k => Math.abs(k - t) <= toleranceMs)) continue;
        known.push(t);
        fresh.push(t);
    }
    return fresh;
}

/**
 * The moment joins start counting from: the latest of a reset (staff, or an unban), an approved
 * application, and the start of the counting window. null means all time.
 */
export function countFrom({ resetAt = null, approvedAt = null, windowDays = 0, now = Date.now() } = {}) {
    const days = Number(windowDays);
    const starts = [toMs(resetAt), toMs(approvedAt), days > 0 ? now - days * DAY : NaN].filter(Number.isFinite);
    return starts.length ? new Date(Math.max(...starts)) : null;
}

/** Is a member over the limit? `count` includes the join being decided; `maxJoins` joins are allowed. */
export function overLimit(count, maxJoins) {
    const max = Number(maxJoins);
    return Number.isInteger(max) && max >= 1 && Number(count) > max;
}

/** "3rd", "11th", "22nd" — for the DM and the log. */
export function ordinal(n) {
    const v = Math.abs(Math.trunc(n)) % 100;
    const suffix = (v >= 11 && v <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[v % 10] || 'th';
    return `${n}${suffix}`;
}
