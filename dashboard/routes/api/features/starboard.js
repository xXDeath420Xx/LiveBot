/**
 * Starboard API
 * Handles starboard configuration
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import socketService from '../../../services/SocketService.js';

const router = express.Router({ mergeParams: true });

/**
 * GET /api/guilds/:guildId/starboard/config
 * Get starboard configuration
 */
router.get('/config', async (req, res) => {
    try {
        const { guildId } = req.params;

        const [config] = await pool.execute(
            'SELECT * FROM starboard_config WHERE guild_id = ?',
            [guildId]
        );

        res.json({
            success: true,
            config: config[0] || {
                enabled: false,
                channel_id: null,
                star_threshold: 3,
                emoji: ':star:',
                self_star: false,
                nsfw_allowed: false,
                ignored_channels: []
            }
        });
    } catch (error) {
        logger.error('[API Starboard Config GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch starboard config' });
    }
});

/**
 * PUT /api/guilds/:guildId/starboard/config
 * Update starboard configuration
 */
router.put('/config', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            enabled,
            channel_id,
            star_threshold,
            emoji,
            self_star,
            nsfw_allowed,
            ignored_channels
        } = req.body;

        await pool.execute(`
            INSERT INTO starboard_config
                (guild_id, enabled, channel_id, star_threshold, emoji, self_star, nsfw_allowed, ignored_channels)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled),
                channel_id = VALUES(channel_id),
                star_threshold = VALUES(star_threshold),
                emoji = VALUES(emoji),
                self_star = VALUES(self_star),
                nsfw_allowed = VALUES(nsfw_allowed),
                ignored_channels = VALUES(ignored_channels)
        `, [
            guildId,
            enabled ? 1 : 0,
            channel_id || null,
            star_threshold || 3,
            emoji || ':star:',
            self_star ? 1 : 0,
            nsfw_allowed ? 1 : 0,
            JSON.stringify(ignored_channels || [])
        ]);

        socketService.configSaved(guildId, 'starboard', req.body);

        res.json({ success: true, message: 'Starboard config updated' });
    } catch (error) {
        logger.error('[API Starboard Config PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update starboard config' });
    }
});

/**
 * GET /api/guilds/:guildId/starboard/posts
 * Get starred posts
 */
router.get('/posts', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { page = 1, limit = 25 } = req.query;
        const offset = (page - 1) * limit;

        const [posts] = await pool.execute(`
            SELECT * FROM starboard_posts
            WHERE guild_id = ?
            ORDER BY star_count DESC, created_at DESC
            LIMIT ? OFFSET ?
        `, [guildId, parseInt(limit), parseInt(offset)]);

        res.json({ success: true, posts });
    } catch (error) {
        logger.error('[API Starboard Posts GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch starboard posts' });
    }
});

export default router;
