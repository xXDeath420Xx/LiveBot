/**
 * Free Games API
 * Handles free game notification subscriptions
 */

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';

const router = express.Router({ mergeParams: true });

/**
 * GET /api/guilds/:guildId/free-games
 * Get all free game subscriptions for a guild
 */
router.get('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [subs] = await pool.execute(
            'SELECT * FROM free_games_subscriptions WHERE guild_id = ? ORDER BY created_at DESC',
            [guildId]
        );
        res.json({ success: true, subscriptions: subs });
    } catch (error) {
        logger.error('[API Free Games GET] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch subscriptions' });
    }
});

/**
 * POST /api/guilds/:guildId/free-games
 * Add a new free game subscription
 */
router.post('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { channel_id, mention_role_id, custom_message } = req.body;

        if (!channel_id) {
            return res.status(400).json({ error: 'Channel is required' });
        }

        // Check for existing subscription on this channel
        const [existing] = await pool.execute(
            'SELECT id FROM free_games_subscriptions WHERE guild_id = ? AND discord_channel_id = ?',
            [guildId, channel_id]
        );

        if (existing.length > 0) {
            return res.status(409).json({ error: 'A subscription already exists for this channel' });
        }

        await pool.execute(
            `INSERT INTO free_games_subscriptions (
                guild_id, discord_channel_id, mention_role_id, custom_message,
                notify_free, notify_weekend, notify_dlc,
                filter_steam, filter_epic, filter_gog, filter_humble, filter_prime,
                filter_windows, is_enabled
            ) VALUES (?, ?, ?, ?, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1)`,
            [guildId, channel_id, mention_role_id || null, custom_message || null]
        );

        res.json({ success: true, message: 'Subscription added' });
    } catch (error) {
        logger.error('[API Free Games POST] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to add subscription' });
    }
});

/**
 * PATCH /api/guilds/:guildId/free-games/:subId
 * Toggle enabled/disabled
 */
router.patch('/:subId', async (req, res) => {
    try {
        const { guildId, subId } = req.params;
        const { is_enabled } = req.body;

        const [result] = await pool.execute(
            'UPDATE free_games_subscriptions SET is_enabled = ? WHERE id = ? AND guild_id = ?',
            [is_enabled ? 1 : 0, subId, guildId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Subscription not found' });
        }

        res.json({ success: true, message: 'Subscription updated' });
    } catch (error) {
        logger.error('[API Free Games PATCH] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to update subscription' });
    }
});

/**
 * PUT /api/guilds/:guildId/free-games/:subId/filters
 * Update subscription filters
 */
router.put('/:subId/filters', async (req, res) => {
    try {
        const { guildId, subId } = req.params;
        const {
            notify_free, notify_weekend, notify_dlc,
            filter_steam, filter_epic, filter_gog, filter_humble, filter_prime,
            filter_windows, filter_mac, filter_linux
        } = req.body;

        const [result] = await pool.execute(
            `UPDATE free_games_subscriptions SET
                notify_free = ?, notify_weekend = ?, notify_dlc = ?,
                filter_steam = ?, filter_epic = ?, filter_gog = ?, filter_humble = ?, filter_prime = ?,
                filter_windows = ?, filter_mac = ?, filter_linux = ?
            WHERE id = ? AND guild_id = ?`,
            [
                notify_free ? 1 : 0, notify_weekend ? 1 : 0, notify_dlc ? 1 : 0,
                filter_steam ? 1 : 0, filter_epic ? 1 : 0, filter_gog ? 1 : 0, filter_humble ? 1 : 0, filter_prime ? 1 : 0,
                filter_windows ? 1 : 0, filter_mac ? 1 : 0, filter_linux ? 1 : 0,
                subId, guildId
            ]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Subscription not found' });
        }

        res.json({ success: true, message: 'Filters updated' });
    } catch (error) {
        logger.error('[API Free Games PUT filters] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to update filters' });
    }
});

/**
 * DELETE /api/guilds/:guildId/free-games/:subId
 * Remove a subscription
 */
router.delete('/:subId', async (req, res) => {
    try {
        const { guildId, subId } = req.params;

        const [result] = await pool.execute(
            'DELETE FROM free_games_subscriptions WHERE id = ? AND guild_id = ?',
            [subId, guildId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Subscription not found' });
        }

        res.json({ success: true, message: 'Subscription removed' });
    } catch (error) {
        logger.error('[API Free Games DELETE] Error:', { error: error.message });
        res.status(500).json({ error: 'Failed to remove subscription' });
    }
});

export default router;
