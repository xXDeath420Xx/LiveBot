"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const bullmq_1 = require("bullmq");
const logger_1 = __importDefault(require("../utils/logger"));
const db_1 = __importDefault(require("../utils/db"));
const cache_1 = require("../utils/cache");
const role_manager_1 = require("../core/role-manager");
const twitchApi = __importStar(require("../utils/twitch-api"));
const kickApi = __importStar(require("../utils/kick-api"));
const facebookApi = __importStar(require("../utils/facebook-api"));
const instagramApi = __importStar(require("../utils/instagram-api"));
const youtubeApi = __importStar(require("../utils/youtube-api"));
const tiktokApi = __importStar(require("../utils/tiktok-api"));
const trovoApi = __importStar(require("../utils/trovo-api"));
const platformModules = {
    twitch: twitchApi,
    kick: kickApi,
    facebook: facebookApi,
    instagram: instagramApi,
    youtube: youtubeApi,
    tiktok: tiktokApi,
    trovo: trovoApi,
};
module.exports = function startOfflineWorker(client) {
    logger_1.default.info('[Offline Worker] Initializing BullMQ Worker for stream offline events.');
    const offlineWorker = new bullmq_1.Worker('offline-queue', async (job) => {
        if (!client.isReady()) {
            logger_1.default.warn(`[Offline Worker] Discord client not ready. Retrying job ${job.id}...`);
            throw new Error('Discord client not ready');
        }
        const { subscription_id, streamer_id, guild_id, username, platform, discord_user_id, channel_id, message_id, delete_on_end, role_ids } = job.data;
        logger_1.default.info(`[Offline Worker] Processing offline event for ${username} (${platform}) in guild ${guild_id}`, {
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
                        const announcementChannel = await guild.channels.fetch(channel_id).catch(() => null);
                        if (announcementChannel && announcementChannel.isTextBased()) {
                            const message = await announcementChannel.messages.fetch(message_id).catch(() => null);
                            if (message) {
                                await message.delete();
                                logger_1.default.info(`[Offline Worker] Deleted announcement for ${username} (delete_on_end=true)`, {
                                    guildId: guild_id,
                                    channelId: channel_id,
                                    messageId: message_id,
                                    category: 'streams'
                                });
                            }
                        }
                    }
                }
                catch (error) {
                    logger_1.default.error(`[Offline Worker] Failed to delete announcement message:`, {
                        error: error.message,
                        guildId: guild_id,
                        messageId: message_id,
                        category: 'streams'
                    });
                }
            }
            else if (!delete_on_end) {
                logger_1.default.info(`[Offline Worker] Keeping announcement for ${username} (delete_on_end=false)`, {
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
                    logger_1.default.info(`[Offline Worker] Checking if ${username} is live on other platforms before role removal`, {
                        guildId: guild_id,
                        userId: discord_user_id,
                        offlinePlatform: platform,
                        category: 'streams'
                    });
                    const [otherStreamers] = await db_1.default.execute('SELECT username, platform FROM streamers WHERE discord_user_id = ?', [discord_user_id]);
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
                                    logger_1.default.info(`[Offline Worker] User still live on ${livePlatformName}, keeping roles`, {
                                        guildId: guild_id,
                                        userId: discord_user_id,
                                        offlinePlatform: `${platform}:${username}`,
                                        livePlatform: livePlatformName,
                                        category: 'streams'
                                    });
                                    break;
                                }
                            }
                            catch (apiError) {
                                logger_1.default.warn(`[Offline Worker] Failed to check live status for ${streamer.platform}:${streamer.username}`, {
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
                                await (0, role_manager_1.processRole)(member, role_ids, 'remove', guild_id);
                                logger_1.default.info(`[Offline Worker] Removed ${role_ids.length} live role(s) from ${member.user.tag} (not live on any platform)`, {
                                    guildId: guild_id,
                                    userId: discord_user_id,
                                    username,
                                    platform,
                                    roleCount: role_ids.length,
                                    checkedPlatforms: otherStreamers.length,
                                    category: 'streams'
                                });
                            }
                            else {
                                logger_1.default.warn(`[Offline Worker] Member ${discord_user_id} not found in guild ${guild_id}`, {
                                    guildId: guild_id,
                                    userId: discord_user_id,
                                    category: 'streams'
                                });
                            }
                        }
                        else {
                            logger_1.default.warn(`[Offline Worker] Guild ${guild_id} not found`, {
                                guildId: guild_id,
                                category: 'streams'
                            });
                        }
                    }
                    else {
                        logger_1.default.info(`[Offline Worker] Skipping role removal - user still live on ${livePlatformName}`, {
                            guildId: guild_id,
                            userId: discord_user_id,
                            offlinePlatform: `${platform}:${username}`,
                            livePlatform: livePlatformName,
                            roleCount: role_ids.length,
                            category: 'streams'
                        });
                    }
                }
                catch (error) {
                    logger_1.default.error(`[Offline Worker] Failed to process role removal with multi-platform check:`, {
                        error: error.message,
                        stack: error.stack,
                        guildId: guild_id,
                        userId: discord_user_id,
                        category: 'streams'
                    });
                }
            }
            else if (!discord_user_id) {
                logger_1.default.debug(`[Offline Worker] No Discord user linked for ${username}, skipping role removal`, {
                    username,
                    platform,
                    category: 'streams'
                });
            }
            // 3. Delete from live_announcements database
            try {
                await db_1.default.execute('DELETE FROM live_announcements WHERE guild_id = ? AND platform = ? AND username = ? AND channel_id = ?', [guild_id, platform, username, channel_id]);
                logger_1.default.info(`[Offline Worker] Deleted from live_announcements table`, {
                    guildId: guild_id,
                    platform,
                    username,
                    channelId: channel_id,
                    category: 'streams'
                });
            }
            catch (error) {
                if (error.code !== 'ER_NO_SUCH_TABLE') {
                    logger_1.default.error(`[Offline Worker] Failed to delete from live_announcements:`, {
                        error: error.message,
                        guildId: guild_id,
                        platform,
                        username,
                        category: 'streams'
                    });
                }
            }
            logger_1.default.info(`[Offline Worker] Successfully processed offline event for ${username}`, {
                jobId: job.id,
                username,
                platform,
                guildId: guild_id,
                announcementDeleted: delete_on_end && !!message_id,
                rolesRemoved: role_ids.length,
                category: 'streams'
            });
        }
        catch (error) {
            logger_1.default.error(`[Offline Worker] Job ${job.id} failed for ${username}:`, {
                error: error.message,
                stack: error.stack,
                guildId: guild_id,
                username,
                platform,
                category: 'streams'
            });
            throw error;
        }
    }, { connection: cache_1.redisOptions, concurrency: 10 });
    offlineWorker.on('error', (err) => logger_1.default.error('[Offline Worker] Worker error:', { error: err, category: 'streams' }));
    offlineWorker.on('completed', (job) => logger_1.default.info(`[Offline Worker] Job ${job.id} completed for ${job.data.username} (${job.data.platform})`, { category: 'streams' }));
    offlineWorker.on('failed', (job, err) => logger_1.default.error(`[Offline Worker] Job ${job?.id} for ${job?.data?.username} failed`, { error: err, category: 'streams' }));
    return offlineWorker;
};
