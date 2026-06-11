/**
 * First-time chatter detection for the Kick/Tokes bot.
 *
 * A user's first-ever message in a channel (no tokes_channel_stats row) trips a
 * configurable welcome greeting (features_enabled.welcome_message). Detection
 * creates the stats row so it fires exactly once, and an in-memory seen-cache
 * keeps it to ~zero DB hits per message for known chatters.
 */
import realPool from '../../utils/db.js';

const MAX_SEEN_PER_CHANNEL = 5000;

export function makeCheckFirstChatter({ pool }) {
    const seen = new Map(); // channelPk -> Set(platform_user_id)
    return async function checkFirstChatter(channelPk, userId, displayName) {
        if (channelPk == null || userId == null) return false;
        const key = Number(channelPk);
        let set = seen.get(key);
        if (!set) { set = new Set(); seen.set(key, set); }
        const uid = String(userId);
        if (set.has(uid)) return false; // known this process — no DB hit

        const [[row]] = await pool.execute(
            'SELECT id FROM tokes_channel_stats WHERE channel_id = ? AND platform_user_id = ?',
            [key, uid]
        );
        if (set.size >= MAX_SEEN_PER_CHANNEL) set.clear(); // crude bound; cleared entries just re-check the DB
        set.add(uid);
        if (row) return false; // chatted before

        // First ever message: create their stats row (same shape the command
        // pipeline creates) so this can never fire twice.
        await pool.execute(
            `INSERT IGNORE INTO tokes_channel_stats (channel_id, platform_user_id, display_name, last_active)
             VALUES (?, ?, ?, NOW())`,
            [key, uid, String(displayName || '').slice(0, 100)]
        );
        return true;
    };
}

export const checkFirstChatter = makeCheckFirstChatter({ pool: realPool });
