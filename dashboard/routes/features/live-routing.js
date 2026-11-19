import express from 'express';
import pool from '../../../utils/db.js';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';
import { invalidateLiveRouting } from '../../../core/live-channel-routing.js';

const router = express.Router();

const toIdArray = (value) => {
    if (!value) return null;
    const list = (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);
    return list.length ? JSON.stringify(list) : null;
};
const toBit = (value, fallback) => {
    if (value === undefined || value === null) return fallback;
    return value === true || value === 1 || value === '1' ? 1 : 0;
};

// GET /api/guilds/:guildId/live-routing/rules
router.get('/:guildId/live-routing/rules', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT * FROM guild_live_channel_rules WHERE guild_id = ? ORDER BY priority DESC, rule_id ASC',
            [req.guildId]
        );
        res.json({ success: true, rules: rows });
    } catch (error) {
        logger.error('[API LiveRouting GET] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch live routing rules' });
    }
});

// POST /api/guilds/:guildId/live-routing/rules
router.post('/:guildId/live-routing/rules', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const { label, role_ids, channel_id, priority, exclude_owner, excluded_user_ids, source_channel_ids, apply_to_unrouted } = req.body;

        if (!channel_id) return res.status(400).json({ error: 'channel_id is required' });

        const [result] = await pool.execute(`
            INSERT INTO guild_live_channel_rules
                (guild_id, label, role_ids, channel_id, priority, enabled, exclude_owner, excluded_user_ids, source_channel_ids, apply_to_unrouted)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        `, [
            req.guildId,
            label ? String(label).slice(0, 64) : null,
            toIdArray(role_ids),
            channel_id,
            Number.isFinite(Number(priority)) ? Number(priority) : 0,
            toBit(exclude_owner, 1),
            toIdArray(excluded_user_ids),
            toIdArray(source_channel_ids),
            toBit(apply_to_unrouted, 0)
        ]);

        invalidateLiveRouting(req.guildId);
        res.json({ success: true, rule_id: result.insertId, message: 'Routing rule added' });
    } catch (error) {
        logger.error('[API LiveRouting POST] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to add routing rule' });
    }
});

// PATCH /api/guilds/:guildId/live-routing/rules/:ruleId
router.patch('/:guildId/live-routing/rules/:ruleId', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const { label, role_ids, channel_id, priority, exclude_owner, excluded_user_ids, source_channel_ids, apply_to_unrouted } = req.body;

        if (!channel_id) return res.status(400).json({ error: 'channel_id is required' });

        const [result] = await pool.execute(`
            UPDATE guild_live_channel_rules
               SET label = ?, role_ids = ?, channel_id = ?, priority = ?,
                   exclude_owner = ?, excluded_user_ids = ?, source_channel_ids = ?, apply_to_unrouted = ?
             WHERE rule_id = ? AND guild_id = ?
        `, [
            label ? String(label).slice(0, 64) : null,
            toIdArray(role_ids),
            channel_id,
            Number.isFinite(Number(priority)) ? Number(priority) : 0,
            toBit(exclude_owner, 1),
            toIdArray(excluded_user_ids),
            toIdArray(source_channel_ids),
            toBit(apply_to_unrouted, 0),
            req.params.ruleId,
            req.guildId
        ]);

        if (result.affectedRows === 0) return res.status(404).json({ error: 'Rule not found' });

        invalidateLiveRouting(req.guildId);
        res.json({ success: true, message: 'Routing rule updated' });
    } catch (error) {
        logger.error('[API LiveRouting PATCH] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to update routing rule' });
    }
});

// PATCH /api/guilds/:guildId/live-routing/rules/:ruleId/toggle
router.patch('/:guildId/live-routing/rules/:ruleId/toggle', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const [result] = await pool.execute(
            'UPDATE guild_live_channel_rules SET enabled = 1 - enabled WHERE rule_id = ? AND guild_id = ?',
            [req.params.ruleId, req.guildId]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Rule not found' });

        invalidateLiveRouting(req.guildId);
        res.json({ success: true, message: 'Routing rule toggled' });
    } catch (error) {
        logger.error('[API LiveRouting TOGGLE] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to toggle routing rule' });
    }
});

// DELETE /api/guilds/:guildId/live-routing/rules/:ruleId
router.delete('/:guildId/live-routing/rules/:ruleId', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        await pool.execute(
            'DELETE FROM guild_live_channel_rules WHERE rule_id = ? AND guild_id = ?',
            [req.params.ruleId, req.guildId]
        );
        invalidateLiveRouting(req.guildId);
        res.json({ success: true, message: 'Routing rule removed' });
    } catch (error) {
        logger.error('[API LiveRouting DELETE] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to remove routing rule' });
    }
});

export default router;
