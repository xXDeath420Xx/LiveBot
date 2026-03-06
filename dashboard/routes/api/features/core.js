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

export default router;
