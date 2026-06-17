// Content feeds API (Reddit / YouTube / Twitter / Bluesky).
// Mounted at /api/guilds/:guildId/feeds by the main API router.

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';

const router = express.Router({ mergeParams: true });

// ─────────────── REDDIT ───────────────
router.post('/reddit', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { subreddit } = req.body;
        const channelId = req.body.channel_id || req.body.discord_channel_id;
        if (!subreddit || !channelId) return res.status(400).json({ error: 'Missing required fields: subreddit, channel_id' });
        const clean = subreddit.trim().replace(/^r\//, '');
        await pool.execute(
            'INSERT INTO reddit_feeds (guild_id, subreddit, channel_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id)',
            [guildId, clean, channelId]
        );
        logger.info(`[API Feeds] Reddit r/${clean} → ${channelId} in ${guildId}`);
        res.json({ success: true, subreddit: clean, channel_id: channelId });
    } catch (e) {
        logger.error('[API Feeds] reddit add error', { err: e.message });
        res.status(500).json({ error: 'Failed to add Reddit feed' });
    }
});

router.delete('/reddit/:id', async (req, res) => {
    try {
        await pool.execute('DELETE FROM reddit_feeds WHERE id = ? AND guild_id = ?', [req.params.id, req.params.guildId]);
        res.json({ success: true });
    } catch (e) {
        logger.error('[API Feeds] reddit delete error', { err: e.message });
        res.status(500).json({ error: 'Failed to remove Reddit feed' });
    }
});

// ─────────────── YOUTUBE ───────────────
router.post('/youtube', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { youtube_channel_id } = req.body; // may be a URL, @handle, or UC… id
        const discordChannelId = req.body.discord_channel_id || req.body.channel_id;
        if (!youtube_channel_id || !discordChannelId) return res.status(400).json({ error: 'Missing required fields: youtube_channel_id, discord_channel_id' });

        // Accept any YouTube URL / @handle and resolve to the canonical UC… id the feed needs.
        const { resolveYouTubeChannelId } = await import('../../../../utils/platforms/youtube-resolve.js');
        let ucId;
        try {
            ({ channelId: ucId } = await resolveYouTubeChannelId(youtube_channel_id));
        } catch (resolveErr) {
            return res.status(400).json({ error: resolveErr.message });
        }

        await pool.execute(
            'INSERT INTO youtube_feeds (guild_id, youtube_channel_id, discord_channel_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE discord_channel_id = VALUES(discord_channel_id)',
            [guildId, ucId, discordChannelId]
        );
        logger.info(`[API Feeds] YouTube ${youtube_channel_id} → ${ucId} → ${discordChannelId} in ${guildId}`);
        res.json({ success: true, youtube_channel_id: ucId });
    } catch (e) {
        logger.error('[API Feeds] youtube add error', { err: e.message });
        res.status(500).json({ error: 'Failed to add YouTube feed' });
    }
});

router.delete('/youtube/:id', async (req, res) => {
    try {
        await pool.execute('DELETE FROM youtube_feeds WHERE id = ? AND guild_id = ?', [req.params.id, req.params.guildId]);
        res.json({ success: true });
    } catch (e) {
        logger.error('[API Feeds] youtube delete error', { err: e.message });
        res.status(500).json({ error: 'Failed to remove YouTube feed' });
    }
});

// ─────────────── TWITTER ───────────────
router.post('/twitter', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { twitter_username } = req.body;
        const channelId = req.body.channel_id || req.body.discord_channel_id;
        if (!twitter_username || !channelId) return res.status(400).json({ error: 'Missing required fields: twitter_username, channel_id' });
        const clean = twitter_username.trim().replace(/^@/, '');
        await pool.execute(
            'INSERT INTO twitter_feeds (guild_id, twitter_username, channel_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id)',
            [guildId, clean, channelId]
        );
        logger.info(`[API Feeds] Twitter @${clean} → ${channelId} in ${guildId}`);
        res.json({ success: true, twitter_username: clean, channel_id: channelId });
    } catch (e) {
        logger.error('[API Feeds] twitter add error', { err: e.message });
        res.status(500).json({ error: 'Failed to add Twitter feed' });
    }
});

router.delete('/twitter/:id', async (req, res) => {
    try {
        await pool.execute('DELETE FROM twitter_feeds WHERE id = ? AND guild_id = ?', [req.params.id, req.params.guildId]);
        res.json({ success: true });
    } catch (e) {
        logger.error('[API Feeds] twitter delete error', { err: e.message });
        res.status(500).json({ error: 'Failed to remove Twitter feed' });
    }
});

// ─────────────── BLUESKY ───────────────
router.post('/bluesky', async (req, res) => {
    try {
        const { guildId } = req.params;
        let { bluesky_handle } = req.body;
        const channelId = req.body.channel_id || req.body.discord_channel_id;
        if (!bluesky_handle || !channelId) return res.status(400).json({ error: 'Missing required fields: bluesky_handle, channel_id' });
        bluesky_handle = bluesky_handle.trim().replace(/^@/, '').replace(/^https?:\/\/bsky\.app\/profile\//, '');

        const { getProfile } = await import('../../../../utils/platforms/bluesky.js');
        const profile = await getProfile(bluesky_handle);
        if (!profile) return res.status(404).json({ error: `Bluesky handle @${bluesky_handle} not found` });

        await pool.execute(
            'INSERT INTO bluesky_feeds (guild_id, bluesky_handle, channel_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id)',
            [guildId, bluesky_handle, channelId]
        );
        logger.info(`[API Feeds] Bluesky @${bluesky_handle} → ${channelId} in ${guildId}`);
        res.json({ success: true, bluesky_handle, channel_id: channelId, displayName: profile.displayName });
    } catch (e) {
        logger.error('[API Feeds] bluesky add error', { err: e.message });
        res.status(500).json({ error: 'Failed to add Bluesky feed' });
    }
});

router.delete('/bluesky/:id', async (req, res) => {
    try {
        await pool.execute('DELETE FROM bluesky_feeds WHERE id = ? AND guild_id = ?', [req.params.id, req.params.guildId]);
        res.json({ success: true });
    } catch (e) {
        logger.error('[API Feeds] bluesky delete error', { err: e.message });
        res.status(500).json({ error: 'Failed to remove Bluesky feed' });
    }
});

export default router;
