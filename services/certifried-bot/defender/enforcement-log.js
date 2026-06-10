/**
 * Append-only audit log of defender actions; powers dashboard counts.
 */
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

export async function log({ channelId, targetUserId = null, targetUsername, action, reason = null, success = false }) {
    try {
        await pool.execute(
            `INSERT INTO kbd_enforcement_log (channel_id, target_user_id, target_username, action, reason, success)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [channelId, targetUserId, targetUsername, action, reason, success ? 1 : 0]
        );
    } catch (error) {
        // Audit logging must never break the chat pipeline — swallow + record.
        logger.error('[KBD] Failed to write enforcement log', { error: error.message });
    }
}

export async function channelStats(channelId) {
    // Three queries, dashboard-frequency; point-in-time consistency not required.
    const [[banned]] = await pool.execute(
        "SELECT COUNT(*) n FROM kbd_enforcement_log WHERE channel_id = ? AND action = 'ban' AND success = 1", [channelId]
    );
    const [[deleted]] = await pool.execute(
        "SELECT COUNT(*) n FROM kbd_enforcement_log WHERE channel_id = ? AND action = 'delete' AND success = 1", [channelId]
    );
    const [[dormant]] = await pool.execute(
        "SELECT COUNT(*) n FROM kbd_enforcement_log WHERE channel_id = ? AND action = 'detected_no_scope'", [channelId]
    );
    return { banned: Number(banned.n), deleted: Number(deleted.n), dormant: Number(dormant.n) };
}
