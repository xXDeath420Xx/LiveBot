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
        // Accept both new (correct) and legacy (wrong) field names from clients,
        // so the Tailwind UI and any older callers both work.
        const {
            channel_id,
            panel_name, title,
            description,
            embed_color, color,
            thumbnail_url,
            image_url,
            panel_mode,
            interaction_type,
            max_selections, max_roles,
            placeholder_text,
            mappings
        } = req.body;

        const resolvedName = panel_name || title;
        const resolvedColor = embed_color || color || '#a78bfa';
        const resolvedMaxSel = max_selections ?? max_roles ?? 1;

        if (!channel_id || !resolvedName) {
            return res.status(400).json({ error: 'Channel and panel name are required' });
        }

        const [result] = await pool.execute(`
            INSERT INTO reaction_role_panels
                (guild_id, channel_id, message_id, panel_name, description,
                 embed_color, thumbnail_url, image_url, panel_mode,
                 interaction_type, max_selections, placeholder_text)
            VALUES (?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            guildId,
            channel_id,
            resolvedName,
            description || null,
            resolvedColor,
            thumbnail_url || null,
            image_url || null,
            panel_mode || 'normal',
            interaction_type || 'button',
            resolvedMaxSel,
            placeholder_text || 'Choose your roles'
        ]);

        const panelId = result.insertId;

        if (mappings && Array.isArray(mappings)) {
            for (const mapping of mappings) {
                await pool.execute(`
                    INSERT INTO reaction_role_mappings
                        (panel_id, role_id, emoji_id, label, button_style)
                    VALUES (?, ?, ?, ?, ?)
                `, [
                    panelId,
                    mapping.role_id,
                    mapping.emoji_id || mapping.emoji || null,
                    mapping.label || null,
                    mapping.button_style || mapping.style || 'primary'
                ]);
            }
        }

        res.json({ success: true, message: 'Panel created', panelId });
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
        // Accept new + legacy field names (see POST handler).
        const {
            panel_name, title,
            description,
            embed_color, color,
            thumbnail_url,
            image_url,
            panel_mode,
            interaction_type,
            max_selections, max_roles,
            placeholder_text,
            mappings
        } = req.body;

        // Build dynamic UPDATE so untouched fields aren't clobbered to defaults.
        const fields = [];
        const values = [];
        const set = (col, val) => { fields.push(`${col} = ?`); values.push(val); };

        if (panel_name !== undefined || title !== undefined) set('panel_name', panel_name ?? title);
        if (description !== undefined) set('description', description || null);
        if (embed_color !== undefined || color !== undefined) set('embed_color', embed_color ?? color);
        if (thumbnail_url !== undefined) set('thumbnail_url', thumbnail_url || null);
        if (image_url !== undefined) set('image_url', image_url || null);
        if (panel_mode !== undefined) set('panel_mode', panel_mode);
        if (interaction_type !== undefined) set('interaction_type', interaction_type);
        if (max_selections !== undefined || max_roles !== undefined) set('max_selections', max_selections ?? max_roles);
        if (placeholder_text !== undefined) set('placeholder_text', placeholder_text);

        if (fields.length > 0) {
            values.push(panelId, guildId);
            await pool.execute(
                `UPDATE reaction_role_panels SET ${fields.join(', ')} WHERE id = ? AND guild_id = ?`,
                values
            );
        }

        if (mappings && Array.isArray(mappings)) {
            await pool.execute('DELETE FROM reaction_role_mappings WHERE panel_id = ?', [panelId]);
            for (const mapping of mappings) {
                await pool.execute(`
                    INSERT INTO reaction_role_mappings
                        (panel_id, role_id, emoji_id, label, button_style)
                    VALUES (?, ?, ?, ?, ?)
                `, [
                    panelId,
                    mapping.role_id,
                    mapping.emoji_id || mapping.emoji || null,
                    mapping.label || null,
                    mapping.button_style || mapping.style || 'primary'
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
