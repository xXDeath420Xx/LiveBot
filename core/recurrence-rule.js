/*
 * Recurrence rules for bot-managed Discord scheduled events (recurring_events.recurrence_rule).
 *
 * A rule is stored as JSON:
 *
 *   { "freq": "daily" | "weekly" | "monthly", "interval": 1-12, "tz": "America/New_York",
 *     "anchor": "2026-10-09T20:00" }
 *
 * `anchor` is the FIRST occurrence as a local wall-clock time in `tz`. Occurrence k is the anchor
 * plus k × interval days / weeks / months, again on the local wall clock — so "every Friday at
 * 20:00 New York time" stays at 20:00 across a DST change instead of drifting by an hour, which
 * is what adding a fixed number of milliseconds would do. Monthly rules on the 29th–31st clamp to
 * the last day of shorter months rather than skipping them.
 *
 * Dependency-free on purpose (time zones come from Intl, which ships with Node's full ICU): the
 * maths is the part worth testing, and the tests have to run without node_modules.
 */

export const FREQUENCIES = Object.freeze(['daily', 'weekly', 'monthly']);
export const MAX_INTERVAL = 12;

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const formatters = new Map();

function formatterFor(tz) {
    let f = formatters.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            hourCycle: 'h23',
            year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric', second: 'numeric',
        });
        formatters.set(tz, f);
    }
    return f;
}

/** True when `tz` is an IANA zone this runtime knows. */
export function isValidTimeZone(tz) {
    if (!tz || typeof tz !== 'string') return false;
    try {
        formatterFor(tz);
        return true;
    } catch {
        return false;
    }
}

/** Wall-clock parts of a UTC instant as seen in `tz`. */
function wallClock(ms, tz) {
    const out = {};
    for (const p of formatterFor(tz).formatToParts(new Date(ms))) {
        if (p.type !== 'literal') out[p.type] = Number(p.value);
    }
    if (out.hour === 24) out.hour = 0;
    return out;
}

/** Offset of `tz` from UTC at instant `ms`, in milliseconds (east positive). */
export function zoneOffsetMs(ms, tz) {
    const whole = ms - (((ms % 1000) + 1000) % 1000);
    const p = wallClock(whole, tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

/**
 * The UTC instant at which the wall clock in `tz` reads the given local time. Month is 1-based;
 * out-of-range days roll over the way Date.UTC does. A local time inside a spring-forward gap does
 * not exist and comes back shifted by the gap; an ambiguous fall-back time resolves to one of its
 * two instants. Both are fine for event scheduling.
 */
export function localToUtc(year, month, day, hour, minute, tz) {
    const guess = Date.UTC(year, month - 1, day, hour, minute);
    const first = zoneOffsetMs(guess - zoneOffsetMs(guess, tz), tz);
    const candidate = guess - first;
    const second = zoneOffsetMs(candidate, tz);
    return second === first ? candidate : guess - second;
}

/** Parse "YYYY-MM-DD HH:MM" (or with a T) into parts, or null. */
export function parseLocalDateTime(input) {
    const m = String(input ?? '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const [year, month, day, hour, minute] = m.slice(1).map(Number);
    if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return null;
    if (day > daysInMonth(year, month)) return null;
    return { year, month, day, hour, minute };
}

function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(n) {
    return String(n).padStart(2, '0');
}

/**
 * Validate and normalise a rule from user input or storage. Accepts the JSON string straight out
 * of the column. Returns the normalised rule, or null if anything about it is unusable.
 */
export function parseRule(raw) {
    let rule = raw;
    if (typeof raw === 'string') {
        try { rule = JSON.parse(raw); } catch { return null; }
    }
    if (!rule || typeof rule !== 'object') return null;

    const freq = String(rule.freq || '').toLowerCase();
    if (!FREQUENCIES.includes(freq)) return null;

    const interval = Number(rule.interval ?? 1);
    if (!Number.isInteger(interval) || interval < 1 || interval > MAX_INTERVAL) return null;

    const tz = rule.tz || 'UTC';
    if (!isValidTimeZone(tz)) return null;

    const anchor = parseLocalDateTime(rule.anchor);
    if (!anchor) return null;

    return {
        freq,
        interval,
        tz,
        anchor: `${anchor.year}-${pad(anchor.month)}-${pad(anchor.day)}T${pad(anchor.hour)}:${pad(anchor.minute)}`,
    };
}

/** Build a rule from command input. Throws an Error whose message is written for the user. */
export function buildRule({ freq, interval = 1, tz = 'UTC', start }) {
    const anchor = parseLocalDateTime(start);
    if (!anchor) throw new Error('Start must look like `2026-10-09 20:00` (year-month-day hour:minute, 24h).');
    if (!isValidTimeZone(tz)) throw new Error(`Unknown time zone \`${tz}\`. Use a name like \`America/New_York\` or \`Europe/London\`.`);
    const rule = parseRule({
        freq, interval, tz,
        anchor: `${anchor.year}-${pad(anchor.month)}-${pad(anchor.day)}T${pad(anchor.hour)}:${pad(anchor.minute)}`,
    });
    if (!rule) throw new Error('That repeat setting is not supported.');
    return rule;
}

/** The UTC instant of occurrence number `k` (0 = the anchor). */
export function occurrenceAt(rule, k) {
    const a = parseLocalDateTime(rule.anchor);
    const step = k * rule.interval;
    let year = a.year;
    let month = a.month;
    let day = a.day;

    if (rule.freq === 'daily' || rule.freq === 'weekly') {
        const d = new Date(Date.UTC(a.year, a.month - 1, a.day + step * (rule.freq === 'weekly' ? 7 : 1)));
        year = d.getUTCFullYear();
        month = d.getUTCMonth() + 1;
        day = d.getUTCDate();
    } else {
        const total = (a.month - 1) + step;
        year = a.year + Math.floor(total / 12);
        month = (((total % 12) + 12) % 12) + 1;
        day = Math.min(a.day, daysInMonth(year, month));
    }
    return localToUtc(year, month, day, a.hour, a.minute, rule.tz);
}

/**
 * First occurrence strictly after `afterMs`. Returns `{ index, startMs }`.
 * Jumps close with an estimate and then steps, so a rule anchored years ago costs a few
 * iterations rather than one per elapsed period.
 */
export function nextOccurrenceAfter(rule, afterMs) {
    const first = occurrenceAt(rule, 0);
    if (first > afterMs) return { index: 0, startMs: first };

    const unit = rule.freq === 'daily' ? DAY_MS : rule.freq === 'weekly' ? 7 * DAY_MS : 28 * DAY_MS;
    let k = Math.max(0, Math.floor((afterMs - first) / (unit * rule.interval)) - 2);
    // Monthly estimates use the shortest month, so k can only undershoot; the loop walks it up.
    for (let guard = 0; guard < 2000; guard++, k++) {
        const t = occurrenceAt(rule, k);
        if (t > afterMs) return { index: k, startMs: t };
    }
    throw new Error('recurrence: no occurrence found (rule is malformed)');
}

/** Human description, e.g. "Every 2 weeks on Friday at 20:00 (America/New_York)". */
export function describeRule(rule) {
    const a = parseLocalDateTime(rule.anchor);
    const time = `${pad(a.hour)}:${pad(a.minute)}`;
    const weekday = WEEKDAYS[new Date(Date.UTC(a.year, a.month - 1, a.day)).getUTCDay()];
    const every = (unit) => (rule.interval === 1 ? `Every ${unit}` : `Every ${rule.interval} ${unit}s`);
    let text;
    if (rule.freq === 'daily') text = `${every('day')} at ${time}`;
    else if (rule.freq === 'weekly') text = `${every('week')} on ${weekday} at ${time}`;
    else text = `${every('month')} on day ${a.day} at ${time}`;
    return `${text} (${rule.tz})`;
}

export default {
    FREQUENCIES, MAX_INTERVAL, isValidTimeZone, zoneOffsetMs, localToUtc, parseLocalDateTime,
    parseRule, buildRule, occurrenceAt, nextOccurrenceAfter, describeRule,
};
