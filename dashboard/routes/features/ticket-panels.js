import express from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

const router = express.Router();

// ── Input checks for create / update ────────────────────────────────────────────
// Lengths follow Discord (embed title 256, description 4096, button label 80) and the columns.
const TEXT_LIMITS = {
    panel_name: [100, 'Panel name'],
    embed_title: [256, 'Title'],
    embed_description: [4096, 'Description'],
    button_text: [80, 'Button text'],
    button_emoji: [100, 'Button emoji'],
    ticket_name_format: [100, 'Ticket channel name'],
};
const TEXT_KINDS = new Set([0, 5]);   // text and announcement channels
const CATEGORY = 4;

function guildFor(guildId) {
    return global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId) || null;
}
function flag(value) {
    return value === false || value === 0 || value === '0' || value === 'false' ? 0 : 1;
}

/**
 * Check and tidy a panel body. With `partial` (PATCH) only the fields sent are checked; a required
 * field may not be cleared. Channels must be text channels of this server, the category a category
 * and the role one of its roles. Returns { data } or { error }.
 */
export function cleanPanel(guildId, body, partial) {
    const data = {};
    const sent = (k) => body[k] !== undefined;
    for (const [key, [max, label]] of Object.entries(TEXT_LIMITS)) {
        if (!sent(key)) continue;
        const value = body[key] == null ? '' : String(body[key]).trim();
        if (value.length > max) return { error: `${label} must be ${max} characters or fewer.` };
        data[key] = value || null;
    }
    if (sent('embed_color')) {
        const colour = String(body.embed_color || '').trim();
        if (colour && !/^#[0-9a-f]{6}$/i.test(colour)) return { error: 'Colour must be a hex value such as #5865F2.' };
        data.embed_color = colour || null;
    }
    if (sent('save_transcripts')) data.save_transcripts = flag(body.save_transcripts);
    if (sent('is_active')) data.is_active = flag(body.is_active);

    const guild = guildFor(guildId);
    const ids = [
        ['panel_channel_id', 'Panel channel', (c) => TEXT_KINDS.has(c.type)],
        ['log_channel_id', 'Log channel', (c) => TEXT_KINDS.has(c.type)],
        ['alert_channel_id', 'Alert channel', (c) => TEXT_KINDS.has(c.type)],
        ['ticket_category_id', 'Ticket category', (c) => c.type === CATEGORY],
    ];
    for (const [key, label, ok] of ids) {
        if (!sent(key)) continue;
        const id = body[key] == null ? '' : String(body[key]).trim();
        if (!id) { data[key] = null; continue; }
        if (!/^\d{17,20}$/.test(id)) return { error: `${label} is not valid.` };
        if (guild) {
            const channel = guild.channels.cache.get(id);
            if (!channel || !ok(channel)) return { error: `${label} is not a ${key === 'ticket_category_id' ? 'category' : 'text channel'} in this server.` };
        }
        data[key] = id;
    }
    if (sent('support_role_id')) {
        const id = body.support_role_id == null ? '' : String(body.support_role_id).trim();
        if (id && !/^\d{17,20}$/.test(id)) return { error: 'Support role is not valid.' };
        if (id && guild && (!guild.roles.cache.has(id) || id === guildId)) return { error: 'Support role is not a role in this server.' };
        data.support_role_id = id || null;
    }

    for (const [key, label] of [['panel_name', 'Panel name'], ['ticket_category_id', 'Ticket category'], ['support_role_id', 'Support role']]) {
        if ((partial ? sent(key) : true) && !data[key]) return { error: `${label} is required.` };
    }
    return { data };
}

/**
 * GET /manage/:guildId/ticket-panels - Get all ticket panels for a guild
 */
router.get('/:guildId/ticket-panels', async (req, res) => {
    try {
        const guildId = req.params.guildId;

        const [panels] = await pool.execute(
            'SELECT * FROM ticket_panels WHERE guild_id = ? ORDER BY created_at DESC',
            [guildId]
        );

        res.json({
            success: true,
            panels: panels
        });

    } catch (error) {
        logger.error('[Dashboard] Error fetching ticket panels:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch ticket panels'
        });
    }
});

/**
 * GET /manage/:guildId/ticket-panels/:panelId - Get single panel
 */
router.get('/:guildId/ticket-panels/:panelId', async (req, res) => {
    try {
        const { guildId, panelId } = req.params;

        const [panels] = await pool.execute(
            'SELECT * FROM ticket_panels WHERE panel_id = ? AND guild_id = ?',
            [panelId, guildId]
        );

        if (panels.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Panel not found'
            });
        }

        res.json({
            success: true,
            panel: panels[0]
        });

    } catch (error) {
        logger.error('[Dashboard] Error fetching ticket panel:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch ticket panel'
        });
    }
});

/**
 * POST /manage/:guildId/ticket-panels - Create new ticket panel
 */
router.post('/:guildId/ticket-panels', async (req, res) => {
    try {
        const guildId = req.params.guildId;
        const {
            panel_name,
            panel_channel_id,
            embed_title,
            embed_description,
            embed_color,
            button_text,
            button_emoji,
            ticket_category_id,
            support_role_id,
            ticket_name_format,
            save_transcripts,
            log_channel_id
        } = req.body;

        // Validate required fields
        if (!panel_name || !ticket_category_id || !support_role_id) {
            return res.status(400).json({
                success: false,
                error: 'Panel name, ticket category, and support role are required'
            });
        }
        const checked = cleanPanel(guildId, req.body, false);
        if (checked.error) return res.status(400).json({ success: false, error: checked.error });
        const d = checked.data;

        // Insert panel
        const [result] = await pool.execute(
            `INSERT INTO ticket_panels (
                guild_id, panel_name, panel_channel_id,
                embed_title, embed_description, embed_color,
                button_text, button_emoji,
                ticket_category_id, support_role_id, ticket_name_format,
                save_transcripts, log_channel_id, alert_channel_id, is_active
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [
                guildId,
                d.panel_name,
                d.panel_channel_id || null,
                d.embed_title || 'Support Ticket',
                d.embed_description || 'Click the button below to create a support ticket. Our team will assist you shortly!',
                d.embed_color || '#a78bfa',
                d.button_text || 'Create Ticket',
                d.button_emoji || null,
                d.ticket_category_id,
                d.support_role_id,
                d.ticket_name_format || 'ticket-{username}',
                save_transcripts !== undefined ? d.save_transcripts : 1,
                d.log_channel_id || null,
                d.alert_channel_id || null
            ]
        );

        logger.info(`[Dashboard] Ticket panel created: ${panel_name}`, {
            guildId,
            panelId: result.insertId,
            category: 'tickets'
        });

        res.json({
            success: true,
            message: 'Ticket panel created successfully',
            panel_id: result.insertId
        });

    } catch (error) {
        logger.error('[Dashboard] Error creating ticket panel:', error);

        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({
                success: false,
                error: 'A panel with this name already exists'
            });
        }

        res.status(500).json({
            success: false,
            error: 'Failed to create ticket panel'
        });
    }
});

/**
 * PATCH /manage/:guildId/ticket-panels/:panelId - Update ticket panel
 */
router.patch('/:guildId/ticket-panels/:panelId', async (req, res) => {
    try {
        const { guildId, panelId } = req.params;
        const checked = cleanPanel(guildId, req.body || {}, true);
        if (checked.error) return res.status(400).json({ success: false, error: checked.error });
        const updateData = checked.data;

        // Build dynamic UPDATE query
        const allowedFields = [
            'panel_name', 'panel_channel_id', 'embed_title', 'embed_description',
            'embed_color', 'button_text', 'button_emoji', 'ticket_category_id',
            'support_role_id', 'ticket_name_format', 'save_transcripts',
            'log_channel_id', 'alert_channel_id', 'is_active'
        ];

        const updates = [];
        const values = [];

        for (const field of allowedFields) {
            if (updateData[field] !== undefined) {
                updates.push(`${field} = ?`);
                values.push(updateData[field]);
            }
        }

        if (updates.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No fields to update'
            });
        }

        values.push(panelId, guildId);

        await pool.execute(
            `UPDATE ticket_panels SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
             WHERE panel_id = ? AND guild_id = ?`,
            values
        );

        logger.info(`[Dashboard] Ticket panel updated: ${panelId}`, {
            guildId,
            category: 'tickets'
        });

        res.json({
            success: true,
            message: 'Ticket panel updated successfully'
        });

    } catch (error) {
        logger.error('[Dashboard] Error updating ticket panel:', error);

        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({
                success: false,
                error: 'A panel with this name already exists'
            });
        }

        res.status(500).json({
            success: false,
            error: 'Failed to update ticket panel'
        });
    }
});

/**
 * DELETE /manage/:guildId/ticket-panels/:panelId - Delete ticket panel
 */
router.delete('/:guildId/ticket-panels/:panelId', async (req, res) => {
    try {
        const { guildId, panelId } = req.params;

        // Check if panel has active tickets
        const [activeTickets] = await pool.execute(
            "SELECT COUNT(*) as count FROM tickets WHERE panel_id = ? AND status != 'closed'",
            [panelId]
        );

        if (activeTickets[0].count > 0) {
            return res.status(400).json({
                success: false,
                error: `Cannot delete panel with ${activeTickets[0].count} active ticket(s). Please close all tickets first.`
            });
        }

        // Get panel to delete message if exists
        const [panels] = await pool.execute(
            'SELECT panel_channel_id, panel_message_id FROM ticket_panels WHERE panel_id = ? AND guild_id = ?',
            [panelId, guildId]
        );

        if (panels.length > 0 && panels[0].panel_message_id && global.botManager) {
            const panel = panels[0];
            try {
                const client = global.botManager.getClientForGuild(guildId);
                if (client) {
                    const channel = await client.channels.fetch(panel.panel_channel_id).catch(() => null);
                    if (channel) {
                        await channel.messages.delete(panel.panel_message_id).catch(() => {});
                    }
                }
            } catch (err) {
                logger.warn('[Dashboard] Could not delete panel message:', err);
            }
        }

        // Delete panel
        await pool.execute(
            'DELETE FROM ticket_panels WHERE panel_id = ? AND guild_id = ?',
            [panelId, guildId]
        );

        logger.info(`[Dashboard] Ticket panel deleted: ${panelId}`, {
            guildId,
            category: 'tickets'
        });

        res.json({
            success: true,
            message: 'Ticket panel deleted successfully'
        });

    } catch (error) {
        logger.error('[Dashboard] Error deleting ticket panel:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete ticket panel'
        });
    }
});

/**
 * POST /manage/:guildId/ticket-panels/:panelId/deploy - Deploy panel to channel
 */
router.post('/:guildId/ticket-panels/:panelId/deploy', async (req, res) => {
    try {
        const { guildId, panelId } = req.params;

        // Get panel config
        const [panels] = await pool.execute(
            'SELECT * FROM ticket_panels WHERE panel_id = ? AND guild_id = ?',
            [panelId, guildId]
        );

        if (panels.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Panel not found'
            });
        }

        const panel = panels[0];

        if (!panel.panel_channel_id) {
            return res.status(400).json({
                success: false,
                error: 'Panel channel is not configured'
            });
        }

        // Get bot client
        const client = global.botManager ? global.botManager.getClientForGuild(guildId) : null;
        if (!client) {
            return res.status(500).json({
                success: false,
                error: 'Bot client not available'
            });
        }

        // Fetch channel
        const channel = await client.channels.fetch(panel.panel_channel_id).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            return res.status(400).json({
                success: false,
                error: 'Could not access panel channel'
            });
        }

        // Delete old panel message if exists
        if (panel.panel_message_id) {
            try {
                await channel.messages.delete(panel.panel_message_id).catch(() => {});
            } catch (err) {
                logger.warn('[Dashboard] Could not delete old panel message:', err);
            }
        }

        // Create embed
        const embed = new EmbedBuilder()
            .setColor(panel.embed_color || '#a78bfa')
            .setTitle(panel.embed_title || 'Support Ticket')
            .setDescription(panel.embed_description || 'Click the button below to create a support ticket. Our team will assist you shortly!')
            .setTimestamp();

        // Create button
        const button = new ButtonBuilder()
            .setCustomId(`ticket_create_panel_${panelId}`)
            .setLabel(panel.button_text || 'Create Ticket')
            .setStyle(ButtonStyle.Primary);

        if (panel.button_emoji) {
            button.setEmoji(panel.button_emoji);
        }

        const row = new ActionRowBuilder().addComponents(button);

        // Send message
        const message = await channel.send({
            embeds: [embed],
            components: [row]
        });

        // Update panel with message ID
        await pool.execute(
            'UPDATE ticket_panels SET panel_message_id = ? WHERE panel_id = ?',
            [message.id, panelId]
        );

        logger.info(`[Dashboard] Ticket panel deployed: ${panel.panel_name}`, {
            guildId,
            panelId,
            channelId: channel.id,
            messageId: message.id,
            category: 'tickets'
        });

        res.json({
            success: true,
            message: 'Ticket panel deployed successfully',
            message_id: message.id,
            channel_id: channel.id
        });

    } catch (error) {
        logger.error('[Dashboard] Error deploying ticket panel:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to deploy ticket panel'
        });
    }
});

export default router;
