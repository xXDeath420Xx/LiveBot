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
            dm_on_already_tracked: true,
            announce_gate_enabled: false,
            announce_min_level: 1,
            announce_required_role_ids: [],
            announce_delete_unauthorized: true,
        };

        // Parse JSON fields if stored as strings
        if (config.allowed_platforms && typeof config.allowed_platforms === 'string') {
            try { config.allowed_platforms = JSON.parse(config.allowed_platforms); } catch { config.allowed_platforms = []; }
        }
        if (config.announce_required_role_ids && typeof config.announce_required_role_ids === 'string') {
            try { config.announce_required_role_ids = JSON.parse(config.announce_required_role_ids); } catch { config.announce_required_role_ids = []; }
        }
        if (!Array.isArray(config.announce_required_role_ids)) {
            config.announce_required_role_ids = [];
        }

        res.json({ success: true, config });
    } catch (error) {
        logger.error('[API Self-Promo Config GET] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch self-promo config' });
    }
});

const SNOWFLAKE_RE = /^\d{17,20}$/;

// PUT /api/guilds/:guildId/self-promo/config
router.put('/:guildId/self-promo/config', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const body = req.body || {};

        // Read existing row so partial updates don't clobber unspecified fields.
        const [existingRows] = await pool.execute(
            'SELECT * FROM self_promo_config WHERE guild_id = ?',
            [req.guildId]
        );
        const existing = existingRows[0] || {};

        const has = key => Object.prototype.hasOwnProperty.call(body, key);

        const enabled = has('enabled') ? (body.enabled ? 1 : 0) : (existing.enabled ?? 0);
        const channel_id = has('channel_id') ? (body.channel_id || null) : (existing.channel_id ?? null);
        const auto_subscribe = has('auto_subscribe') ? (body.auto_subscribe ? 1 : 0) : (existing.auto_subscribe ?? 1);
        const delete_invalid = has('delete_invalid') ? (body.delete_invalid ? 1 : 0) : (existing.delete_invalid ?? 1);
        // keep_message = a real self-promo channel: the member's post stays up and nothing is
        // deleted. Auto-tracking still runs, confirmed by a reaction + DM instead.
        const keep_message = has('keep_message') ? (body.keep_message ? 1 : 0) : (existing.keep_message ?? 0);
        const dm_on_track = has('dm_on_track') ? (body.dm_on_track ? 1 : 0) : (existing.dm_on_track ?? 1);
        const dm_on_already_tracked = has('dm_on_already_tracked') ? (body.dm_on_already_tracked ? 1 : 0) : (existing.dm_on_already_tracked ?? 1);
        const same_channel = has('same_channel') ? (body.same_channel ? 1 : 0) : (existing.same_channel ?? 0);
        const announcement_channel_id = has('announcement_channel_id') ? (body.announcement_channel_id || null) : (existing.announcement_channel_id ?? null);

        let allowed_platforms;
        if (has('allowed_platforms')) {
            allowed_platforms = Array.isArray(body.allowed_platforms)
                ? JSON.stringify(body.allowed_platforms)
                : (body.allowed_platforms || '["twitch","kick","youtube"]');
        } else {
            allowed_platforms = existing.allowed_platforms || '["twitch","kick","youtube"]';
        }

        // Announce-channel gate fields
        const announce_gate_enabled = has('announce_gate_enabled')
            ? (body.announce_gate_enabled ? 1 : 0)
            : (existing.announce_gate_enabled ?? 0);

        let announce_min_level;
        if (has('announce_min_level')) {
            const parsed = Number.parseInt(body.announce_min_level, 10);
            if (!Number.isFinite(parsed) || parsed < 0 || parsed > 200) {
                return res.status(400).json({ error: 'announce_min_level must be an integer between 0 and 200' });
            }
            announce_min_level = parsed;
        } else {
            announce_min_level = existing.announce_min_level ?? 1;
        }

        let announce_required_role_ids;
        if (has('announce_required_role_ids')) {
            const arr = Array.isArray(body.announce_required_role_ids) ? body.announce_required_role_ids : [];
            for (const id of arr) {
                if (typeof id !== 'string' || !SNOWFLAKE_RE.test(id)) {
                    return res.status(400).json({ error: `Invalid role ID in announce_required_role_ids: ${id}` });
                }
            }
            announce_required_role_ids = arr.length > 0 ? JSON.stringify(arr) : null;
        } else {
            announce_required_role_ids = existing.announce_required_role_ids ?? null;
        }

        const announce_delete_unauthorized = has('announce_delete_unauthorized')
            ? (body.announce_delete_unauthorized ? 1 : 0)
            : (existing.announce_delete_unauthorized ?? 1);

        await pool.execute(`
            INSERT INTO self_promo_config (
                guild_id, enabled, channel_id, allowed_platforms,
                auto_subscribe, delete_invalid, keep_message, dm_on_track, dm_on_already_tracked,
                same_channel, announcement_channel_id,
                announce_gate_enabled, announce_min_level, announce_required_role_ids, announce_delete_unauthorized
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                enabled = VALUES(enabled),
                channel_id = VALUES(channel_id),
                allowed_platforms = VALUES(allowed_platforms),
                auto_subscribe = VALUES(auto_subscribe),
                delete_invalid = VALUES(delete_invalid),
                keep_message = VALUES(keep_message),
                dm_on_track = VALUES(dm_on_track),
                dm_on_already_tracked = VALUES(dm_on_already_tracked),
                same_channel = VALUES(same_channel),
                announcement_channel_id = VALUES(announcement_channel_id),
                announce_gate_enabled = VALUES(announce_gate_enabled),
                announce_min_level = VALUES(announce_min_level),
                announce_required_role_ids = VALUES(announce_required_role_ids),
                announce_delete_unauthorized = VALUES(announce_delete_unauthorized)
        `, [
            req.guildId,
            enabled,
            channel_id,
            allowed_platforms,
            auto_subscribe,
            delete_invalid,
            keep_message,
            dm_on_track,
            dm_on_already_tracked,
            same_channel,
            announcement_channel_id,
            announce_gate_enabled,
            announce_min_level,
            announce_required_role_ids,
            announce_delete_unauthorized,
        ]);

        invalidateSelfPromoConfig(req.guildId);

        res.json({ success: true, message: 'Self-promo config updated' });
    } catch (error) {
        logger.error('[API Self-Promo Config PUT] Error:', { error: error.message, stack: error.stack });
        res.status(500).json({ error: 'Failed to update self-promo config' });
    }
});

export default router;
