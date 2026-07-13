/**
 * Logging API
 * Handles server logging configuration
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import socketService from '../../../services/SocketService.js';

const router = express.Router({ mergeParams: true });

// Available log event types
const LOG_EVENTS = [
    'message_delete', 'message_edit', 'message_bulk_delete',
    'member_join', 'member_leave', 'member_update', 'member_ban', 'member_unban',
    'role_create', 'role_delete', 'role_update',
    'channel_create', 'channel_delete', 'channel_update',
    'voice_join', 'voice_leave', 'voice_move',
    'invite_create', 'invite_delete',
    'emoji_create', 'emoji_delete',
    'moderation_action'
];

/**
 * GET /api/guilds/:guildId/logging/config
 * Get logging configuration
 */
router.get('/config', async (req, res) => {
    try {
        const { guildId } = req.params;

        const [config] = await pool.execute(
            'SELECT * FROM logging_config WHERE guild_id = ?',
            [guildId]
        );

        const [eventConfigs] = await pool.execute(
            'SELECT * FROM log_event_config WHERE guild_id = ?',
            [guildId]
        );

        // Build event map
        const events = {};
        eventConfigs.forEach(e => {
            events[e.event_type] = {
                enabled: e.enabled === 1,
                channel_id: e.log_channel_id,
                embed_color: e.embed_color || null
            };
        });

        res.json({
            success: true,
            config: {
                enabled: config[0]?.enabled === 1,
                default_channel_id: config[0]?.log_channel_id,
                events,
                available_events: LOG_EVENTS
            }
        });
    } catch (error) {
        logger.error('[API Logging Config GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch logging config' });
    }
});

/**
 * PUT /api/guilds/:guildId/logging/config
 * Update logging configuration
 */
router.put('/config', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { enabled, default_channel_id, events, enabled_logs, log_channel_id, log_categories, event_colors } = req.body;

        // Update main config (support both form formats)
        const channelId = log_channel_id || default_channel_id || null;
        const isEnabled = enabled !== undefined ? (enabled ? 1 : 0) : 1;

        await pool.execute(`
            INSERT INTO logging_config (guild_id, enabled, log_channel_id)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled),
                log_channel_id = VALUES(log_channel_id)
        `, [guildId, isEnabled, channelId]);

        // Handle dashboard form format: enabled_logs[] + log_categories{} + event_colors{}
        if (enabled_logs && Array.isArray(enabled_logs)) {
            // Update enabled_events in logging_config to match the toggled events
            await pool.execute(
                'UPDATE logging_config SET enabled_events = ? WHERE guild_id = ?',
                [JSON.stringify(enabled_logs), guildId]
            );

            // Collect all event types that exist in log_event_config
            const [existingEvents] = await pool.execute(
                'SELECT event_type FROM log_event_config WHERE guild_id = ?',
                [guildId]
            );
            const existingEventTypes = new Set(existingEvents.map(r => r.event_type));

            // Update/insert per-event configs
            const allEventKeys = new Set([
                ...enabled_logs,
                ...Object.keys(log_categories || {}),
                ...Object.keys(event_colors || {}),
                ...existingEventTypes,
            ]);

            for (const eventType of allEventKeys) {
                const eventEnabled = enabled_logs.includes(eventType) ? 1 : 0;
                const eventChannelId = (log_categories && log_categories[eventType]) || null;
                const eventColor = (event_colors && event_colors[eventType]) || null;

                await pool.execute(`
                    INSERT INTO log_event_config
                        (guild_id, event_type, enabled, log_channel_id, embed_color)
                    VALUES (?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE
                        enabled = VALUES(enabled),
                        log_channel_id = COALESCE(VALUES(log_channel_id), log_channel_id),
                        embed_color = COALESCE(VALUES(embed_color), embed_color)
                `, [guildId, eventType, eventEnabled, eventChannelId, eventColor]);
            }
        }

        // Handle programmatic API format: events{}
        if (events && typeof events === 'object') {
            for (const [eventType, eventConfig] of Object.entries(events)) {
                await pool.execute(`
                    INSERT INTO log_event_config
                        (guild_id, event_type, enabled, log_channel_id, embed_color)
                    VALUES (?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE
                        enabled = VALUES(enabled),
                        log_channel_id = VALUES(log_channel_id),
                        embed_color = VALUES(embed_color)
                `, [
                    guildId,
                    eventType,
                    eventConfig.enabled ? 1 : 0,
                    eventConfig.channel_id || null,
                    eventConfig.embed_color || null
                ]);
            }
        }

        socketService.configSaved(guildId, 'logging', req.body);

        res.json({ success: true, message: 'Logging config updated' });
    } catch (error) {
        logger.error('[API Logging Config PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update logging config' });
    }
});

/**
 * GET /api/guilds/:guildId/logging/events
 * Get available log event types
 */
router.get('/events', (req, res) => {
    res.json({
        success: true,
        events: LOG_EVENTS.map(e => ({
            type: e,
            label: e.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
        }))
    });
});

export default router;
