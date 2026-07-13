/**
 * Custom commands API — `/api/guilds/:guildId/custom-commands/*`
 *
 * Already gated by `apiCheckGuildAdmin` at the parent router, so every caller has at
 * least Manage Guild on this guild.
 *
 * Custom commands are invoked from chat with any of the guild's prefixes (`!rules`),
 * handled by core/custom-command-handler.js via the universal command bridge.
 */
import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { invalidateCommandCache, TEMPLATE_VARIABLES } from '../../../../core/custom-command-handler.js';
import { TEMPLATES, getTemplate, templateCategories } from '../../../../core/custom-command-templates.js';
import { isReservedName } from '../../../../core/universal-commands.js';
import { getCommand } from '../../../../core/prefix-command-registry.js';

const router = express.Router({ mergeParams: true });

const NAME_RE = /^[a-z0-9_-]{1,30}$/;
const ACTION_TYPES = new Set(['reply', 'add_role', 'remove_role']);
const MAX_RESPONSE = 2000; // a Discord message

/**
 * Reject malformed input and names that would shadow a real command.
 * @param opts.currentName skip the shadow check when the name is unchanged.
 */
function validate({ command_name, action_type, response, action_content }, opts = {}) {
    const name = String(command_name || '').toLowerCase().trim();
    if (!NAME_RE.test(name)) {
        return { error: 'Name must be 1–30 characters: letters, numbers, - or _ (no prefix symbol).' };
    }
    // The bridge checks custom commands LAST, so a clashing name would never fire.
    if (name !== opts.currentName && (getCommand(name) || isReservedName(name))) {
        return { error: `"${name}" is already a built-in command or shortcut — pick another name.` };
    }
    if (!ACTION_TYPES.has(action_type)) {
        return { error: `action_type must be one of: ${[...ACTION_TYPES].join(', ')}.` };
    }
    if (action_type === 'reply') {
        if (!response || !String(response).trim()) return { error: 'A reply command needs a response.' };
        if (String(response).length > MAX_RESPONSE) return { error: `Response must be under ${MAX_RESPONSE} characters.` };
    } else if (!/^\d{17,20}$/.test(String(action_content || ''))) {
        return { error: 'Pick a role for this command.' };
    }
    return { name };
}

function jsonOrNull(value) {
    if (!Array.isArray(value) || !value.length) return null;
    return JSON.stringify(value.filter(v => /^\d{17,20}$/.test(String(v))));
}

// ── Templates ────────────────────────────────────────────────────────────────

router.get('/templates', (_req, res) => {
    res.json({
        success: true,
        templates: TEMPLATES,
        categories: templateCategories(),
        variables: TEMPLATE_VARIABLES,
    });
});

/** Create a command from a template. The admin edits it afterwards. */
router.post('/templates/:templateId', async (req, res) => {
    try {
        const { guildId, templateId } = req.params;
        const template = getTemplate(templateId);
        if (!template) return res.status(404).json({ error: 'Unknown template.' });

        // Allow overriding the name so two templates can coexist.
        const command_name = String(req.body?.command_name || template.command_name).toLowerCase().trim();
        const payload = {
            command_name,
            action_type: template.action_type,
            response: template.response,
            action_content: req.body?.action_content ?? template.action_content ?? null,
        };

        // A role template can't be validated until a role is chosen; store it disabled-ish
        // by requiring the caller to supply one.
        const check = validate(payload);
        if (check.error) return res.status(400).json({ error: check.error });

        const [existing] = await pool.execute(
            'SELECT id FROM custom_commands WHERE guild_id = ? AND command_name = ?', [guildId, command_name]);
        if (existing.length) return res.status(409).json({ error: `\`${command_name}\` already exists.` });

        await pool.execute(
            `INSERT INTO custom_commands (guild_id, command_name, response, action_type, action_content)
             VALUES (?, ?, ?, ?, ?)`,
            [guildId, command_name, payload.response || '', payload.action_type, payload.action_content || null]);

        invalidateCommandCache(guildId, command_name);
        res.json({ success: true, command_name });
    } catch (error) {
        logger.error('[API CustomCmd] template apply failed:', { error: error.message });
        res.status(500).json({ error: 'Failed to create command from template.' });
    }
});

// ── CRUD ─────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT id, command_name, response, action_type, action_content, required_roles, allowed_channels
               FROM custom_commands WHERE guild_id = ? ORDER BY command_name`,
            [req.params.guildId]);
        res.json({
            success: true,
            commands: rows.map(r => ({
                ...r,
                required_roles: r.required_roles ? JSON.parse(r.required_roles) : [],
                allowed_channels: r.allowed_channels ? JSON.parse(r.allowed_channels) : [],
            })),
            variables: TEMPLATE_VARIABLES,
        });
    } catch (error) {
        logger.error('[API CustomCmd] list failed:', { error: error.message });
        res.status(500).json({ error: 'Failed to list custom commands.' });
    }
});

router.post('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const check = validate(req.body);
        if (check.error) return res.status(400).json({ error: check.error });

        const [existing] = await pool.execute(
            'SELECT id FROM custom_commands WHERE guild_id = ? AND command_name = ?', [guildId, check.name]);
        if (existing.length) return res.status(409).json({ error: `\`${check.name}\` already exists.` });

        await pool.execute(
            `INSERT INTO custom_commands
               (guild_id, command_name, response, action_type, action_content, required_roles, allowed_channels)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [guildId, check.name, req.body.response || '', req.body.action_type,
                req.body.action_content || null, jsonOrNull(req.body.required_roles), jsonOrNull(req.body.allowed_channels)]);

        invalidateCommandCache(guildId, check.name);
        res.json({ success: true, command_name: check.name });
    } catch (error) {
        logger.error('[API CustomCmd] create failed:', { error: error.message });
        res.status(500).json({ error: 'Failed to create custom command.' });
    }
});

router.put('/:id', async (req, res) => {
    try {
        const { guildId, id } = req.params;
        const [[current]] = await pool.execute(
            'SELECT command_name FROM custom_commands WHERE id = ? AND guild_id = ?', [id, guildId]);
        if (!current) return res.status(404).json({ error: 'Command not found.' });

        const check = validate(req.body, { currentName: current.command_name });
        if (check.error) return res.status(400).json({ error: check.error });
        const name = check.name;

        await pool.execute(
            `UPDATE custom_commands SET command_name = ?, response = ?, action_type = ?,
                    action_content = ?, required_roles = ?, allowed_channels = ?
              WHERE id = ? AND guild_id = ?`,
            [name, req.body.response || '', req.body.action_type, req.body.action_content || null,
                jsonOrNull(req.body.required_roles), jsonOrNull(req.body.allowed_channels), id, guildId]);

        invalidateCommandCache(guildId, current.command_name);
        invalidateCommandCache(guildId, name);
        res.json({ success: true });
    } catch (error) {
        logger.error('[API CustomCmd] update failed:', { error: error.message });
        res.status(500).json({ error: 'Failed to update custom command.' });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const { guildId, id } = req.params;
        const [[current]] = await pool.execute(
            'SELECT command_name FROM custom_commands WHERE id = ? AND guild_id = ?', [id, guildId]);
        if (!current) return res.status(404).json({ error: 'Command not found.' });

        await pool.execute('DELETE FROM custom_commands WHERE id = ? AND guild_id = ?', [id, guildId]);
        invalidateCommandCache(guildId, current.command_name);
        res.json({ success: true });
    } catch (error) {
        logger.error('[API CustomCmd] delete failed:', { error: error.message });
        res.status(500).json({ error: 'Failed to delete custom command.' });
    }
});

export default router;
