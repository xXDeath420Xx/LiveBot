import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';

const router = express.Router({ mergeParams: true });

// GET / — list all autoresponders for guild
router.get('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [rows] = await pool.execute(
            'SELECT * FROM autoresponders WHERE guild_id = ? ORDER BY created_at DESC',
            [guildId]
        );
        const [[{ total }]] = await pool.execute(
            'SELECT COALESCE(SUM(use_count), 0) as total FROM autoresponders WHERE guild_id = ?',
            [guildId]
        );
        res.json({ success: true, autoresponders: rows, totalTriggers: total });
    } catch (error) {
        logger.error('[API Autoresponders GET]', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch autoresponders' });
    }
});

// POST / — create
router.post('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const d = req.body;

        if (!d.trigger_text || !d.trigger_text.trim()) {
            return res.status(400).json({ error: 'Trigger text is required' });
        }

        if (d.response_type === 'text' && !d.response_text?.trim()) {
            return res.status(400).json({ error: 'Response text is required for text responses' });
        }

        // Validate regex if match_type is regex
        if (d.match_type === 'regex') {
            try { new RegExp(d.trigger_text); } catch {
                return res.status(400).json({ error: 'Invalid regex pattern' });
            }
        }

        await pool.execute(
            `INSERT INTO autoresponders (guild_id, trigger_text, response_text, match_type, case_sensitive,
             response_type, embed_json, reactions, delete_trigger, reply_to_user,
             allowed_channels, blocked_channels, allowed_roles, blocked_roles, require_all_roles,
             cooldown_seconds, cooldown_per_user, cooldown_per_channel, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                guildId, d.trigger_text.trim(), d.response_text?.trim() || null,
                d.match_type || 'contains', d.case_sensitive ? 1 : 0,
                d.response_type || 'text', d.embed_json || null, d.reactions || null,
                d.delete_trigger ? 1 : 0, d.reply_to_user !== false ? 1 : 0,
                d.allowed_channels || null, d.blocked_channels || null,
                d.allowed_roles || null, d.blocked_roles || null, d.require_all_roles ? 1 : 0,
                d.cooldown_seconds || 0, d.cooldown_per_user !== false ? 1 : 0, d.cooldown_per_channel ? 1 : 0,
                req.user?.id || null
            ]
        );

        invalidateManagerCache(guildId);
        res.json({ success: true });
    } catch (error) {
        logger.error('[API Autoresponders POST]', { error: error.message });
        res.status(500).json({ error: error.code === 'ER_DUP_ENTRY' ? 'Trigger already exists' : 'Failed to create' });
    }
});

// PUT /:id — update
router.put('/:id', async (req, res) => {
    try {
        const { guildId, id } = req.params;
        const d = req.body;

        const allowed = ['trigger_text', 'response_text', 'match_type', 'case_sensitive',
            'response_type', 'embed_json', 'reactions', 'delete_trigger', 'reply_to_user',
            'allowed_channels', 'blocked_channels', 'allowed_roles', 'blocked_roles', 'require_all_roles',
            'cooldown_seconds', 'cooldown_per_user', 'cooldown_per_channel', 'enabled'];

        const sets = [];
        const params = [];
        for (const key of allowed) {
            if (d[key] !== undefined) {
                sets.push(`\`${key}\` = ?`);
                params.push(d[key]);
            }
        }

        if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });

        params.push(id, guildId);
        await pool.execute(`UPDATE autoresponders SET ${sets.join(', ')} WHERE id = ? AND guild_id = ?`, params);
        invalidateManagerCache(guildId);
        res.json({ success: true });
    } catch (error) {
        logger.error('[API Autoresponders PUT]', { error: error.message });
        res.status(500).json({ error: 'Failed to update' });
    }
});

// PUT /:id/toggle — enable/disable
router.put('/:id/toggle', async (req, res) => {
    try {
        const { guildId, id } = req.params;
        await pool.execute(
            'UPDATE autoresponders SET enabled = NOT enabled WHERE id = ? AND guild_id = ?',
            [id, guildId]
        );
        invalidateManagerCache(guildId);
        res.json({ success: true });
    } catch (error) {
        logger.error('[API Autoresponders toggle]', { error: error.message });
        res.status(500).json({ error: 'Failed to toggle' });
    }
});

// DELETE /:id
router.delete('/:id', async (req, res) => {
    try {
        const { guildId, id } = req.params;
        const [result] = await pool.execute('DELETE FROM autoresponders WHERE id = ? AND guild_id = ?', [id, guildId]);
        invalidateManagerCache(guildId);
        res.json({ success: result.affectedRows > 0, error: result.affectedRows === 0 ? 'Not found' : undefined });
    } catch (error) {
        logger.error('[API Autoresponders DELETE]', { error: error.message });
        res.status(500).json({ error: 'Failed to delete' });
    }
});

function invalidateManagerCache(guildId) {
    try {
        const botManager = global.botManager;
        if (botManager) {
            for (const [, client] of botManager.clients) {
                client.autoResponseManager?.invalidateCache(guildId);
            }
        }
    } catch { /* best effort */ }
}

export default router;
