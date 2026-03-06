import express from 'express';
import pool from '../../../utils/db.js';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';
import { invalidateConfig as invalidateCommunityConfig } from '../../../core/community-support-manager.js';

const router = express.Router();

// GET /api/guilds/:guildId/community-support/config
router.get('/:guildId/community-support/config', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT * FROM community_support_config WHERE guild_id = ?',
            [req.guildId]
        );

        const config = rows[0] || {
            guild_id: req.guildId,
            enabled: false,
            raid_channel_id: null,
            support_channel_id: null,
            shoutout_channel_id: null,
            affiliate_link_channel_id: null,
            non_affiliate_link_channel_id: null,
            raid_affiliate_points: 5,
            raid_non_affiliate_points: 10,
            support_points: 3
        };

        res.json({ success: true, config });
    } catch (error) {
        logger.error('[API Community Support Config GET] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch community support config' });
    }
});

// PUT /api/guilds/:guildId/community-support/config
router.put('/:guildId/community-support/config', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const {
            enabled, raid_channel_id, support_channel_id, shoutout_channel_id,
            affiliate_link_channel_id, non_affiliate_link_channel_id,
            raid_affiliate_points, raid_non_affiliate_points, support_points
        } = req.body;

        await pool.execute(`
            INSERT INTO community_support_config
                (guild_id, enabled, raid_channel_id, support_channel_id, shoutout_channel_id,
                 affiliate_link_channel_id, non_affiliate_link_channel_id,
                 raid_affiliate_points, raid_non_affiliate_points, support_points)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled), raid_channel_id = VALUES(raid_channel_id),
                support_channel_id = VALUES(support_channel_id), shoutout_channel_id = VALUES(shoutout_channel_id),
                affiliate_link_channel_id = VALUES(affiliate_link_channel_id),
                non_affiliate_link_channel_id = VALUES(non_affiliate_link_channel_id),
                raid_affiliate_points = VALUES(raid_affiliate_points),
                raid_non_affiliate_points = VALUES(raid_non_affiliate_points),
                support_points = VALUES(support_points)
        `, [
            req.guildId,
            enabled ? 1 : 0,
            raid_channel_id || null,
            support_channel_id || null,
            shoutout_channel_id || null,
            affiliate_link_channel_id || null,
            non_affiliate_link_channel_id || null,
            raid_affiliate_points ?? 5,
            raid_non_affiliate_points ?? 10,
            support_points ?? 3
        ]);

        invalidateCommunityConfig(req.guildId);

        res.json({ success: true, message: 'Community support config updated' });
    } catch (error) {
        logger.error('[API Community Support Config PUT] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to update community support config' });
    }
});

export default router;
