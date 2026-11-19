import express from 'express';
import pool from '../../../utils/db.js';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';
import {
    getStreamEndDefaults,
    setStreamEndDefaults,
    applyStreamEndDefaultsToExisting,
} from '../../../core/stream-end-defaults.js';

const router = express.Router();

// GET /api/guilds/:guildId/stream-ended/defaults
// The guild-wide answer new subscriptions inherit.
router.get('/:guildId/stream-ended/defaults', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const defaults = await getStreamEndDefaults(req.guildId);
        res.json({ success: true, defaults });
    } catch (error) {
        logger.error('[API Stream-Ended Defaults GET] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to load defaults' });
    }
});

// PUT /api/guilds/:guildId/stream-ended/defaults
// Body: { edit_on_end, delete_on_end, apply_to_existing? }
router.put('/:guildId/stream-ended/defaults', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const { edit_on_end, delete_on_end, apply_to_existing } = req.body;

        // edit_on_end wins over delete_on_end at cleanup time, so "keep on end"
        // (delete_on_end = 0) is only meaningful with edit off. Normalise here
        // rather than storing a pair that reads one way and behaves another.
        const edit = edit_on_end ? 1 : 0;
        const del = edit ? 1 : (delete_on_end ? 1 : 0);

        const defaults = await setStreamEndDefaults(req.guildId, {
            edit_on_end: edit,
            delete_on_end: del,
        });

        let applied = 0;
        if (apply_to_existing) {
            applied = await applyStreamEndDefaultsToExisting(req.guildId);
        }

        res.json({ success: true, defaults, applied });
    } catch (error) {
        logger.error('[API Stream-Ended Defaults PUT] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to save defaults' });
    }
});

// POST /api/guilds/:guildId/stream-ended/defaults/apply
// Push the saved defaults onto every existing subscription. Deliberately separate
// from the save above — it overwrites per-streamer choices.
router.post('/:guildId/stream-ended/defaults/apply', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const applied = await applyStreamEndDefaultsToExisting(req.guildId);
        res.json({ success: true, applied, message: `Applied to ${applied} subscription${applied === 1 ? '' : 's'}` });
    } catch (error) {
        logger.error('[API Stream-Ended Defaults APPLY] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to apply defaults' });
    }
});

// GET /api/guilds/:guildId/stream-ended/subscriptions
router.get('/:guildId/stream-ended/subscriptions', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT sub.subscription_id, s.username, s.platform, sub.edit_on_end, sub.delete_on_end,
                   COALESCE(sub.announcement_channel_id, ts.announcement_channel_id, gc.announcement_channel_id) AS channel_id
            FROM subscriptions sub
            JOIN streamers s ON sub.streamer_id = s.streamer_id
            LEFT JOIN twitch_teams ts ON sub.team_subscription_id = ts.id
            LEFT JOIN guild_config gc ON sub.guild_id COLLATE utf8mb4_unicode_ci = gc.guild_id COLLATE utf8mb4_unicode_ci
            WHERE sub.guild_id = ?
            ORDER BY sub.edit_on_end DESC, s.username
        `, [req.guildId]);

        res.json({ success: true, subscriptions: rows });
    } catch (error) {
        logger.error('[API Stream-Ended Subscriptions GET] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch subscriptions' });
    }
});

// PATCH /api/guilds/:guildId/stream-ended/subscriptions/bulk
// Must be defined before :subId route so "bulk" isn't caught as a param
router.patch('/:guildId/stream-ended/subscriptions/bulk', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const { subscription_ids, edit_on_end } = req.body;

        if (!Array.isArray(subscription_ids) || subscription_ids.length === 0) {
            return res.status(400).json({ error: 'subscription_ids array is required' });
        }

        const placeholders = subscription_ids.map(() => '?').join(',');
        const [result] = await pool.execute(
            `UPDATE subscriptions SET edit_on_end = ? WHERE subscription_id IN (${placeholders}) AND guild_id = ?`,
            [edit_on_end ? 1 : 0, ...subscription_ids, req.guildId]
        );

        res.json({ success: true, message: `Updated ${result.affectedRows} subscriptions` });
    } catch (error) {
        logger.error('[API Stream-Ended Bulk PATCH] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to bulk update subscriptions' });
    }
});

// PATCH /api/guilds/:guildId/stream-ended/subscriptions/:subId
router.patch('/:guildId/stream-ended/subscriptions/:subId', ensureAuth, ensureGuildPerms, async (req, res) => {
    try {
        const { edit_on_end } = req.body;

        const [result] = await pool.execute(
            'UPDATE subscriptions SET edit_on_end = ? WHERE subscription_id = ? AND guild_id = ?',
            [edit_on_end ? 1 : 0, req.params.subId, req.guildId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Subscription not found' });
        }

        res.json({ success: true, message: 'edit_on_end updated' });
    } catch (error) {
        logger.error('[API Stream-Ended Subscription PATCH] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to update subscription' });
    }
});

export default router;
