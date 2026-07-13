// Facebook Page post watcher via Meta Graph API.
import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { fbPageRecentPosts, fbPageInfo } from '../utils/platforms/meta.js';

const FB_COLOR = 0x1877F2;
const MAX_NEW_PER_TICK = 3;

export async function checkFacebookFeeds(client) {
    let feeds;
    try {
        [feeds] = await pool.execute('SELECT * FROM facebook_feeds');
    } catch (e) {
        if (e.code === 'ER_NO_SUCH_TABLE') return;
        throw e;
    }
    if (!feeds.length) return;
    logger.info(`[FacebookFeed] Checking ${feeds.length} Facebook feeds…`);

    for (let i = 0; i < feeds.length; i += 2) {
        const batch = feeds.slice(i, i + 2);
        await Promise.all(batch.map(f => processFeed(f, client).catch(err => {
            logger.error(`[FacebookFeed] feed ${f.id} (${f.facebook_page_id}) failed: ${err.message}`);
        })));
    }
}

async function processFeed(feed, client) {
    const posts = await fbPageRecentPosts(feed.facebook_page_id, { limit: 5 });
    if (!posts.length) return;

    if (!feed.page_name) {
        const info = await fbPageInfo(feed.facebook_page_id);
        if (info?.name) {
            await pool.execute('UPDATE facebook_feeds SET page_name = ? WHERE id = ?', [info.name, feed.id]).catch(() => {});
            feed.page_name = info.name;
        }
    }

    // Graph returns newest-first; walk until we hit last_post_id
    const newOnes = [];
    for (const p of posts) {
        if (p.id === feed.last_post_id) break;
        newOnes.push(p);
    }
    if (!newOnes.length) return;

    const toPost = newOnes.reverse().slice(-MAX_NEW_PER_TICK);
    const channel = await resolveChannel(client, feed.channel_id);
    if (!channel) {
        logger.warn(`[FacebookFeed] channel ${feed.channel_id} not resolvable (feed id ${feed.id})`);
        return;
    }

    for (const p of toPost) {
        try {
            const embed = buildEmbed(p, feed);
            const content = (feed.custom_message || '').trim() || undefined;
            await channel.send({ content, embeds: [embed] });
        } catch (err) {
            logger.error(`[FacebookFeed] send failed for ${feed.id}: ${err.message}`);
        }
    }

    await pool.execute(
        'UPDATE facebook_feeds SET last_post_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [toPost[toPost.length - 1].id, feed.id]
    );
}

function buildEmbed(p, feed) {
    const text = (p.message || '').slice(0, 1800);
    const embed = new EmbedBuilder()
        .setColor(FB_COLOR)
        .setURL(p.permalink_url || undefined)
        .setAuthor({
            name: feed.page_name || `Facebook Page ${feed.facebook_page_id}`,
            url: p.permalink_url || undefined,
        })
        .setDescription(text || '*[no text]*')
        .setTimestamp(p.created_time ? new Date(p.created_time) : new Date())
        .setFooter({ text: 'Facebook' });
    if (p.full_picture) embed.setImage(p.full_picture);
    return embed;
}

async function resolveChannel(client, channelId) {
    if (client?.channels?.cache?.get(channelId)) return client.channels.cache.get(channelId);
    if (global.botManager?.clients) {
        for (const [, c] of global.botManager.clients) {
            const ch = c.channels.cache.get(channelId);
            if (ch) return ch;
        }
    }
    try { return await client.channels.fetch(channelId); } catch { return null; }
}
