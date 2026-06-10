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

export function makeListEvents({ pool }) {
    return async function listEvents({ channelId, action = null, limit = 50, offset = 0 }) {
        const where = ['channel_id = ?'];
        const params = [String(channelId)];
        // null / undefined / '' all mean "no action filter".
        if (action) { where.push('action = ?'); params.push(action); }
        const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const off = Math.max(parseInt(offset, 10) || 0, 0);
        params.push(lim, off);
        const [rows] = await pool.execute(
            `SELECT id, channel_id, target_user_id, target_username, action, reason, success, created_at
             FROM kbd_enforcement_log
             WHERE ${where.join(' AND ')}
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?`,
            params
        );
        return rows;
    };
}

// Real-wired singleton using the module's DB pool (same pool log()/channelStats() use).
export const listEvents = makeListEvents({ pool });
