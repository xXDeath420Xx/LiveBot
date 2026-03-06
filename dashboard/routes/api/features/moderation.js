/**
 * Moderation API
 * Handles moderation settings and infractions
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import socketService from '../../../services/SocketService.js';

const router = express.Router({ mergeParams: true });

/**
 * GET /api/guilds/:guildId/moderation/config
 * Get moderation configuration
 */
router.get('/config', async (req, res) => {
    try {
        const { guildId } = req.params;

        const [config] = await pool.execute(
            'SELECT * FROM moderation_config WHERE guild_id = ?',
            [guildId]
        );

        res.json({
            success: true,
            config: config[0] || {
                enabled: false,
                mod_log_channel_id: null,
                mute_role_id: null,
                auto_delete_commands: false,
                dm_on_action: true
            }
        });
    } catch (error) {
        logger.error('[API Moderation Config GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch moderation config' });
    }
});

/**
 * PUT /api/guilds/:guildId/moderation/config
 * Update moderation configuration
 */
router.put('/config', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            enabled,
            mod_log_channel_id,
            mute_role_id,
            auto_delete_commands,
            dm_on_action
        } = req.body;

        await pool.execute(`
            INSERT INTO moderation_config
                (guild_id, enabled, mod_log_channel_id, mute_role_id, auto_delete_commands, dm_on_action)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled),
                mod_log_channel_id = VALUES(mod_log_channel_id),
                mute_role_id = VALUES(mute_role_id),
                auto_delete_commands = VALUES(auto_delete_commands),
                dm_on_action = VALUES(dm_on_action)
        `, [guildId, enabled ? 1 : 0, mod_log_channel_id || null, mute_role_id || null, auto_delete_commands ? 1 : 0, dm_on_action ? 1 : 0]);

        socketService.configSaved(guildId, 'moderation', req.body);

        res.json({ success: true, message: 'Moderation config updated' });
    } catch (error) {
        logger.error('[API Moderation Config PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update moderation config' });
    }
});

/**
 * GET /api/guilds/:guildId/moderation/infractions
 * Get recent infractions
 */
router.get('/infractions', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { page = 1, limit = 50, user_id, action } = req.query;
        const offset = (page - 1) * limit;

        let query = 'SELECT * FROM infractions WHERE guild_id = ?';
        const params = [guildId];

        if (user_id) {
            query += ' AND user_id = ?';
            params.push(user_id);
        }

        if (action) {
            query += ' AND action = ?';
            params.push(action);
        }

        query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const [infractions] = await pool.execute(query, params);

        // Get total count
        const [countResult] = await pool.execute(
            'SELECT COUNT(*) as total FROM infractions WHERE guild_id = ?',
            [guildId]
        );

        res.json({
            success: true,
            infractions,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: countResult[0].total,
                pages: Math.ceil(countResult[0].total / limit)
            }
        });
    } catch (error) {
        logger.error('[API Moderation Infractions GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch infractions' });
    }
});

/**
 * DELETE /api/guilds/:guildId/moderation/infractions/:id
 * Delete an infraction
 */
router.delete('/infractions/:id', async (req, res) => {
    try {
        const { guildId, id } = req.params;

        const [result] = await pool.execute(
            'DELETE FROM infractions WHERE id = ? AND guild_id = ?',
            [id, guildId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Infraction not found' });
        }

        res.json({ success: true, message: 'Infraction deleted' });
    } catch (error) {
        logger.error('[API Moderation Infractions DELETE] Error:', error);
        res.status(500).json({ error: 'Failed to delete infraction' });
    }
});

/**
 * GET /api/guilds/:guildId/moderation/user/:userId
 * Get user moderation history
 */
router.get('/user/:userId', async (req, res) => {
    try {
        const { guildId, userId } = req.params;

        const [infractions] = await pool.execute(
            'SELECT * FROM infractions WHERE guild_id = ? AND user_id = ? ORDER BY timestamp DESC',
            [guildId, userId]
        );

        // Get infraction summary
        const [summary] = await pool.execute(`
            SELECT action, COUNT(*) as count
            FROM infractions
            WHERE guild_id = ? AND user_id = ?
            GROUP BY action
        `, [guildId, userId]);

        res.json({
            success: true,
            userId,
            infractions,
            summary: summary.reduce((acc, s) => {
                acc[s.action] = s.count;
                return acc;
            }, {})
        });
    } catch (error) {
        logger.error('[API Moderation User GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch user history' });
    }
});

/**
 * PUT /api/guilds/:guildId/moderation/infractions/:id
 * Update infraction reason
 */
router.put('/infractions/:id', async (req, res) => {
    try {
        const { guildId, id } = req.params;
        const { reason } = req.body;

        const [result] = await pool.execute(
            'UPDATE infractions SET reason = ? WHERE id = ? AND guild_id = ?',
            [reason, id, guildId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Infraction not found' });
        }

        res.json({ success: true, message: 'Infraction updated' });
    } catch (error) {
        logger.error('[API Moderation Infractions PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update infraction' });
    }
});

export default router;
