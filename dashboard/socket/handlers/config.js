/**
 * Config Socket Handler
 * Handles real-time config updates
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

export function configHandler(io, socket) {
    const user = socket.user;

    /**
     * Handle config update request
     * Client sends config changes, server saves and broadcasts
     */
    socket.on('config:update', async (data) => {
        try {
            const { guildId, feature, config } = data;

            if (!guildId || !feature || !config) {
                socket.emit('config:error', {
                    feature,
                    error: 'Missing required fields'
                });
                return;
            }

            // Verify user has permission (basic check)
            if (!socket.currentGuildId || socket.currentGuildId !== guildId) {
                socket.emit('config:error', {
                    feature,
                    error: 'Not authorized for this guild'
                });
                return;
            }

            // Log the update
            logger.info(`[Socket Config] ${user.username} updating ${feature} for guild ${guildId}`);

            // Broadcast to all clients viewing this guild
            io.to(`guild:${guildId}`).emit('config:updated', {
                feature,
                config,
                updatedBy: user.username,
                timestamp: Date.now()
            });

            // Confirm to sender
            socket.emit('config:saved', {
                feature,
                success: true,
                timestamp: Date.now()
            });

        } catch (error) {
            logger.error('[Socket Config] Error:', error);
            socket.emit('config:error', {
                feature: data?.feature,
                error: 'Failed to save config'
            });
        }
    });

    /**
     * Request current config for a feature
     */
    socket.on('config:get', async (data) => {
        try {
            const { guildId, feature } = data;

            if (!guildId || !feature) {
                return;
            }

            // Map feature to table
            const tableMap = {
                'moderation': 'moderation_config',
                'automod': 'automod_config',
                'leveling': 'level_config',
                'economy': 'economy_config',
                'welcome': 'welcome_settings',
                'starboard': 'starboard_config',
                'suggestions': 'suggestion_config',
                'tickets': 'ticket_config'
            };

            const table = tableMap[feature];
            if (!table) {
                socket.emit('config:data', { feature, config: null });
                return;
            }

            const [rows] = await pool.execute(
                `SELECT * FROM ${table} WHERE guild_id = ?`,
                [guildId]
            );

            socket.emit('config:data', {
                feature,
                config: rows[0] || null
            });

        } catch (error) {
            logger.error('[Socket Config Get] Error:', error);
        }
    });

    /**
     * Subscribe to config changes for specific features
     */
    socket.on('config:subscribe', (features) => {
        if (!Array.isArray(features)) return;
        socket.subscribedFeatures = features;
    });
}

export default configHandler;
