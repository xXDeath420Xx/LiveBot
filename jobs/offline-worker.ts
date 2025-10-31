import { Worker, Job } from 'bullmq';
import { Client, TextChannel } from 'discord.js';
import logger from '../utils/logger';
import db from '../utils/db';
import { redisOptions } from '../utils/cache';
import { processRole } from '../core/role-manager';
import { OfflineJobData } from './offline-queue';
import * as twitchApi from '../utils/twitch-api';
import * as kickApi from '../utils/kick-api';
import * as facebookApi from '../utils/facebook-api';
import * as instagramApi from '../utils/instagram-api';
import * as youtubeApi from '../utils/youtube-api';
import * as tiktokApi from '../utils/tiktok-api';
import * as trovoApi from '../utils/trovo-api';
import { RowDataPacket } from 'mysql2/promise';

interface PlatformAPI {
    isStreamerLive: (username: string) => Promise<boolean>;
    getStreamDetails?: (username: string) => Promise<any>;
}

const platformModules: Record<string, PlatformAPI> = {
    twitch: twitchApi,
    kick: kickApi,
    facebook: facebookApi,
    instagram: instagramApi,
    youtube: youtubeApi,
    tiktok: tiktokApi,
    trovo: trovoApi,
};

export = function startOfflineWorker(client: Client): Worker {
    logger.info('[Offline Worker] Initializing BullMQ Worker for stream offline events.');

    const offlineWorker = new Worker<OfflineJobData>('offline-queue', async (job: Job<OfflineJobData>) => {
        if (!client.isReady()) {
            logger.warn(`[Offline Worker] Discord client not ready. Retrying job ${job.id}...`);
            throw new Error('Discord client not ready');
        }

        const {
            subscription_id,
            streamer_id,
            guild_id,
            username,
            platform,
            discord_user_id,
            channel_id,
            message_id,
            delete_on_end,
            role_ids
        } = job.data;

        logger.info(`[Offline Worker] Processing offline event for ${username} (${platform}) in guild ${guild_id}`, {
            jobId: job.id,
            username,
            platform,
            guildId: guild_id,
            category: 'streams'
        });

        try {
            // 1. Delete announcement message if configured
            if (delete_on_end && message_id) {
                try {
                    const guild = await client.guilds.fetch(guild_id).catch(() => null);
                    if (guild) {
                        const announcementChannel = await guild.channels.fetch(channel_id).catch(() => null) as TextChannel | null;
                        if (announcementChannel && announcementChannel.isTextBased()) {
                            const message = await announcementChannel.messages.fetch(message_id).catch(() => null);
                            if (message) {
                                await message.delete();
                                logger.info(`[Offline Worker] Deleted announcement for ${username} (delete_on_end=true)`, {
                                    guildId: guild_id,
                                    channelId: channel_id,
                                    messageId: message_id,
                                    category: 'streams'
                                });
                            }
                        }
                    }
                } catch (error: any) {
                    logger.error(`[Offline Worker] Failed to delete announcement message:`, {
                        error: error.message,
                        guildId: guild_id,
                        messageId: message_id,
                        category: 'streams'
                    });
                }
            } else if (!delete_on_end) {
                logger.info(`[Offline Worker] Keeping announcement for ${username} (delete_on_end=false)`, {
                    guildId: guild_id,
                    channelId: channel_id,
                    messageId: message_id,
                    category: 'streams'
                });
            }

            // 2. Remove live roles from Discord user (with multi-platform check)
            if (discord_user_id && role_ids.length > 0) {
                try {
                    // CRITICAL: Check if user is still live on OTHER platforms before removing roles
                    logger.info(`[Offline Worker] Checking if ${username} is live on other platforms before role removal`, {
                        guildId: guild_id,
                        userId: discord_user_id,
                        offlinePlatform: platform,
                        category: 'streams'
                    });

                    interface StreamerRow extends RowDataPacket {
                        username: string;
                        platform: string;
                    }

                    const [otherStreamers] = await db.execute<StreamerRow[]>(
                        'SELECT username, platform FROM streamers WHERE discord_user_id = ?',
                        [discord_user_id]
                    );

                    let stillLiveOnOtherPlatform = false;
                    let livePlatformName = '';

                    for (const streamer of otherStreamers) {
                        // Skip the platform that just went offline
                        if (streamer.platform === platform && streamer.username === username) {
                            continue;
                        }

                        // Check if live on any OTHER platform
                        const api = platformModules[streamer.platform];
                        if (api) {
                            try {
                                const isLive = await api.isStreamerLive(streamer.username);
                                if (isLive) {
                                    stillLiveOnOtherPlatform = true;
                                    livePlatformName = `${streamer.platform}:${streamer.username}`;
                                    logger.info(`[Offline Worker] User still live on ${livePlatformName}, keeping roles`, {
                                        guildId: guild_id,
                                        userId: discord_user_id,
                                        offlinePlatform: `${platform}:${username}`,
                                        livePlatform: livePlatformName,
                                        category: 'streams'
                                    });
                                    break;
                                }
                            } catch (apiError: any) {
                                logger.warn(`[Offline Worker] Failed to check live status for ${streamer.platform}:${streamer.username}`, {
                                    error: apiError.message,
                                    category: 'streams'
                                });
                            }
                        }
                    }

                    // Only remove roles if NOT live on any other platform
                    if (!stillLiveOnOtherPlatform) {
                        const guild = await client.guilds.fetch(guild_id).catch(() => null);
                        if (guild) {
                            const member = await guild.members.fetch(discord_user_id).catch(() => null);
                            if (member) {
                                await processRole(member, role_ids, 'remove', guild_id);
                                logger.info(`[Offline Worker] Removed ${role_ids.length} live role(s) from ${member.user.tag} (not live on any platform)`, {
                                    guildId: guild_id,
                                    userId: discord_user_id,
                                    username,
                                    platform,
                                    roleCount: role_ids.length,
                                    checkedPlatforms: otherStreamers.length,
                                    category: 'streams'
                                });
                            } else {
                                logger.warn(`[Offline Worker] Member ${discord_user_id} not found in guild ${guild_id}`, {
                                    guildId: guild_id,
                                    userId: discord_user_id,
                                    category: 'streams'
                                });
                            }
                        } else {
                            logger.warn(`[Offline Worker] Guild ${guild_id} not found`, {
                                guildId: guild_id,
                                category: 'streams'
                            });
                        }
                    } else {
                        logger.info(`[Offline Worker] Skipping role removal - user still live on ${livePlatformName}`, {
                            guildId: guild_id,
                            userId: discord_user_id,
                            offlinePlatform: `${platform}:${username}`,
                            livePlatform: livePlatformName,
                            roleCount: role_ids.length,
                            category: 'streams'
                        });
                    }
                } catch (error: any) {
                    logger.error(`[Offline Worker] Failed to process role removal with multi-platform check:`, {
                        error: error.message,
                        stack: error.stack,
                        guildId: guild_id,
                        userId: discord_user_id,
                        category: 'streams'
                    });
                }
            } else if (!discord_user_id) {
                logger.debug(`[Offline Worker] No Discord user linked for ${username}, skipping role removal`, {
                    username,
                    platform,
                    category: 'streams'
                });
            }

            // 3. Delete from live_announcements database
            try {
                await db.execute(
                    'DELETE FROM live_announcements WHERE guild_id = ? AND platform = ? AND username = ? AND channel_id = ?',
                    [guild_id, platform, username, channel_id]
                );
                logger.info(`[Offline Worker] Deleted from live_announcements table`, {
                    guildId: guild_id,
                    platform,
                    username,
                    channelId: channel_id,
                    category: 'streams'
                });
            } catch (error: any) {
                if (error.code !== 'ER_NO_SUCH_TABLE') {
                    logger.error(`[Offline Worker] Failed to delete from live_announcements:`, {
                        error: error.message,
                        guildId: guild_id,
                        platform,
                        username,
                        category: 'streams'
                    });
                }
            }

            logger.info(`[Offline Worker] Successfully processed offline event for ${username}`, {
                jobId: job.id,
                username,
                platform,
                guildId: guild_id,
                announcementDeleted: delete_on_end && !!message_id,
                rolesRemoved: role_ids.length,
                category: 'streams'
            });

        } catch (error: any) {
            logger.error(`[Offline Worker] Job ${job.id} failed for ${username}:`, {
                error: error.message,
                stack: error.stack,
                guildId: guild_id,
                username,
                platform,
                category: 'streams'
            });
            throw error;
        }
    }, { connection: redisOptions, concurrency: 10 });

    offlineWorker.on('error', (err: Error) => logger.error('[Offline Worker] Worker error:', { error: err, category: 'streams' }));
    offlineWorker.on('completed', (job: Job<OfflineJobData>) =>
        logger.info(`[Offline Worker] Job ${job.id} completed for ${job.data.username} (${job.data.platform})`, { category: 'streams' })
    );
    offlineWorker.on('failed', (job: Job<OfflineJobData> | undefined, err: Error) =>
        logger.error(`[Offline Worker] Job ${job?.id} for ${job?.data?.username} failed`, { error: err, category: 'streams' })
    );

    return offlineWorker;
};
