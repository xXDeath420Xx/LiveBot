/**
 * Automod API
 * Handles automod configuration
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import socketService from '../../../services/SocketService.js';

const router = express.Router({ mergeParams: true });

/**
 * GET /api/guilds/:guildId/automod/config
 * Get all automod configurations
 */
router.get('/config', async (req, res) => {
    try {
        const { guildId } = req.params;

        // Fetch all automod configs
        const [automodConfig] = await pool.execute(
            'SELECT * FROM automod_config WHERE guild_id = ?',
            [guildId]
        );

        const [adaptiveSpam] = await pool.execute(
            'SELECT * FROM adaptive_spam_config WHERE guild_id = ?',
            [guildId]
        );

        const [antiNuke] = await pool.execute(
            'SELECT * FROM anti_nuke_config WHERE guild_id = ?',
            [guildId]
        );

        res.json({
            success: true,
            config: {
                automod: automodConfig[0] || {},
                adaptiveSpam: adaptiveSpam[0] || {},
                antiNuke: antiNuke[0] || {}
            }
        });
    } catch (error) {
        logger.error('[API Automod Config GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch automod config' });
    }
});

/**
 * PUT /api/guilds/:guildId/automod/config
 * Update main automod configuration
 */
router.put('/config', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            enabled,
            log_channel_id,
            exempt_roles,
            exempt_channels,
            anti_spam,
            anti_links,
            anti_invites,
            anti_caps,
            anti_mass_mentions,
            word_filter_enabled,
            filtered_words
        } = req.body;

        await pool.execute(`
            INSERT INTO automod_config
                (guild_id, enabled, log_channel_id, exempt_roles, exempt_channels,
                 anti_spam, anti_links, anti_invites, anti_caps, anti_mass_mentions,
                 word_filter_enabled, filtered_words)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled),
                log_channel_id = VALUES(log_channel_id),
                exempt_roles = VALUES(exempt_roles),
                exempt_channels = VALUES(exempt_channels),
                anti_spam = VALUES(anti_spam),
                anti_links = VALUES(anti_links),
                anti_invites = VALUES(anti_invites),
                anti_caps = VALUES(anti_caps),
                anti_mass_mentions = VALUES(anti_mass_mentions),
                word_filter_enabled = VALUES(word_filter_enabled),
                filtered_words = VALUES(filtered_words)
        `, [
            guildId,
            enabled ? 1 : 0,
            log_channel_id || null,
            JSON.stringify(exempt_roles || []),
            JSON.stringify(exempt_channels || []),
            anti_spam ? 1 : 0,
            anti_links ? 1 : 0,
            anti_invites ? 1 : 0,
            anti_caps ? 1 : 0,
            anti_mass_mentions ? 1 : 0,
            word_filter_enabled ? 1 : 0,
            JSON.stringify(filtered_words || [])
        ]);

        socketService.configSaved(guildId, 'automod', req.body);

        res.json({ success: true, message: 'Automod config updated' });
    } catch (error) {
        logger.error('[API Automod Config PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update automod config' });
    }
});

/**
 * PUT /api/guilds/:guildId/automod/adaptive-spam
 * Update adaptive spam configuration
 */
router.put('/adaptive-spam', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            enabled,
            action,
            threshold,
            mute_duration,
            log_channel_id,
            exempt_roles,
            alert_channel_id,
            new_account_multiplier_24h,
            new_account_multiplier_7d
        } = req.body;

        await pool.execute(`
            INSERT INTO adaptive_spam_config
                (guild_id, enabled, action, threshold, mute_duration, log_channel_id,
                 exempt_roles, alert_channel_id, new_account_multiplier_24h, new_account_multiplier_7d)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled),
                action = VALUES(action),
                threshold = VALUES(threshold),
                mute_duration = VALUES(mute_duration),
                log_channel_id = VALUES(log_channel_id),
                exempt_roles = VALUES(exempt_roles),
                alert_channel_id = VALUES(alert_channel_id),
                new_account_multiplier_24h = VALUES(new_account_multiplier_24h),
                new_account_multiplier_7d = VALUES(new_account_multiplier_7d)
        `, [
            guildId,
            enabled ? 1 : 0,
            action || 'mute',
            threshold || 75,
            mute_duration || 300,
            log_channel_id || null,
            JSON.stringify(exempt_roles || []),
            alert_channel_id || null,
            new_account_multiplier_24h || 2.5,
            new_account_multiplier_7d || 1.75
        ]);

        socketService.configSaved(guildId, 'adaptive-spam', req.body);

        res.json({ success: true, message: 'Adaptive spam config updated' });
    } catch (error) {
        logger.error('[API Adaptive Spam PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update adaptive spam config' });
    }
});

/**
 * PUT /api/guilds/:guildId/automod/anti-nuke
 * Update anti-nuke configuration
 */
router.put('/anti-nuke', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            enabled,
            log_channel_id,
            action,
            max_bans_per_hour,
            max_kicks_per_hour,
            max_channel_deletes_per_hour,
            max_role_deletes_per_hour,
            trusted_roles
        } = req.body;

        await pool.execute(`
            INSERT INTO anti_nuke_config
                (guild_id, enabled, log_channel_id, action,
                 max_bans_per_hour, max_kicks_per_hour, max_channel_deletes_per_hour,
                 max_role_deletes_per_hour, trusted_roles)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled),
                log_channel_id = VALUES(log_channel_id),
                action = VALUES(action),
                max_bans_per_hour = VALUES(max_bans_per_hour),
                max_kicks_per_hour = VALUES(max_kicks_per_hour),
                max_channel_deletes_per_hour = VALUES(max_channel_deletes_per_hour),
                max_role_deletes_per_hour = VALUES(max_role_deletes_per_hour),
                trusted_roles = VALUES(trusted_roles)
        `, [
            guildId,
            enabled ? 1 : 0,
            log_channel_id || null,
            action || 'remove_roles',
            max_bans_per_hour || 5,
            max_kicks_per_hour || 5,
            max_channel_deletes_per_hour || 3,
            max_role_deletes_per_hour || 3,
            JSON.stringify(trusted_roles || [])
        ]);

        socketService.configSaved(guildId, 'anti-nuke', req.body);

        res.json({ success: true, message: 'Anti-nuke config updated' });
    } catch (error) {
        logger.error('[API Anti-Nuke PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update anti-nuke config' });
    }
});

/**
 * GET /api/guilds/:guildId/automod/logs
 * Get automod action logs
 */
router.get('/logs', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { page = 1, limit = 50 } = req.query;
        const offset = (page - 1) * limit;

        const [logs] = await pool.execute(`
            SELECT * FROM automod_logs
            WHERE guild_id = ?
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        `, [guildId, parseInt(limit), parseInt(offset)]);

        res.json({ success: true, logs });
    } catch (error) {
        logger.error('[API Automod Logs GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch automod logs' });
    }
});

export default router;
