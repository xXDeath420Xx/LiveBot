import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';

const router = express.Router({ mergeParams: true });

/**
 * GET /api/guilds/:guildId/throne/notifications
 */
router.get('/notifications', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [rows] = await pool.execute(
            'SELECT * FROM throne_notifications WHERE guild_id = ? ORDER BY added_at DESC',
            [guildId]
        );
        res.json({ success: true, notifications: rows });
    } catch (error) {
        logger.error('[API Throne] Get notifications error:', error);
        res.status(500).json({ error: 'Failed to fetch throne notifications' });
    }
});

/**
 * POST /api/guilds/:guildId/throne/notifications
 */
router.post('/notifications', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { throne_username, channel_id, notify_new_items, notify_gifts, notify_contributions } = req.body;

        if (!throne_username || !channel_id) {
            return res.status(400).json({ error: 'Throne username and channel are required' });
        }

        await pool.execute(
            `INSERT INTO throne_notifications (guild_id, throne_username, channel_id, notify_new_items, notify_gifts, notify_contributions, added_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), notify_new_items = VALUES(notify_new_items), notify_gifts = VALUES(notify_gifts), notify_contributions = VALUES(notify_contributions)`,
            [guildId, throne_username.toLowerCase().trim(), channel_id, notify_new_items ? 1 : 0, notify_gifts ? 1 : 0, notify_contributions ? 1 : 0, req.user?.id || 'dashboard']
        );

        res.json({ success: true, message: 'Throne tracking added' });
    } catch (error) {
        logger.error('[API Throne] Add notification error:', error);
        res.status(500).json({ error: 'Failed to add throne tracking' });
    }
});

/**
 * DELETE /api/guilds/:guildId/throne/notifications/:username
 */
router.delete('/notifications/:username', async (req, res) => {
    try {
        const { guildId, username } = req.params;
        const [result] = await pool.execute(
            'DELETE FROM throne_notifications WHERE guild_id = ? AND throne_username = ?',
            [guildId, username.toLowerCase()]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Tracking not found' });
        }

        res.json({ success: true, message: 'Throne tracking removed' });
    } catch (error) {
        logger.error('[API Throne] Delete notification error:', error);
        res.status(500).json({ error: 'Failed to remove throne tracking' });
    }
});

/**
 * GET /api/guilds/:guildId/throne/featured
 */
router.get('/featured', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [rows] = await pool.execute(
            'SELECT * FROM throne_guild_config WHERE guild_id = ?',
            [guildId]
        );
        res.json({ success: true, featured: rows[0] || null });
    } catch (error) {
        logger.error('[API Throne] Get featured error:', error);
        res.status(500).json({ error: 'Failed to fetch featured config' });
    }
});

/**
 * PUT /api/guilds/:guildId/throne/featured
 */
router.put('/featured', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { featured_username } = req.body;

        if (!featured_username) {
            // Clear featured
            await pool.execute('DELETE FROM throne_guild_config WHERE guild_id = ?', [guildId]);
            return res.json({ success: true, message: 'Featured wishlist cleared' });
        }

        await pool.execute(
            `INSERT INTO throne_guild_config (guild_id, featured_username, set_by)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE featured_username = VALUES(featured_username), set_by = VALUES(set_by), set_at = CURRENT_TIMESTAMP`,
            [guildId, featured_username.toLowerCase().trim(), req.user?.id || 'dashboard']
        );

        res.json({ success: true, message: 'Featured wishlist updated' });
    } catch (error) {
        logger.error('[API Throne] Update featured error:', error);
        res.status(500).json({ error: 'Failed to update featured config' });
    }
});

/**
 * GET /api/guilds/:guildId/throne/settings
 */
router.get('/settings', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [rows] = await pool.execute(
            'SELECT * FROM throne_guild_settings WHERE guild_id = ?',
            [guildId]
        );
        res.json({ success: true, settings: rows[0] || null });
    } catch (error) {
        logger.error('[API Throne] Get settings error:', error);
        res.status(500).json({ error: 'Failed to fetch throne settings' });
    }
});

/**
 * PUT /api/guilds/:guildId/throne/settings
 */
router.put('/settings', async (req, res) => {
    try {
        const { guildId } = req.params;
        const fields = [
            'notify_item_added', 'notify_item_removed', 'notify_gift_received',
            'notify_contribution', 'notify_price_change', 'notify_milestone',
            'notify_gift_thankyou', 'auto_embed_links', 'birthday_reminder',
            'monthly_spotlight', 'wishlist_role_enabled', 'notification_channel_id',
            'birthday_channel_id', 'spotlight_channel_id', 'wishlist_role_id',
            'birthday_reminder_days', 'price_change_threshold'
        ];

        const updates = {};
        for (const field of fields) {
            if (req.body[field] !== undefined) {
                updates[field] = req.body[field];
            }
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'No settings provided' });
        }

        const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
        const values = Object.values(updates);

        await pool.execute(
            `INSERT INTO throne_guild_settings (guild_id, ${Object.keys(updates).join(', ')})
             VALUES (?, ${values.map(() => '?').join(', ')})
             ON DUPLICATE KEY UPDATE ${setClauses}`,
            [guildId, ...values, ...values]
        );

        res.json({ success: true, message: 'Throne settings updated' });
    } catch (error) {
        logger.error('[API Throne] Update settings error:', error);
        res.status(500).json({ error: 'Failed to update throne settings' });
    }
});

/**
 * GET /api/guilds/:guildId/throne/log
 */
router.get('/log', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [rows] = await pool.execute(
            'SELECT * FROM throne_notification_log WHERE guild_id = ? ORDER BY created_at DESC LIMIT 50',
            [guildId]
        );
        res.json({ success: true, log: rows });
    } catch (error) {
        logger.error('[API Throne] Get log error:', error);
        res.status(500).json({ error: 'Failed to fetch notification log' });
    }
});

export default router;
