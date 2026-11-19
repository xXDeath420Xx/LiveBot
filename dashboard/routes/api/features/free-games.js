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
                filter_steam, filter_epic, filter_gog, filter_prime,
                filter_windows, is_enabled
            ) VALUES (?, ?, ?, ?, 1, 0, 0, 1, 1, 1, 1, 1, 1)`,
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
        const b = req.body || {};
        // Pause/resume, and since 2026-11-18 the channel, role and message (the page's Edit dialog).
        const sets = [];
        const args = [];
        const guild = req.botClient?.guilds?.cache?.get(guildId)
            || global.botManager?.getClientForGuild?.(guildId)?.guilds?.cache?.get(guildId) || null;
        if (b.is_enabled !== undefined) { sets.push('is_enabled = ?'); args.push(b.is_enabled ? 1 : 0); }
        if (b.channel_id !== undefined) {
            const id = String(b.channel_id || '');
            const ch = guild?.channels?.cache?.get(id);
            if (!/^\d{15,25}$/.test(id) || (guild && (!ch || !ch.isTextBased?.()))) {
                return res.status(400).json({ error: 'Choose a text channel in this server' });
            }
            const [dupe] = await pool.execute(
                'SELECT id FROM free_games_subscriptions WHERE guild_id = ? AND discord_channel_id = ? AND id <> ?',
                [guildId, id, subId]);
            if (dupe.length) return res.status(409).json({ error: 'Another subscription already posts in that channel' });
            sets.push('discord_channel_id = ?'); args.push(id);
        }
        if (b.mention_role_id !== undefined) {
            const role = b.mention_role_id ? String(b.mention_role_id) : null;
            if (role && (!/^\d{15,25}$/.test(role) || (guild && !guild.roles.cache.has(role)))) {
                return res.status(400).json({ error: 'That role is not in this server' });
            }
            sets.push('mention_role_id = ?'); args.push(role);
        }
        if (b.custom_message !== undefined) {
            const msg = String(b.custom_message ?? '').trim().slice(0, 200);
            sets.push('custom_message = ?'); args.push(msg || null);
        }
        if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });

        args.push(subId, guildId);
        const [result] = await pool.execute(
            `UPDATE free_games_subscriptions SET ${sets.join(', ')} WHERE id = ? AND guild_id = ?`,
            args
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

/**
 * Every toggle a subscription understands, grouped the way the page presents them.
 *
 * Kept as one list so the route, the UI and the schema cannot drift.
 *
 * ONLY OFFER WHAT A SCRAPER CAN ACTUALLY PRODUCE. The GamerPower aggregator was removed — its
 * links sent members to third-party giveaway sites that demand a sign-up or a download — and it
 * was the only source of Ubisoft, EA/Origin, itch.io, Humble, Battle.net, "other", every console
 * and mobile platform, and in-game loot. Those toggles are now unreachable by construction, so
 * they are no longer listed: a switch that cannot change what gets delivered is worse than a
 * missing one, because the server owner believes it did something. The columns stay in the
 * schema for the historic rows that carry them.
 */
export const SUBSCRIPTION_TOGGLES = {
    kinds: [
        ['notify_free', 'Free to keep', 'Games you claim and own permanently'],
        ['notify_weekend', 'Free weekends', 'Temporarily playable, not kept'],
        ['notify_dlc', 'DLC & expansions', 'Add-on content for games you own'],
        ['notify_prime', 'Prime Gaming', 'Requires an Amazon Prime subscription to claim'],
        ['notify_gamepass', 'Game Pass', 'Included with a Game Pass subscription'],
    ],
    stores: [
        ['filter_steam', 'Steam'],
        ['filter_epic', 'Epic Games'],
        ['filter_gog', 'GOG'],
        ['filter_prime', 'Prime Gaming'],
    ],
    platforms: [
        ['filter_windows', 'Windows'],
        ['filter_mac', 'macOS'],
        ['filter_linux', 'Linux'],
    ],
};

const ALL_TOGGLE_COLUMNS = Object.values(SUBSCRIPTION_TOGGLES).flat().map(([col]) => col);

/**
 * GET /api/guilds/:guildId/free-games/toggles
 * The toggle vocabulary, so the page renders from the schema rather than a hardcoded list.
 */
router.get('/toggles', (req, res) => {
    res.json({ success: true, toggles: SUBSCRIPTION_TOGGLES });
});

/**
 * PUT /api/guilds/:guildId/free-games/:subId/filters
 * Update subscription filters. Only columns actually present in the body are written, so a
 * partial update cannot silently reset toggles the caller did not mention.
 */
router.put('/:subId/filters', async (req, res) => {
    try {
        const { guildId, subId } = req.params;

        const present = ALL_TOGGLE_COLUMNS.filter(col => req.body[col] !== undefined);
        if (!present.length) {
            return res.status(400).json({ error: 'No recognised filters in request' });
        }

        const [result] = await pool.execute(
            `UPDATE free_games_subscriptions SET ${present.map(c => `${c} = ?`).join(', ')}
              WHERE id = ? AND guild_id = ?`,
            [...present.map(c => (req.body[c] ? 1 : 0)), subId, guildId]
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

/**
 * POST /api/guilds/:guildId/free-games/:subId/test
 * Posts the newest free game the bot has seen to the subscription's channel, built the same way as a
 * real alert (core/free-games-manager.js buildAnnouncementEmbed), marked as a test, without pinging the
 * role and without recording a delivery.
 */
router.post('/:subId/test', async (req, res) => {
    try {
        const { guildId, subId } = req.params;
        const [[sub]] = await pool.execute(
            'SELECT * FROM free_games_subscriptions WHERE id = ? AND guild_id = ?', [subId, guildId]);
        if (!sub) return res.status(404).json({ error: 'Subscription not found' });

        const client = global.botManager?.getClientForGuild?.(guildId) || req.botClient;
        const guild = client?.guilds?.cache?.get(guildId);
        const channel = guild?.channels?.cache?.get(sub.discord_channel_id);
        if (!channel || !channel.isTextBased?.()) {
            return res.status(400).json({ error: 'The bot cannot find that channel. Edit the subscription to pick another.' });
        }

        const [[product]] = await pool.execute('SELECT * FROM free_games_products ORDER BY id DESC LIMIT 1');
        const sample = product || {
            title: 'Sample Game', url: 'https://store.epicgames.com/', store: 'epic',
            description: 'A test post from the dashboard.', org_price_usd: 19.99,
        };
        const { default: FreeGamesManager } = await import('../../../../core/free-games-manager.js');
        const embed = FreeGamesManager.prototype.buildAnnouncementEmbed.call(null, { title: sample.title }, [sample]);

        let content = sub.custom_message || '🎮 **Free Game Alert!**';
        if (sub.mention_role_id) content = `<@&${sub.mention_role_id}> ${content}`;
        content = `${content}\n-# Test post from the dashboard. Nobody was pinged.`.slice(0, 2000);

        await channel.send({ content, embeds: [embed], allowedMentions: { parse: [] } });
        res.json({ success: true, title: sample.title, channel: channel.name });
    } catch (error) {
        logger.error('[API Free Games TEST] Error:', { error: error.message });
        res.status(500).json({ error: `Could not post the test: ${error.message}` });
    }
});

export default router;
