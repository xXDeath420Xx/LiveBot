/**
 * Minigames API — `/api/guilds/:guildId/minigames/*`
 *
 * Cat Bot, Grow a Tree and Timezones are all inert until a guild opts in, which until now
 * could only be done from chat. Each is a single config row.
 */
import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';

const router = express.Router({ mergeParams: true });
const SNOWFLAKE = /^\d{15,25}$/;

router.get('/', async (req, res) => {
    const g = req.params.guildId;
    try {
        const [catChannels, [[tree]], [[tz]], [[settings]]] = await Promise.all([
            pool.execute('SELECT channel_id, enabled, spawn_min, spawn_max FROM catbot_channels WHERE guild_id = ?', [g])
                .then(([rows]) => rows),
            pool.execute('SELECT guild_id, size, name FROM gat_trees WHERE guild_id = ?', [g]),
            pool.execute('SELECT * FROM tz_guild_config WHERE guild_id = ?', [g]),
            pool.execute('SELECT * FROM catbot_settings WHERE guild_id = ?', [g]),
        ]);

        const guild = req.botClient?.guilds?.cache?.get(g);
        res.json({
            catbot: {
                enabled: catChannels.some(c => c.enabled),
                channels: catChannels.map(c => ({
                    ...c,
                    enabled: !!c.enabled,
                    channel_name: guild?.channels?.cache?.get(c.channel_id)?.name ?? null,
                })),
                settings: settings || null,
            },
            growtree: { planted: !!tree, tree: tree || null },
            timezone: { enabled: !!tz?.enabled, config: tz || null },
        });
    } catch (err) {
        logger.error(`[API minigames] get failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to load minigame settings' });
    }
});

/** Start (or stop) cat spawns in a channel. */
router.post('/catbot', async (req, res) => {
    const { channel_id, enabled } = req.body || {};
    if (!SNOWFLAKE.test(String(channel_id || ''))) return res.status(400).json({ error: 'Pick a channel.' });

    try {
        const { setupChannel, forgetChannel, scheduleRespawn } = await import('../../../../core/catbot/spawn-manager.js');
        if (enabled === false) {
            await forgetChannel(channel_id);
            return res.json({ success: true, enabled: false });
        }
        await setupChannel(req.params.guildId, channel_id);
        await scheduleRespawn(channel_id);
        res.json({ success: true, enabled: true });
    } catch (err) {
        logger.error(`[API minigames] catbot failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to update Cat Bot' });
    }
});

router.put('/catbot/timings', async (req, res) => {
    const { channel_id, spawn_min, spawn_max } = req.body || {};
    const min = Number(spawn_min), max = Number(spawn_max);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 20 || max < min) {
        return res.status(400).json({ error: 'Timings must be whole seconds, at least 20, and max ≥ min.' });
    }
    try {
        const [r] = await pool.execute(
            'UPDATE catbot_channels SET spawn_min = ?, spawn_max = ? WHERE guild_id = ? AND channel_id = ?',
            [min, max, req.params.guildId, channel_id]);
        if (!r.affectedRows) return res.status(404).json({ error: 'Cats do not spawn in that channel.' });
        res.json({ success: true });
    } catch (err) {
        logger.error(`[API minigames] timings failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to save timings' });
    }
});

router.post('/timezone', async (req, res) => {
    try {
        const enabled = req.body?.enabled ? 1 : 0;
        await pool.execute(
            `INSERT INTO tz_guild_config (guild_id, enabled, auto_detect) VALUES (?, ?, 'react')
             ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`, [req.params.guildId, enabled]);
        res.json({ success: true, enabled: !!enabled });
    } catch (err) {
        logger.error(`[API minigames] timezone failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to toggle timezones' });
    }
});

export default router;
