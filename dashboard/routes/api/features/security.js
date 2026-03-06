/**
 * Security API
 * Handles raid detection, anti-nuke, and security settings
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import socketService from '../../../services/SocketService.js';

const router = express.Router({ mergeParams: true });

/**
 * GET /api/guilds/:guildId/security/raid
 * Get raid detection configuration
 */
router.get('/raid', async (req, res) => {
    try {
        const { guildId } = req.params;

        const [config] = await pool.execute(
            'SELECT * FROM raid_detection_config WHERE guild_id = ?',
            [guildId]
        );

        res.json({
            success: true,
            config: config[0] || {
                enabled: false,
                join_threshold: 10,
                join_window_seconds: 10,
                action: 'lockdown',
                log_channel_id: null,
                whitelist_roles: []
            }
        });
    } catch (error) {
        logger.error('[API Security Raid GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch raid config' });
    }
});

/**
 * PUT /api/guilds/:guildId/security/raid
 * Update raid detection configuration
 */
router.put('/raid', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            enabled,
            join_threshold,
            join_window_seconds,
            action,
            log_channel_id,
            whitelist_roles,
            auto_unban_minutes
        } = req.body;

        await pool.execute(`
            INSERT INTO raid_detection_config
                (guild_id, enabled, join_threshold, join_window_seconds, action,
                 log_channel_id, whitelist_roles, auto_unban_minutes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled),
                join_threshold = VALUES(join_threshold),
                join_window_seconds = VALUES(join_window_seconds),
                action = VALUES(action),
                log_channel_id = VALUES(log_channel_id),
                whitelist_roles = VALUES(whitelist_roles),
                auto_unban_minutes = VALUES(auto_unban_minutes)
        `, [
            guildId,
            enabled ? 1 : 0,
            join_threshold || 10,
            join_window_seconds || 10,
            action || 'lockdown',
            log_channel_id || null,
            JSON.stringify(whitelist_roles || []),
            auto_unban_minutes || 0
        ]);

        socketService.configSaved(guildId, 'raid-detection', req.body);

        res.json({ success: true, message: 'Raid detection config updated' });
    } catch (error) {
        logger.error('[API Security Raid PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update raid config' });
    }
});

/**
 * GET /api/guilds/:guildId/security/incidents
 * Get security incidents
 */
router.get('/incidents', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { type, page = 1, limit = 25 } = req.query;
        const offset = (page - 1) * limit;

        let query = 'SELECT * FROM raid_incidents WHERE guild_id = ?';
        const params = [guildId];

        if (type) {
            query += ' AND incident_type = ?';
            params.push(type);
        }

        query += ' ORDER BY detected_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const [incidents] = await pool.execute(query, params);

        res.json({ success: true, incidents });
    } catch (error) {
        logger.error('[API Security Incidents GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch incidents' });
    }
});

/**
 * GET /api/guilds/:guildId/security/selfbot
 * Get selfbot detection configuration
 */
router.get('/selfbot', async (req, res) => {
    try {
        const { guildId } = req.params;

        const [config] = await pool.execute(
            'SELECT * FROM selfbot_detection_config WHERE guild_id = ?',
            [guildId]
        );

        res.json({
            success: true,
            config: config[0] || {
                enabled: false,
                action: 'warn',
                log_channel_id: null,
                exempt_roles: []
            }
        });
    } catch (error) {
        logger.error('[API Security Selfbot GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch selfbot config' });
    }
});

/**
 * PUT /api/guilds/:guildId/security/selfbot
 * Update selfbot detection configuration
 */
router.put('/selfbot', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { enabled, action, log_channel_id, exempt_roles } = req.body;

        await pool.execute(`
            INSERT INTO selfbot_detection_config
                (guild_id, enabled, action, log_channel_id, exempt_roles)
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled),
                action = VALUES(action),
                log_channel_id = VALUES(log_channel_id),
                exempt_roles = VALUES(exempt_roles)
        `, [
            guildId,
            enabled ? 1 : 0,
            action || 'warn',
            log_channel_id || null,
            JSON.stringify(exempt_roles || [])
        ]);

        socketService.configSaved(guildId, 'selfbot-detection', req.body);

        res.json({ success: true, message: 'Selfbot detection config updated' });
    } catch (error) {
        logger.error('[API Security Selfbot PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update selfbot config' });
    }
});

export default router;
