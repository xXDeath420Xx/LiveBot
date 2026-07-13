/**
 * Phishing Detection API
 * GET/PUT config including exempt channels and report channel
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';

const router = express.Router({ mergeParams: true });

/**
 * GET /api/guilds/:guildId/phishing
 */
router.get('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [config] = await pool.execute(
            'SELECT * FROM phishing_config WHERE guild_id = ?',
            [guildId]
        );

        res.json({
            success: true,
            config: config[0] || {
                enabled: false,
                action: 'delete',
                mute_duration_minutes: 30,
                alert_channel_id: null,
                whitelist_domains: '[]',
                log_detections: true,
                exempt_channels: '[]',
                report_channel_id: null
            }
        });
    } catch (error) {
        logger.error('[API Phishing GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch phishing config' });
    }
});

/**
 * PUT /api/guilds/:guildId/phishing
 */
router.put('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            enabled,
            action,
            mute_duration_minutes,
            alert_channel_id,
            whitelist_domains,
            log_detections,
            exempt_channels,
            report_channel_id
        } = req.body;

        // Validate JSON arrays if provided
        for (const [field, value] of [['exempt_channels', exempt_channels], ['whitelist_domains', whitelist_domains]]) {
            if (value && value !== '[]') {
                try {
                    const parsed = JSON.parse(value);
                    if (!Array.isArray(parsed)) {
                        return res.status(400).json({ error: `${field} must be a JSON array` });
                    }
                } catch {
                    return res.status(400).json({ error: `${field} must be valid JSON` });
                }
            }
        }

        await pool.execute(`
            INSERT INTO phishing_config (guild_id, enabled, action, mute_duration_minutes, alert_channel_id, whitelist_domains, log_detections, exempt_channels, report_channel_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled),
                action = VALUES(action),
                mute_duration_minutes = VALUES(mute_duration_minutes),
                alert_channel_id = VALUES(alert_channel_id),
                whitelist_domains = VALUES(whitelist_domains),
                log_detections = VALUES(log_detections),
                exempt_channels = VALUES(exempt_channels),
                report_channel_id = VALUES(report_channel_id)
        `, [
            guildId,
            enabled ? 1 : 0,
            action || 'delete',
            mute_duration_minutes || 30,
            alert_channel_id || null,
            whitelist_domains || '[]',
            log_detections ? 1 : 0,
            exempt_channels || '[]',
            report_channel_id || null
        ]);

        res.json({ success: true });
    } catch (error) {
        logger.error('[API Phishing PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update phishing config' });
    }
});

export default router;
