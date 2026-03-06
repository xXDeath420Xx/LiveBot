import cron from 'node-cron';
import logger from '../utils/logger.js';
import { getLiveAnnouncements } from '../core/stream-manager.js';
import { updateAnnouncement } from '../utils/announcer.js';
import pool from '../utils/db.js';

// Platform API modules
import * as twitchApi from '../utils/platforms/twitch.js';
import * as kickApi from '../utils/platforms/kick.js';
import * as facebookApi from '../utils/platforms/facebook.js';
import * as instagramApi from '../utils/platforms/instagram.js';
import * as youtubeApi from '../utils/platforms/youtube.js';
import * as tiktokApi from '../utils/platforms/tiktok.js';
import * as trovoApi from '../utils/platforms/trovo.js';

const platformModules = {
    twitch: twitchApi,
    kick: kickApi,
    facebook: facebookApi,
    instagram: instagramApi,
    youtube: youtubeApi,
    tiktok: tiktokApi,
    trovo: trovoApi,
};

let schedulerTask = null;

/**
 * Start the announcement updater scheduler
 * Runs every 5 minutes to update existing stream announcements with current viewer counts
 * Supports multi-bot system - updates announcements for all bots
 */
export function startAnnouncementUpdater(client) {
    if (schedulerTask) {
        logger.warn('[Announcement Updater] Scheduler is already running', { category: 'streams' });
        return;
    }

    // Run every 5 minutes
    schedulerTask = cron.schedule('*/5 * * * *', async () => {
        logger.info('[Announcement Updater] Running scheduled announcement update for all bots', { category: 'streams' });

        // Update for default bot
        const defaultClient = global.botManager?.getDefaultClient() || client;
        if (defaultClient) {
            try {
                await updateLiveAnnouncements(defaultClient);
            } catch (error) {
                logger.error('[Announcement Updater] Error during scheduled update (default bot):', { error, category: 'streams' });
            }
        }

        // Update for all custom bots
        if (global.botManager?.clients) {
            for (const [botId, botClient] of global.botManager.clients.entries()) {
                if (botId === 'default') continue;

                try {
                    await updateLiveAnnouncements(botClient);
                } catch (error) {
                    logger.error(`[Announcement Updater] Error during scheduled update (bot ${botId}):`, { error, botId, category: 'streams' });
                }
            }
        }
    });

    logger.info('[Announcement Updater] Scheduler started (every 5 minutes, multi-bot support enabled)', { category: 'streams' });
}

/**
 * Stop the announcement updater scheduler
 */
export function stopAnnouncementUpdater() {
    if (schedulerTask) {
        schedulerTask.stop();
        schedulerTask = null;
        logger.info('[Announcement Updater] Scheduler stopped', { category: 'streams' });
    } else {
        logger.warn('[Announcement Updater] No scheduler running to stop', { category: 'streams' });
    }
}

/**
 * Update all live announcements with current stream data
 */
async function updateLiveAnnouncements(client) {
    const liveAnnouncements = getLiveAnnouncements();

    if (liveAnnouncements.size === 0) {
        logger.info('[Announcement Updater] No live announcements to update', { category: 'streams' });
        return;
    }

    logger.info(`[Announcement Updater] Updating ${liveAnnouncements.size} live announcements`, { category: 'streams' });

    let connection;
    try {
        connection = await pool.getConnection();

        for (const [key, announcement] of liveAnnouncements.entries()) {
            try {
                const api = platformModules[announcement.platform];
                if (!api) {
                    logger.warn(`[Announcement Updater] No API module for platform: ${announcement.platform}`, {
                        category: 'streams'
                    });
                    continue;
                }

                // Check if still live and get updated data
                const isLive = await api.isStreamerLive(announcement.username);
                if (!isLive) {
                    logger.info(`[Announcement Updater] Streamer ${announcement.username} is no longer live, skipping update`, {
                        category: 'streams'
                    });
                    continue;
                }

                const streamData = await api.getStreamDetails(announcement.username);
                if (!streamData) {
                    logger.warn(`[Announcement Updater] Could not get stream details for ${announcement.username}`, {
                        category: 'streams'
                    });
                    continue;
                }

                // Extract guild_id and channel_id from the key: "guildId-platform-username-channelId"
                const keyParts = key.split('-');
                const guildId = keyParts[0];
                const channelId = keyParts[keyParts.length - 1];

                // Get subscription and guild settings
                const [subscriptions] = await connection.query(
                    `SELECT sub.*, s.profile_image_url, s.discord_user_id
                     FROM subscriptions sub
                     JOIN streamers s ON sub.streamer_id = s.streamer_id
                     WHERE sub.guild_id = ? AND s.streamer_id = ?`,
                    [guildId, announcement.streamerId]
                );

                if (subscriptions.length === 0) continue;

                const subscription = subscriptions[0];

                const [guildSettings] = await connection.query(
                    'SELECT * FROM guilds WHERE guild_id = ?',
                    [guildId]
                );

                if (guildSettings.length === 0) continue;

                // Build platform URL
                const platformUrls = {
                    twitch: `https://twitch.tv/${announcement.username}`,
                    kick: `https://kick.com/${announcement.username}`,
                    youtube: `https://youtube.com/channel/${announcement.username}`,
                    tiktok: `https://tiktok.com/@${announcement.username}`,
                    trovo: `https://trovo.live/s/${announcement.username}`,
                    facebook: `https://facebook.com/gaming/${announcement.username}`,
                    instagram: `https://instagram.com/${announcement.username}`,
                };

                const platformUrl = platformUrls[announcement.platform] || `https://${announcement.platform}.com/${announcement.username}`;

                const subContext = {
                    streamer_id: announcement.streamerId,
                    username: announcement.username,
                    guild_id: guildId,
                    profile_image_url: subscription.profile_image_url,
                    custom_message: subscription.custom_message,
                    override_nickname: subscription.override_nickname,
                    override_avatar_url: subscription.override_avatar_url,
                    discord_user_id: subscription.discord_user_id
                };

                const liveData = {
                    game: streamData.game_name || null,
                    title: streamData.title || null,
                    thumbnailUrl: streamData.thumbnail_url || null,
                    platform: announcement.platform,
                    url: platformUrl,
                    username: announcement.username,
                    profileImageUrl: subscription.profile_image_url || null,
                    viewerCount: streamData.viewer_count || 0
                };

                const existingAnnouncement = { message_id: announcement.messageId };

                // Get the correct bot client for this guild (supports multi-bot system)
                const guildClient = global.botManager ? global.botManager.getClientForGuild(guildId) : client;

                // Update the announcement
                await updateAnnouncement(
                    guildClient,
                    subContext,
                    liveData,
                    existingAnnouncement,
                    guildSettings[0],
                    null,
                    null,
                    channelId
                );

                logger.info(`[Announcement Updater] Updated announcement for ${announcement.username}`, {
                    category: 'streams',
                    viewers: streamData.viewer_count
                });

            } catch (error) {
                logger.error(`[Announcement Updater] Error updating announcement for ${announcement.username}:`, {
                    error: error.message,
                    category: 'streams'
                });
            }
        }

    } catch (error) {
        logger.error('[Announcement Updater] Error during announcement update process:', {
            error,
            category: 'streams'
        });
    } finally {
        if (connection) connection.release();
    }
}
