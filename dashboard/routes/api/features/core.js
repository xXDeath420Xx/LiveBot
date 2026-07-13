/**
 * Core Guild Settings API
 * Handles basic guild configuration
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import socketService from '../../../services/SocketService.js';

const router = express.Router({ mergeParams: true });

/**
 * GET /api/guilds/:guildId/core
 * Get core guild settings
 */
router.get('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const guild = req.guildObject;

        // Fetch guild settings
        const [settings] = await pool.execute(
            'SELECT * FROM guild_settings WHERE guild_id = ?',
            [guildId]
        );

        // Fetch guild config
        const [config] = await pool.execute(
            'SELECT * FROM guild_config WHERE guild_id = ?',
            [guildId]
        );

        // Fetch guilds table for legacy settings
        const [guildRow] = await pool.execute(
            'SELECT * FROM guilds WHERE guild_id = ?',
            [guildId]
        );

        res.json({
            success: true,
            data: {
                id: guildId,
                name: guild.name,
                icon: guild.iconURL({ size: 128 }),
                memberCount: guild.memberCount,
                settings: settings[0] || {},
                config: config[0] || {},
                legacy: guildRow[0] || {}
            }
        });
    } catch (error) {
        logger.error('[API Core GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch guild settings' });
    }
});

/**
 * PUT /api/guilds/:guildId/core
 * Update core guild settings
 */
router.put('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            timezone,
            prefix,
            language,
            bot_nickname,
            embed_color
        } = req.body;

        // Update guild_settings
        await pool.execute(`
            INSERT INTO guild_settings (guild_id, timezone, prefix, language)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                timezone = VALUES(timezone),
                prefix = VALUES(prefix),
                language = VALUES(language)
        `, [guildId, timezone || 'UTC', prefix || '!', language || 'en']);

        // Update guild_config for appearance
        if (bot_nickname !== undefined || embed_color !== undefined) {
            await pool.execute(`
                INSERT INTO guild_config (guild_id, bot_nickname, embed_color)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    bot_nickname = VALUES(bot_nickname),
                    embed_color = VALUES(embed_color)
            `, [guildId, bot_nickname || null, embed_color || '#a78bfa']);
        }

        // Notify connected clients
        socketService.configSaved(guildId, 'core', { timezone, prefix, language });

        res.json({
            success: true,
            message: 'Core settings updated successfully'
        });
    } catch (error) {
        logger.error('[API Core PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

/**
 * GET /api/guilds/:guildId/core/channels
 * Get all guild channels for selects
 */
router.get('/channels', async (req, res) => {
    try {
        const guild = req.guildObject;

        const channels = guild.channels.cache
            .filter(c => [0, 2, 5, 13, 15].includes(c.type)) // Text, Voice, Announcement, Stage, Forum
            .map(c => ({
                id: c.id,
                name: c.name,
                type: c.type,
                parentId: c.parentId,
                position: c.position
            }))
            .sort((a, b) => a.position - b.position);

        res.json({ success: true, channels });
    } catch (error) {
        logger.error('[API Core Channels] Error:', error);
        res.status(500).json({ error: 'Failed to fetch channels' });
    }
});

/**
 * GET /api/guilds/:guildId/core/roles
 * Get all guild roles for selects
 */
router.get('/roles', async (req, res) => {
    try {
        const guild = req.guildObject;

        const roles = guild.roles.cache
            .filter(r => r.name !== '@everyone')
            .map(r => ({
                id: r.id,
                name: r.name,
                color: r.color,
                position: r.position,
                managed: r.managed
            }))
            .sort((a, b) => b.position - a.position);

        res.json({ success: true, roles });
    } catch (error) {
        logger.error('[API Core Roles] Error:', error);
        res.status(500).json({ error: 'Failed to fetch roles' });
    }
});

/**
 * GET /api/guilds/:guildId/core/stats
 * Get guild statistics
 */
router.get('/stats', async (req, res) => {
    try {
        const { guildId } = req.params;
        const guild = req.guildObject;

        // Get message stats (last 30 days)
        const [messageStats] = await pool.execute(`
            SELECT
                SUM(count) as total_messages,
                COUNT(DISTINCT log_date) as days_with_activity
            FROM activity_logs
            WHERE guild_id = ? AND type = 'message'
            AND log_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        `, [guildId]);

        // Get member activity
        const [memberStats] = await pool.execute(`
            SELECT event_type, COUNT(*) as count
            FROM member_logs
            WHERE guild_id = ?
            AND timestamp >= DATE_SUB(NOW(), INTERVAL 30 DAY)
            GROUP BY event_type
        `, [guildId]);

        // Get moderation stats
        const [modStats] = await pool.execute(`
            SELECT action, COUNT(*) as count
            FROM infractions
            WHERE guild_id = ?
            AND timestamp >= DATE_SUB(NOW(), INTERVAL 30 DAY)
            GROUP BY action
        `, [guildId]);

        const stats = {
            members: {
                total: guild.memberCount,
                online: guild.members.cache.filter(m => m.presence?.status === 'online').size,
                joins: memberStats.find(s => s.event_type === 'JOIN')?.count || 0,
                leaves: memberStats.find(s => s.event_type === 'LEAVE')?.count || 0
            },
            messages: {
                total: messageStats[0]?.total_messages || 0,
                avgPerDay: Math.round((messageStats[0]?.total_messages || 0) / (messageStats[0]?.days_with_activity || 1))
            },
            moderation: modStats.reduce((acc, s) => {
                acc[s.action] = s.count;
                return acc;
            }, {})
        };

        res.json({ success: true, stats });
    } catch (error) {
        logger.error('[API Core Stats] Error:', error);
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

/**
 * POST /api/guilds/:guildId/core/sync
 * Force sync guild data from Discord
 */
router.post('/sync', async (req, res) => {
    try {
        const guild = req.guildObject;

        // Force fetch members (if privileged intents available)
        try {
            await guild.members.fetch();
        } catch (e) {
            logger.warn('[API Core Sync] Could not fetch all members:', e.message);
        }

        // Update guild record
        await pool.execute(`
            INSERT INTO guilds (guild_id, name, icon, member_count)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                name = VALUES(name),
                icon = VALUES(icon),
                member_count = VALUES(member_count)
        `, [guild.id, guild.name, guild.icon, guild.memberCount]);

        res.json({
            success: true,
            message: 'Guild data synced successfully',
            memberCount: guild.memberCount
        });
    } catch (error) {
        logger.error('[API Core Sync] Error:', error);
        res.status(500).json({ error: 'Failed to sync guild data' });
    }
});

// ===========================
// STAT DISPLAY CHANNELS
// ===========================

/**
 * GET /api/guilds/:guildId/core/stat-displays
 */
router.get('/stat-displays', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [rows] = await pool.execute(
            'SELECT id, channel_id, stat_type, template FROM stat_display_channels WHERE guild_id = ?',
            [guildId]
        );
        res.json({ success: true, statDisplays: rows });
    } catch (error) {
        logger.error('[API Core] Error fetching stat displays:', error);
        res.status(500).json({ error: 'Failed to fetch stat display channels' });
    }
});

/**
 * POST /api/guilds/:guildId/core/stat-displays
 */
router.post('/stat-displays', async (req, res) => {
    try {
        const { guildId } = req.params;
        let { channel_id, stat_type, template } = req.body;

        if (!stat_type) {
            return res.status(400).json({ error: 'Stat type is required' });
        }

        const validTypes = ['members', 'humans', 'bots', 'online', 'channels', 'roles', 'boosts', 'time', 'date', 'role', 'twitch_followers'];
        if (!validTypes.includes(stat_type)) {
            return res.status(400).json({ error: 'Invalid stat type' });
        }

        if (stat_type === 'role' && !req.body.role_id) {
            return res.status(400).json({ error: 'Select a role to count members for' });
        }

        if (stat_type === 'twitch_followers' && !req.body.twitch_username) {
            return res.status(400).json({ error: 'Enter a Twitch username to track followers for' });
        }

        const finalTemplate = template || `${stat_type.charAt(0).toUpperCase() + stat_type.slice(1)}: {value}`;

        // Create a new voice channel if requested
        if (channel_id === 'create') {
            const guild = req.guildObject;
            if (!guild) {
                return res.status(400).json({ error: 'Could not access server' });
            }
            try {
                const { ChannelType, PermissionsBitField } = await import('discord.js');
                const newChannel = await guild.channels.create({
                    name: finalTemplate.replace('{value}', '...'),
                    type: ChannelType.GuildVoice,
                    permissionOverwrites: [
                        { id: guildId, deny: [PermissionsBitField.Flags.Connect] } // Deny @everyone from joining
                    ],
                    reason: 'Stat display channel'
                });
                channel_id = newChannel.id;
                logger.info(`[API Core] Created stat display voice channel: ${newChannel.name} (${channel_id})`);
            } catch (createErr) {
                logger.error('[API Core] Failed to create voice channel:', { error: createErr.message });
                return res.status(500).json({ error: 'Failed to create voice channel: ' + createErr.message });
            }
        }

        if (!channel_id) {
            return res.status(400).json({ error: 'Select a voice channel or choose "Create new channel"' });
        }

        const config = stat_type === 'role' ? JSON.stringify({ role_id: req.body.role_id })
            : stat_type === 'twitch_followers' ? JSON.stringify({ twitch_username: req.body.twitch_username.trim().toLowerCase() })
            : null;

        await pool.execute(`
            INSERT INTO stat_display_channels (guild_id, channel_id, stat_type, template, config)
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE stat_type = VALUES(stat_type), template = VALUES(template), config = VALUES(config)
        `, [guildId, channel_id, stat_type, finalTemplate, config]);

        logger.info(`[API Core] Stat display added: ${stat_type} → ${channel_id} in guild ${guildId}`);
        res.json({ success: true, message: 'Stat display channel added' });
    } catch (error) {
        logger.error('[API Core] Error adding stat display:', { error: error.message, code: error.code, sql: error.sql });
        res.status(500).json({ error: error.code === 'ER_DUP_ENTRY' ? 'This channel already has a stat display assigned' : 'Failed to add stat display channel' });
    }
});

/**
 * DELETE /api/guilds/:guildId/core/stat-displays/:id
 */
router.delete('/stat-displays/:id', async (req, res) => {
    try {
        const { guildId, id } = req.params;
        await pool.execute(
            'DELETE FROM stat_display_channels WHERE id = ? AND guild_id = ?',
            [id, guildId]
        );
        logger.info(`[API Core] Stat display ${id} removed from guild ${guildId}`);
        res.json({ success: true, message: 'Stat display channel removed' });
    } catch (error) {
        logger.error('[API Core] Error removing stat display:', error);
        res.status(500).json({ error: 'Failed to remove stat display channel' });
    }
});

/**
 * PATCH /api/guilds/:guildId/core/stat-displays/:id
 * Update a stat display's template or config
 */
router.patch('/stat-displays/:id', async (req, res) => {
    try {
        const { guildId, id } = req.params;
        const { template, stat_type, config } = req.body;

        const updates = [];
        const values = [];

        if (template !== undefined) {
            if (!template.includes('{value}')) {
                return res.status(400).json({ error: 'Template must include {value}' });
            }
            updates.push('template = ?');
            values.push(template);
        }
        if (stat_type !== undefined) {
            updates.push('stat_type = ?');
            values.push(stat_type);
        }
        if (config !== undefined) {
            updates.push('config = ?');
            values.push(typeof config === 'string' ? config : JSON.stringify(config));
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'Nothing to update' });
        }

        values.push(id, guildId);
        await pool.execute(
            `UPDATE stat_display_channels SET ${updates.join(', ')} WHERE id = ? AND guild_id = ?`,
            values
        );

        logger.info(`[API Core] Stat display ${id} updated in guild ${guildId}`);
        res.json({ success: true });
    } catch (error) {
        logger.error('[API Core] Error updating stat display:', { error: error.message });
        res.status(500).json({ error: 'Failed to update stat display' });
    }
});

export default router;
