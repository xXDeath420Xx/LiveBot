import axios from 'axios';
import { EmbedBuilder, TextChannel } from 'discord.js';
import db from '../utils/db';
import logger from '../utils/logger';
import { RowDataPacket } from 'mysql2';

interface RedditFeed extends RowDataPacket {
    id: number;
    guild_id: string;
    channel_id: string;
    subreddit: string;
    last_post_id: string | null;
}

interface RedditPost {
    id: string;
    title: string;
    selftext: string;
    permalink: string;
    author: string;
    score: number;
    created_utc: number;
    thumbnail: string;
}

async function checkRedditFeeds(): Promise<void> {
    try {
        const [feeds] = await db.execute<RedditFeed[]>('SELECT * FROM reddit_feeds');
        if (feeds.length === 0) return;

        for (const feed of feeds) {
            await processFeed(feed);
        }
    } catch (error) {
        logger.error('[RedditFeed] Error checking feeds:', error as Record<string, any>);
    }
}

async function processFeed(feed: RedditFeed): Promise<void> {
    try {
        const response = await axios.get(`https://www.reddit.com/r/${feed.subreddit}/new.json?limit=5`);
        const posts = response.data.data.children;

        if (posts.length === 0) return;

        const newPosts: RedditPost[] = [];
        let latestPostId = feed.last_post_id;

        // Find posts newer than the last one we saw
        for (const post of posts) {
            if (post.data.id === feed.last_post_id) {
                break; // We've reached the last post we announced
            }
            newPosts.unshift(post.data); // Add to the beginning to send oldest first
        }

        if (newPosts.length > 0) {
            latestPostId = newPosts[newPosts.length - 1].id;
            const guild = (global as any).client.guilds.cache.get(feed.guild_id);
            if (!guild) return;

            const channel = await guild.channels.fetch(feed.channel_id).catch(() => null) as TextChannel | null;
            if (!channel) return;

            for (const post of newPosts) {
                const embed = new EmbedBuilder()
                    .setColor('#FF4500')
                    .setTitle(post.title.substring(0, 256))
                    .setURL(`https://www.reddit.com${post.permalink}`)
                    .setDescription(post.selftext.substring(0, 400) || 'No text content.')
                    .setAuthor({ name: `New post in r/${feed.subreddit}`, iconURL: 'https://www.redditinc.com/assets/images/site/reddit-logo.png' })
                    .addFields({ name: 'Author', value: `u/${post.author}`, inline: true }, { name: 'Upvotes', value: post.score.toString(), inline: true })
                    .setTimestamp(post.created_utc * 1000);

                if (post.thumbnail && post.thumbnail.startsWith('http')) {
                    embed.setThumbnail(post.thumbnail);
                }

                await channel.send({ embeds: [embed] });
            }

            await db.execute('UPDATE reddit_feeds SET last_post_id = ? WHERE id = ?', [latestPostId, feed.id]);
        }
    } catch (error: any) {
        logger.warn(`[RedditFeed] Failed to fetch subreddit r/${feed.subreddit}:`, error.message);
    }
}

export { checkRedditFeeds };
