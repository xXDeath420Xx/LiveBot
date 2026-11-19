// Pure birthday validation + age helpers. No DB/Discord imports.

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // Feb=29 (leap-born allowed)

/** Parse a clean non-negative integer from text, or null. */
export function parseIntStrict(text) {
    const s = String(text ?? '').trim();
    if (!/^\d+$/.test(s)) return null;
    return parseInt(s, 10);
}

/**
 * Validate a birthday. Year is optional (null/undefined = no year).
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateBirthday(month, day, year) {
    if (!Number.isInteger(month) || month < 1 || month > 12) {
        return { ok: false, error: 'Month must be between 1 and 12.' };
    }
    if (!Number.isInteger(day) || day < 1 || day > DAYS_IN_MONTH[month - 1]) {
        return { ok: false, error: `Day must be between 1 and ${DAYS_IN_MONTH[month - 1]} for that month.` };
    }
    if (year !== null && year !== undefined) {
        const nowYear = new Date().getFullYear();
        if (!Number.isInteger(year) || year < 1900 || year > nowYear) {
            return { ok: false, error: `Year must be between 1900 and ${nowYear} (or leave it blank).` };
        }
        if (nowYear - year > 120) {
            return { ok: false, error: 'That birth year is out of range.' };
        }
    }
    return { ok: true };
}

/** Birthdays are announced at midnight in this zone, for every server. */
export const BIRTHDAY_ZONE = 'America/New_York';

/** The birthday role is taken back this long after the announcement that gave it. */
export const BIRTHDAY_ROLE_HOURS = 24;

export function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** The calendar date (year, month 1-12, day) at instant `now` in `zone`. */
export function dateIn(zone = BIRTHDAY_ZONE, now = new Date()) {
    const parts = {};
    for (const p of new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now)) {
        if (p.type !== 'literal') parts[p.type] = Number(p.value);
    }
    return { year: parts.year, month: parts.month, day: parts.day };
}

/** 'YYYY-MM-DD' for a { year, month, day }. */
export function isoDate({ year, month, day }) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The saved birthdays celebrated on a calendar date. Someone born on 29 February is celebrated on
 * the 28th in years without a 29th; otherwise a date only matches itself.
 */
export function birthdaysOn({ year, month, day }) {
    const out = [{ month, day }];
    if (month === 2 && day === 28 && !isLeapYear(year)) out.push({ month: 2, day: 29 });
    return out;
}

/**
 * The next date (local midnight) a birthday is celebrated, on or after `today` (a local-midnight
 * Date). 29 February falls on the 28th in years without one.
 */
export function nextBirthdayDate(month, day, today) {
    const on = (year) => new Date(year, month - 1, month === 2 && day === 29 && !isLeapYear(year) ? 28 : day);
    const thisYear = on(today.getFullYear());
    return thisYear < today ? on(today.getFullYear() + 1) : thisYear;
}

/**
 * Age the person reaches in `today`'s year. Announcements fire on the birthday,
 * so age = today's year - birth year. Returns null when no year is known.
 */
export function computeAge(year, today) {
    if (year === null || year === undefined) return null;
    return today.getFullYear() - year;
}
