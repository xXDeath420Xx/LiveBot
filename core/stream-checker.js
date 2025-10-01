// B:/Code/LiveBot/core/stream-checker.js - Updated on 2025-10-01 - Unique Identifier: STREAM-CHECKER-FINAL-005
const db = require('../utils/db');
const apiChecks = require('../utils/api_checks');
const cache = require('../utils/cache');
const logger = require('../utils/logger');
const { Queue } = require('bullmq');
const { syncTwitchTeam } = require('./team-sync');
const { handleRole } = require('./role-manager');

async function checkStreams(client) {
    logger.info('[Check] ---> Starting stream check @ ' + new Date().toLocaleTimeString());
    try {
        const [subscriptions] = await db.execute('SELECT sub.*, s.platform_user_id, s.username, s.platform, s.kick_username, s.discord_user_id FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id');
        const [existingAnnouncements] = await db.execute('SELECT * FROM announcements');
        const [guildSettings] = await db.execute('SELECT * FROM guilds');
        const [teamSettings] = await db.execute('SELECT * FROM twitch_teams');

        logger.info(`[Check] Fetched ${subscriptions.length} subscriptions, ${existingAnnouncements.length} existing announcements, ${guildSettings.length} guild settings, ${teamSettings.length} team settings.`);

        const uniqueStreamers = [...new Map(subscriptions.map(s => [`${s.platform}:${s.username}`, s])).values()];
        logger.info(`[Check] Identified ${uniqueStreamers.length} unique streamers to check.`);

        const statuses = new Map();
        for (const streamer of uniqueStreamers) {
            const cacheKey = `api:${streamer.platform}:${streamer.username}`;
            let status = await cache.get(cacheKey);
            if (!status) {
                logger.debug(`[Check] Cache miss for ${streamer.username} on ${streamer.platform}. Calling API.`);
                switch (streamer.platform) {
                    case 'twitch': status = await apiChecks.checkTwitch(streamer); break;
                    case 'kick': status = await apiChecks.checkKick(streamer.username); break;
                    case 'youtube': status = await apiChecks.checkYouTube(streamer.platform_user_id); break;
                    case 'tiktok': status = await apiChecks.checkTikTok(streamer.username); break;
                    case 'trovo': status = await apiChecks.checkTrovo(streamer.username); break;
                    default: status = { isLive: false };
                }
                await cache.set(cacheKey, status, 300); // Cache for 300 seconds (5 minutes)
            } else {
                logger.debug(`[Check] Cache hit for ${streamer.username} on ${streamer.platform}.`);
            }

            const consecutiveFailsCacheKey = `consecutive_fails:${streamer.platform}:${streamer.username}`;
            let consecutiveFails = await cache.get(consecutiveFailsCacheKey) || 0;

            if (status.isLive === true) {
                await cache.del(consecutiveFailsCacheKey);
            } else if (status.isLive === false) {
                consecutiveFails++;
                await cache.set(consecutiveFailsCacheKey, consecutiveFails, 900); // cache for 15 mins
                if (consecutiveFails < 3) {
                    logger.warn(`[Check] Streamer ${streamer.username} (${streamer.platform}) appeared offline, but it's only been ${consecutiveFails} time(s). Giving grace period.`);
                    status.isLive = 'unknown'; // Treat as unknown for a few checks
                }
            }

            statuses.set(`${streamer.platform}:${streamer.username}`, status);
            if (status && status.isLive === true) {
                logger.info(`[Check] Streamer ${streamer.username} (${streamer.platform}) is LIVE.`);
            }
        }

        const announcementsMap = new Map(existingAnnouncements.map(a => [a.subscription_id, a]));
        const announcementQueue = [];

        logger.info(`[Check] Iterating through ${subscriptions.length} subscriptions to enqueue announcements.`);
        for (const sub of subscriptions) {
            const liveData = statuses.get(`${sub.platform}:${sub.username}`);
            const existingAnn = announcementsMap.get(sub.subscription_id);

            if (liveData && liveData.isLive === true) {
                let targetChannelId = sub.announcement_channel_id;
                if (sub.team_subscription_id) {
                    const team = teamSettings.find(t => t.id === sub.team_subscription_id);
                    if (team) targetChannelId = team.announcement_channel_id;
                }

                if (!targetChannelId) {
                    logger.warn(`[Check] No announcement channel found for subscription ID ${sub.subscription_id}. Skipping.`);
                    continue;
                }

                logger.debug(`[Check] Resolved targetChannelId for ${sub.username} (Sub ID: ${sub.subscription_id}): ${targetChannelId}`);

                const jobData = { sub, liveData };
                announcementQueue.push({ name: `announcement-${sub.subscription_id}`, data: jobData });
                logger.info(`[Check] Enqueueing announcement job for ${sub.username} (Subscription: ${sub.subscription_id}) to channel ${targetChannelId}. Existing announcement: ${!!existingAnn}`);

                if (!existingAnn) {
                    announcementsMap.set(sub.subscription_id, { temp: true });
                    logger.debug(`[Check] Optimistically updated announcementsMap for new announcement job for ${sub.username} (Subscription: ${sub.subscription_id}).`);
                }
            }
        }

        const endedStreams = existingAnnouncements.filter(ann => {
            const sub = subscriptions.find(s => s.subscription_id === ann.subscription_id);
            if (!sub) return true;

            const status = statuses.get(`${sub.platform}:${sub.username}`);

            if (status && status.isLive === 'unknown') {
                return false;
            }

            return !status || !status.isLive;
        });

        if (endedStreams.length > 0) {
            logger.info(`[Check] Found ${endedStreams.length} streams that have ended. Processing cleanup.`);
            const announcementIdsToDelete = [];
            for (const ann of endedStreams) {
                const sub = subscriptions.find(s => s.subscription_id === ann.subscription_id);
                if (sub) {
                    const rolesToRemove = [];
                    const guildSetting = guildSettings.find(gs => gs.guild_id === sub.guild_id);
                    if (guildSetting?.live_role_id) {
                        rolesToRemove.push(guildSetting.live_role_id);
                    }
                    if (sub.team_subscription_id) {
                        const teamSetting = teamSettings.find(ts => ts.id === sub.team_subscription_id);
                        if (teamSetting?.live_role_id) {
                            rolesToRemove.push(teamSetting.live_role_id);
                        }
                    }
                    const uniqueRolesToRemove = [...new Set(rolesToRemove)];
                    const discordUserId = sub.discord_user_id;

                    if (uniqueRolesToRemove.length > 0 && discordUserId) {
                        try {
                            const guild = await client.guilds.fetch(sub.guild_id);
                            const member = await guild.members.fetch(discordUserId).catch(() => null);
                            if (member) {
                                await handleRole(member, uniqueRolesToRemove, "remove", sub.guild_id);
                                logger.info(`[Check] Removed live roles ${uniqueRolesToRemove.join(', ')} from ${member.user.tag} in guild ${sub.guild_id}.`);
                            } else {
                                logger.warn(`[Check] Could not find member ${discordUserId} in guild ${sub.guild_id} to remove live roles.`);
                            }
                        } catch (roleError) {
                            logger.error(`[Check] Failed to remove live roles from ${sub.username} (${discordUserId}) in guild ${sub.guild_id}: ${roleError.message}`);
                        }
                    }
                }

                try {
                    const channel = await client.channels.fetch(ann.channel_id).catch(() => null);
                    if (channel) {
                        await channel.messages.delete(ann.message_id).catch(err => {
                            if (err.code !== 10008) logger.error(`[Check] Failed to delete message ${ann.message_id} in channel ${ann.channel_id}:`, err.message);
                        });
                        logger.info(`[Check] Deleting message for ended announcement ${ann.announcement_id} in channel ${ann.channel_id}.`);
                    }
                    announcementIdsToDelete.push(ann.announcement_id);
                } catch (e) {
                    logger.error(`[Check] Error during cleanup for announcement ${ann.announcement_id}:`, e.message);
                    if (e.code === 10003 || e.code === 10008) announcementIdsToDelete.push(ann.announcement_id);
                }
            }
            if (announcementIdsToDelete.length > 0) {
                await db.execute(`DELETE FROM announcements WHERE announcement_id IN (${announcementIdsToDelete.join(',')})`);
                logger.info(`[Check] Cleaned up ${announcementIdsToDelete.length} ended stream announcements from the database.`);
            }
        }

        if (announcementQueue.length > 0) {
            const announcementBullQueue = new Queue('announcement-queue', { connection: cache.redis });
            await announcementBullQueue.addBulk(announcementQueue);
            await announcementBullQueue.close();
        }

    } catch (error) {
        logger.error('[Check] CRITICAL ERROR in checkStreams:', error);
    } finally {
        logger.info('[Check] ---> Finished stream check');
    }
}

async function checkTeams(client) {
    logger.info('[Team Sync] ---> Starting hourly team sync @ ' + new Date().toLocaleTimeString());
    try {
        const [teamSubscriptions] = await db.execute('SELECT id FROM twitch_teams');
        logger.debug(`DEBUG (checkTeams): teamSubscriptionsRawResult:`, teamSubscriptions);

        if (teamSubscriptions && teamSubscriptions.length > 0) {
            logger.info(`[Team Sync] Found ${teamSubscriptions.length} teams to sync. Running in parallel...`);
            const syncPromises = teamSubscriptions.map(team => syncTwitchTeam(team.id, db, logger));
            await Promise.all(syncPromises);
            logger.info('[Team Sync] All team sync promises resolved.');
        } else {
            logger.info('[Team Sync] No teams to sync.');
        }
    } catch (error) {
        logger.error('[Team Sync] CRITICAL ERROR in checkTeams:', error);
    } finally {
        logger.info('[Team Sync] ---> Finished hourly team sync.');
    }
}

module.exports = { checkStreams, checkTeams };
