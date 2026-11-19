/*
 * Pure helpers for temporary bans and temporary roles (core/timed-moderation-manager.js,
 * jobs/timed-moderation-job.js). Unit-tested in tests/timed-moderation.test.js.
 */
import { parseTimeToSeconds } from '../utils/timeParser.js';

const MINUTE = 60_000;
const DAY = 86_400_000;

export const TEMP_BAN_LIMITS = Object.freeze({ minMs: MINUTE, maxMs: 365 * DAY });
export const TEMP_ROLE_LIMITS = Object.freeze({ minMs: MINUTE, maxMs: 365 * DAY });

/** Attempts before an expiry that keeps failing is given up on (and reported). */
export const MAX_ATTEMPTS = 12;

/** Discord caps an audit-log reason at 512 characters. */
const REASON_MAX = 512;

/**
 * Parse a moderator-typed duration ("30m", "2h", "7d", "1w 2d") within limits.
 * @returns {{ok:true, ms:number, minutes:number} | {ok:false, error:string}}
 */
export function parseModerationDuration(input, { minMs, maxMs }) {
    const raw = String(input ?? '').trim();
    if (!raw) return { ok: false, error: 'No duration given.' };
    if (raw.length > 40) return { ok: false, error: 'That duration is too long to read — use something like `7d`.' };
    // parseTimeToSeconds is lenient (it pulls number+unit pairs out of any string); insist the whole
    // input is made of such pairs so "7 days please" is rejected instead of half-read.
    if (!/^(\s*\d+\s*(mo|w|d|h|m|s)\s*,?)+$/i.test(raw)) {
        return { ok: false, error: 'Use a duration like `30m`, `12h`, `7d` or `1w 2d`.' };
    }
    const seconds = parseTimeToSeconds(raw.replace(/\s+/g, ''));
    if (!seconds) return { ok: false, error: 'Use a duration like `30m`, `12h`, `7d` or `1w 2d`.' };
    const ms = seconds * 1000;
    if (ms < minMs) return { ok: false, error: `The shortest allowed duration is ${Math.round(minMs / MINUTE)} minute(s).` };
    if (ms > maxMs) return { ok: false, error: `The longest allowed duration is ${Math.round(maxMs / DAY)} days.` };
    return { ok: true, ms, minutes: Math.max(1, Math.round(ms / MINUTE)) };
}

/** Marker written into the Discord ban reason, so expiry can tell the ban is still the one we placed. */
export function tempBanMarker(rowId) {
    return `[tempban #${rowId}]`;
}

/** Ban reason with the marker appended, trimmed to fit Discord's limit (the marker always survives). */
export function banReasonWithMarker(reason, rowId) {
    const marker = tempBanMarker(rowId);
    const base = String(reason || 'No reason provided').trim();
    const room = REASON_MAX - marker.length - 1;
    const trimmed = base.length > room ? `${base.slice(0, Math.max(0, room - 1))}…` : base;
    return `${trimmed} ${marker}`;
}

/**
 * Is the ban currently on the user still the one this row placed? A ban that was lifted and
 * re-applied by hand (or by another command) carries a different reason, and must NOT be undone
 * when this timer runs out.
 */
export function banCarriesMarker(banReason, rowId) {
    return typeof banReason === 'string' && banReason.includes(tempBanMarker(rowId));
}

/** Minutes to wait after the Nth failed attempt before trying again: 1, 2, 4 … capped at 12h. */
export function backoffMinutes(attempts) {
    const n = Math.max(0, Math.floor(Number(attempts) || 0));
    return Math.min(2 ** n, 720);
}

/** Short error text for the last_error VARCHAR(255) column. */
export function errorText(err) {
    const code = err && err.code !== undefined ? `[${err.code}] ` : '';
    return `${code}${err?.message || String(err)}`.slice(0, 255);
}

/** Unix seconds for a Discord <t:…> timestamp. */
export function unixSeconds(ms) {
    return Math.floor(Number(ms) / 1000);
}
