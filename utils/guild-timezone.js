/**
 * Guild timezone helpers — shared by stat-display, calendar render, and any
 * other surface that needs to format times in a guild's local zone.
 *
 * `guild_settings.timezone` may hold either:
 *   - an IANA name (e.g. "America/Los_Angeles", "Europe/London")  — DST-aware
 *   - a legacy fixed offset (e.g. "UTC-7", "UTC+5:30")             — no DST
 *
 * Prefer IANA. Legacy offsets remain supported as a fallback so existing rows
 * don't break.
 */

import pool from './db.js';

/**
 * Read the configured timezone for a guild. Returns "UTC" when nothing is set
 * — UTC is a valid IANA identifier so every helper below works uniformly.
 */
export async function getGuildTimezone(guildId) {
  try {
    const [rows] = await pool.execute(
      'SELECT timezone FROM guild_settings WHERE guild_id = ?',
      [guildId]
    );
    if (rows.length && rows[0].timezone) return rows[0].timezone;
  } catch { /* fall through to default */ }
  return 'UTC';
}

/**
 * True when `tz` is accepted by Intl as an IANA identifier.
 */
export function isIanaTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch { return false; }
}

/**
 * Parse a legacy "UTC±H[:MM]" string into an offset in milliseconds.
 * Returns 0 when the input doesn't match the legacy format.
 */
export function parseLegacyOffset(tz) {
  if (!tz) return 0;
  const m = tz.match(/^UTC([+-])(\d+)(?::(\d+))?$/);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  const hours = parseInt(m[2], 10);
  const minutes = m[3] ? parseInt(m[3], 10) : 0;
  return sign * (hours * 3_600_000 + minutes * 60_000);
}

/**
 * Format `date` as observed in `tz`. Accepts the same options as
 * Intl.DateTimeFormat. DST-aware for IANA names; static offset for legacy.
 */
export function formatTimeInZone(date, tz, options = {}) {
  const d = date instanceof Date ? date : new Date(date);
  if (isIanaTimezone(tz)) {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: tz }).format(d);
  }
  // Legacy UTC±N: shift the instant by the offset and format as UTC so
  // the *output* clock matches the desired offset.
  const offsetMs = parseLegacyOffset(tz);
  const shifted = new Date(d.getTime() + offsetMs);
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(shifted);
}

/**
 * Get the short zone label that should follow a formatted time.
 *  - IANA → "PST"/"PDT"/"GMT"/"BST"/etc., DST-aware on the supplied date.
 *    When Intl falls back to "GMT-7" style for less common zones we return that.
 *  - Legacy → returns the input as-is ("UTC-7"). Fixed-offset strings can't
 *    represent DST so we don't try to fake an abbreviation.
 */
export function getZoneAbbreviation(tz, date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (!isIanaTimezone(tz)) return tz || 'UTC';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'short',
      hour: 'numeric'
    }).formatToParts(d);
    const found = parts.find(p => p.type === 'timeZoneName')?.value;
    return found || tz;
  } catch {
    return tz;
  }
}

/**
 * Return the calendar parts of `date` as observed in `tz`. Useful when
 * bucketing events into a per-guild local day/month — `Date.getUTCDate()`
 * would otherwise rolling-fence events in the wrong cell for far-west zones.
 *
 * weekday is 0=Sun..6=Sat.
 */
export function getLocalDateParts(date, tz) {
  const d = date instanceof Date ? date : new Date(date);
  if (isIanaTimezone(tz)) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hour12: false
    }).formatToParts(d);
    const get = type => parts.find(p => p.type === type)?.value;
    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    // Intl returns hour=24 at midnight for some locales — normalize to 0.
    const hour = parseInt(get('hour') || '0', 10) % 24;
    return {
      year: parseInt(get('year'), 10),
      month: parseInt(get('month'), 10) - 1,    // 0-indexed to match JS Date
      day: parseInt(get('day'), 10),
      hour,
      minute: parseInt(get('minute') || '0', 10),
      second: parseInt(get('second') || '0', 10),
      weekday: weekdayMap[get('weekday')] ?? 0
    };
  }

  // Legacy UTC±N — apply offset and read UTC parts.
  const shifted = new Date(d.getTime() + parseLegacyOffset(tz));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay()
  };
}

/**
 * Build a local Date object representing "now" in the guild's zone.
 * Note: the returned Date's UTC fields are misleading — only its local-getter
 * values are meaningful. Useful when downstream code needs a Date instance
 * and uses `.getHours()`, `.getDate()`, etc.
 */
export async function getLocalDateForGuild(guildId, now = new Date()) {
  const tz = await getGuildTimezone(guildId);
  const p = getLocalDateParts(now, tz);
  return new Date(p.year, p.month, p.day, p.hour, p.minute, p.second);
}
