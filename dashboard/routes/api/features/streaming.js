/**
 * Streaming API
 * Handles streamer notifications configuration
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import socketService from '../../../services/SocketService.js';

const router = express.Router({ mergeParams: true });

/**
 * GET /api/guilds/:guildId/streaming/config
 * Get streaming configuration
 */
router.get('/config', async (req, res) => {
    try {
        const { guildId } = req.params;

        const [config] = await pool.execute(
            'SELECT * FROM guilds WHERE guild_id = ?',
            [guildId]
        );

        res.json({
            success: true,
            config: {
                announcement_channel_id: config[0]?.announcement_channel_id || null,
                live_role_id: config[0]?.live_role_id || null
            }
        });
    } catch (error) {
        logger.error('[API Streaming Config GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch streaming config' });
    }
});

/**
 * PUT /api/guilds/:guildId/streaming/config
 * Update streaming configuration
 */
router.put('/config', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { announcement_channel_id, live_role_id } = req.body;

        // Check if this guild previously had no announcement channel
        const [prevConfig] = await pool.execute(
            'SELECT announcement_channel_id FROM guilds WHERE guild_id = ?',
            [guildId]
        );
        const hadChannel = prevConfig.length > 0 && prevConfig[0].announcement_channel_id;

        await pool.execute(`
            INSERT INTO guilds (guild_id, announcement_channel_id, live_role_id)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE
                announcement_channel_id = VALUES(announcement_channel_id),
                live_role_id = VALUES(live_role_id)
        `, [guildId, announcement_channel_id || null, live_role_id || null]);

        // If a channel was just set (wasn't configured before), cross-pollinate existing streamers
        if (announcement_channel_id && !hadChannel) {
            import('../../../../utils/streamer-cross-pollinate.js').then(({ crossPollinateGuild }) => {
                crossPollinateGuild(guildId, announcement_channel_id).catch(err => {
                    logger.error('[CrossPollinate:Guild] Background error:', { error: err.message, guildId, category: 'streams' });
                });
            }).catch(() => {});
        }

        socketService.configSaved(guildId, 'streaming', req.body);

        res.json({ success: true, message: 'Streaming config updated' });
    } catch (error) {
        logger.error('[API Streaming Config PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update streaming config' });
    }
});

/**
 * GET /api/guilds/:guildId/streaming/subscriptions
 * Get all streamer subscriptions
 */
router.get('/subscriptions', async (req, res) => {
    try {
        const { guildId } = req.params;

        const [subscriptions] = await pool.execute(`
            SELECT s.*, st.platform, st.username, st.platform_user_id, st.discord_user_id,
                   (SELECT COUNT(*) FROM live_announcements WHERE streamer_id = s.streamer_id AND guild_id = ?) as is_live
            FROM subscriptions s
            JOIN streamers st ON s.streamer_id = st.streamer_id
            WHERE s.guild_id = ?
            ORDER BY st.username
        `, [guildId, guildId]);

        res.json({ success: true, subscriptions });
    } catch (error) {
        logger.error('[API Streaming Subscriptions GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch subscriptions' });
    }
});

/**
 * POST /api/guilds/:guildId/streaming/subscriptions
 * Add a streamer subscription
 */
router.post('/subscriptions', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            platform,
            username,
            announcement_channel_id,
            live_role_id,
            custom_message,
            delete_on_end
        } = req.body;

        if (!platform || !username) {
            return res.status(400).json({ error: 'Platform and username are required' });
        }

        // Find or create streamer
        let [streamer] = await pool.execute(
            'SELECT streamer_id FROM streamers WHERE platform = ? AND username = ?',
            [platform, username.toLowerCase()]
        );

        let streamerId;
        if (streamer.length === 0) {
            const [result] = await pool.execute(
                'INSERT INTO streamers (platform, username) VALUES (?, ?)',
                [platform, username.toLowerCase()]
            );
            streamerId = result.insertId;
        } else {
            streamerId = streamer[0].streamer_id;
        }

        // Create subscription
        await pool.execute(`
            INSERT INTO subscriptions
                (guild_id, streamer_id, announcement_channel_id, live_role_id, custom_message, delete_on_end)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [
            guildId,
            streamerId,
            announcement_channel_id || null,
            live_role_id || null,
            custom_message || null,
            delete_on_end ? 1 : 0
        ]);

        res.json({ success: true, message: 'Subscription added' });
    } catch (error) {
        logger.error('[API Streaming Subscriptions POST] Error:', error);
        res.status(500).json({ error: 'Failed to add subscription' });
    }
});

/**
 * DELETE /api/guilds/:guildId/streaming/subscriptions/:subscriptionId
 * Remove a subscription
 */
router.delete('/subscriptions/:subscriptionId', async (req, res) => {
    try {
        const { guildId, subscriptionId } = req.params;

        await pool.execute(
            'DELETE FROM subscriptions WHERE subscription_id = ? AND guild_id = ?',
            [subscriptionId, guildId]
        );

        res.json({ success: true, message: 'Subscription removed' });
    } catch (error) {
        logger.error('[API Streaming Subscriptions DELETE] Error:', error);
        res.status(500).json({ error: 'Failed to remove subscription' });
    }
});

/**
 * GET /api/guilds/:guildId/streaming/teams
 * Get team subscriptions
 */
router.get('/teams', async (req, res) => {
    try {
        const { guildId } = req.params;

        const [teams] = await pool.execute(
            'SELECT * FROM twitch_teams WHERE guild_id = ? ORDER BY team_name',
            [guildId]
        );

        res.json({ success: true, teams });
    } catch (error) {
        logger.error('[API Streaming Teams GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch teams' });
    }
});

export default router;
