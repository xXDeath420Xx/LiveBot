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

/**
 * Age the person reaches in `today`'s year. Announcements fire on the birthday,
 * so age = today's year - birth year. Returns null when no year is known.
 */
export function computeAge(year, today) {
    if (year === null || year === undefined) return null;
    return today.getFullYear() - year;
}
