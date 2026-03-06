import express from 'express';
import pool from '../../../utils/db.js';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';

const router = express.Router();

// GET /api/guilds/:guildId/stream-ended/subscriptions
router.get('/:guildId/stream-ended/subscriptions', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT sub.subscription_id, s.username, s.platform, sub.edit_on_end, sub.delete_on_end,
                   COALESCE(sub.announcement_channel_id, ts.announcement_channel_id, gc.announcement_channel_id) AS channel_id
            FROM subscriptions sub
            JOIN streamers s ON sub.streamer_id = s.streamer_id
            LEFT JOIN twitch_teams ts ON sub.team_subscription_id = ts.id
            LEFT JOIN guild_config gc ON CAST(sub.guild_id AS CHAR) = CAST(gc.guild_id AS CHAR)
            WHERE sub.guild_id = ?
            ORDER BY sub.edit_on_end DESC, s.username
        `, [req.guildId]);

        res.json({ success: true, subscriptions: rows });
    } catch (error) {
        logger.error('[API Stream-Ended Subscriptions GET] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch subscriptions' });
    }
});

// PATCH /api/guilds/:guildId/stream-ended/subscriptions/:subId
router.patch('/:guildId/stream-ended/subscriptions/:subId', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const { edit_on_end } = req.body;

        const [result] = await pool.execute(
            'UPDATE subscriptions SET edit_on_end = ? WHERE subscription_id = ? AND guild_id = ?',
            [edit_on_end ? 1 : 0, req.params.subId, req.guildId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Subscription not found' });
        }

        res.json({ success: true, message: 'edit_on_end updated' });
    } catch (error) {
        logger.error('[API Stream-Ended Subscription PATCH] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to update subscription' });
    }
});

export default router;
