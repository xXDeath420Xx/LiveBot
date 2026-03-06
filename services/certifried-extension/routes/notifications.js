/**
 * Notifications Routes
 * Player notification management
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const router = Router();

/**
 * GET /notifications
 * Get player notifications
 */
router.get('/', async (req, res) => {
    try {
        const playerId = req.player.id;
        const { limit = 50, unreadOnly = false } = req.query;

        let query = `
            SELECT id, type, title, message, data, is_read, created_at
            FROM cfx_notifications
            WHERE player_id = ?
        `;
        const params = [playerId];

        if (unreadOnly === 'true') {
            query += ' AND is_read = 0';
        }

        query += ' ORDER BY created_at DESC LIMIT ?';
        params.push(parseInt(limit));

        const [notifications] = await pool.execute(query, params);

        // Get unread count
        const [[countResult]] = await pool.execute(
            'SELECT COUNT(*) as count FROM cfx_notifications WHERE player_id = ? AND is_read = 0',
            [playerId]
        );

        res.json({
            success: true,
            notifications: notifications.map(n => ({
                id: n.id,
                type: n.type,
                title: n.title,
                message: n.message,
                data: n.data ? JSON.parse(n.data) : null,
                isRead: n.is_read === 1,
                createdAt: n.created_at
            })),
            unreadCount: countResult.count
        });

    } catch (error) {
        logger.error('[Notifications] Get failed', { error: error.message });
        res.status(500).json({ error: 'Failed to load notifications', code: 'ERROR' });
    }
});

/**
 * POST /notifications/:id/read
 * Mark a notification as read
 */
router.post('/:id/read', async (req, res) => {
    try {
        const playerId = req.player.id;
        const notificationId = parseInt(req.params.id);

        const [result] = await pool.execute(
            'UPDATE cfx_notifications SET is_read = 1 WHERE id = ? AND player_id = ?',
            [notificationId, playerId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Notification not found', code: 'NOT_FOUND' });
        }

        res.json({ success: true });

    } catch (error) {
        logger.error('[Notifications] Mark read failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * POST /notifications/read-all
 * Mark all notifications as read
 */
router.post('/read-all', async (req, res) => {
    try {
        const playerId = req.player.id;

        await pool.execute(
            'UPDATE cfx_notifications SET is_read = 1 WHERE player_id = ? AND is_read = 0',
            [playerId]
        );

        res.json({ success: true });

    } catch (error) {
        logger.error('[Notifications] Mark all read failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * Helper: Create a notification for a player
 */
export async function createNotification(playerId, type, title, message, data = null) {
    try {
        await pool.execute(
            `INSERT INTO cfx_notifications (player_id, type, title, message, data)
             VALUES (?, ?, ?, ?, ?)`,
            [playerId, type, title, message, data ? JSON.stringify(data) : null]
        );
    } catch (error) {
        logger.error('[Notifications] Create failed', { error: error.message });
    }
}

export default router;
