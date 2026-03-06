import express from 'express';
import pool from '../../../utils/db.js';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';
import { invalidateSelfPromoConfig } from '../../../core/self-promo-handler.js';

const router = express.Router();

// GET /api/guilds/:guildId/self-promo/config
router.get('/:guildId/self-promo/config', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT * FROM self_promo_config WHERE guild_id = ?',
            [req.guildId]
        );

        const config = rows[0] || {
            guild_id: req.guildId,
            enabled: false,
            channel_id: null,
            allowed_platforms: ['twitch', 'kick', 'youtube'],
            auto_subscribe: true,
            delete_invalid: true,
            dm_on_track: true,
            dm_on_already_tracked: true
        };

        // Parse JSON field if string
        if (config.allowed_platforms && typeof config.allowed_platforms === 'string') {
            try { config.allowed_platforms = JSON.parse(config.allowed_platforms); } catch { config.allowed_platforms = []; }
        }

        res.json({ success: true, config });
    } catch (error) {
        logger.error('[API Self-Promo Config GET] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch self-promo config' });
    }
});

// PUT /api/guilds/:guildId/self-promo/config
router.put('/:guildId/self-promo/config', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const { enabled, channel_id, allowed_platforms, auto_subscribe, delete_invalid, dm_on_track, dm_on_already_tracked } = req.body;

        const platformsJson = Array.isArray(allowed_platforms) ? JSON.stringify(allowed_platforms) : (allowed_platforms || '["twitch","kick","youtube"]');

        await pool.execute(`
            INSERT INTO self_promo_config (guild_id, enabled, channel_id, allowed_platforms, auto_subscribe, delete_invalid, dm_on_track, dm_on_already_tracked)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled), channel_id = VALUES(channel_id),
                allowed_platforms = VALUES(allowed_platforms), auto_subscribe = VALUES(auto_subscribe),
                delete_invalid = VALUES(delete_invalid), dm_on_track = VALUES(dm_on_track),
                dm_on_already_tracked = VALUES(dm_on_already_tracked)
        `, [
            req.guildId,
            enabled ? 1 : 0,
            channel_id || null,
            platformsJson,
            auto_subscribe !== false ? 1 : 0,
            delete_invalid !== false ? 1 : 0,
            dm_on_track !== false ? 1 : 0,
            dm_on_already_tracked !== false ? 1 : 0
        ]);

        invalidateSelfPromoConfig(req.guildId);

        res.json({ success: true, message: 'Self-promo config updated' });
    } catch (error) {
        logger.error('[API Self-Promo Config PUT] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to update self-promo config' });
    }
});

export default router;
