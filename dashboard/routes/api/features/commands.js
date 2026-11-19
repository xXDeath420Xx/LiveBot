/**
 * Commands API
 * Per-guild command settings, stored on guild_command_restrictions (one row per command key:
 * 'command' or 'command:subcommand'), read at run time by core/command-restrictions.js for slash
 * commands (events/interactionCreate.js) and chat commands (core/universal-commands.js).
 *
 *   GET /restrictions             access level per key ({ allowed, admin_only })
 *   PUT /restrictions             access levels from the Commands page list (Everyone / Mod only /
 *                                 Disabled). Changes only allowed/admin_only, never a row's other
 *                                 settings. It used to delete every row for the guild and re-insert
 *                                 the access levels, which wiped role/channel overrides, cooldowns,
 *                                 denial messages and every subcommand row on each save.
 *   PUT /settings/:key            the settings drawer: access, allowed/denied roles and channels,
 *                                 cooldown, private replies, delete-reply-after, refusal message
 *   DELETE /settings/:key         back to defaults (the row is removed)
 *   GET /usage                    uses in the last 30 days and the last day used, per command, from
 *                                 command_usage_daily (jobs/command-usage-rollup.js, migration 433)
 *   GET /usage/series?key=        uses per day for 90 days for one key ('command' or 'command:sub')
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { invalidate as invalidateRestriction, MAX_AUTODELETE_SECONDS } from '../../../../core/command-restrictions.js';

const router = express.Router({ mergeParams: true });

// Same as events/interactionCreate.js: with no row, these categories are Mod only.
const ADMIN_CATEGORIES = new Set(['admin', 'streams']);
const KEY_RE = /^[a-z0-9_-]{1,32}(:[a-z0-9_-]{1,32})?$/;
const SNOWFLAKE = /^\d{15,25}$/;
const MAX_LIST = 50;
const MAX_COOLDOWN = 86400;
const MAX_DENIAL = 500;

function clientFor(req) {
    const { guildId } = req.params;
    return global.botManager?.getClientForGuild?.(guildId) || req.app?.locals?.client || null;
}

/** The command a key names, or null. `sub` is checked against the command's own options. */
function findCommand(client, key) {
    const [base, sub] = String(key).split(':');
    const cmd = client?.commands?.get?.(base);
    if (!cmd) return null;
    if (sub) {
        let json = null;
        try { json = cmd.data?.toJSON?.() || null; } catch { json = null; }
        const ok = (json?.options || []).some((o) => o.name === sub && (o.type === 1 || o.type === 2));
        if (!ok) return null;
    }
    return cmd;
}

function categoryDefault(cmd) {
    return ADMIN_CATEGORIES.has(cmd?.category) ? 'mod_only' : 'everyone';
}

function accessOf(row) {
    if (!row) return null;
    if (!Number(row.allowed)) return 'disabled';
    return Number(row.admin_only) ? 'mod_only' : 'everyone';
}

function accessColumns(access) {
    if (access === 'disabled') return { allowed: 0, admin_only: 1 };
    if (access === 'mod_only') return { allowed: 1, admin_only: 1 };
    return { allowed: 1, admin_only: 0 };
}

function jsonList(v) {
    if (!v) return [];
    try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}

/** True when a row carries anything besides its access level. */
function hasExtras(row) {
    if (!row) return false;
    return Boolean(row.channel_id)
        || ['allowed_roles', 'denied_roles', 'allowed_channels', 'denied_channels'].some((c) => jsonList(row[c]).length)
        || Number(row.cooldown_seconds) > 0
        || Number(row.ephemeral) === 1
        || Number(row.autodelete_reply_seconds) > 0
        || Boolean(row.denial_message);
}

/** The drawer's view of a row (the shape the page keeps per key). */
function shape(row) {
    if (!row) return null;
    return {
        allowed: Number(row.allowed) ? 1 : 0,
        admin_only: Number(row.admin_only) ? 1 : 0,
        allowed_roles: jsonList(row.allowed_roles),
        denied_roles: jsonList(row.denied_roles),
        // channel_id is the original single-channel lock; it is shown (and saved) as an allowed channel.
        allowed_channels: [...new Set([...jsonList(row.allowed_channels), ...(row.channel_id ? [String(row.channel_id)] : [])])],
        denied_channels: jsonList(row.denied_channels),
        cooldown_seconds: Number(row.cooldown_seconds) || 0,
        cooldown_scope: row.cooldown_scope || 'user',
        ephemeral: Number(row.ephemeral) === 1,
        autodelete_reply_seconds: Number(row.autodelete_reply_seconds) || 0,
        denial_message: row.denial_message || '',
    };
}

// Migration 424 adds autodelete_reply_seconds. Until it has run, the drawer saves everything else.
let autodeleteColumn = { known: false, at: 0 };
async function hasAutodeleteColumn() {
    if (autodeleteColumn.known && Date.now() - autodeleteColumn.at < 60000) return autodeleteColumn.value;
    const [rows] = await pool.query(
        `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'guild_command_restrictions' AND COLUMN_NAME = 'autodelete_reply_seconds'`);
    autodeleteColumn = { known: true, at: Date.now(), value: rows.length > 0 };
    return autodeleteColumn.value;
}

function forget(guildId, key) {
    invalidateRestriction(guildId, key);
}

// command_usage_daily arrives with migration 433; until then the usage endpoints answer "not yet".
const missingTable = (e) => e?.code === 'ER_NO_SUCH_TABLE';

/**
 * GET /api/guilds/:guildId/commands/usage
 * { success, available, since, commands: { [command]: { uses30, last } } }, all kinds and sources
 * added up. `last` is the last day (YYYY-MM-DD) with a use, over all time.
 */
router.get('/usage', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [rows] = await pool.query(
            `SELECT SUBSTRING_INDEX(path, ' ', 1) AS command,
                    SUM(CASE WHEN day >= CURDATE() - INTERVAL 29 DAY THEN uses ELSE 0 END) AS uses30,
                    DATE_FORMAT(MAX(day), '%Y-%m-%d') AS last
               FROM command_usage_daily
              WHERE guild_id = ?
              GROUP BY command`, [guildId]);
        const [[span]] = await pool.query(
            "SELECT DATE_FORMAT(MIN(day), '%Y-%m-%d') AS since FROM command_usage_daily WHERE guild_id = ?", [guildId]);
        const commands = {};
        for (const r of rows) commands[r.command] = { uses30: Number(r.uses30) || 0, last: r.last };
        res.set('Cache-Control', 'no-store').json({ success: true, available: true, since: span?.since || null, commands });
    } catch (error) {
        if (missingTable(error)) return res.json({ success: true, available: false, commands: {} });
        logger.error('[API Commands Usage GET] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to load command usage' });
    }
});

/**
 * GET /api/guilds/:guildId/commands/usage/series?key=music:play
 * { success, available, days: [{ day, uses }] } for the last 90 days, one entry per day (zeros kept).
 */
router.get('/usage/series', async (req, res) => {
    try {
        const { guildId } = req.params;
        const key = String(req.query.key || '').toLowerCase();
        if (!KEY_RE.test(key)) return res.status(400).json({ error: 'Unknown command' });
        const prefix = key.replace(':', ' ');
        const [rows] = await pool.query(
            `SELECT DATE_FORMAT(day, '%Y-%m-%d') AS day, SUM(uses) AS uses
               FROM command_usage_daily
              WHERE guild_id = ? AND day >= CURDATE() - INTERVAL 89 DAY
                AND (path = ? OR path LIKE CONCAT(?, ' %'))
              GROUP BY day ORDER BY day`, [guildId, prefix, prefix.replace(/[\\%_]/g, '\\$&')]);
        const [[{ today }]] = await pool.query("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today");
        const byDay = new Map(rows.map(r => [r.day, Number(r.uses) || 0]));
        const days = [];
        const end = new Date(`${today}T00:00:00Z`);
        for (let i = 89; i >= 0; i--) {
            const d = new Date(end.getTime() - i * 86400000).toISOString().slice(0, 10);
            days.push({ day: d, uses: byDay.get(d) || 0 });
        }
        res.set('Cache-Control', 'no-store').json({ success: true, available: true, days });
    } catch (error) {
        if (missingTable(error)) return res.json({ success: true, available: false, days: [] });
        logger.error('[API Commands Usage series GET] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to load command usage' });
    }
});

/**
 * GET /api/guilds/:guildId/commands/restrictions
 */
router.get('/restrictions', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [rows] = await pool.execute('SELECT * FROM guild_command_restrictions WHERE guild_id = ?', [guildId]);
        const restrictions = {};
        rows.forEach((row) => {
            restrictions[row.command_name] = { allowed: row.allowed === 1, admin_only: row.admin_only === 1, settings: shape(row) };
        });
        res.json({ success: true, restrictions });
    } catch (error) {
        logger.error('[API Commands Restrictions GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch command restrictions' });
    }
});

/**
 * PUT /api/guilds/:guildId/commands/restrictions
 * Body: { restrictions: [{ command_name, allowed, admin_only }] }
 * Only the listed keys are touched, and only their access level.
 */
router.put('/restrictions', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { restrictions } = req.body || {};
        if (!Array.isArray(restrictions)) return res.status(400).json({ error: 'restrictions must be an array' });
        if (restrictions.length > 1000) return res.status(400).json({ error: 'Too many commands in one save' });

        const client = clientFor(req);
        const [rows] = await pool.execute('SELECT * FROM guild_command_restrictions WHERE guild_id = ?', [guildId]);
        const existing = new Map(rows.map((r) => [r.command_name, r]));
        let changed = 0;

        for (const r of restrictions) {
            const key = String(r?.command_name || '').toLowerCase();
            if (!KEY_RE.test(key)) continue;
            const cols = { allowed: r.allowed ? 1 : 0, admin_only: r.allowed ? (r.admin_only ? 1 : 0) : 1 };
            const cmd = client?.commands?.size ? findCommand(client, key) : null;
            if (client?.commands?.size && !cmd) continue;   // not a command of this bot
            const wantDefault = accessOf(cols) === categoryDefault(cmd) && !key.includes(':');
            const row = existing.get(key);

            if (row) {
                if (Number(row.allowed) === cols.allowed && Number(row.admin_only) === cols.admin_only) continue;
                if (wantDefault && !hasExtras(row)) {
                    await pool.execute('DELETE FROM guild_command_restrictions WHERE guild_id = ? AND command_name = ?', [guildId, key]);
                } else {
                    await pool.execute('UPDATE guild_command_restrictions SET allowed = ?, admin_only = ? WHERE guild_id = ? AND command_name = ?',
                        [cols.allowed, cols.admin_only, guildId, key]);
                }
            } else {
                if (wantDefault) continue;   // no row means the category default already
                await pool.execute('INSERT INTO guild_command_restrictions (guild_id, command_name, allowed, admin_only) VALUES (?, ?, ?, ?)',
                    [guildId, key, cols.allowed, cols.admin_only]);
            }
            changed++;
            forget(guildId, key);
        }

        res.json({ success: true, message: 'Command restrictions updated', changed });
    } catch (error) {
        logger.error('[API Commands Restrictions PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update command restrictions' });
    }
});

/** Validate a list of ids against what exists in the guild. Returns { ids } or { error }. */
function idList(raw, label, has) {
    const list = Array.isArray(raw) ? raw : [];
    if (list.length > MAX_LIST) return { error: `${label}: at most ${MAX_LIST}` };
    const ids = [...new Set(list.map(String))];
    if (ids.some((id) => !SNOWFLAKE.test(id) || !has(id))) return { error: `${label}: one of them is not in this server` };
    return { ids };
}

/**
 * PUT /api/guilds/:guildId/commands/settings/:key
 * Body: { access, allowed_roles, denied_roles, allowed_channels, denied_channels, cooldown_seconds,
 *         cooldown_scope, ephemeral, autodelete_reply_seconds, denial_message }
 */
router.put('/settings/:key', async (req, res) => {
    try {
        const { guildId } = req.params;
        const key = String(req.params.key || '').toLowerCase();
        if (!KEY_RE.test(key)) return res.status(400).json({ error: 'Unknown command' });

        const client = clientFor(req);
        const guild = client?.guilds?.cache?.get(guildId);
        if (!guild) return res.status(400).json({ error: 'The bot is not in this server' });
        const cmd = findCommand(client, key);
        if (!cmd) return res.status(400).json({ error: 'Unknown command' });

        const b = req.body || {};
        const access = ['everyone', 'mod_only', 'disabled'].includes(b.access) ? b.access : null;
        if (!access) return res.status(400).json({ error: 'Choose who can use it' });

        const hasRole = (id) => id !== guildId && guild.roles.cache.has(id);
        const hasChannel = (id) => guild.channels.cache.has(id);
        const lists = {};
        for (const [field, label, has] of [
            ['allowed_roles', 'Allowed roles', hasRole], ['denied_roles', 'Blocked roles', hasRole],
            ['allowed_channels', 'Allowed channels', hasChannel], ['denied_channels', 'Blocked channels', hasChannel],
        ]) {
            const r = idList(b[field], label, has);
            if (r.error) return res.status(400).json({ error: r.error });
            lists[field] = r.ids;
        }
        if (lists.allowed_roles.some((id) => lists.denied_roles.includes(id))) {
            return res.status(400).json({ error: 'A role cannot be both allowed and blocked' });
        }
        if (lists.allowed_channels.some((id) => lists.denied_channels.includes(id))) {
            return res.status(400).json({ error: 'A channel cannot be both allowed and blocked' });
        }

        const cooldown = Number(b.cooldown_seconds ?? 0);
        if (!Number.isInteger(cooldown) || cooldown < 0 || cooldown > MAX_COOLDOWN) {
            return res.status(400).json({ error: `Cooldown must be a whole number from 0 to ${MAX_COOLDOWN} seconds` });
        }
        const scope = ['user', 'channel', 'guild'].includes(b.cooldown_scope) ? b.cooldown_scope : 'user';
        const autodelete = Number(b.autodelete_reply_seconds ?? 0);
        if (!Number.isInteger(autodelete) || autodelete < 0 || autodelete > MAX_AUTODELETE_SECONDS) {
            return res.status(400).json({ error: `Delete after must be a whole number from 0 to ${MAX_AUTODELETE_SECONDS} seconds` });
        }
        const denial = String(b.denial_message ?? '').trim();
        if (denial.length > MAX_DENIAL) return res.status(400).json({ error: `Refusal message: at most ${MAX_DENIAL} characters` });
        const ephemeral = b.ephemeral === true || b.ephemeral === 1 || b.ephemeral === '1';

        const withAutodelete = await hasAutodeleteColumn();
        if (autodelete > 0 && !withAutodelete) {
            return res.status(503).json({ error: 'Delete after is not available yet (database migration 424 has not run)' });
        }

        const cols = accessColumns(access);
        const row = {
            ...cols,
            channel_id: null,
            subcommand_group: key.includes(':') ? key.split(':')[1] : null,
            allowed_roles: lists.allowed_roles.length ? JSON.stringify(lists.allowed_roles) : null,
            denied_roles: lists.denied_roles.length ? JSON.stringify(lists.denied_roles) : null,
            allowed_channels: lists.allowed_channels.length ? JSON.stringify(lists.allowed_channels) : null,
            denied_channels: lists.denied_channels.length ? JSON.stringify(lists.denied_channels) : null,
            cooldown_seconds: cooldown || null,
            cooldown_scope: scope,
            denial_message: denial || null,
            ephemeral: ephemeral ? 1 : null,
        };
        if (withAutodelete) row.autodelete_reply_seconds = autodelete || null;

        // A top-level command with nothing but its usual access level needs no row. A subcommand
        // row always stays: it replaces the command's own row for that subcommand.
        if (!key.includes(':') && access === categoryDefault(cmd) && !hasExtras(row)) {
            await pool.execute('DELETE FROM guild_command_restrictions WHERE guild_id = ? AND command_name = ?', [guildId, key]);
            forget(guildId, key);
            return res.json({ success: true, message: 'Saved', settings: null });
        }

        const names = Object.keys(row);
        await pool.execute(
            `INSERT INTO guild_command_restrictions (guild_id, command_name, ${names.map((n) => `\`${n}\``).join(', ')})
             VALUES (?, ?, ${names.map(() => '?').join(', ')})
             ON DUPLICATE KEY UPDATE ${names.map((n) => `\`${n}\` = VALUES(\`${n}\`)`).join(', ')}`,
            [guildId, key, ...names.map((n) => row[n])]);
        forget(guildId, key);
        res.json({ success: true, message: 'Saved', settings: shape(row) });
    } catch (error) {
        logger.error('[API Commands Settings PUT] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to save command settings' });
    }
});

/**
 * DELETE /api/guilds/:guildId/commands/settings/:key — remove the row: the command goes back to
 * its usual access level, and a subcommand back to the command's own settings.
 */
router.delete('/settings/:key', async (req, res) => {
    try {
        const { guildId } = req.params;
        const key = String(req.params.key || '').toLowerCase();
        if (!KEY_RE.test(key)) return res.status(400).json({ error: 'Unknown command' });
        await pool.execute('DELETE FROM guild_command_restrictions WHERE guild_id = ? AND command_name = ?', [guildId, key]);
        forget(guildId, key);
        res.json({ success: true, message: 'Reset', settings: null });
    } catch (error) {
        logger.error('[API Commands Settings DELETE] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to reset command settings' });
    }
});

export default router;
