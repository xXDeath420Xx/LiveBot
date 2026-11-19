/**
 * LFG auto-close (LFG & Music Quiz page: "Auto-close LFG posts after (hours)").
 *
 * /arcade lfg create stores expires_at from that setting (commands/games/arcade-lfg-handler.js).
 * Every 5 minutes this closes posts that are still open or full past that time: the row becomes
 * 'expired' and the message shows Closed with its buttons switched off. The deadline lives in the
 * database, so a restart just means the next sweep catches up.
 */
import cron from 'node-cron';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { markLfgMessageClosed } from '../commands/games/arcade-lfg-handler.js';

let task = null;
let running = false;

/** Close every due post (at most `limit` per sweep). Returns how many were closed. */
export async function closeExpiredLfgPosts(limit = 50) {
    if (running) return 0;
    running = true;
    let closed = 0;
    try {
        const [rows] = await pool.execute(
            `SELECT id, guild_id, channel_id, message_id FROM lfg_posts
              WHERE status IN ('open', 'full') AND expires_at IS NOT NULL AND expires_at <= NOW()
              ORDER BY expires_at ASC LIMIT ${Math.max(1, Math.min(500, Math.trunc(limit) || 50))}`
        );
        for (const post of rows) {
            const [res] = await pool.execute(
                `UPDATE lfg_posts SET status = 'expired' WHERE id = ? AND status IN ('open', 'full')`,
                [post.id]
            );
            if (!res.affectedRows) continue; // closed by hand in the meantime
            closed++;
            const client = global.botManager?.getClientForGuild?.(post.guild_id);
            if (client) await markLfgMessageClosed(client, post, 'Closed (timed out)');
        }
        if (closed) logger.info(`[LFG] Auto-closed ${closed} post(s)`);
    } catch (err) {
        logger.warn('[LFG] Auto-close sweep failed', { error: err.message });
    } finally {
        running = false;
    }
    return closed;
}

export function startLfgExpiry() {
    if (task) return task;
    task = cron.schedule('*/5 * * * *', () => { void closeExpiredLfgPosts(); });
    logger.info('[LFG] Auto-close sweep started (every 5 minutes)');
    return task;
}

export function stopLfgExpiry() {
    if (task) { task.stop(); task = null; }
}

export default startLfgExpiry;
