import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import * as twitchApi from '../utils/platforms/twitch-api.js';

const { getTwitchUser, getStreamSchedule } = twitchApi;

/**
 * Import a member's Twitch schedule into event_schedule_events as source='twitch'.
 * Reads the PUBLIC schedule via Helix (app token) — works without user OAuth.
 *
 * Return-shape notes (verified against utils/platforms/twitch-api.js):
 *   - getTwitchUser(identifier) -> raw Helix user object (response.data.data[0]) or null;
 *     fields used: .id (string), .display_name.
 *   - getStreamSchedule(twitchUserId) -> the raw axios RESPONSE (or null on error/404);
 *     segments live at response.data.data.segments; each segment has
 *     .id, .start_time, .end_time, .title.
 *
 * @returns {Promise<{ imported:number, twitchUsername:string }>}
 */
export async function importTwitchSchedule(guildId, userId, username, { categoryId = null } = {}) {
    const cleanName = String(username).trim().replace(/^@/, '');
    const user = await getTwitchUser(cleanName);
    if (!user?.id) throw new Error(`Twitch user "${cleanName}" not found.`);

    const response = await getStreamSchedule(String(user.id)).catch(() => null);
    const segments = response?.data?.data?.segments || [];

    const keptRefs = [];
    for (const seg of segments) {
        const ref = seg.id;
        if (!ref || !seg.start_time) continue;
        keptRefs.push(ref);
        const title = (seg.title || user.display_name || cleanName).substring(0, 120);
        const [existing] = await pool.execute(
            "SELECT id FROM event_schedule_events WHERE guild_id=? AND user_id=? AND source='twitch' AND source_ref=?",
            [guildId, userId, ref]
        );
        if (existing.length) {
            await pool.execute(
                'UPDATE event_schedule_events SET title=?, start_time=?, end_time=?, category_id=COALESCE(category_id,?), updated_at=NOW() WHERE id=?',
                [title, toMysql(seg.start_time), toMysql(seg.end_time), categoryId, existing[0].id]
            );
        } else {
            await pool.execute(
                `INSERT INTO event_schedule_events (guild_id,user_id,category_id,title,start_time,end_time,recurrence,source,source_ref)
                 VALUES (?,?,?,?,?,?, 'none','twitch', ?)`,
                [guildId, userId, categoryId, title, toMysql(seg.start_time), toMysql(seg.end_time), ref]
            );
        }
    }

    if (keptRefs.length) {
        const placeholders = keptRefs.map(() => '?').join(',');
        await pool.execute(
            `DELETE FROM event_schedule_events WHERE guild_id=? AND user_id=? AND source='twitch' AND source_ref NOT IN (${placeholders})`,
            [guildId, userId, ...keptRefs]
        );
    } else {
        await pool.execute("DELETE FROM event_schedule_events WHERE guild_id=? AND user_id=? AND source='twitch'", [guildId, userId]);
    }

    logger.info(`[EventSchedule] Imported ${keptRefs.length} Twitch segments for ${cleanName} (guild ${guildId}, user ${userId})`);
    return { imported: keptRefs.length, twitchUsername: user.display_name || cleanName };
}

function toMysql(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return isNaN(d) ? null : d.toISOString().slice(0, 19).replace('T', ' ');
}
