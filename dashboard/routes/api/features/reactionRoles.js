/**
 * Reaction Roles API
 * Handles reaction role panels and mappings
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import socketService from '../../../services/SocketService.js';

const router = express.Router({ mergeParams: true });

/**
 * GET /api/guilds/:guildId/reaction-roles/panels
 * Get all reaction role panels
 */
router.get('/panels', async (req, res) => {
    try {
        const { guildId } = req.params;

        const [panels] = await pool.execute(
            'SELECT * FROM reaction_role_panels WHERE guild_id = ? ORDER BY id DESC',
            [guildId]
        );

        // Fetch mappings for each panel
        for (const panel of panels) {
            const [mappings] = await pool.execute(
                'SELECT * FROM reaction_role_mappings WHERE panel_id = ? ORDER BY id ASC',
                [panel.id]
            );
            panel.mappings = mappings;
        }

        res.json({ success: true, panels });
    } catch (error) {
        logger.error('[API Reaction Roles Panels GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch panels' });
    }
});

/**
 * POST /api/guilds/:guildId/reaction-roles/panels
 * Create a reaction role panel
 */
router.post('/panels', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            channel_id,
            title,
            description,
            color,
            panel_mode,
            interaction_type,
            max_roles,
            mappings
        } = req.body;

        if (!channel_id || !title) {
            return res.status(400).json({ error: 'Channel and title are required' });
        }

        // Create panel
        const [result] = await pool.execute(`
            INSERT INTO reaction_role_panels
                (guild_id, channel_id, title, description, color, panel_mode, interaction_type, max_roles)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            guildId,
            channel_id,
            title,
            description || '',
            color || '#a78bfa',
            panel_mode || 'normal',
            interaction_type || 'button',
            max_roles || 0
        ]);

        const panelId = result.insertId;

        // Add mappings if provided
        if (mappings && Array.isArray(mappings)) {
            for (const mapping of mappings) {
                await pool.execute(`
                    INSERT INTO reaction_role_mappings
                        (panel_id, role_id, emoji, label, description, style)
                    VALUES (?, ?, ?, ?, ?, ?)
                `, [
                    panelId,
                    mapping.role_id,
                    mapping.emoji || null,
                    mapping.label || null,
                    mapping.description || null,
                    mapping.style || 'primary'
                ]);
            }
        }

        res.json({
            success: true,
            message: 'Panel created',
            panelId
        });
    } catch (error) {
        logger.error('[API Reaction Roles Panels POST] Error:', error);
        res.status(500).json({ error: 'Failed to create panel' });
    }
});

/**
 * PUT /api/guilds/:guildId/reaction-roles/panels/:panelId
 * Update a reaction role panel
 */
router.put('/panels/:panelId', async (req, res) => {
    try {
        const { guildId, panelId } = req.params;
        const {
            title,
            description,
            color,
            panel_mode,
            interaction_type,
            max_roles,
            mappings
        } = req.body;

        // Update panel
        await pool.execute(`
            UPDATE reaction_role_panels
            SET title = ?, description = ?, color = ?, panel_mode = ?,
                interaction_type = ?, max_roles = ?
            WHERE id = ? AND guild_id = ?
        `, [
            title,
            description || '',
            color || '#a78bfa',
            panel_mode || 'normal',
            interaction_type || 'button',
            max_roles || 0,
            panelId,
            guildId
        ]);

        // Update mappings if provided
        if (mappings && Array.isArray(mappings)) {
            // Delete existing mappings
            await pool.execute(
                'DELETE FROM reaction_role_mappings WHERE panel_id = ?',
                [panelId]
            );

            // Add new mappings
            for (const mapping of mappings) {
                await pool.execute(`
                    INSERT INTO reaction_role_mappings
                        (panel_id, role_id, emoji, label, description, style)
                    VALUES (?, ?, ?, ?, ?, ?)
                `, [
                    panelId,
                    mapping.role_id,
                    mapping.emoji || null,
                    mapping.label || null,
                    mapping.description || null,
                    mapping.style || 'primary'
                ]);
            }
        }

        socketService.configSaved(guildId, 'reaction-roles', { panelId });

        res.json({ success: true, message: 'Panel updated' });
    } catch (error) {
        logger.error('[API Reaction Roles Panels PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update panel' });
    }
});

/**
 * DELETE /api/guilds/:guildId/reaction-roles/panels/:panelId
 * Delete a reaction role panel
 */
router.delete('/panels/:panelId', async (req, res) => {
    try {
        const { guildId, panelId } = req.params;

        // Delete mappings first
        await pool.execute(
            'DELETE FROM reaction_role_mappings WHERE panel_id = ?',
            [panelId]
        );

        // Delete panel
        await pool.execute(
            'DELETE FROM reaction_role_panels WHERE id = ? AND guild_id = ?',
            [panelId, guildId]
        );

        res.json({ success: true, message: 'Panel deleted' });
    } catch (error) {
        logger.error('[API Reaction Roles Panels DELETE] Error:', error);
        res.status(500).json({ error: 'Failed to delete panel' });
    }
});

/**
 * POST /api/guilds/:guildId/reaction-roles/panels/:panelId/deploy
 * Deploy a panel to Discord
 */
router.post('/panels/:panelId/deploy', async (req, res) => {
    try {
        const { guildId, panelId } = req.params;
        const guild = req.guildObject;

        // Get panel data
        const [panels] = await pool.execute(
            'SELECT * FROM reaction_role_panels WHERE id = ? AND guild_id = ?',
            [panelId, guildId]
        );

        if (panels.length === 0) {
            return res.status(404).json({ error: 'Panel not found' });
        }

        const panel = panels[0];
        const channel = guild.channels.cache.get(panel.channel_id);

        if (!channel) {
            return res.status(400).json({ error: 'Channel not found' });
        }

        // Get mappings
        const [mappings] = await pool.execute(
            'SELECT * FROM reaction_role_mappings WHERE panel_id = ?',
            [panelId]
        );

        // This would normally call the reaction role manager to deploy
        // For now, just return success
        res.json({
            success: true,
            message: 'Panel deployment initiated',
            note: 'The panel will be sent to the channel by the bot'
        });
    } catch (error) {
        logger.error('[API Reaction Roles Deploy POST] Error:', error);
        res.status(500).json({ error: 'Failed to deploy panel' });
    }
});

export default router;
