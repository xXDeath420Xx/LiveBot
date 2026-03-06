/**
 * Tickets API
 * Handles ticket system configuration and management
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import socketService from '../../../services/SocketService.js';

const router = express.Router({ mergeParams: true });

/**
 * GET /api/guilds/:guildId/tickets/config
 * Get ticket system configuration
 */
router.get('/config', async (req, res) => {
    try {
        const { guildId } = req.params;

        const [config] = await pool.execute(
            'SELECT * FROM ticket_config WHERE guild_id = ?',
            [guildId]
        );

        res.json({
            success: true,
            config: config[0] || {
                enabled: false,
                category_id: null,
                log_channel_id: null,
                support_roles: [],
                max_open_tickets: 1,
                auto_close_hours: 0
            }
        });
    } catch (error) {
        logger.error('[API Tickets Config GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch ticket config' });
    }
});

/**
 * PUT /api/guilds/:guildId/tickets/config
 * Update ticket configuration
 */
router.put('/config', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            enabled,
            category_id,
            log_channel_id,
            support_roles,
            max_open_tickets,
            auto_close_hours,
            dm_on_close,
            transcript_channel_id
        } = req.body;

        await pool.execute(`
            INSERT INTO ticket_config
                (guild_id, enabled, category_id, log_channel_id, support_roles,
                 max_open_tickets, auto_close_hours, dm_on_close, transcript_channel_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled),
                category_id = VALUES(category_id),
                log_channel_id = VALUES(log_channel_id),
                support_roles = VALUES(support_roles),
                max_open_tickets = VALUES(max_open_tickets),
                auto_close_hours = VALUES(auto_close_hours),
                dm_on_close = VALUES(dm_on_close),
                transcript_channel_id = VALUES(transcript_channel_id)
        `, [
            guildId,
            enabled ? 1 : 0,
            category_id || null,
            log_channel_id || null,
            JSON.stringify(support_roles || []),
            max_open_tickets || 1,
            auto_close_hours || 0,
            dm_on_close ? 1 : 0,
            transcript_channel_id || null
        ]);

        socketService.configSaved(guildId, 'tickets', req.body);

        res.json({ success: true, message: 'Ticket config updated' });
    } catch (error) {
        logger.error('[API Tickets Config PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update ticket config' });
    }
});

/**
 * GET /api/guilds/:guildId/tickets/panels
 * Get all ticket panels
 */
router.get('/panels', async (req, res) => {
    try {
        const { guildId } = req.params;

        const [panels] = await pool.execute(
            'SELECT * FROM ticket_panels WHERE guild_id = ? ORDER BY created_at DESC',
            [guildId]
        );

        res.json({ success: true, panels });
    } catch (error) {
        logger.error('[API Tickets Panels GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch panels' });
    }
});

/**
 * POST /api/guilds/:guildId/tickets/panels
 * Create a ticket panel
 */
router.post('/panels', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            name,
            title,
            description,
            channel_id,
            button_label,
            button_emoji,
            button_style,
            category_id,
            support_roles,
            welcome_message
        } = req.body;

        if (!name || !channel_id) {
            return res.status(400).json({ error: 'Name and channel_id are required' });
        }

        const [result] = await pool.execute(`
            INSERT INTO ticket_panels
                (guild_id, name, title, description, channel_id, button_label,
                 button_emoji, button_style, category_id, support_roles, welcome_message)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            guildId,
            name,
            title || 'Support Ticket',
            description || 'Click the button below to create a ticket',
            channel_id,
            button_label || 'Create Ticket',
            button_emoji || ':ticket:',
            button_style || 'primary',
            category_id || null,
            JSON.stringify(support_roles || []),
            welcome_message || 'Thank you for creating a ticket! Support will be with you shortly.'
        ]);

        res.json({
            success: true,
            message: 'Panel created',
            panelId: result.insertId
        });
    } catch (error) {
        logger.error('[API Tickets Panels POST] Error:', error);
        res.status(500).json({ error: 'Failed to create panel' });
    }
});

/**
 * DELETE /api/guilds/:guildId/tickets/panels/:panelId
 * Delete a ticket panel
 */
router.delete('/panels/:panelId', async (req, res) => {
    try {
        const { guildId, panelId } = req.params;

        await pool.execute(
            'DELETE FROM ticket_panels WHERE id = ? AND guild_id = ?',
            [panelId, guildId]
        );

        res.json({ success: true, message: 'Panel deleted' });
    } catch (error) {
        logger.error('[API Tickets Panels DELETE] Error:', error);
        res.status(500).json({ error: 'Failed to delete panel' });
    }
});

/**
 * GET /api/guilds/:guildId/tickets/list
 * Get list of tickets
 */
router.get('/list', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { status = 'open', page = 1, limit = 25 } = req.query;
        const offset = (page - 1) * limit;

        const [tickets] = await pool.execute(`
            SELECT * FROM tickets
            WHERE guild_id = ? AND status = ?
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `, [guildId, status, parseInt(limit), parseInt(offset)]);

        res.json({ success: true, tickets });
    } catch (error) {
        logger.error('[API Tickets List GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch tickets' });
    }
});

export default router;
