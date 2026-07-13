import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { invalidateGuildCache } from '../../../../core/prefix-command-manager.js';
import { getAllCommands, getCategories } from '../../../../core/prefix-command-registry.js';
import { DEFAULT_PREFIXES, listCommandPaths } from '../../../../core/universal-commands.js';

// A prefix has to be a short run of symbols. Letters/digits would swallow ordinary chat.
const PREFIX_RE = /^[^\w\s]{1,5}$/;

const router = express.Router({ mergeParams: true });

// GET config
router.get('/config', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [configRows] = await pool.execute(
            'SELECT prefix, prefixes, allow_mention, universal_commands, enabled, disabled_commands, delete_trigger, cleanup_delay, private_categories FROM prefix_command_config WHERE guild_id = ?',
            [guildId]
        );
        const [aliasRows] = await pool.execute(
            'SELECT alias, command_name, created_by, created_at FROM prefix_command_aliases WHERE guild_id = ? ORDER BY alias',
            [guildId]
        );
        const row = configRows[0];
        let prefixes = null;
        if (row?.prefixes) { try { prefixes = JSON.parse(row.prefixes); } catch { prefixes = null; } }

        res.json({
            success: true,
            config: {
                prefix: row?.prefix ?? '!',
                prefixes: prefixes ?? DEFAULT_PREFIXES,
                allow_mention: row ? row.allow_mention !== 0 : true,
                universal_commands: row ? row.universal_commands !== 0 : true,
                enabled: row?.enabled ?? 1,
                disabled_commands: row?.disabled_commands ?? null,
                delete_trigger: row?.delete_trigger ?? 0,
                cleanup_delay: row?.cleanup_delay ?? 0,
                private_categories: row?.private_categories ?? null,
            },
            defaultPrefixes: DEFAULT_PREFIXES,
            aliases: aliasRows
        });
    } catch (error) {
        logger.error('[API PrefixCmd] Error fetching config:', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch prefix command config' });
    }
});

// PUT config (prefix, enabled)
router.put('/config', async (req, res) => {
    try {
        const { guildId } = req.params;
        const {
            prefix, prefixes, allow_mention, universal_commands,
            enabled, delete_trigger, cleanup_delay, private_categories,
        } = req.body;

        if (prefix && !PREFIX_RE.test(prefix)) {
            return res.status(400).json({ error: 'Prefix must be 1–5 symbol characters (no letters, digits or spaces).' });
        }

        let prefixList = null;
        if (prefixes !== undefined) {
            if (!Array.isArray(prefixes)) {
                return res.status(400).json({ error: 'prefixes must be an array.' });
            }
            const cleaned = [...new Set(prefixes.map(p => String(p).trim()).filter(Boolean))];
            const bad = cleaned.find(p => !PREFIX_RE.test(p));
            if (bad) return res.status(400).json({ error: `"${bad}" is not a valid prefix — use 1–5 symbol characters.` });
            if (cleaned.length > 8) return res.status(400).json({ error: 'At most 8 prefixes.' });
            prefixList = cleaned;
        }

        await pool.execute(
            `INSERT INTO prefix_command_config
               (guild_id, prefix, prefixes, allow_mention, universal_commands, enabled, delete_trigger, cleanup_delay, private_categories)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE prefix = VALUES(prefix), prefixes = VALUES(prefixes),
             allow_mention = VALUES(allow_mention), universal_commands = VALUES(universal_commands),
             enabled = VALUES(enabled), delete_trigger = VALUES(delete_trigger),
             cleanup_delay = VALUES(cleanup_delay), private_categories = VALUES(private_categories)`,
            [
                guildId,
                prefix || '!',
                prefixList ? JSON.stringify(prefixList) : null,
                allow_mention === false ? 0 : 1,
                universal_commands === false ? 0 : 1,
                enabled ? 1 : 0,
                delete_trigger ? 1 : 0,
                cleanup_delay || 0,
                private_categories ? JSON.stringify(private_categories) : null
            ]
        );

        invalidateGuildCache(guildId);
        res.json({ success: true });
    } catch (error) {
        logger.error('[API PrefixCmd] Error updating config:', { error: error.message });
        res.status(500).json({ error: 'Failed to update config' });
    }
});

// POST alias
router.post('/aliases', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { alias, command_name } = req.body;

        if (!alias || !command_name) {
            return res.status(400).json({ error: 'alias and command_name are required' });
        }
        if (alias.length > 30 || command_name.length > 50) {
            return res.status(400).json({ error: 'alias max 30 chars, command_name max 50 chars' });
        }
        if (!/^[a-z0-9_-]+$/i.test(alias)) {
            return res.status(400).json({ error: 'Alias may only contain letters, numbers, - and _ (no prefix symbol, no spaces).' });
        }

        // The target must be a real prefix command OR a real slash path ("music play").
        const target = command_name.toLowerCase().trim();
        if (!getAllCommands().some(c => c.name === target) && !isKnownPath(target)) {
            return res.status(400).json({ error: `"${target}" isn't a command. Use a name like "ping" or a slash path like "music play".` });
        }

        await pool.execute(
            `INSERT INTO prefix_command_aliases (guild_id, alias, command_name, created_by)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE command_name = VALUES(command_name)`,
            [guildId, alias.toLowerCase(), command_name.toLowerCase(), req.user?.id || null]
        );

        invalidateGuildCache(guildId);
        res.json({ success: true });
    } catch (error) {
        logger.error('[API PrefixCmd] Error adding alias:', { error: error.message });
        res.status(500).json({ error: 'Failed to add alias' });
    }
});

// DELETE alias
router.delete('/aliases/:alias', async (req, res) => {
    try {
        const { guildId, alias } = req.params;
        await pool.execute(
            'DELETE FROM prefix_command_aliases WHERE guild_id = ? AND alias = ?',
            [guildId, alias.toLowerCase()]
        );
        invalidateGuildCache(guildId);
        res.json({ success: true });
    } catch (error) {
        logger.error('[API PrefixCmd] Error removing alias:', { error: error.message });
        res.status(500).json({ error: 'Failed to remove alias' });
    }
});

// PUT disable command
router.put('/commands/:command/disable', async (req, res) => {
    try {
        const { guildId, command } = req.params;
        const [rows] = await pool.execute(
            'SELECT disabled_commands FROM prefix_command_config WHERE guild_id = ?',
            [guildId]
        );

        let disabled = rows[0]?.disabled_commands ? JSON.parse(rows[0].disabled_commands) : [];
        if (!disabled.includes(command)) disabled.push(command);

        await pool.execute(
            `INSERT INTO prefix_command_config (guild_id, disabled_commands)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE disabled_commands = VALUES(disabled_commands)`,
            [guildId, JSON.stringify(disabled)]
        );

        invalidateGuildCache(guildId);
        res.json({ success: true });
    } catch (error) {
        logger.error('[API PrefixCmd] Error disabling command:', { error: error.message });
        res.status(500).json({ error: 'Failed to disable command' });
    }
});

// PUT enable command
router.put('/commands/:command/enable', async (req, res) => {
    try {
        const { guildId, command } = req.params;
        const [rows] = await pool.execute(
            'SELECT disabled_commands FROM prefix_command_config WHERE guild_id = ?',
            [guildId]
        );

        let disabled = rows[0]?.disabled_commands ? JSON.parse(rows[0].disabled_commands) : [];
        disabled = disabled.filter(c => c !== command);

        await pool.execute(
            'UPDATE prefix_command_config SET disabled_commands = ? WHERE guild_id = ?',
            [JSON.stringify(disabled), guildId]
        );

        invalidateGuildCache(guildId);
        res.json({ success: true });
    } catch (error) {
        logger.error('[API PrefixCmd] Error enabling command:', { error: error.message });
        res.status(500).json({ error: 'Failed to enable command' });
    }
});

// GET available commands (for dashboard UI to populate dropdowns)
router.get('/available', async (req, res) => {
    const commands = getAllCommands();
    const categories = getCategories();
    res.json({ success: true, commands, categories });
});

/**
 * Every command reachable from chat: the auto-indexed slash paths plus their
 * built-in shortcuts. Powers the dashboard's command browser and alias picker.
 */
router.get('/slash-commands', async (req, res) => {
    try {
        const paths = listCommandPaths();
        const byCategory = {};
        for (const p of paths) (byCategory[p.category] ??= []).push(p);
        res.json({
            success: true,
            total: paths.length,
            categories: Object.keys(byCategory).sort(),
            commands: paths,
        });
    } catch (error) {
        logger.error('[API PrefixCmd] Error listing slash commands:', { error: error.message });
        res.status(500).json({ error: 'Failed to list commands' });
    }
});

export default router;
