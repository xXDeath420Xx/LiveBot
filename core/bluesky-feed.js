// Bluesky post watcher — mirrors twitter-feed.js shape.
// Each row in `bluesky_feeds` gets polled; new posts (newer than last_post_uri) get embedded into the bound channel.
import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { getAuthorFeed, getProfile, normalizeActor, postUrlFor } from '../utils/platforms/bluesky.js';

const BLUESKY_COLOR = 0x0085FF;
const MAX_NEW_PER_TICK = 3; // don't flood a channel when a feed has accumulated many

export async function checkBlueskyFeeds(client) {
    let feeds;
    try {
        [feeds] = await pool.execute('SELECT * FROM bluesky_feeds');
    } catch (e) {
        if (e.code === 'ER_NO_SUCH_TABLE') return; // table not created yet
        throw e;
    }
    if (!feeds.length) return;
    logger.info(`[BlueskyFeed] Checking ${feeds.length} Bluesky feeds…`);

    for (let i = 0; i < feeds.length; i += 3) {
        const batch = feeds.slice(i, i + 3);
        await Promise.all(batch.map(f => processFeed(f, client).catch(err => {
            logger.error(`[BlueskyFeed] feed ${f.id} (${f.bluesky_handle}) failed: ${err.message}`);
        })));
    }
}

async function processFeed(feed, client) {
    const handle = normalizeActor(feed.bluesky_handle);
    if (!handle) return;

    const filter = feed.filter_replies ? 'posts_no_replies' : 'posts_with_replies';
    const items = await getAuthorFeed(handle, { limit: 10, filter });
    if (!items.length) return;

    // items are newest-first. Walk forward collecting posts until we hit the last-seen.
    const newOnes = [];
    for (const item of items) {
        const uri = item.post?.uri;
        if (!uri) continue;
        if (uri === feed.last_post_uri) break;
        // Reposts are items where reason.$type is "app.bsky.feed.defs#reasonRepost". Skip if configured.
        if (feed.filter_reposts && item.reason && item.reason.$type?.includes('Repost')) continue;
        newOnes.push(item);
    }
    if (!newOnes.length) return;

    // Post oldest-first, cap at MAX_NEW_PER_TICK to avoid flood on first-ever sync.
    const toPost = newOnes.reverse().slice(-MAX_NEW_PER_TICK);

    const channel = await resolveChannel(client, feed.channel_id);
    if (!channel) {
        logger.warn(`[BlueskyFeed] channel ${feed.channel_id} not resolvable (feed id ${feed.id})`);
        return;
    }

    for (const item of toPost) {
        try {
            const embed = buildEmbed(item);
            const content = (feed.custom_message || '').trim() || undefined;
            await channel.send({ content, embeds: [embed] });
        } catch (err) {
            logger.error(`[BlueskyFeed] send failed for ${feed.id}: ${err.message}`);
        }
    }

    // Advance the cursor to the newest post we just saw.
    const newestUri = toPost[toPost.length - 1].post?.uri;
    if (newestUri) {
        await pool.execute(
            'UPDATE bluesky_feeds SET last_post_uri = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [newestUri, feed.id]
        );
    }
}

function buildEmbed(item) {
    const post = item.post;
    const author = post?.author;
    const record = post?.record;
    const text = record?.text || '';
    const createdAt = record?.createdAt ? new Date(record.createdAt) : new Date();

    const embed = new EmbedBuilder()
        .setColor(BLUESKY_COLOR)
        .setURL(postUrlFor(item) || undefined)
        .setAuthor({
            name: `${author?.displayName || author?.handle || 'Bluesky'} (@${author?.handle || '?'})`,
            iconURL: author?.avatar || undefined,
            url: author?.handle ? `https://bsky.app/profile/${author.handle}` : undefined,
        })
        .setDescription(text || '*[no text]*')
        .setTimestamp(createdAt)
        .setFooter({ text: 'Bluesky' });

    // First image, if present
    const imgs = post?.embed?.images || post?.embed?.media?.images;
    if (Array.isArray(imgs) && imgs.length > 0) {
        const first = imgs[0];
        if (first.fullsize) embed.setImage(first.fullsize);
        else if (first.thumb) embed.setImage(first.thumb);
    }

    return embed;
}

async function resolveChannel(client, channelId) {
    // Works for both the main bot and custom bots — check all bot clients
    if (client?.channels?.cache?.get(channelId)) return client.channels.cache.get(channelId);
    if (global.botManager?.clients) {
        for (const [, c] of global.botManager.clients) {
            const ch = c.channels.cache.get(channelId);
            if (ch) return ch;
        }
    }
    try {
        return await client.channels.fetch(channelId);
    } catch {
        return null;
    }
}

export { getProfile };
