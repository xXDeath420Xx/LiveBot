import axios from 'axios';
import { EmbedBuilder } from 'discord.js';
import { XMLParser } from 'fast-xml-parser';
import db from '../utils/db';
import logger from '../utils/logger';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

// Using a public Nitter instance. For production, a self-hosted one is more reliable.
const NITTER_INSTANCE = 'https://nitter.net';

interface TwitterFeed extends RowDataPacket {
    id: number;
    twitter_username: string;
    guild_id: string;
    channel_id: string;
    last_tweet_id: string | null;
}

interface Tweet {
    guid: string;
    title: string;
    description: string;
    pubDate: string;
}

async function checkTwitterFeeds(): Promise<void> {
    try {
        const [feeds] = await db.execute<TwitterFeed[]>('SELECT * FROM twitter_feeds');
        if (feeds.length === 0) return;

        for (const feed of feeds) {
            await processTwitterFeed(feed);
        }
    } catch (error) {
        const err = _error as Error;
        logger.error('[TwitterFeed] Error checking Twitter feeds:', err as Record<string, any>);
    }
}

async function processTwitterFeed(feed: TwitterFeed): Promise<void> {
    try {
        const feedUrl = `${NITTER_INSTANCE}/${feed.twitter_username}/rss`;
        const response = await axios.get(feedUrl);

        const parser = new XMLParser({ ignoreAttributes: false });
        const result = parser.parse(response.data);

        const tweets: Tweet[] = result.rss.channel.item;
        if (!tweets || tweets.length === 0) return;

        const newTweets: Tweet[] = [];
        let latestTweetId = feed.last_tweet_id;

        // Find tweets newer than the last one we saw
        for (const tweet of tweets) {
            const tweetId = tweet.guid;
            if (tweetId === feed.last_tweet_id) {
                break;
            }
            // Ignore retweets and replies for a cleaner feed
            if (!tweet.title.startsWith('RT by') && !tweet.description.startsWith('@')) {
                newTweets.unshift(tweet); // Add to the beginning to send oldest first
            }
        }

        if (newTweets.length > 0) {
            latestTweetId = newTweets[newTweets.length - 1].guid;
            const guild = (global as any).client.guilds.cache.get(feed.guild_id);
            if (!guild) return;

            const channel = await guild.channels.fetch(feed.channel_id).catch(() => null);
            if (!channel) return;

            for (const tweet of newTweets) {
                const embed = new EmbedBuilder()
                    .setColor('#1DA1F2') // Twitter Blue
                    .setAuthor({ name: `@${feed.twitter_username}`, iconURL: 'https://i.imgur.com/t340K8c.png', url: `${NITTER_INSTANCE}/${feed.twitter_username}` })
                    .setDescription(tweet.description.replace(/<br>/g, '\n').substring(0, 4096))
                    .setTimestamp(new Date(tweet.pubDate));

                await channel.send({ embeds: [embed] });
            }

            await db.execute<ResultSetHeader>('UPDATE twitter_feeds SET last_tweet_id = ? WHERE id = ?', [latestTweetId, feed.id]);
        }
    } catch (error) {
        const err = _error as Error;
        logger.warn(`[TwitterFeed] Failed to fetch feed for @${feed.twitter_username}:`, err.message);
    }
}

export = { checkTwitterFeeds };
