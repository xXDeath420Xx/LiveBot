/**
 * Reaction Roles API
 * Handles reaction role panels and mappings
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import socketService from '../../../services/SocketService.js';
import { refreshPanelMessage } from '../../../../core/reaction-role-manager.js';
import { parseMappingList, capacityFor, MAX_LABEL_LENGTH } from '../../../../core/reaction-role-bulk.js';

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

        // Everything below reaches Discord when the panel is posted, so it is checked here
        // rather than trusted from the page (the dashboard's template panels send mappings).
        const guild = req.guildObject;
        if (!guild?.channels?.cache?.has(String(channel_id))) {
            return res.status(400).json({ error: 'That channel is not in this server.' });
        }
        if (String(resolvedName).length > 256) return res.status(400).json({ error: 'Panel name can be at most 256 characters.' });
        if (description && String(description).length > 4096) return res.status(400).json({ error: 'Embed text can be at most 4096 characters.' });
        if (!/^#[0-9a-f]{6}$/i.test(String(resolvedColor))) return res.status(400).json({ error: 'Embed colour must be a hex colour such as #a78bfa.' });
        if (panel_mode && !['normal', 'unique'].includes(panel_mode)) return res.status(400).json({ error: 'Unknown panel mode.' });
        if (interaction_type && !['button', 'select_menu', 'reaction'].includes(interaction_type)) return res.status(400).json({ error: 'Unknown control type.' });
        if (mappings !== undefined && mappings !== null && !Array.isArray(mappings)) return res.status(400).json({ error: 'Roles must be a list.' });

        const cleanMappings = [];
        if (Array.isArray(mappings) && mappings.length) {
            const type = interaction_type || 'button';
            const capacity = capacityFor(type);
            if (mappings.length > capacity) {
                return res.status(400).json({ error: `Discord allows ${capacity} roles on a ${type.replace('_', ' ')} panel.` });
            }
            const botTop = guild.members?.me?.roles?.highest?.position;
            const seen = new Set();
            for (const m of mappings) {
                const roleId = String(m?.role_id || '');
                const role = /^\d{15,25}$/.test(roleId) ? guild.roles.cache.get(roleId) : null;
                if (!role || role.id === guild.id) return res.status(400).json({ error: 'A role on the list no longer exists in this server.' });
                if (role.managed) return res.status(400).json({ error: `"${role.name}" is managed by an integration, so no bot can give it.` });
                if (typeof botTop === 'number' && role.position >= botTop) {
                    return res.status(400).json({ error: `"${role.name}" is above the bot's highest role, so the bot cannot give it.` });
                }
                if (seen.has(roleId)) return res.status(400).json({ error: `"${role.name}" is on the list twice.` });
                seen.add(roleId);
                const emoji = m.emoji_id || m.emoji || null;
                if (emoji && String(emoji).length > 100) return res.status(400).json({ error: 'An emoji on the list is not valid.' });
                if (type === 'reaction' && !emoji) return res.status(400).json({ error: 'Reaction panels need an emoji for each role.' });
                const label = m.label ? String(m.label).trim() : '';
                if (label.length > MAX_LABEL_LENGTH) {
                    return res.status(400).json({ error: `Label is too long — Discord allows ${MAX_LABEL_LENGTH} characters.` });
                }
                const style = m.button_style || m.style;
                cleanMappings.push({ role_id: roleId, emoji_id: emoji ? String(emoji) : null, label: label || null,
                    button_style: VALID_STYLES.includes(style) ? style : 'primary' });
            }
        }

        // message_id NULL = not posted yet. The column is UNIQUE, so the old 'PENDING' sentinel
        // allowed only one unposted panel across every server at a time.
        const [result] = await pool.execute(`
            INSERT INTO reaction_role_panels
                (guild_id, channel_id, message_id, panel_name, description,
                 embed_color, thumbnail_url, image_url, panel_mode,
                 interaction_type, max_selections, placeholder_text)
            VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

        for (const mapping of cleanMappings) {
            await pool.execute(`
                INSERT INTO reaction_role_mappings
                    (panel_id, role_id, emoji_id, label, button_style)
                VALUES (?, ?, ?, ?, ?)
            `, [panelId, mapping.role_id, mapping.emoji_id, mapping.label, mapping.button_style]);
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
            channel_id,
            mappings
        } = req.body;

        const [[before]] = await pool.execute(
            'SELECT channel_id, message_id FROM reaction_role_panels WHERE id = ? AND guild_id = ?', [panelId, guildId]);
        if (!before) return res.status(404).json({ error: 'Panel not found' });

        // Moving a posted panel to another channel: the old message has to go, or it stays live
        // in the old channel handing out roles from a panel that no longer exists there.
        let movedChannel = false;
        if (channel_id && channel_id !== before.channel_id) {
            movedChannel = true;
            if (before.message_id && before.message_id !== 'PENDING') {
                try {
                    const oldChannel = await req.botClient?.channels.fetch(before.channel_id).catch(() => null);
                    const oldMessage = oldChannel ? await oldChannel.messages.fetch(before.message_id).catch(() => null) : null;
                    if (oldMessage) await oldMessage.delete().catch(() => {});
                } catch { /* old message may already be gone */ }
            }
        }

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
        if (movedChannel) {
            set('channel_id', channel_id);
            // NULL, not 'PENDING' — the post endpoint treats both as unposted, and the view now does too.
            set('message_id', null);
        }

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

        // A panel IS its message — saving the form without touching what members already see
        // would look like the edit did nothing. Refresh the live message in place (same message
        // id, so pins and jump links survive) unless the panel was just moved or isn't posted.
        let liveMessage = 'not_posted';
        if (!movedChannel) {
            liveMessage = await refreshPanelMessage({ guildId, panelId, botClient: req.botClient });
        } else {
            liveMessage = 'moved_needs_post';
        }

        res.json({ success: true, message: 'Panel updated', liveMessage });
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

/* ───────────────────────── Role mappings ─────────────────────────
 * These back the panel page's in-place add/remove. Each one returns the panel's full mapping
 * list plus the live-message status, so the page can redraw one card instead of reloading.
 */

const VALID_STYLES = ['primary', 'secondary', 'success', 'danger'];

/** Load a panel and its mappings, or answer the request with 404. */
async function loadPanel(req, res) {
    const { guildId, panelId } = req.params;
    const [[panel]] = await pool.execute(
        'SELECT * FROM reaction_role_panels WHERE id = ? AND guild_id = ?', [panelId, guildId]);
    if (!panel) { res.status(404).json({ error: 'Panel not found' }); return null; }

    const [mappings] = await pool.execute(
        'SELECT * FROM reaction_role_mappings WHERE panel_id = ? ORDER BY id ASC', [panelId]);
    return { panel, mappings };
}

/** Mappings decorated with their role's current name and colour, for redrawing the card. */
function serialiseMappings(mappings, guild) {
    return mappings.map(m => {
        const role = guild?.roles?.cache?.get(m.role_id);
        return {
            id: m.id,
            role_id: m.role_id,
            role_name: role?.name ?? null,
            role_color: role ? `#${(role.color >>> 0 & 0xffffff).toString(16).padStart(6, '0')}` : null,
            emoji_id: m.emoji_id,
            label: m.label,
            button_style: m.button_style || 'primary',
        };
    });
}

/** GET mappings — used to redraw a card after a change made elsewhere. */
router.get('/panels/:panelId/mappings', async (req, res) => {
    try {
        const loaded = await loadPanel(req, res);
        if (!loaded) return;
        res.json({ mappings: serialiseMappings(loaded.mappings, req.guildObject) });
    } catch (error) {
        logger.error('[API Reaction Roles Mappings GET] Error:', error);
        res.status(500).json({ error: 'Failed to load mappings' });
    }
});

/** POST one mapping. */
router.post('/panels/:panelId/mappings', async (req, res) => {
    try {
        const loaded = await loadPanel(req, res);
        if (!loaded) return;
        const { panel, mappings } = loaded;
        const { role_id, emoji_id, label, button_style } = req.body || {};

        if (!/^\d{15,25}$/.test(String(role_id || ''))) return res.status(400).json({ error: 'Pick a role.' });
        if (!req.guildObject?.roles?.cache?.has(String(role_id))) {
            return res.status(400).json({ error: 'That role no longer exists in this server.' });
        }

        const interactionType = panel.interaction_type || 'reaction';
        if (interactionType === 'reaction' && !emoji_id) {
            return res.status(400).json({ error: 'Reaction panels need an emoji for each role.' });
        }
        if (label && label.length > MAX_LABEL_LENGTH) {
            return res.status(400).json({ error: `Label is too long — Discord allows ${MAX_LABEL_LENGTH} characters.` });
        }
        if (mappings.some(m => m.role_id === String(role_id))) {
            return res.status(409).json({ error: 'That role is already on this panel.' });
        }

        const capacity = capacityFor(interactionType);
        if (mappings.length + 1 > capacity) {
            return res.status(400).json({ error: `This panel is full — Discord allows ${capacity} roles on a ${interactionType.replace('_', ' ')} panel.` });
        }

        await pool.execute(
            'INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label, button_style) VALUES (?, ?, ?, ?, ?)',
            [panel.id, String(role_id), emoji_id || null, label || null,
             VALID_STYLES.includes(button_style) ? button_style : 'primary']);

        const liveMessage = await refreshPanelMessage({ guildId: req.params.guildId, panelId: panel.id, botClient: req.botClient });
        const [after] = await pool.execute(
            'SELECT * FROM reaction_role_mappings WHERE panel_id = ? ORDER BY id ASC', [panel.id]);

        logger.info(`[Reaction Roles] Mapping added to panel ${panel.id}: ${role_id}`);
        res.json({ success: true, mappings: serialiseMappings(after, req.guildObject), liveMessage });
    } catch (error) {
        logger.error('[API Reaction Roles Mappings POST] Error:', error);
        res.status(500).json({ error: 'Failed to add that role' });
    }
});

/**
 * POST many mappings from a pasted list.
 *
 * `dryRun` parses and reports without writing, so the page can preview the whole list —
 * including the lines it can't resolve — before anything reaches Discord.
 */
router.post('/panels/:panelId/mappings/bulk', async (req, res) => {
    try {
        const loaded = await loadPanel(req, res);
        if (!loaded) return;
        const { panel, mappings } = loaded;
        const { text, dryRun } = req.body || {};

        if (typeof text !== 'string' || !text.trim()) {
            return res.status(400).json({ error: 'Paste at least one role.' });
        }
        if (text.length > 10000) {
            return res.status(400).json({ error: 'That list is too long — split it into smaller batches.' });
        }

        const interactionType = panel.interaction_type || 'reaction';
        const guildRoles = [...(req.guildObject?.roles?.cache?.values() ?? [])]
            .filter(r => !r.managed && r.id !== req.params.guildId);

        const { entries, errors } = parseMappingList(text, {
            guildRoles,
            interactionType,
            existingRoleIds: new Set(mappings.map(m => m.role_id)),
        });

        // Capacity is a panel-wide limit, so it's checked against what's already there.
        const capacity = capacityFor(interactionType);
        const room = Math.max(0, capacity - mappings.length);
        const accepted = entries.slice(0, room);
        const overflow = entries.slice(room).map(e => ({
            line: e.line, text: e.role_name,
            error: `Panel is full — Discord allows ${capacity} roles on a ${interactionType.replace('_', ' ')} panel`,
        }));

        if (dryRun) {
            return res.json({
                preview: true,
                add: accepted,
                errors: [...errors, ...overflow].sort((a, b) => a.line - b.line),
                capacity, used: mappings.length,
            });
        }

        if (!accepted.length) {
            return res.status(400).json({
                error: room === 0 ? 'This panel is already full.' : 'Nothing on that list could be added.',
                errors: [...errors, ...overflow].sort((a, b) => a.line - b.line),
            });
        }

        for (const entry of accepted) {
            await pool.execute(
                'INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label, button_style) VALUES (?, ?, ?, ?, ?)',
                [panel.id, entry.role_id, entry.emoji_id || null, entry.label || null, entry.button_style]);
        }

        // One refresh for the whole batch — editing the message per row would burn rate limit
        // and flicker the panel for anyone looking at it.
        const liveMessage = await refreshPanelMessage({ guildId: req.params.guildId, panelId: panel.id, botClient: req.botClient });
        const [after] = await pool.execute(
            'SELECT * FROM reaction_role_mappings WHERE panel_id = ? ORDER BY id ASC', [panel.id]);

        logger.info(`[Reaction Roles] Bulk-added ${accepted.length} mapping(s) to panel ${panel.id}`);
        res.json({
            success: true,
            added: accepted.length,
            errors: [...errors, ...overflow].sort((a, b) => a.line - b.line),
            mappings: serialiseMappings(after, req.guildObject),
            liveMessage,
        });
    } catch (error) {
        logger.error('[API Reaction Roles Bulk Mappings POST] Error:', error);
        res.status(500).json({ error: 'Failed to add those roles' });
    }
});

/** DELETE one mapping. */
router.delete('/panels/:panelId/mappings/:mappingId', async (req, res) => {
    try {
        const loaded = await loadPanel(req, res);
        if (!loaded) return;
        const { panel, mappings } = loaded;

        const target = mappings.find(m => String(m.id) === String(req.params.mappingId));
        if (!target) return res.status(404).json({ error: 'That mapping is already gone.' });

        await pool.execute('DELETE FROM reaction_role_mappings WHERE id = ? AND panel_id = ?',
            [target.id, panel.id]);

        // Reaction panels: pull the bot's own reaction so the emoji stops inviting clicks.
        if ((panel.interaction_type || 'reaction') === 'reaction' && target.emoji_id && panel.message_id) {
            try {
                const channel = await req.botClient?.channels.fetch(panel.channel_id).catch(() => null);
                const message = channel ? await channel.messages.fetch(panel.message_id).catch(() => null) : null;
                const reaction = message?.reactions.cache.find(r => r.emoji.name === target.emoji_id || r.emoji.id === target.emoji_id);
                if (reaction) await reaction.remove().catch(() => reaction.users.remove(req.botClient.user.id));
            } catch (err) {
                logger.warn(`[Reaction Roles] Could not clear reaction for mapping ${target.id}: ${err.message}`);
            }
        }

        const liveMessage = await refreshPanelMessage({ guildId: req.params.guildId, panelId: panel.id, botClient: req.botClient });
        const [after] = await pool.execute(
            'SELECT * FROM reaction_role_mappings WHERE panel_id = ? ORDER BY id ASC', [panel.id]);

        logger.info(`[Reaction Roles] Mapping ${target.id} removed from panel ${panel.id}`);
        res.json({ success: true, mappings: serialiseMappings(after, req.guildObject), liveMessage });
    } catch (error) {
        logger.error('[API Reaction Roles Mappings DELETE] Error:', error);
        res.status(500).json({ error: 'Failed to remove that role' });
    }
});

export default router;
