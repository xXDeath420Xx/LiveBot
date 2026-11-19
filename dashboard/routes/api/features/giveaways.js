/**
 * Giveaways API
 * Handles giveaway management via the GiveawayManager
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { logFeatureEvent, userLabel } from '../../../../core/feature-log.js';
import configCache from '../../../../utils/configCache.js';

const router = express.Router({ mergeParams: true });

/**
 * GET /api/guilds/:guildId/giveaways/host-roles
 * Roles allowed to start a giveaway from the panel (interactions/buttons/giveaway_create.js).
 * Empty = anyone with Manage Messages; Manage Server always may.
 */
router.get('/host-roles', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT role_id FROM giveaway_host_roles WHERE guild_id = ?', [req.params.guildId]);
        res.json({ roles: rows.map(r => r.role_id) });
    } catch (error) {
        logger.error('[Giveaways API] host roles load failed', { error: error.message });
        res.status(500).json({ error: 'Could not load host roles' });
    }
});

/** PUT /api/guilds/:guildId/giveaways/host-roles  { roles: [roleId, ...] } replaces the list. */
router.put('/host-roles', async (req, res) => {
    const guildId = req.params.guildId;
    const ids = [...new Set((Array.isArray(req.body?.roles) ? req.body.roles : []).map(String))];
    if (ids.length > 25 || ids.some(id => !/^\d{17,20}$/.test(id))) return res.status(400).json({ error: 'Pick up to 25 roles.' });
    const guild = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId);
    if (guild && ids.some(id => !guild.roles.cache.has(id) || id === guildId)) return res.status(400).json({ error: 'A role is not in this server.' });
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.execute('DELETE FROM giveaway_host_roles WHERE guild_id = ?', [guildId]);
        if (ids.length) await conn.query('INSERT INTO giveaway_host_roles (guild_id, role_id, added_by) VALUES ?', [ids.map(id => [guildId, id, req.user?.id || null])]);
        await conn.commit();
    } catch (error) {
        await conn.rollback().catch(() => {});
        logger.error('[Giveaways API] host roles save failed', { error: error.message });
        return res.status(500).json({ error: 'Could not save. Nothing was changed.' });
    } finally {
        conn.release();
    }
    configCache.invalidate('giveaway_host_roles', guildId);
    res.json({ ok: true, roles: ids });
});

/**
 * The "Create giveaway" panel host roles apply to (H-715, core/giveaway-panel.js).
 * GET  /api/guilds/:guildId/giveaways/panel                  -> { panel: { channel_id, message_id } | null }
 * PUT  /api/guilds/:guildId/giveaways/panel { channel_id }   posts, updates or moves it; an empty channel removes it.
 */
router.get('/panel', async (req, res) => {
    try {
        const { getGiveawayPanel } = await import('../../../../core/giveaway-panel.js');
        res.json({ panel: await getGiveawayPanel(req.params.guildId) });
    } catch (error) {
        logger.error('[Giveaways API] panel load failed', { error: error.message });
        res.status(500).json({ error: 'Could not load the panel' });
    }
});

router.put('/panel', async (req, res) => {
    const guildId = req.params.guildId;
    try {
        const { postGiveawayPanel, removeGiveawayPanel } = await import('../../../../core/giveaway-panel.js');
        const client = req.botClient || global.botManager?.getClientForGuild?.(guildId) || null;
        const guild = client?.guilds?.cache?.get(guildId) || null;
        const channelId = String(req.body?.channel_id || '').trim();
        if (!channelId) {
            const out = await removeGiveawayPanel({ guild, guildId });
            return res.json({ ok: true, panel: null, message: out.removed ? 'Panel removed' : 'No panel to remove' });
        }
        const out = await postGiveawayPanel({ guild, channelId, userId: req.user?.id || null });
        if (!out.ok) return res.status(400).json({ error: out.error });
        res.json({
            ok: true,
            panel: { channel_id: out.channelId, message_id: out.messageId },
            message: out.action === 'updated' ? 'Panel updated' : out.action === 'moved' ? 'Panel moved' : 'Panel posted',
        });
    } catch (error) {
        logger.error('[Giveaways API] panel post failed', { error: error.message, guildId });
        res.status(500).json({ error: 'Could not post the panel. Check the bot can send messages there.' });
    }
});

/**
 * GET /api/guilds/:guildId/giveaways
 * Get all giveaways
 */
router.get('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { status = 'all' } = req.query;

        let query = 'SELECT * FROM giveaways WHERE guild_id = ?';
        const params = [guildId];

        if (status === 'active') {
            query += ' AND is_active = 1';
        } else if (status === 'ended') {
            query += ' AND is_active = 0';
        }

        query += ' ORDER BY ends_at DESC';

        const [giveaways] = await pool.execute(query, params);

        res.json({ success: true, giveaways });
    } catch (error) {
        logger.error('[API Giveaways GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch giveaways' });
    }
});

/**
 * POST /api/guilds/:guildId/giveaways
 * Create a giveaway via the bot's GiveawayManager
 */
router.post('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            channel_id,
            prize,
            winner_count,
            duration_seconds
        } = req.body;

        if (!channel_id || !prize || !duration_seconds) {
            return res.status(400).json({ error: 'Channel, prize, and duration are required' });
        }

        if (!/^\d{17,20}$/.test(channel_id)) {
            return res.status(400).json({ error: 'Invalid channel_id format' });
        }

        if (typeof prize !== 'string' || prize.length < 1 || prize.length > 256) {
            return res.status(400).json({ error: 'Prize must be 1-256 characters' });
        }

        const durationNum = parseInt(duration_seconds);
        if (isNaN(durationNum) || durationNum < 10 || durationNum > 15552000) {
            return res.status(400).json({ error: 'Duration must be between 10 seconds and 6 months' });
        }

        const winnerNum = parseInt(winner_count) || 1;
        if (winnerNum < 1 || winnerNum > 100) {
            return res.status(400).json({ error: 'Winner count must be between 1 and 100' });
        }

        // Use the bot client's GiveawayManager to create the giveaway
        // This sends the embed, reacts, and inserts into DB
        const botClient = req.botClient;
        if (!botClient?.giveawayManager) {
            return res.status(500).json({ error: 'Giveaway manager not available for this bot' });
        }

        const result = await botClient.giveawayManager.createGiveaway(
            guildId,
            channel_id,
            req.user.id,
            prize.trim(),
            winnerNum,
            durationNum,
            { description: typeof req.body.description === 'string' ? req.body.description.slice(0, 1000) : '' }
        );

        res.json({
            success: true,
            message: 'Giveaway created',
            giveawayId: result.giveawayId,
            messageId: result.messageId
        });
    } catch (error) {
        logger.error('[API Giveaways POST] Error:', error);
        res.status(500).json({ error: error.message || 'Failed to create giveaway' });
    }
});

/**
 * DELETE /api/guilds/:guildId/giveaways/:giveawayId
 * Delete/cancel a giveaway
 */
router.delete('/:giveawayId', async (req, res) => {
    try {
        const { guildId, giveawayId } = req.params;

        // Fetch giveaway first so we can delete the Discord message
        const [[giveaway]] = await pool.execute(
            'SELECT * FROM giveaways WHERE id = ? AND guild_id = ?',
            [giveawayId, guildId]
        );

        if (!giveaway) {
            return res.status(404).json({ error: 'Giveaway not found' });
        }

        // Try to delete the giveaway message from Discord
        const botClient = req.botClient;
        if (botClient && giveaway.channel_id && giveaway.message_id) {
            try {
                const guild = botClient.guilds.cache.get(guildId);
                if (guild) {
                    const channel = await guild.channels.fetch(giveaway.channel_id).catch(() => null);
                    if (channel) {
                        const message = await channel.messages.fetch(giveaway.message_id).catch(() => null);
                        if (message) {
                            await message.delete();
                        }
                    }
                }
            } catch (discordErr) {
                logger.warn(`[API Giveaways DELETE] Could not delete Discord message for giveaway ${giveawayId}:`, discordErr.message);
            }
        }

        await pool.execute(
            'DELETE FROM giveaways WHERE id = ? AND guild_id = ?',
            [giveawayId, guildId]
        );

        void logFeatureEvent(() => (botClient?.guilds?.cache?.get(guildId)), 'giveaway.deleted', () => ({
            title: '🗑️ Giveaway Deleted',
            fields: [
                ['Prize', giveaway.prize], ['Status', giveaway.is_active ? 'Was running' : 'Had ended'],
                ['Channel', giveaway.channel_id ? `<#${giveaway.channel_id}>` : null], ['Deleted By', userLabel(req.user)],
            ],
        }));

        res.json({ success: true, message: 'Giveaway deleted' });
    } catch (error) {
        logger.error('[API Giveaways DELETE] Error:', error);
        res.status(500).json({ error: 'Failed to delete giveaway' });
    }
});

/**
 * POST /api/guilds/:guildId/giveaways/:giveawayId/end
 * End a giveaway early
 */
router.post('/:giveawayId/end', async (req, res) => {
    try {
        const { guildId, giveawayId } = req.params;

        const [[giveaway]] = await pool.execute(
            'SELECT * FROM giveaways WHERE id = ? AND guild_id = ? AND is_active = 1',
            [giveawayId, guildId]
        );

        if (!giveaway) {
            // Check if it exists but already ended
            const [[ended]] = await pool.execute(
                'SELECT id FROM giveaways WHERE id = ? AND guild_id = ?',
                [giveawayId, guildId]
            );
            if (ended) {
                return res.status(409).json({ error: 'This giveaway has already ended' });
            }
            return res.status(404).json({ error: 'Giveaway not found' });
        }

        const botClient = req.botClient;
        if (botClient?.giveawayManager) {
            await botClient.giveawayManager.endGiveaway(giveaway, false, req.user);
        } else {
            await pool.execute(
                'UPDATE giveaways SET is_active = 0, ends_at = NOW() WHERE id = ?',
                [giveawayId]
            );
        }

        res.json({ success: true, message: 'Giveaway ended' });
    } catch (error) {
        logger.error('[API Giveaways End POST] Error:', error);
        res.status(500).json({ error: error.message || 'Failed to end giveaway' });
    }
});

/**
 * POST /api/guilds/:guildId/giveaways/:giveawayId/reroll
 * Reroll giveaway winners
 */
router.post('/:giveawayId/reroll', async (req, res) => {
    try {
        const { guildId, giveawayId } = req.params;

        const [[giveaway]] = await pool.execute(
            'SELECT * FROM giveaways WHERE id = ? AND guild_id = ?',
            [giveawayId, guildId]
        );

        if (!giveaway) {
            return res.status(404).json({ error: 'Giveaway not found' });
        }

        const botClient = req.botClient;
        if (botClient?.giveawayManager) {
            await botClient.giveawayManager.endGiveaway(giveaway, true, req.user);
            res.json({ success: true, message: 'Winners rerolled' });
        } else {
            res.status(500).json({ error: 'Giveaway manager not available' });
        }
    } catch (error) {
        logger.error('[API Giveaways Reroll POST] Error:', error);
        res.status(500).json({ error: error.message || 'Failed to reroll giveaway' });
    }
});

export default router;
