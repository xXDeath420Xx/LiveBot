import cron from 'node-cron';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { getRecentPosts } from '../utils/platforms/facebook-api.js';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

// This file announces new Facebook page posts. (Instagram feeds were removed —
// Meta's Graph API can't read a non-business account, so it never worked for
// normal users.)

let schedulerTask = null;

const PLATFORM_COLORS = {
    facebook: 0x1877F2,
};

const PLATFORM_ICONS = {
    facebook: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/05/Facebook_Logo_%282019%29.png/600px-Facebook_Logo_%282019%29.png',
};

/**
 * Check for new Facebook posts and announce them.
 */
async function checkSocialFeeds(client) {
    try {
        logger.info('[SocialFeed] Starting feed check cycle');

        // Get all subscriptions with feed notifications enabled.
        const [subscriptions] = await pool.execute(`
            SELECT DISTINCT s.streamer_id, s.username, s.profile_image_url, s.platform,
                   sub.guild_id, sub.feed_channel_id, sub.announcement_channel_id,
                   sub.facebook_feed_notifications,
                   sub.custom_message, sub.ping_role_id
            FROM streamers s
            JOIN subscriptions sub ON s.streamer_id = sub.streamer_id
            WHERE s.platform = 'facebook' AND sub.facebook_feed_notifications = 1
            AND (sub.feed_channel_id IS NOT NULL OR sub.announcement_channel_id IS NOT NULL)
        `);

        if (subscriptions.length === 0) {
            logger.info('[SocialFeed] No Facebook feed subscriptions found');
            return;
        }

        logger.info(`[SocialFeed] Checking ${subscriptions.length} feed subscriptions`);

        // Group by platform + username to avoid duplicate API calls
        const streamerMap = new Map();
        for (const sub of subscriptions) {
            const key = `${sub.platform}:${sub.username}`;
            if (!streamerMap.has(key)) {
                streamerMap.set(key, { ...sub, guilds: [] });
            }
            streamerMap.get(key).guilds.push({
                guildId: sub.guild_id,
                channelId: sub.feed_channel_id || sub.announcement_channel_id,
                customMessage: sub.custom_message,
                pingRoleId: sub.ping_role_id,
            });
        }

        for (const [key, streamerData] of streamerMap) {
            try {
                await checkStreamerFeed(client, streamerData);
            } catch (error) {
                logger.error(`[SocialFeed] Error checking ${key}:`, { error: error.message });
            }
            // Pace API calls
            await new Promise(r => setTimeout(r, 1000));
        }

        logger.info('[SocialFeed] Feed check cycle complete');
    } catch (error) {
        logger.error('[SocialFeed] Error in feed check cycle:', { error: error.message });
    }
}

async function checkStreamerFeed(client, streamerData) {
    const { streamer_id, username, profile_image_url, platform, guilds } = streamerData;

    logger.info(`[SocialFeed] Checking ${platform}/${username} for new posts`);

    // Fetch recent posts from the platform
    let posts = [];
    if (platform === 'facebook') {
        posts = await getRecentPosts(null, 10);
    }

    if (posts.length === 0) {
        logger.info(`[SocialFeed] No posts found for ${platform}/${username}`);
        return;
    }

    // Check which posts are new (not in database)
    for (const post of posts) {
        const postId = post.id;
        const postUrl = post.permalink || post.url || null;

        try {
            const [[existing]] = await pool.execute(
                'SELECT id FROM social_feed_posts WHERE platform = ? AND post_id = ?',
                [platform, postId]
            );

            if (existing) continue; // Already announced

            // New post — save and announce
            let postedAtMysql = null;
            const timestamp = post.timestamp || post.createdAt;
            if (timestamp) {
                const date = new Date(timestamp);
                if (!isNaN(date.getTime())) {
                    postedAtMysql = date.toISOString().slice(0, 19).replace('T', ' ');
                }
            }

            // Skip posts older than 24 hours (don't backfill on first run)
            if (timestamp) {
                const postAge = Date.now() - new Date(timestamp).getTime();
                if (postAge > 24 * 60 * 60 * 1000) {
                    // Still save to DB to avoid re-checking, but don't announce
                    await pool.execute(
                        'INSERT INTO social_feed_posts (platform, streamer_id, post_id, post_url, caption, media_type, media_url, thumbnail_url, like_count, comment_count, posted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        [platform, streamer_id, postId, postUrl, (post.caption || post.message || '').substring(0, 5000), post.type || post.media_type || 'post', post.mediaUrl || post.imageUrl || null, post.thumbnailUrl || null, post.likes || 0, post.comments || 0, postedAtMysql]
                    ).catch(() => {});
                    continue;
                }
            }

            // Save to DB
            await pool.execute(
                'INSERT INTO social_feed_posts (platform, streamer_id, post_id, post_url, caption, media_type, media_url, thumbnail_url, like_count, comment_count, posted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [platform, streamer_id, postId, postUrl, (post.caption || post.message || '').substring(0, 5000), post.type || post.media_type || 'post', post.mediaUrl || post.imageUrl || null, post.thumbnailUrl || null, post.likes || 0, post.comments || 0, postedAtMysql]
            );

            logger.info(`[SocialFeed] New ${platform} post from ${username}: ${postId}`);

            // Announce to all subscribed guilds
            for (const guild of guilds) {
                try {
                    const botClient = global.botManager?.getClientForGuild(guild.guildId) || global.botManager?.getDefaultClient() || client;
                    const channel = await botClient.channels.fetch(guild.channelId).catch(() => null);
                    if (!channel) continue;

                    const caption = (post.caption || post.message || '').substring(0, 300);
                    const mediaType = post.type || post.media_type || 'post';
                    const typeLabel = mediaType === 'VIDEO' ? '🎬 Reel' : mediaType === 'CAROUSEL_ALBUM' ? '📸 Album' : mediaType === 'IMAGE' ? '📷 Photo' : '📝 Post';
                    const platformName = 'Facebook';

                    const embed = new EmbedBuilder()
                        .setColor(PLATFORM_COLORS[platform])
                        .setAuthor({
                            name: `${username} posted on ${platformName}`,
                            iconURL: profile_image_url || PLATFORM_ICONS[platform],
                            url: postUrl,
                        })
                        .setDescription(caption || `New ${typeLabel.toLowerCase()} from ${username}`)
                        .setFooter({ text: `${typeLabel} • ${platformName}` })
                        .setTimestamp(timestamp ? new Date(timestamp) : new Date());

                    // Set image if available
                    const imageUrl = post.mediaUrl || post.imageUrl || post.thumbnailUrl;
                    if (imageUrl) embed.setImage(imageUrl);

                    const buttons = new ActionRowBuilder();
                    if (postUrl) {
                        buttons.addComponents(
                            new ButtonBuilder()
                                .setLabel(`View on ${platformName}`)
                                .setURL(postUrl)
                                .setStyle(ButtonStyle.Link)
                        );
                    }

                    const escMd = str => str.replace(/([_*~`|\\])/g, '\\$1');
                    let content = guild.customMessage
                        ? guild.customMessage
                            .replace(/{username}/g, escMd(username))
                            .replace(/{streamer}/g, escMd(username))
                            .replace(/{platform}/g, platformName)
                            .replace(/{url}/g, postUrl || '')
                            .replace(/{everyone}/g, '@everyone')
                            .replace(/{here}/g, '@here')
                        : null;

                    if (guild.pingRoleId) {
                        const mention = guild.pingRoleId === 'everyone' ? '@everyone' : `<@&${guild.pingRoleId}>`;
                        content = content ? `${mention} ${content}` : mention;
                    }

                    await channel.send({
                        content,
                        embeds: [embed],
                        components: postUrl ? [buttons] : [],
                    });

                    logger.info(`[SocialFeed] Announced ${platform} post to guild ${guild.guildId}`);
                } catch (announceErr) {
                    logger.error(`[SocialFeed] Failed to announce to guild ${guild.guildId}:`, { error: announceErr.message });
                }
            }
        } catch (postErr) {
            logger.error(`[SocialFeed] Error processing post ${postId}:`, { error: postErr.message });
        }
    }
}

/**
 * Start the social feed checker scheduler
 */
function startSocialFeedScheduler(client) {
    if (schedulerTask) {
        logger.warn('[SocialFeed] Scheduler already running');
        return;
    }

    // Run every 5 minutes
    schedulerTask = cron.schedule('*/5 * * * *', () => {
        checkSocialFeeds(client).catch(err =>
            logger.error('[SocialFeed] Scheduler error:', { error: err.message })
        );
    });

    logger.info('[SocialFeed] Scheduler started (every 5 minutes)');

    // Run initial check after 30 seconds
    setTimeout(() => checkSocialFeeds(client).catch(() => {}), 30000);
}

function stopSocialFeedScheduler() {
    if (schedulerTask) {
        schedulerTask.stop();
        schedulerTask = null;
        logger.info('[SocialFeed] Scheduler stopped');
    }
}

export { startSocialFeedScheduler, stopSocialFeedScheduler, checkSocialFeeds };
