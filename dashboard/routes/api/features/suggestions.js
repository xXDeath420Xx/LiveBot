/**
 * Suggestions API
 * Handles suggestion system configuration and management
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import socketService from '../../../services/SocketService.js';

const router = express.Router({ mergeParams: true });

/**
 * GET /api/guilds/:guildId/suggestions/config
 * Get suggestions configuration
 */
router.get('/config', async (req, res) => {
    try {
        const { guildId } = req.params;

        const [config] = await pool.execute(
            'SELECT * FROM suggestion_config WHERE guild_id = ?',
            [guildId]
        );

        res.json({
            success: true,
            config: config[0] || {
                enabled: false,
                channel_id: null,
                approved_channel_id: null,
                denied_channel_id: null,
                staff_role_id: null,
                auto_thread: false,
                dm_on_status: true
            }
        });
    } catch (error) {
        logger.error('[API Suggestions Config GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch suggestions config' });
    }
});

/**
 * PUT /api/guilds/:guildId/suggestions/config
 * Update suggestions configuration
 */
router.put('/config', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            enabled,
            channel_id,
            approved_channel_id,
            denied_channel_id,
            staff_role_id,
            auto_thread,
            dm_on_status,
            upvote_emoji,
            downvote_emoji
        } = req.body;

        await pool.execute(`
            INSERT INTO suggestion_config
                (guild_id, enabled, channel_id, approved_channel_id, denied_channel_id,
                 staff_role_id, auto_thread, dm_on_status, upvote_emoji, downvote_emoji)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled),
                channel_id = VALUES(channel_id),
                approved_channel_id = VALUES(approved_channel_id),
                denied_channel_id = VALUES(denied_channel_id),
                staff_role_id = VALUES(staff_role_id),
                auto_thread = VALUES(auto_thread),
                dm_on_status = VALUES(dm_on_status),
                upvote_emoji = VALUES(upvote_emoji),
                downvote_emoji = VALUES(downvote_emoji)
        `, [
            guildId,
            enabled ? 1 : 0,
            channel_id || null,
            approved_channel_id || null,
            denied_channel_id || null,
            staff_role_id || null,
            auto_thread ? 1 : 0,
            dm_on_status ? 1 : 0,
            upvote_emoji || ':thumbsup:',
            downvote_emoji || ':thumbsdown:'
        ]);

        socketService.configSaved(guildId, 'suggestions', req.body);

        res.json({ success: true, message: 'Suggestions config updated' });
    } catch (error) {
        logger.error('[API Suggestions Config PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update suggestions config' });
    }
});

/**
 * GET /api/guilds/:guildId/suggestions
 * Get all suggestions
 */
router.get('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { status = 'all', page = 1, limit = 25 } = req.query;
        const offset = (page - 1) * limit;

        let query = 'SELECT * FROM suggestions WHERE guild_id = ?';
        const params = [guildId];

        if (status !== 'all') {
            query += ' AND status = ?';
            params.push(status);
        }

        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const [suggestions] = await pool.execute(query, params);

        res.json({ success: true, suggestions });
    } catch (error) {
        logger.error('[API Suggestions GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch suggestions' });
    }
});

/**
 * PUT /api/guilds/:guildId/suggestions/:suggestionId/status
 * Update suggestion status
 */
router.put('/:suggestionId/status', async (req, res) => {
    try {
        const { guildId, suggestionId } = req.params;
        const { status, response } = req.body;

        if (!['pending', 'approved', 'denied', 'implemented'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        await pool.execute(`
            UPDATE suggestions
            SET status = ?, staff_response = ?, reviewed_by = ?, reviewed_at = NOW()
            WHERE id = ? AND guild_id = ?
        `, [status, response || null, req.user.id, suggestionId, guildId]);

        res.json({ success: true, message: 'Suggestion status updated' });
    } catch (error) {
        logger.error('[API Suggestions Status PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update suggestion status' });
    }
});

/**
 * DELETE /api/guilds/:guildId/suggestions/:suggestionId
 * Delete a suggestion
 */
router.delete('/:suggestionId', async (req, res) => {
    try {
        const { guildId, suggestionId } = req.params;

        await pool.execute(
            'DELETE FROM suggestions WHERE id = ? AND guild_id = ?',
            [suggestionId, guildId]
        );

        res.json({ success: true, message: 'Suggestion deleted' });
    } catch (error) {
        logger.error('[API Suggestions DELETE] Error:', error);
        res.status(500).json({ error: 'Failed to delete suggestion' });
    }
});

export default router;
