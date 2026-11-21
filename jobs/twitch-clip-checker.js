/*
 * Announcing new Twitch clips.
 *
 * The rule that matters: a feed announces only clips created AFTER the moment it was
 * switched on (`posted_from`). Owners typically enable this straight after uploading a
 * batch, and seeing that batch replayed into the channel is the one outcome that makes
 * the feature feel broken. Nothing before the watermark is ever announced.
 *
 * The second rule, learned the hard way: the client this job was STARTED with is not
 * the client that can post. Feeds live in custom-bot guilds the main bot was never
 * invited to, and `channels.fetch` there returns null every cycle — the feed looked
 * alive (last_checked kept moving) while two real clips sat unposted for a day. Each
 * feed resolves its own client from the guild.
 */
import cron from 'node-cron';
import { EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { resolveFeedTarget } from '../core/feed-target.js';
import { buildFeedContent } from '../core/feed-message.js';
import { clipsSince, gameNames, thumbnailUrl } from '../utils/platforms/twitch-clips.js';

let task = null;

// A quiet channel should not receive twenty posts in one minute because someone
// went on a clipping spree. The rest wait for the next cycle.
const MAX_PER_CYCLE = 5;

function clipEmbed(clip, game) {
    const e = new EmbedBuilder()
        .setColor(0x9146FF)
        .setTitle(clip.title?.slice(0, 250) || 'New clip')
        .setURL(clip.url)
        .setImage(thumbnailUrl(clip))
        .setTimestamp(new Date(clip.created_at));

    const fields = [];
    if (game) fields.push({ name: 'Playing', value: game, inline: true });
    if (clip.duration) fields.push({ name: 'Length', value: `${Math.round(clip.duration)}s`, inline: true });
    if (clip.view_count != null) fields.push({ name: 'Views', value: Number(clip.view_count).toLocaleString(), inline: true });
    if (fields.length) e.addFields(fields);

    // Viewers clip these more often than the streamer does, and they deserve the credit.
    const byThem = clip.creator_name && clip.creator_name.toLowerCase() !== String(clip.broadcaster_name || '').toLowerCase();
    e.setFooter({ text: byThem ? `Clipped by ${clip.creator_name}` : `Clipped by ${clip.broadcaster_name}` });
    return e;
}

/**
 * The client that can actually see this feed's guild.
 *
 * `getClientForGuild` checks the mapped custom bot has the guild CACHED before
 * returning it, then falls back to any connected client that does — so a feed
 * never gets handed a bot that is merely logged in.
 */
function clientForFeed(feed, fallback) {
    return global.botManager?.getClientForGuild?.(feed.guild_id) || fallback;
}

async function runFeed(feed, defaultClient) {
    const client = clientForFeed(feed, defaultClient);
    // getClientForGuild falls back to the main bot even when no bot is in the server (H-315):
    // don't ask Twitch for clips nobody can post.
    if (!client?.guilds?.cache?.has(feed.guild_id)) return 0;
    const since = new Date(feed.posted_from);
    let clips = await clipsSince(feed.broadcaster_id, since);

    if (feed.creators_filter === 'broadcaster_only') {
        clips = clips.filter(c => String(c.creator_id) === String(feed.broadcaster_id));
    }
    if (feed.min_views > 0) clips = clips.filter(c => (c.view_count || 0) >= feed.min_views);
    if (!clips.length) return 0;

    const [seen] = await pool.execute('SELECT clip_id FROM twitch_clip_seen WHERE feed_id = ?', [feed.id]);
    const known = new Set(seen.map(r => r.clip_id));
    const fresh = clips.filter(c => !known.has(c.id)).slice(0, MAX_PER_CYCLE);
    if (!fresh.length) return 0;

    // Threads too (an archived one is reopened first): see core/feed-target.js.
    const { channel, problem } = await resolveFeedTarget(client, feed.channel_id, { guildId: feed.guild_id });
    if (!channel) {
        logger.warn(
            `[TwitchClips] ${feed.username}: bot ${client?.user?.id || 'unknown'} cannot post to `
            + `${feed.channel_id} in guild ${feed.guild_id} (${problem}) — ${clips.length} clip(s) waiting`,
            { category: 'twitch' });
        return 0;
    }

    const names = await gameNames(fresh.map(c => c.game_id));
    // The feed's ping role (migration 480): a role, 'everyone' or none, let through and nothing else.
    const { content, allowedMentions } = buildFeedContent({ template: null, vars: {}, pingRoleId: feed.ping_role_id });
    let posted = 0;
    for (const clip of fresh) {
        try {
            await channel.send({ content, allowedMentions, embeds: [clipEmbed(clip, names[clip.game_id])] });
            // Record only after the post actually lands, or a failed send is never retried.
            await pool.execute(
                'INSERT IGNORE INTO twitch_clip_seen (feed_id, clip_id) VALUES (?, ?)', [feed.id, clip.id]
            );
            posted++;
        } catch (e) {
            logger.error(`[TwitchClips] failed to post ${clip.id}: ${e.message}`, { category: 'twitch' });
        }
    }
    return posted;
}

async function checkClips(client) {
    let feeds;
    try {
        const [rows] = await pool.execute('SELECT * FROM twitch_clip_feeds WHERE enabled = 1');
        feeds = rows;
    } catch (e) {
        if (e.code !== 'ER_NO_SUCH_TABLE') {
            logger.error(`[TwitchClips] could not load feeds: ${e.message}`, { category: 'twitch' });
        }
        return;
    }
    if (!feeds.length) return;

    for (const feed of feeds) {
        try {
            const n = await runFeed(feed, client);
            if (n) logger.info(`[TwitchClips] posted ${n} clip(s) for ${feed.username}`, { category: 'twitch' });
            await pool.execute('UPDATE twitch_clip_feeds SET last_checked = NOW() WHERE id = ?', [feed.id]);
        } catch (e) {
            logger.error(`[TwitchClips] ${feed.username} failed: ${e.message}`, { category: 'twitch' });
        }
    }
}

export function startTwitchClipChecker(client) {
    if (task) return;
    task = cron.schedule('*/10 * * * *', () => checkClips(client));
    logger.info('[TwitchClips] checker started (every 10 minutes)', { category: 'twitch' });
}

export function stopTwitchClipChecker() {
    if (task) { task.stop(); task = null; }
}

export { checkClips };
