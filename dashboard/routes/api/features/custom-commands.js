/**
 * Custom commands API — `/api/guilds/:guildId/custom-commands/*`
 *
 * Already gated by `apiCheckGuildAdmin` at the parent router, so every caller has at
 * least Manage Guild on this guild.
 *
 * Custom commands are invoked from chat with any of the guild's prefixes (`!rules`),
 * handled by core/custom-command-handler.js via the universal command bridge.
 *
 * Writes re-check the caller's LIVE permission (liveConfigAccess), and every save returns
 * `warnings` from validateTemplate (unknown variables, bad API URLs) — a warning never blocks a
 * save, because text like "{this}" can be intended. POST /preview renders a response as the
 * admin with its API calls really made, through the same SSRF guard and rate limits as chat.
 */
import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { invalidateCommandCache, previewCustomResponse } from '../../../../core/custom-command-handler.js';
import {
    TEMPLATE_VARIABLES, ALIAS_VARIABLES, MAX_API_CALLS, API_OUTPUT_MAX, RATE_LIMITS, validateTemplate,
    MAX_DB_OPS, DB_KEY_MAX, DB_VALUE_MAX, DB_INCR_MAX, DB_USER_KEYS, DB_SERVER_KEYS,
} from '../../../../core/custom-command-vars.js';
import { liveConfigAccess } from '../../../../core/protection-exempt.js';
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

/** Writes need the caller to still be allowed to configure the bot right now, not just at login. */
async function mayWrite(req, res) {
    if (req.isSuperAdmin) return true;
    const access = await liveConfigAccess(req.guildObject, req.user.id).catch(() => ({ ok: false }));
    if (!access.ok) { res.status(403).json({ error: "You no longer have permission to change this server's settings." }); return false; }
    return true;
}

/** What the dashboard shows next to the editor: every variable, the alias forms and the limits. */
const REFERENCE = Object.freeze({
    variables: TEMPLATE_VARIABLES,
    aliases: ALIAS_VARIABLES,
    limits: { maxApiCalls: MAX_API_CALLS, apiOutputMax: API_OUTPUT_MAX, timeoutSeconds: 5, ...RATE_LIMITS },
    storage: {
        maxOps: MAX_DB_OPS, keyMax: DB_KEY_MAX, valueMax: DB_VALUE_MAX, incrMax: DB_INCR_MAX,
        userKeys: DB_USER_KEYS, serverKeys: DB_SERVER_KEYS, retainDays: 400,
    },
});

function jsonOrNull(value) {
    if (!Array.isArray(value) || !value.length) return null;
    const ids = value.filter(v => /^\d{17,20}$/.test(String(v)));
    return ids.length ? JSON.stringify(ids) : null;
}

const MAX_LIMIT_IDS = 25;

/**
 * Check the role, required roles and allowed channels against the guild: unknown ids are dropped,
 * and a role command's role must be one the bot can give (below its highest role, not managed).
 * Returns { roles, channels } (clean id arrays) or { error }.
 */
function guildRefs(req, body) {
    const guildId = req.params.guildId;
    const guild = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId) || req.guildObject || null;
    const ids = (v) => Array.isArray(v) ? [...new Set(v.map(String).filter(id => /^\d{17,20}$/.test(id)))] : [];
    let roles = ids(body.required_roles);
    let channels = ids(body.allowed_channels);
    if (roles.length > MAX_LIMIT_IDS || channels.length > MAX_LIMIT_IDS) {
        return { error: `Pick at most ${MAX_LIMIT_IDS} roles and ${MAX_LIMIT_IDS} channels.` };
    }
    if (guild) {
        roles = roles.filter(id => guild.roles.cache.has(id) && id !== guildId);
        channels = channels.filter(id => guild.channels.cache.has(id));
        if (body.action_type === 'add_role' || body.action_type === 'remove_role') {
            const role = guild.roles.cache.get(String(body.action_content));
            if (!role || role.id === guildId) return { error: 'That role is not in this server.' };
            if (role.managed || !role.editable) {
                return { error: `The bot cannot give or take @${role.name}: it is above the bot's highest role, or managed by an integration.` };
            }
        }
    }
    return { roles, channels };
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

// ── Variables, validation and the Test button ───────────────────────────────

router.get('/reference', (_req, res) => res.json({ success: true, ...REFERENCE }));

router.post('/validate', (req, res) => {
    const response = String(req.body?.response ?? '').slice(0, 4000);
    res.json({ success: true, ...validateTemplate(response) });
});

router.post('/preview', async (req, res) => {
    const guild = req.guildObject;
    const response = String(req.body?.response ?? '');
    if (!response.trim()) return res.status(400).json({ error: 'Write a response to test first.' });
    if (response.length > MAX_RESPONSE) return res.status(400).json({ error: `Response must be under ${MAX_RESPONSE} characters.` });
    if (!guild) return res.status(503).json({ error: 'The bot is not connected to this server right now.' });
    try {
        const { warnings } = validateTemplate(response);
        const { content, calls } = await previewCustomResponse(guild, req.user, response, String(req.body?.args ?? '').slice(0, 500));
        res.json({
            success: true,
            output: content,
            warnings,
            calls: calls.map(c => ({ url: c.url.slice(0, 300), ok: c.ok, error: c.error || null, cached: !!c.cached, local: !!c.local })),
        });
    } catch (error) {
        logger.error('[API CustomCmd] preview failed:', { error: error.message, guildId: guild.id });
        res.status(500).json({ error: 'Could not render a preview.' });
    }
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
        const refs = guildRefs(req, payload);
        if (refs.error) return res.status(400).json({ error: refs.error });

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
        // SELECT * so use_count / last_used_at (migration 425) come through once they exist.
        const [rows] = await pool.execute(
            'SELECT * FROM custom_commands WHERE guild_id = ? ORDER BY command_name',
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
        if (!(await mayWrite(req, res))) return;
        const check = validate(req.body);
        if (check.error) return res.status(400).json({ error: check.error });
        const refs = guildRefs(req, req.body);
        if (refs.error) return res.status(400).json({ error: refs.error });

        const [existing] = await pool.execute(
            'SELECT id FROM custom_commands WHERE guild_id = ? AND command_name = ?', [guildId, check.name]);
        if (existing.length) return res.status(409).json({ error: `\`${check.name}\` already exists.` });

        const isReply = req.body.action_type === 'reply';
        await pool.execute(
            `INSERT INTO custom_commands
               (guild_id, command_name, response, action_type, action_content, required_roles, allowed_channels)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [guildId, check.name, isReply ? (req.body.response || '') : '', req.body.action_type,
                isReply ? null : (req.body.action_content || null), jsonOrNull(refs.roles), jsonOrNull(refs.channels)]);

        invalidateCommandCache(guildId, check.name);
        res.json({
            success: true, command_name: check.name, required_roles: refs.roles, allowed_channels: refs.channels,
            warnings: isReply ? validateTemplate(req.body.response || '').warnings : [],
        });
    } catch (error) {
        logger.error('[API CustomCmd] create failed:', { error: error.message });
        res.status(500).json({ error: 'Failed to create custom command.' });
    }
});

router.put('/:id', async (req, res) => {
    try {
        const { guildId, id } = req.params;
        if (!(await mayWrite(req, res))) return;
        const [[current]] = await pool.execute(
            'SELECT command_name FROM custom_commands WHERE id = ? AND guild_id = ?', [id, guildId]);
        if (!current) return res.status(404).json({ error: 'Command not found.' });

        const check = validate(req.body, { currentName: current.command_name });
        if (check.error) return res.status(400).json({ error: check.error });
        const name = check.name;
        if (name !== current.command_name) {
            const [taken] = await pool.execute(
                'SELECT id FROM custom_commands WHERE guild_id = ? AND command_name = ? AND id <> ?', [guildId, name, id]);
            if (taken.length) return res.status(409).json({ error: `\`${name}\` already exists.` });
        }
        const refs = guildRefs(req, req.body);
        if (refs.error) return res.status(400).json({ error: refs.error });

        const isReply = req.body.action_type === 'reply';
        await pool.execute(
            `UPDATE custom_commands SET command_name = ?, response = ?, action_type = ?,
                    action_content = ?, required_roles = ?, allowed_channels = ?
              WHERE id = ? AND guild_id = ?`,
            [name, isReply ? (req.body.response || '') : '', req.body.action_type, isReply ? null : (req.body.action_content || null),
                jsonOrNull(refs.roles), jsonOrNull(refs.channels), id, guildId]);

        invalidateCommandCache(guildId, current.command_name);
        invalidateCommandCache(guildId, name);
        res.json({
            success: true, command_name: name, required_roles: refs.roles, allowed_channels: refs.channels,
            warnings: isReply ? validateTemplate(req.body.response || '').warnings : [],
        });
    } catch (error) {
        logger.error('[API CustomCmd] update failed:', { error: error.message });
        res.status(500).json({ error: 'Failed to update custom command.' });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const { guildId, id } = req.params;
        if (!(await mayWrite(req, res))) return;
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
