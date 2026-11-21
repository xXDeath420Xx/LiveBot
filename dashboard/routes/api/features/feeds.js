// Content feeds API (Reddit / YouTube / Twitter / Bluesky / RSS), plus the Post-to picker (GET /targets) and
// feed threads (POST /threads).
// Mounted at /api/guilds/:guildId/feeds by the main API router.

import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { cleanList, FEED_MESSAGE_MAX, FEED_KEYWORDS_MAX } from '../../../../core/feed-message.js';
import { fetchFeed, RSS_MAX_PER_GUILD } from '../../../../core/rss-feed.js';
import { checkUrl } from '../../../../utils/safe-fetch.js';
import { isFeedTarget, loadFeedTargets, createFeedThread, pingProblem, FeedTargetError, targetLabel } from '../../../../core/feed-target.js';

const router = express.Router({ mergeParams: true });

/** The guild as the bot that serves it sees it, or null. */
function feedGuild(guildId) {
    return global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId) || null;
}

/**
 * A channel id a feed may post to in this guild: a text or announcement channel, or a thread in one (or a
 * forum post). Threads are often not cached, so the API is asked when the cache misses.
 */
async function feedTargetIn(guild, raw) {
    const id = String(raw || '').trim();
    if (!guild || !/^\d{17,20}$/.test(id)) return null;
    const ch = guild.channels?.cache?.get(id) || await guild.channels?.fetch?.(id).catch(() => null);
    return ch && String(ch.guildId ?? guild.id) === String(guild.id) && isFeedTarget(ch) ? ch : null;
}

// ─────────────── POST-TO PICKER ───────────────
// GET /targets: the channels and active threads a feed can post into ("#channel › thread"), and whether the
// bot can ping any role (Mention @everyone, @here and All Roles) or only mentionable ones.
router.get('/targets', async (req, res) => {
    const guild = feedGuild(req.params.guildId);
    if (!guild) return res.status(503).json({ error: 'The bot for this server is not connected right now.' });
    try {
        const targets = await loadFeedTargets(guild);
        res.json({ targets, canMentionAll: !pingProblem(guild, null, 'everyone') });
    } catch (e) {
        logger.error('[API Feeds] targets error', { err: e.message });
        res.status(500).json({ error: 'Could not list the channels' });
    }
});

// POST /threads { channel_id, name }: the server's bot makes a public thread (one-week auto-archive) under that
// channel for a feed to post into, or returns the existing one with that name.
router.post('/threads', async (req, res) => {
    const guild = feedGuild(req.params.guildId);
    if (!guild) return res.status(503).json({ error: 'The bot for this server is not connected right now.' });
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const { thread, reused } = await createFeedThread(guild, body.channel_id, body.name,
            { reason: `Feed thread, requested on the dashboard by ${req.user?.username || req.user?.id || 'an admin'}` });
        const label = targetLabel(thread, thread.parent || guild.channels.cache.get(thread.parentId));
        logger.info(`[API Feeds] ${reused ? 'Reused' : 'Created'} feed thread ${thread.id} (${label}) in ${guild.id}`);
        res.json({ success: true, reused, thread: { id: String(thread.id), name: thread.name, label, parentId: String(thread.parentId) } });
    } catch (e) {
        if (e instanceof FeedTargetError) return res.status(e.status).json({ error: e.message });
        logger.error('[API Feeds] thread create error', { err: e.message });
        res.status(500).json({ error: 'Discord would not create the thread' });
    }
});

// ─────────────── REDDIT ───────────────
router.post('/reddit', async (req, res) => {
    const { redditAvailable, REDDIT_UNAVAILABLE_NOTE } = await import('../../../../utils/reddit.js');
    if (!redditAvailable()) return res.status(410).json({ error: REDDIT_UNAVAILABLE_NOTE });
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

// ─────────────── RSS / ATOM (blogs, news, podcasts) ───────────────
// The address is fetched once here (through utils/safe-fetch.js) to check it is a feed and to remember
// its current items, so adding a feed never posts its back catalogue. core/rss-feed.js polls it after.
router.post('/rss', async (req, res) => {
    const { guildId } = req.params;
    try {
        const guild = feedGuild(guildId);
        const channelId = String(req.body?.channel_id || '').trim();
        const channel = await feedTargetIn(guild, channelId);
        if (!channel) return res.status(400).json({ error: 'Choose a text or announcement channel, or a thread in one, in this server.' });
        let url;
        try {
            url = checkUrl(req.body?.feed_url).href;
        } catch (e) {
            const local = e.code === 'blocked_address' || e.code === 'blocked_host';
            return res.status(400).json({ error: local ? 'That address is on a private or local network, which is not allowed.' : 'Enter the full feed address, starting with https://' });
        }
        if (url.length > 1000) return res.status(400).json({ error: 'That address is too long.' });
        const [[{ n }]] = await pool.execute('SELECT COUNT(*) AS n FROM rss_feeds WHERE guild_id = ?', [guildId]);
        if (n >= RSS_MAX_PER_GUILD) return res.status(400).json({ error: `A server can have up to ${RSS_MAX_PER_GUILD} RSS feeds.` });
        let parsed;
        try {
            parsed = await fetchFeed(url);
        } catch (e) {
            const why = String(e.message || 'no answer').replace(/the API/gi, 'the site');
            return res.status(400).json({ error: `Could not read that feed: ${why}` });
        }
        const [result] = await pool.execute(
            'INSERT INTO rss_feeds (guild_id, feed_url, channel_id, feed_title, seen_ids) VALUES (?, ?, ?, ?, ?)',
            [guildId, url, channelId, parsed.title ? parsed.title.slice(0, 255) : null, JSON.stringify(parsed.items.map(i => i.key).slice(0, 150))]
        );
        logger.info(`[API Feeds] RSS ${url} → ${channelId} in ${guildId} (${parsed.items.length} items baselined)`);
        res.json({ success: true, id: result.insertId, feed_title: parsed.title, items: parsed.items.length });
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That feed already posts in that channel.' });
        if (e.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'RSS feeds are not available yet (a database update has not run).' });
        logger.error('[API Feeds] rss add error', { err: e.message });
        res.status(500).json({ error: 'Failed to add the RSS feed' });
    }
});

router.delete('/rss/:id', async (req, res) => {
    try {
        const [result] = await pool.execute('DELETE FROM rss_feeds WHERE id = ? AND guild_id = ?', [req.params.id, req.params.guildId]);
        if (!result.affectedRows) return res.status(404).json({ error: 'Feed not found' });
        res.json({ success: true });
    } catch (e) {
        if (e.code === 'ER_NO_SUCH_TABLE') return res.status(404).json({ error: 'Feed not found' });
        logger.error('[API Feeds] rss delete error', { err: e.message });
        res.status(500).json({ error: 'Failed to remove the RSS feed' });
    }
});

// ─────────────── PER-FEED OPTIONS ───────────────
// PATCH /:kind/:id changes one feed's channel, message, ping role and filters. Only the fields sent
// are changed. The posters read these through core/feed-message.js.
//
// Field  -> column, how the value is checked, and (for the "include" toggles over filter_* columns)
// whether it is stored inverted.
const FEED_KINDS = {
    reddit: {
        table: 'reddit_feeds', channelCol: 'channel_id',
        fields: {
            custom_message: { col: 'custom_message', type: 'message' },
            ping_role_id: { col: 'ping_role_id', type: 'ping' },
            title_include: { col: 'title_include', type: 'list' },
            title_exclude: { col: 'title_exclude', type: 'list' },
            flair_filter: { col: 'flair_filter', type: 'list', max: 255 },
        },
    },
    youtube: {
        table: 'youtube_feeds', channelCol: 'discord_channel_id',
        fields: {
            custom_message: { col: 'custom_message', type: 'message' },
            ping_role_id: { col: 'ping_role_id', type: 'ping' },
            include_videos: { col: 'include_videos', type: 'bool' },
            include_shorts: { col: 'include_shorts', type: 'bool' },
            include_live: { col: 'include_live', type: 'bool' },
        },
    },
    twitter: {
        table: 'twitter_feeds', channelCol: 'channel_id',
        fields: {
            custom_message: { col: 'custom_message', type: 'message' },
            ping_role_id: { col: 'ping_role_id', type: 'ping' },
            include_replies: { col: 'filter_replies', type: 'bool', invert: true },
            include_retweets: { col: 'filter_retweets', type: 'bool', invert: true },
            media_only: { col: 'filter_media_only', type: 'bool' },
            include_images: { col: 'include_images', type: 'bool' },
        },
    },
    bluesky: {
        table: 'bluesky_feeds', channelCol: 'channel_id',
        fields: {
            custom_message: { col: 'custom_message', type: 'message' },
            ping_role_id: { col: 'ping_role_id', type: 'ping' },
            include_replies: { col: 'filter_replies', type: 'bool', invert: true },
            include_reposts: { col: 'filter_reposts', type: 'bool', invert: true },
        },
    },
    // The Fortnite feed (jobs/fortnite-feed-checker.js): channel and ping only; it has no message template.
    fortnite: {
        table: 'fortnite_feeds', channelCol: 'channel_id',
        fields: {
            ping_role_id: { col: 'ping_role_id', type: 'ping' },
        },
    },
    rss: {
        table: 'rss_feeds', channelCol: 'channel_id',
        fields: {
            custom_message: { col: 'custom_message', type: 'message' },
            ping_role_id: { col: 'ping_role_id', type: 'ping' },
            title_include: { col: 'title_include', type: 'list' },
            title_exclude: { col: 'title_exclude', type: 'list' },
        },
    },
};

class FeedInputError extends Error {}

const asBool = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';

/** One field's value as stored, or a FeedInputError explaining what is wrong with it. */
function feedValue(spec, raw, guild) {
    switch (spec.type) {
        case 'message': {
            const s = raw == null ? '' : String(raw).replace(/\r\n/g, '\n').trim();
            if (s.length > FEED_MESSAGE_MAX) throw new FeedInputError(`The message can be at most ${FEED_MESSAGE_MAX} characters.`);
            return s || null;
        }
        case 'ping': {
            const s = raw == null ? '' : String(raw).trim();
            if (!s) return null;
            if (s === 'everyone') return 'everyone';
            if (!/^\d{17,20}$/.test(s) || !guild?.roles?.cache?.has(s) || s === guild.id) {
                throw new FeedInputError('That ping role is not a role in this server.');
            }
            return s;
        }
        case 'list':
            return cleanList(raw, spec.max || FEED_KEYWORDS_MAX);
        case 'bool': {
            const on = asBool(raw);
            return (spec.invert ? !on : on) ? 1 : 0;
        }
        default:
            throw new FeedInputError('Unknown field.');
    }
}

router.patch('/:kind/:id', async (req, res) => {
    const { guildId, kind } = req.params;
    const def = FEED_KINDS[kind];
    const id = Number.parseInt(req.params.id, 10);
    if (!def || !Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Feed not found' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
        const guild = feedGuild(guildId);
        const sets = [];
        const values = [];
        if (body.channel_id !== undefined) {
            const ch = String(body.channel_id || '').trim();
            const channel = await feedTargetIn(guild, ch);
            if (!channel) {
                return res.status(400).json({ error: 'Choose a text or announcement channel, or a thread in one, in this server.' });
            }
            sets.push(`\`${def.channelCol}\` = ?`);
            values.push(ch);
        }
        for (const [field, spec] of Object.entries(def.fields)) {
            if (body[field] === undefined) continue;
            sets.push(`\`${spec.col}\` = ?`);
            values.push(feedValue(spec, body[field], guild));
        }
        if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });

        const [result] = await pool.execute(
            `UPDATE \`${def.table}\` SET ${sets.join(', ')} WHERE id = ? AND guild_id = ?`,
            [...values, id, guildId]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Feed not found' });
        const [[feed]] = await pool.execute(`SELECT * FROM \`${def.table}\` WHERE id = ? AND guild_id = ?`, [id, guildId]);
        logger.info(`[API Feeds] ${kind} feed ${id} updated in ${guildId}: ${sets.map(s => s.split('`')[1]).join(', ')}`);
        // Tell the page when the saved ping cannot notify anyone (role not mentionable and no Mention Everyone).
        let pingWarning = null;
        if (feed?.ping_role_id && guild) {
            const target = await feedTargetIn(guild, feed[def.channelCol]);
            pingWarning = pingProblem(guild, target, feed.ping_role_id);
        }
        res.json({ success: true, feed, pingWarning });
    } catch (e) {
        if (e instanceof FeedInputError) return res.status(400).json({ error: e.message });
        if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This server already has that feed posting in that channel.' });
        if (e.code === 'ER_BAD_FIELD_ERROR') {
            logger.warn(`[API Feeds] ${kind} feed options need the social feed migration: ${e.message}`);
            return res.status(503).json({ error: 'These options are not available yet (a database update has not run).' });
        }
        logger.error('[API Feeds] update error', { err: e.message, kind, id });
        res.status(500).json({ error: 'Failed to save the feed' });
    }
});

export default router;
