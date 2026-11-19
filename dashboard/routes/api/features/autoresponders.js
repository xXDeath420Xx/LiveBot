import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';

const router = express.Router({ mergeParams: true });

// ── Input checks for create / update ────────────────────────────────────────────
const MATCH_TYPES = new Set(['exact', 'contains', 'starts_with', 'ends_with', 'regex', 'wildcard']);
const RESPONSE_TYPES = new Set(['text', 'embed', 'react']);
const MAX_TRIGGER = 500;
const MAX_REPLY = 2000;        // a Discord message
const MAX_LIST = 50;
const MAX_REACTIONS = 20;      // Discord's limit of different reactions on one message

function guildFor(guildId) {
    return global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId) || null;
}
function bool(v) { return v === true || v === 1 || v === '1' || v === 'true' || v === 'on'; }

/** A JSON id list (array or JSON string) reduced to ids that exist in the guild. */
function idList(value, guild, kind) {
    let list = value;
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
    if (!Array.isArray(list)) return null;
    let ids = [...new Set(list.map(String).filter(id => /^\d{17,20}$/.test(id)))].slice(0, MAX_LIST);
    if (guild) ids = ids.filter(id => kind === 'role' ? guild.roles.cache.has(id) : guild.channels.cache.has(id));
    return ids.length ? JSON.stringify(ids) : null;
}

/**
 * Check and tidy an auto-response body. With `partial` (PUT) only the fields sent are checked.
 * Returns { data } with column values, or { error }.
 */
function cleanAutoresponder(guildId, d, partial) {
    const out = {};
    const sent = (k) => d[k] !== undefined;
    const guild = guildFor(guildId);
    if (!partial || sent('trigger_text')) {
        const trigger = String(d.trigger_text ?? '').trim();
        if (!trigger) return { error: 'Trigger text is required' };
        if (trigger.length > MAX_TRIGGER) return { error: `The trigger must be ${MAX_TRIGGER} characters or fewer.` };
        out.trigger_text = trigger;
    }
    if (!partial || sent('match_type')) {
        out.match_type = MATCH_TYPES.has(d.match_type) ? d.match_type : 'contains';
    }
    const trigger = out.trigger_text ?? d.trigger_text;
    if (out.match_type === 'regex' && trigger) {
        try { new RegExp(trigger); } catch { return { error: 'Invalid regex pattern' }; }
    }
    if (!partial || sent('response_type')) out.response_type = RESPONSE_TYPES.has(d.response_type) ? d.response_type : 'text';
    const type = out.response_type || (partial ? null : 'text');
    if (!partial || sent('response_text')) {
        const text = d.response_text == null ? '' : String(d.response_text).trim();
        if (text.length > MAX_REPLY) return { error: `The reply must be ${MAX_REPLY} characters or fewer.` };
        if (type === 'text' && !text) return { error: 'Response text is required for text responses' };
        out.response_text = text;   // NOT NULL column: embed and reaction replies store ''
    }
    if (!partial || sent('embed_json')) {
        if (d.embed_json == null || d.embed_json === '') {
            if (type === 'embed') return { error: 'An embed reply needs a title or a description.' };
            out.embed_json = null;
        } else {
            let e;
            try { e = typeof d.embed_json === 'string' ? JSON.parse(d.embed_json) : d.embed_json; } catch { return { error: 'The embed is not valid.' }; }
            const title = String(e?.title ?? '').trim().slice(0, 256);
            const description = String(e?.description ?? '').trim().slice(0, 4096);
            if (type === 'embed' && !title && !description) return { error: 'An embed reply needs a title or a description.' };
            const color = Number.isInteger(e?.color) && e.color >= 0 && e.color <= 0xffffff ? e.color : undefined;
            out.embed_json = JSON.stringify({ ...(title ? { title } : {}), ...(description ? { description } : {}), ...(color !== undefined ? { color } : {}) });
        }
    }
    if (!partial || sent('reactions')) {
        let list = d.reactions;
        if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = list.split(/\s+/); } }
        list = Array.isArray(list) ? [...new Set(list.map(s => String(s).trim()).filter(s => s && s.length <= 100))].slice(0, MAX_REACTIONS) : [];
        if (type === 'react' && !list.length) return { error: 'Add at least one emoji to react with.' };
        out.reactions = list.length ? JSON.stringify(list) : null;
    }
    for (const [key, kind] of [['allowed_channels', 'channel'], ['blocked_channels', 'channel'], ['allowed_roles', 'role'], ['blocked_roles', 'role']]) {
        if (!partial || sent(key)) out[key] = d[key] == null ? null : idList(d[key], guild, kind);
    }
    for (const key of ['case_sensitive', 'delete_trigger', 'require_all_roles', 'cooldown_per_channel']) {
        if (!partial || sent(key)) out[key] = bool(d[key]) ? 1 : 0;
    }
    // These two default to on when a create leaves them out (what the form has always done).
    for (const key of ['reply_to_user', 'cooldown_per_user']) {
        if (!partial || sent(key)) out[key] = d[key] === undefined || bool(d[key]) ? 1 : 0;
    }
    if (!partial || sent('cooldown_seconds')) {
        const n = Math.round(Number(d.cooldown_seconds) || 0);
        out.cooldown_seconds = Math.max(0, Math.min(86400, n));
    }
    if (partial && sent('enabled')) out.enabled = bool(d.enabled) ? 1 : 0;
    return { data: out };
}

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
        const checked = cleanAutoresponder(guildId, req.body || {}, false);
        if (checked.error) return res.status(400).json({ error: checked.error });
        const d = checked.data;

        await pool.execute(
            `INSERT INTO autoresponders (guild_id, trigger_text, response_text, match_type, case_sensitive,
             response_type, embed_json, reactions, delete_trigger, reply_to_user,
             allowed_channels, blocked_channels, allowed_roles, blocked_roles, require_all_roles,
             cooldown_seconds, cooldown_per_user, cooldown_per_channel, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                guildId, d.trigger_text, d.response_text,
                d.match_type, d.case_sensitive,
                d.response_type, d.embed_json, d.reactions,
                d.delete_trigger, d.reply_to_user,
                d.allowed_channels, d.blocked_channels,
                d.allowed_roles, d.blocked_roles, d.require_all_roles,
                d.cooldown_seconds, d.cooldown_per_user, d.cooldown_per_channel,
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
        const checked = cleanAutoresponder(guildId, req.body || {}, true);
        if (checked.error) return res.status(400).json({ error: checked.error });
        const d = checked.data;
        if (d.trigger_text !== undefined && d.match_type === undefined) {
            // A new trigger on a regex auto-response must still compile.
            const [[row]] = await pool.execute('SELECT match_type FROM autoresponders WHERE id = ? AND guild_id = ?', [id, guildId]);
            if (row?.match_type === 'regex') { try { new RegExp(d.trigger_text); } catch { return res.status(400).json({ error: 'Invalid regex pattern' }); } }
        }

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
        res.status(500).json({ error: error.code === 'ER_DUP_ENTRY' ? 'Trigger already exists' : 'Failed to update' });
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
