/**
 * Twitch Clips API — the dashboard side of `/alerts clips`.
 *
 * Thin wrapper over core/twitch-clip-feeds.js; the watermark rules (posted_from moves to
 * NOW() on create, resume, and streamer change) live there so both front ends agree.
 */

import express from 'express';
import logger from '../../../../utils/logger.js';
import {
    listFeeds, createFeed, updateFeed, deleteFeed, previewFeed, ClipFeedError,
} from '../../../../core/twitch-clip-feeds.js';

const router = express.Router({ mergeParams: true });

/** The bot that will actually post here — custom-bot guilds are invisible to the main client. */
function postingClient(req) {
    return global.botManager?.getClientForGuild?.(req.params.guildId) || req.botClient || null;
}

function fail(res, error, tag) {
    if (error instanceof ClipFeedError) return res.status(error.status).json({ error: error.message });
    logger.error(`[API TwitchClips ${tag}] Error:`, { error: error.message });
    return res.status(500).json({ error: 'Something went wrong' });
}

router.get('/', async (req, res) => {
    try {
        res.json({ success: true, feeds: await listFeeds(req.params.guildId) });
    } catch (error) { fail(res, error, 'GET'); }
});

router.post('/', async (req, res) => {
    try {
        const b = req.body || {};
        const feed = await createFeed({
            guildId: req.params.guildId,
            channelId: b.channel_id,
            streamer: b.streamer,
            creatorsFilter: b.creators_filter || 'anyone',
            minViews: b.min_views || 0,
            pingRoleId: b.ping_role_id || null,
            client: postingClient(req),
        });
        res.json({ success: true, id: feed.id, message: `Posting ${feed.display_name}'s new clips` });
    } catch (error) { fail(res, error, 'POST'); }
});

router.patch('/:id', async (req, res) => {
    try {
        const b = req.body || {};
        const changes = {};
        if (b.enabled !== undefined) changes.enabled = !!b.enabled;
        if (b.channel_id !== undefined) changes.channelId = b.channel_id;
        if (b.streamer !== undefined) changes.streamer = b.streamer;
        if (b.creators_filter !== undefined) changes.creatorsFilter = b.creators_filter;
        if (b.min_views !== undefined) changes.minViews = b.min_views;
        if (b.ping_role_id !== undefined) changes.pingRoleId = b.ping_role_id;

        const { watermarkMoved } = await updateFeed(req.params.guildId, req.params.id, changes, { client: postingClient(req) });
        res.json({
            success: true,
            message: watermarkMoved ? 'Saved. It counts from now, so earlier clips will not be posted.' : 'Saved',
        });
    } catch (error) { fail(res, error, 'PATCH'); }
});

router.delete('/:id', async (req, res) => {
    try {
        await deleteFeed(req.params.guildId, req.params.id);
        res.json({ success: true, message: 'Feed removed' });
    } catch (error) { fail(res, error, 'DELETE'); }
});

/** What the feed sees right now, without posting anything. */
router.post('/:id/preview', async (req, res) => {
    try {
        res.json({ success: true, ...(await previewFeed(req.params.guildId, req.params.id)) });
    } catch (error) { fail(res, error, 'PREVIEW'); }
});

export default router;
