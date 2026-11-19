/**
 * Voice-XP sessions (register H-672). A member's time in voice used to be held only in
 * LevelingManager's memory: a restart lost every open session, so nobody in voice at the time got
 * anything for it, and moving between voice channels was not seen at all (only join and leave were),
 * so the whole stay was judged by the channel they finally left.
 *
 * Each open session is now a level_voice_sessions row (migrations/440_level_voice_sessions.js):
 * the channel and when it started. last_seen_at is refreshed every few minutes while the bot runs,
 * so after a restart a session whose member has gone is credited up to when the bot last saw it,
 * not up to the restart. A channel move ends the session in the old channel and starts one in the
 * new one, so no-XP channels and channel boosts apply to the time actually spent in each.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

/** How often open sessions are marked as still running. */
export const HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * What a voice state change does to a session. Mute, deafen, stream and video changes keep the
 * channel and do nothing; a move ends one session and starts another.
 */
export function voiceTransition(oldChannelId, newChannelId) {
    const from = oldChannelId || null;
    const to = newChannelId || null;
    if (from === to) return { end: false, start: false };
    return { end: Boolean(from), start: Boolean(to) };
}

/** Whole minutes between two instants (ms), never negative. */
export function sessionMinutes(startMs, endMs) {
    const span = Number(endMs) - Number(startMs);
    return Number.isFinite(span) && span > 0 ? Math.floor(span / 60000) : 0;
}

const ms = (v) => (v instanceof Date ? v.getTime() : v == null ? null : new Date(v).getTime());

/**
 * A stored session found when the bot starts, against where the member is now.
 *   keep        still in the same channel: the session simply carries on
 *   creditUntil otherwise, credit up to the last time the bot saw the session running (never
 *               past now, and never less than nothing)
 *   restartIn   the channel they are in now, if it is a different one: a new session starts there
 */
export function reconcileSession(row, liveChannelId, nowMs) {
    if (liveChannelId && liveChannelId === row.channel_id) return { keep: true, creditUntil: null, restartIn: null };
    const started = ms(row.started_at);
    const seen = ms(row.last_seen_at) ?? started;
    return {
        keep: false,
        creditUntil: Math.max(started, Math.min(seen, nowMs)),
        restartIn: liveChannelId || null,
    };
}

export async function saveSession(guildId, userId, channelId, startedAtMs) {
    const at = new Date(startedAtMs);
    await pool.execute(
        `INSERT INTO level_voice_sessions (guild_id, user_id, channel_id, started_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), started_at = VALUES(started_at), last_seen_at = VALUES(last_seen_at)`,
        [guildId, userId, channelId, at, at]
    );
}

export async function loadSession(guildId, userId) {
    const [rows] = await pool.execute(
        'SELECT guild_id, user_id, channel_id, started_at, last_seen_at FROM level_voice_sessions WHERE guild_id = ? AND user_id = ?',
        [guildId, userId]
    );
    return rows[0] || null;
}

export async function deleteSession(guildId, userId) {
    await pool.execute('DELETE FROM level_voice_sessions WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
}

/** Every stored session in these guilds. */
export async function listSessions(guildIds) {
    if (!guildIds?.length) return [];
    const [rows] = await pool.query(
        'SELECT guild_id, user_id, channel_id, started_at, last_seen_at FROM level_voice_sessions WHERE guild_id IN (?)',
        [guildIds]
    );
    return rows;
}

/** Mark these guilds' open sessions as still running. */
export async function touchSessions(guildIds) {
    if (!guildIds?.length) return;
    try {
        await pool.query('UPDATE level_voice_sessions SET last_seen_at = NOW() WHERE guild_id IN (?)', [guildIds]);
    } catch (err) {
        logger.warn(`[LevelingManager] Voice session heartbeat failed: ${err.message}`);
    }
}
