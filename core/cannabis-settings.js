/*
 * Cannabis Community settings that the commands and the scheduler share (Cannabis Community page,
 * feature key 'cannabis' in core/feature-config-spec.js).
 *
 * The "day" used by /dailyjoint and the toke streak starts at the page's "Daily reset hour", in the
 * server's timezone (guild_settings.timezone, UTC when none is set). Day numbers are only ever
 * compared with each other, so their origin does not matter: same number = same day, one apart =
 * consecutive days.
 */
import { getConfig } from './feature-config.js';
import { getGuildTimezone, getLocalDateParts } from '../utils/guild-timezone.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export function isOn(v) {
    return v === true || v === 1 || v === '1' || v === 'true';
}

function clampInt(v, min, max, fallback) {
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
}

/** The cannabis settings with every value already validated. */
export async function getCannabisSettings(guildId) {
    const cfg = await getConfig('cannabis', guildId);
    return {
        circleChannelId: /^\d{17,20}$/.test(String(cfg.circle_channel_id || '')) ? String(cfg.circle_channel_id) : null,
        circleMaxPlayers: clampInt(cfg.circle_max_players, 2, 50, 20),
        circleTurnSeconds: clampInt(cfg.circle_turn_seconds, 10, 600, 120),
        dailyResetHour: clampInt(cfg.daily_reset_hour, 0, 23, 0),
        leaderboardChannelId: /^\d{17,20}$/.test(String(cfg.leaderboard_channel_id || '')) ? String(cfg.leaderboard_channel_id) : null,
    };
}

/**
 * Day number of `date` for a server whose day starts at `resetHour` local time in `tz`.
 * The local wall-clock reading is treated as if it were UTC, which makes the arithmetic exact
 * for both IANA zones (DST included) and legacy fixed offsets.
 */
export function dayNumber(date, tz, resetHour) {
    const p = getLocalDateParts(date instanceof Date ? date : new Date(date), tz);
    const wall = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second);
    return Math.floor((wall - resetHour * HOUR_MS) / DAY_MS);
}

/**
 * The server's day clock: `day(date)` gives a day number, `nextReset(now)` the instant the
 * current day ends (to show as a Discord timestamp).
 */
export async function getCannabisDayClock(guildId) {
    const [tz, settings] = await Promise.all([getGuildTimezone(guildId), getCannabisSettings(guildId)]);
    const resetHour = settings.dailyResetHour;
    const day = (date) => dayNumber(date, tz, resetHour);
    const nextReset = (now = new Date()) => {
        // Walk forward to the first minute that belongs to the next day. Coarse steps then fine
        // ones keep this cheap; a DST shift only moves the boundary by an hour.
        const today = day(now);
        let t = now.getTime();
        while (day(new Date(t + HOUR_MS)) === today) t += HOUR_MS;
        while (day(new Date(t + 60_000)) === today) t += 60_000;
        return new Date(Math.ceil((t + 1) / 60_000) * 60_000);
    };
    return { tz, resetHour, day, nextReset };
}

export default { getCannabisSettings, getCannabisDayClock, dayNumber, isOn };
