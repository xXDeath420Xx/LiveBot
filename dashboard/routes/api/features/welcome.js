/**
 * Welcome API
 * Handles welcome/goodbye message configuration
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import socketService from '../../../services/SocketService.js';

const router = express.Router({ mergeParams: true });

/**
 * GET /api/guilds/:guildId/welcome/config
 * Get welcome configuration
 */
router.get('/config', async (req, res) => {
    try {
        const { guildId } = req.params;

        const [config] = await pool.execute(
            'SELECT * FROM welcome_settings WHERE guild_id = ?',
            [guildId]
        );

        const [autoroles] = await pool.execute(
            'SELECT * FROM autoroles_config WHERE guild_id = ?',
            [guildId]
        );

        res.json({
            success: true,
            welcome: config[0] || {
                enabled: false,
                channel_id: null,
                message: 'Welcome to the server, {user}!',
                embed_enabled: false,
                embed_title: 'Welcome!',
                embed_description: '',
                embed_color: '#a78bfa',
                dm_enabled: false,
                dm_message: ''
            },
            goodbye: {
                enabled: config[0]?.goodbye_enabled || false,
                channel_id: config[0]?.goodbye_channel_id || null,
                message: config[0]?.goodbye_message || 'Goodbye {user}, we\'ll miss you!'
            },
            autoroles: {
                enabled: autoroles[0]?.is_enabled || false,
                roles: autoroles[0]?.roles_to_assign ? JSON.parse(autoroles[0].roles_to_assign) : []
            }
        });
    } catch (error) {
        logger.error('[API Welcome Config GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch welcome config' });
    }
});

/**
 * PUT /api/guilds/:guildId/welcome/config
 * Update welcome configuration
 */
router.put('/config', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            enabled,
            channel_id,
            message,
            embed_enabled,
            embed_title,
            embed_description,
            embed_color,
            embed_thumbnail,
            embed_image,
            dm_enabled,
            dm_message,
            goodbye_enabled,
            goodbye_channel_id,
            goodbye_message
        } = req.body;

        await pool.execute(`
            INSERT INTO welcome_settings
                (guild_id, enabled, channel_id, message, embed_enabled, embed_title,
                 embed_description, embed_color, embed_thumbnail, embed_image,
                 dm_enabled, dm_message, goodbye_enabled, goodbye_channel_id, goodbye_message)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled),
                channel_id = VALUES(channel_id),
                message = VALUES(message),
                embed_enabled = VALUES(embed_enabled),
                embed_title = VALUES(embed_title),
                embed_description = VALUES(embed_description),
                embed_color = VALUES(embed_color),
                embed_thumbnail = VALUES(embed_thumbnail),
                embed_image = VALUES(embed_image),
                dm_enabled = VALUES(dm_enabled),
                dm_message = VALUES(dm_message),
                goodbye_enabled = VALUES(goodbye_enabled),
                goodbye_channel_id = VALUES(goodbye_channel_id),
                goodbye_message = VALUES(goodbye_message)
        `, [
            guildId,
            enabled ? 1 : 0,
            channel_id || null,
            message || 'Welcome to the server, {user}!',
            embed_enabled ? 1 : 0,
            embed_title || 'Welcome!',
            embed_description || '',
            embed_color || '#a78bfa',
            embed_thumbnail || null,
            embed_image || null,
            dm_enabled ? 1 : 0,
            dm_message || '',
            goodbye_enabled ? 1 : 0,
            goodbye_channel_id || null,
            goodbye_message || 'Goodbye {user}, we\'ll miss you!'
        ]);

        socketService.configSaved(guildId, 'welcome', req.body);

        res.json({ success: true, message: 'Welcome config updated' });
    } catch (error) {
        logger.error('[API Welcome Config PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update welcome config' });
    }
});

/**
 * PUT /api/guilds/:guildId/welcome/autoroles
 * Update autoroles configuration
 */
router.put('/autoroles', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { enabled, roles } = req.body;

        await pool.execute(`
            INSERT INTO autoroles_config (guild_id, is_enabled, roles_to_assign)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE
                is_enabled = VALUES(is_enabled),
                roles_to_assign = VALUES(roles_to_assign)
        `, [guildId, enabled ? 1 : 0, JSON.stringify(roles || [])]);

        socketService.configSaved(guildId, 'autoroles', req.body);

        res.json({ success: true, message: 'Autoroles config updated' });
    } catch (error) {
        logger.error('[API Autoroles PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update autoroles config' });
    }
});

/**
 * POST /api/guilds/:guildId/welcome/test
 * Send a test welcome message
 */
router.post('/test', async (req, res) => {
    try {
        const { guildId } = req.params;
        const guild = req.guildObject;

        const [config] = await pool.execute(
            'SELECT * FROM welcome_settings WHERE guild_id = ?',
            [guildId]
        );

        if (!config[0] || !config[0].channel_id) {
            return res.status(400).json({ error: 'Welcome channel not configured' });
        }

        const channel = guild.channels.cache.get(config[0].channel_id);
        if (!channel) {
            return res.status(400).json({ error: 'Welcome channel not found' });
        }

        // Get the user who triggered the test
        const member = await guild.members.fetch(req.user.id).catch(() => null);
        const testMessage = (config[0].message || 'Welcome {user}!')
            .replace(/{user}/g, member ? `<@${member.id}>` : '<@test_user>')
            .replace(/{server}/g, guild.name)
            .replace(/{memberCount}/g, guild.memberCount);

        await channel.send({ content: testMessage });

        res.json({ success: true, message: 'Test message sent' });
    } catch (error) {
        logger.error('[API Welcome Test POST] Error:', error);
        res.status(500).json({ error: 'Failed to send test message' });
    }
});

export default router;
