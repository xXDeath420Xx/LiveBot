import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { getUserTweets, getUserProfile } from '../utils/platforms/twitter-api.js';

// Cache for profile avatars
const avatarCache = new Map();
const AVATAR_CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

/**
 * Check all Twitter feeds and post new content
 */
async function checkTwitterFeeds(client) {
    try {
        const [feeds] = await pool.execute('SELECT * FROM twitter_feeds');
        if (feeds.length === 0) return;

        logger.info(`[TwitterFeed] Checking ${feeds.length} Twitter feeds...`);

        // Process feeds in parallel batches of 3
        const batchSize = 3;
        for (let i = 0; i < feeds.length; i += batchSize) {
            const batch = feeds.slice(i, i + batchSize);
            await Promise.all(batch.map(feed => processTwitterFeed(feed, client)));
        }
    } catch (error) {
        logger.error('[TwitterFeed] Error checking Twitter feeds:', error);
    }
}

/**
 * Process a single Twitter feed
 */
async function processTwitterFeed(feed, client) {
    try {
        const username = feed.twitter_username.replace(/^@/, '');

        // Fetch recent tweets using the new API wrapper
        const tweets = await getUserTweets(username, 10);

        if (!tweets || tweets.length === 0) {
            logger.debug(`[TwitterFeed] No tweets found for @${username}`);
            return;
        }

        // Get profile avatar (cached)
        const avatar = await getCachedAvatar(username);

        // Filter tweets based on feed settings
        const filteredTweets = filterTweets(tweets, feed);

        // Find new tweets (after last_tweet_id)
        const newTweets = [];
        for (const tweet of filteredTweets) {
            // If we've seen this tweet before, stop
            if (tweet.id === feed.last_tweet_id) {
                break;
            }
            newTweets.unshift(tweet); // Add oldest first
        }

        if (newTweets.length === 0) {
            return;
        }

        // Get Discord channel
        const guild = client.guilds.cache.get(feed.guild_id);
        if (!guild) {
            logger.warn(`[TwitterFeed] Guild ${feed.guild_id} not found`);
            return;
        }

        const channel = await guild.channels.fetch(feed.channel_id).catch(() => null);
        if (!channel) {
            logger.warn(`[TwitterFeed] Channel ${feed.channel_id} not found in guild ${guild.name}`);
            return;
        }

        // Post new tweets
        for (const tweet of newTweets) {
            try {
                await postTweetEmbed(channel, tweet, feed, avatar);
                // Small delay between posts
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (postError) {
                logger.error(`[TwitterFeed] Error posting tweet:`, postError);
            }
        }

        // Update last tweet ID (use the most recent tweet)
        const latestTweetId = filteredTweets[0]?.id;
        if (latestTweetId) {
            await pool.execute(
                'UPDATE twitter_feeds SET last_tweet_id = ? WHERE id = ?',
                [latestTweetId, feed.id]
            );
        }

        logger.info(`[TwitterFeed] Posted ${newTweets.length} new tweet(s) from @${username} to #${channel.name}`);

    } catch (error) {
        logger.warn(`[TwitterFeed] Failed to process feed for @${feed.twitter_username}:`, error.message);
    }
}

/**
 * Filter tweets based on feed settings
 */
function filterTweets(tweets, feed) {
    return tweets.filter(tweet => {
        // Filter retweets (default: filter out)
        if (feed.filter_retweets && tweet.is_retweet) {
            return false;
        }

        // Filter replies (default: filter out)
        if (feed.filter_replies && tweet.is_reply) {
            return false;
        }

        // Media only filter
        if (feed.filter_media_only && (!tweet.media || tweet.media.length === 0)) {
            return false;
        }

        return true;
    });
}

/**
 * Post a tweet embed to Discord
 */
async function postTweetEmbed(channel, tweet, feed, avatar) {
    // Build the embed
    const embed = new EmbedBuilder()
        .setColor('#1DA1F2') // Twitter Blue
        .setAuthor({
            name: `${tweet.author?.name || feed.twitter_username} (@${tweet.author?.username || feed.twitter_username})`,
            iconURL: avatar || tweet.author?.avatar || 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png',
            url: `https://twitter.com/${tweet.author?.username || feed.twitter_username}`
        })
        .setDescription(truncateText(tweet.text, 4096))
        .setTimestamp(new Date(tweet.created_at));

    // Add images if enabled (up to 4)
    if (feed.include_images !== 0 && tweet.media && tweet.media.length > 0) {
        const images = tweet.media.filter(m => m.type === 'image' || m.type === 'photo');
        if (images.length > 0) {
            // Set the first image as the main embed image
            embed.setImage(images[0].url);
        }
    }

    // Add engagement metrics if available
    if (tweet.metrics && (tweet.metrics.likes > 0 || tweet.metrics.retweets > 0)) {
        const metricsText = [];
        if (tweet.metrics.likes > 0) metricsText.push(`${formatNumber(tweet.metrics.likes)} Likes`);
        if (tweet.metrics.retweets > 0) metricsText.push(`${formatNumber(tweet.metrics.retweets)} RTs`);
        if (tweet.metrics.replies > 0) metricsText.push(`${formatNumber(tweet.metrics.replies)} Replies`);

        if (metricsText.length > 0) {
            embed.setFooter({
                text: metricsText.join(' | '),
                iconURL: 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png'
            });
        }
    }

    // Build "View on Twitter" button
    const tweetUrl = tweet.url || `https://twitter.com/${tweet.author?.username || feed.twitter_username}/status/${tweet.id}`;

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setLabel('View on Twitter')
                .setStyle(ButtonStyle.Link)
                .setURL(tweetUrl)
                .setEmoji('1263655741992898663') // Twitter emoji or use default
        );

    // Build message content
    let content = null;
    if (feed.custom_message) {
        content = feed.custom_message
            .replace('{username}', tweet.author?.username || feed.twitter_username)
            .replace('{name}', tweet.author?.name || feed.twitter_username);
    }

    // Send the message
    await channel.send({
        content: content,
        embeds: [embed],
        components: [row]
    });

    // If there are additional images (2-4), send them in a follow-up
    if (feed.include_images !== 0 && tweet.media && tweet.media.length > 1) {
        const additionalImages = tweet.media
            .filter(m => m.type === 'image' || m.type === 'photo')
            .slice(1, 4);

        if (additionalImages.length > 0) {
            const additionalEmbeds = additionalImages.map(img =>
                new EmbedBuilder()
                    .setURL(tweetUrl)
                    .setImage(img.url)
            );

            // Link embeds share the same URL to group them
            await channel.send({ embeds: additionalEmbeds });
        }
    }
}

/**
 * Get cached avatar for a user
 */
async function getCachedAvatar(username) {
    const cached = avatarCache.get(username);
    if (cached && Date.now() - cached.timestamp < AVATAR_CACHE_DURATION) {
        return cached.avatar;
    }

    try {
        const profile = await getUserProfile(username);
        const avatar = profile?.avatar || null;
        avatarCache.set(username, { avatar, timestamp: Date.now() });
        return avatar;
    } catch (error) {
        return null;
    }
}

/**
 * Truncate text to a maximum length
 */
function truncateText(text, maxLength) {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
}

/**
 * Format large numbers (1000 -> 1K, 1000000 -> 1M)
 */
function formatNumber(num) {
    if (num >= 1000000) {
        return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    }
    if (num >= 1000) {
        return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    }
    return num.toString();
}

/**
 * Add a new Twitter feed
 */
async function addTwitterFeed(guildId, channelId, username, options = {}) {
    const cleanUsername = username.replace(/^@/, '').toLowerCase();

    const [existing] = await pool.execute(
        'SELECT id FROM twitter_feeds WHERE guild_id = ? AND twitter_username = ?',
        [guildId, cleanUsername]
    );

    if (existing.length > 0) {
        throw new Error(`Already tracking @${cleanUsername} in this server`);
    }

    await pool.execute(
        `INSERT INTO twitter_feeds
         (guild_id, channel_id, twitter_username, filter_retweets, filter_replies, filter_media_only, include_images, custom_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            guildId,
            channelId,
            cleanUsername,
            options.filterRetweets ?? 1,
            options.filterReplies ?? 1,
            options.mediaOnly ?? 0,
            options.includeImages ?? 1,
            options.customMessage || null
        ]
    );

    return { username: cleanUsername, channelId };
}

/**
 * Remove a Twitter feed
 */
async function removeTwitterFeed(guildId, username) {
    const cleanUsername = username.replace(/^@/, '').toLowerCase();

    const [result] = await pool.execute(
        'DELETE FROM twitter_feeds WHERE guild_id = ? AND twitter_username = ?',
        [guildId, cleanUsername]
    );

    return result.affectedRows > 0;
}

/**
 * Get all Twitter feeds for a guild
 */
async function getTwitterFeeds(guildId) {
    const [feeds] = await pool.execute(
        'SELECT * FROM twitter_feeds WHERE guild_id = ?',
        [guildId]
    );
    return feeds;
}

/**
 * Update a Twitter feed's settings
 */
async function updateTwitterFeed(guildId, username, options) {
    const cleanUsername = username.replace(/^@/, '').toLowerCase();

    const updates = [];
    const values = [];

    if (options.channelId !== undefined) {
        updates.push('channel_id = ?');
        values.push(options.channelId);
    }
    if (options.filterRetweets !== undefined) {
        updates.push('filter_retweets = ?');
        values.push(options.filterRetweets ? 1 : 0);
    }
    if (options.filterReplies !== undefined) {
        updates.push('filter_replies = ?');
        values.push(options.filterReplies ? 1 : 0);
    }
    if (options.mediaOnly !== undefined) {
        updates.push('filter_media_only = ?');
        values.push(options.mediaOnly ? 1 : 0);
    }
    if (options.includeImages !== undefined) {
        updates.push('include_images = ?');
        values.push(options.includeImages ? 1 : 0);
    }
    if (options.customMessage !== undefined) {
        updates.push('custom_message = ?');
        values.push(options.customMessage || null);
    }

    if (updates.length === 0) {
        throw new Error('No options to update');
    }

    values.push(guildId, cleanUsername);

    const [result] = await pool.execute(
        `UPDATE twitter_feeds SET ${updates.join(', ')} WHERE guild_id = ? AND twitter_username = ?`,
        values
    );

    return result.affectedRows > 0;
}

export {
    checkTwitterFeeds,
    addTwitterFeed,
    removeTwitterFeed,
    getTwitterFeeds,
    updateTwitterFeed
};
