/**
 * Commands API
 * Handles per-guild command restriction management
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import configCache from '../../../../utils/configCache.js';

const router = express.Router({ mergeParams: true });

/**
 * GET /api/guilds/:guildId/commands/restrictions
 * Get all command restrictions for a guild
 */
router.get('/restrictions', async (req, res) => {
    try {
        const { guildId } = req.params;

        const [rows] = await pool.execute(
            'SELECT command_name, allowed, admin_only FROM guild_command_restrictions WHERE guild_id = ?',
            [guildId]
        );

        // Build a map: command_name -> { allowed, admin_only }
        const restrictions = {};
        rows.forEach(row => {
            restrictions[row.command_name] = {
                allowed: row.allowed === 1,
                admin_only: row.admin_only === 1
            };
        });

        res.json({ success: true, restrictions });
    } catch (error) {
        logger.error('[API Commands Restrictions GET] Error:', error);
        res.status(500).json({ error: 'Failed to fetch command restrictions' });
    }
});

/**
 * PUT /api/guilds/:guildId/commands/restrictions
 * Bulk update command restrictions
 * Body: { restrictions: [{ command_name, allowed, admin_only }] }
 */
router.put('/restrictions', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { restrictions } = req.body;

        if (!Array.isArray(restrictions)) {
            return res.status(400).json({ error: 'restrictions must be an array' });
        }

        // Clear existing restrictions for this guild, then insert new ones
        await pool.execute(
            'DELETE FROM guild_command_restrictions WHERE guild_id = ?',
            [guildId]
        );

        // Only insert non-default restrictions (allowed=1, admin_only=0 is default, no row needed)
        for (const r of restrictions) {
            if (!r.command_name) continue;

            const allowed = r.allowed ? 1 : 0;
            const adminOnly = r.admin_only ? 1 : 0;

            // Skip default state (everyone allowed, not admin-only) — no row needed
            if (allowed === 1 && adminOnly === 0) continue;

            await pool.execute(`
                INSERT INTO guild_command_restrictions (guild_id, command_name, allowed, admin_only)
                VALUES (?, ?, ?, ?)
            `, [guildId, r.command_name, allowed, adminOnly]);
        }

        // Invalidate configCache for all commands in this guild
        for (const r of restrictions) {
            if (r.command_name) {
                configCache.invalidate('cmd_restrict', `${guildId}:${r.command_name}`);
            }
        }

        res.json({ success: true, message: 'Command restrictions updated' });
    } catch (error) {
        logger.error('[API Commands Restrictions PUT] Error:', error);
        res.status(500).json({ error: 'Failed to update command restrictions' });
    }
});

export default router;
