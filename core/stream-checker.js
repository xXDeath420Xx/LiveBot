// B:/Code/LiveBot/core/stream-checker.js - Updated on 2025-10-02 - Unique Identifier: STREAM-CHECKER-FINAL-006
const db = require('../utils/db');
const apiChecks = require('../utils/api_checks');
const cache = require('../utils/cache');
const logger = require('../utils/logger');
const { Queue } = require('bullmq');
const { syncTwitchTeam } = require('./team-sync');
const { processRole } = require('./role-manager'); // Corrected import
const { EmbedBuilder } = require('discord.js'); // Import EmbedBuilder

async function checkStreams(client) {
    logger.info('[Check] ---> Starting stream check @ ' + new Date().toLocaleTimeString(), { category: 'stream-check' });
    try {
        const [subscriptions] = await db.execute('SELECT sub.*, s.platform_user_id, s.username, s.platform, s.kick_username, s.discord_user_id FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id');
        const [existingAnnouncements] = await db.execute('SELECT * FROM announcements');
        const [guildSettings] = await db.execute('SELECT * FROM guilds');
        const [teamSettings] = await db.execute('SELECT * FROM twitch_teams');

        logger.info(`[Check] Fetched ${subscriptions.length} subscriptions, ${existingAnnouncements.length} existing announcements, ${guildSettings.length} guild settings, ${teamSettings.length} team settings.`, { category: 'stream-check' });

        const uniqueStreamers = [...new Map(subscriptions.map(s => [`${s.platform}:${s.username}`, s])).values()];
        logger.info(`[Check] Identified ${uniqueStreamers.length} unique streamers to check.`, { category: 'stream-check' });

        const statuses = new Map();
        for (const streamer of uniqueStreamers) {
            const cacheKey = `api:${streamer.platform}:${streamer.username}`;
            let status = await cache.redis.get(cacheKey);
            if (status) {
                status = JSON.parse(status);
            }

            if (!status) {
                logger.debug(`[Check] Cache miss for ${streamer.username} on ${streamer.platform}. Calling API.`, { category: 'stream-check' });
                switch (streamer.platform) {
                    case 'twitch': status = await apiChecks.checkTwitch(streamer); break;
                    case 'kick': status = await apiChecks.checkKick(streamer.kick_username); break;
                    case 'youtube': status = await apiChecks.checkYouTube(streamer.platform_user_id); break;
                    case 'tiktok': status = await apiChecks.checkTikTok(streamer.username); break;
                    case 'trovo': status = await apiChecks.checkTrovo(streamer.username); break;
                    default: status = { isLive: false };
                }
                await cache.redis.set(cacheKey, JSON.stringify(status), 'EX', 300); // Cache for 300 seconds (5 minutes)
            } else {
                logger.debug(`[Check] Cache hit for ${streamer.username} on ${streamer.platform}.`, { category: 'stream-check' });
            }

            const consecutiveFailsCacheKey = `consecutive_fails:${streamer.platform}:${streamer.username}`;
            let consecutiveFails = await cache.redis.get(consecutiveFailsCacheKey);
            consecutiveFails = consecutiveFails ? parseInt(consecutiveFails, 10) : 0;

            if (status.isLive === true) {
                // If live, reset the fail counter.
                await cache.redis.del(consecutiveFailsCacheKey);
            } else { // This will now catch both `false` and `'unknown'`.
                consecutiveFails++;
                await cache.redis.set(consecutiveFailsCacheKey, consecutiveFails, 'EX', 900); // cache for 15 mins

                // If we have failed less than 2 times, we are in the grace period.
                // The status remains 'unknown' to prevent premature cleanup.
                if (consecutiveFails < 2) { // Changed from 3 to 2 for more aggressive cleanup
                    logger.warn(`[Check] Streamer ${streamer.username} (${streamer.platform}) appeared offline or had an API error. Grace period active (Attempt ${consecutiveFails}/2).`, { category: 'stream-check' });
                    status.isLive = 'unknown';
                } else {
                    // If we have failed 2 or more times, we now consider the streamer definitively offline.
                    logger.warn(`[Check] Streamer ${streamer.username} (${streamer.platform}) is definitively offline after ${consecutiveFails} failed checks.`, { category: 'stream-check' });
                    await cache.redis.del(consecutiveFailsCacheKey); // Clear fails once definitively offline
                    status.isLive = false;
                }
            }

            statuses.set(`${streamer.platform}:${streamer.username}`, status);
            if (status && status.isLive === true) {
                logger.info(`[Check] Streamer ${streamer.username} (${streamer.platform}) is LIVE.`, { category: 'stream-check' });
            }
        }

        const announcementsMap = new Map(existingAnnouncements.map(a => [a.subscription_id, a]));
        const announcementQueue = [];

        logger.info(`[Check] Iterating through ${subscriptions.length} subscriptions to enqueue announcements.`, { category: 'stream-check' });
        for (const sub of subscriptions) {
            const liveData = statuses.get(`${sub.platform}:${sub.username}`);
            const existingAnn = announcementsMap.get(sub.subscription_id);

            // Apply game and title filters
            if (liveData && liveData.isLive === true) {
                if (sub.game_filter && liveData.game && liveData.game.toLowerCase() !== sub.game_filter.toLowerCase()) {
                    logger.debug(`[Check] Skipping announcement for ${sub.username} due to game filter mismatch. Expected: ${sub.game_filter}, Got: ${liveData.game}`, { category: 'stream-check' });
                    continue;
                }
                if (sub.title_filter && liveData.title && !liveData.title.toLowerCase().includes(sub.title_filter.toLowerCase())) {
                    logger.debug(`[Check] Skipping announcement for ${sub.username} due to title filter mismatch. Expected: ${sub.title_filter}, Got: ${liveData.title}`, { category: 'stream-check' });
                    continue;
                }
            }

            if (liveData && liveData.isLive === true) {
                let targetChannelId = sub.announcement_channel_id;
                if (sub.team_subscription_id) {
                    const team = teamSettings.find(t => t.id === sub.team_subscription_id);
                    if (team) targetChannelId = team.announcement_channel_id;
                }

                if (!targetChannelId) {
                    logger.warn(`[Check] No announcement channel found for subscription ID ${sub.subscription_id}. Skipping.`, { category: 'stream-check' });
                    continue;
                }

                logger.debug(`[Check] Resolved targetChannelId for ${sub.username} (Sub ID: ${sub.subscription_id}): ${targetChannelId}`, { category: 'stream-check' });

                const jobData = { sub, liveData };
                announcementQueue.push({ name: `announcement-${sub.subscription_id}`, data: jobData });
                logger.info(`[Check] Enqueueing announcement job for ${sub.username} (Subscription: ${sub.subscription_id}) to channel ${targetChannelId}. Existing announcement: ${!!existingAnn}`, { category: 'stream-check' });

                if (!existingAnn) {
                    announcementsMap.set(sub.subscription_id, { temp: true });
                    logger.debug(`[Check] Optimistically updated announcementsMap for new announcement job for ${sub.subscription_id}).`, { category: 'stream-check' });
                }
            }
        }

        const endedStreams = existingAnnouncements.filter(ann => {
            const sub = subscriptions.find(s => s.subscription_id === ann.subscription_id);
            if (!sub) return true; // Subscription was deleted, so end the announcement.

            const status = statuses.get(`${sub.platform}:${sub.username}`);

            // A stream is considered ended only if its status is definitively false.
            // 'unknown' status means we're in a grace period, so we don't consider it ended.
            return !status || status.isLive === false;
        });

        if (endedStreams.length > 0) {
            logger.info(`[Check] Found ${endedStreams.length} streams that have ended. Processing cleanup.`, { category: 'stream-check' });
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
                                await processRole(member, uniqueRolesToRemove, "remove", sub.guild_id); // Using the new processRole function
                                logger.info(`[Check] Removed live roles ${uniqueRolesToRemove.join(', ')} from ${member.user.tag} in guild ${sub.guild_id}.`, { category: 'stream-check' });
                            } else {
                                logger.warn(`[Check] Could not find member ${discordUserId} in guild ${sub.guild_id} to remove live roles.`, { category: 'stream-check' });
                            }
                        } catch (roleError) {
                            logger.error(`[Check] Failed to remove live roles from ${sub.username} (${discordUserId}) in guild ${sub.guild_id}: ${roleError.message}`, { category: 'stream-check', error: roleError.stack });
                        }
                    }
                }

                try {
                    const channel = await client.channels.fetch(ann.channel_id).catch(() => null);
                    if (channel) {
                        const messageToProcess = await channel.messages.fetch(ann.message_id).catch(() => null);

                        if (messageToProcess) {
                            // If delete_on_end is false (meaning keep_summary was true), edit the message first
                            // to indicate the stream has ended, before deleting it.
                            if (sub && !sub.delete_on_end && messageToProcess.editable) {
                                const embed = messageToProcess.embeds[0];
                                if (embed) {
                                    const updatedEmbed = EmbedBuilder.from(embed)
                                        .setColor('#95A5A6') // Grey color for ended stream
                                        .setDescription(`${embed.description}\n\n**Stream Ended.**`)
                                        .setFields([]); // Clear dynamic fields if any
                                    await messageToProcess.edit({ embeds: [updatedEmbed], components: [] }).catch(e => {
                                        logger.error(`[Check] Failed to edit message ${ann.message_id} before deletion:`, { category: 'stream-check', error: e.stack });
                                    });
                                    logger.info(`[Check] Edited message for ended announcement ${ann.announcement_id} in channel ${ann.channel_id} before deletion.`, { category: 'stream-check' });
                                }
                            }
                            // Now, delete the message regardless of the delete_on_end setting
                            await messageToProcess.delete().catch(err => {
                                if (err.code !== 10008) logger.error(`[Check] Failed to delete message ${ann.message_id} in channel ${ann.channel_id}:`, { category: 'stream-check', error: err.stack });
                            });
                            logger.info(`[Check] Deleting message for ended announcement ${ann.announcement_id} in channel ${ann.channel_id}.`, { category: 'stream-check' });
                        } else {
                            logger.warn(`[Check] Message ${ann.message_id} not found for deletion in channel ${ann.channel_id}.`, { category: 'stream-check' });
                        }
                    }
                    announcementIdsToDelete.push(ann.announcement_id);
                } catch (e) {
                    logger.error(`[Check] Error during cleanup for announcement ${ann.announcement_id}:`, { category: 'stream-check', error: e.stack });
                    if (e.code === 10003 || e.code === 10008) announcementIdsToDelete.push(ann.announcement_id);
                }
            }
            if (announcementIdsToDelete.length > 0) {
                await db.execute(`DELETE FROM announcements WHERE announcement_id IN (${announcementIdsToDelete.join(',')})`);
                logger.info(`[Check] Cleaned up ${announcementIdsToDelete.length} ended stream announcements from the database.`, { category: 'stream-check' });
            }
        }

        if (announcementQueue.length > 0) {
            const announcementBullQueue = new Queue('announcement-queue', { connection: cache.redisOptions });
            await announcementBullQueue.addBulk(announcementQueue);
            await announcementBullQueue.close();
        }

    } catch (error) {
        logger.error('[Check] CRITICAL ERROR in checkStreams:', { category: 'stream-check', error: error.stack });
    } finally {
        logger.info('[Check] ---> Finished stream check', { category: 'stream-check' });
    }
}

async function checkTeams(client) {
    logger.info('[Team Sync] ---> Starting hourly team sync @ ' + new Date().toLocaleTimeString(), { category: 'team-sync' });
    try {
        const [teamSubscriptions] = await db.execute('SELECT id FROM twitch_teams');
        logger.debug(`DEBUG (checkTeams): teamSubscriptionsRawResult:`, { teamSubscriptions, category: 'team-sync' });

        if (teamSubscriptions && teamSubscriptions.length > 0) {
            logger.info(`[Team Sync] Found ${teamSubscriptions.length} teams to sync. Running in parallel...`, { category: 'team-sync' });
            const syncPromises = teamSubscriptions.map(team => syncTwitchTeam(team.id, db));
            const results = await Promise.allSettled(syncPromises);

            results.forEach((result, index) => {
                const teamId = teamSubscriptions[index].id;
                if (result.status === 'fulfilled') {
                    if (!result.value.success) {
                        logger.warn(`[Team Sync] Team sync for ID ${teamId} completed with issues: ${result.value.message}`, { category: 'team-sync' });
                    }
                } else { // result.status === 'rejected'
                    logger.error(`[Team Sync] Team sync for ID ${teamId} failed unexpectedly: ${result.reason.stack || result.reason}`, { category: 'team-sync' });
                }
            });

            logger.info('[Team Sync] All team sync promises resolved.', { category: 'team-sync' });
        } else {
            logger.info('[Team Sync] No teams to sync.', { category: 'team-sync' });
        }
    } catch (error) {
        logger.error('[Team Sync] CRITICAL ERROR in checkTeams:', { category: 'team-sync', error: error.stack });
    } finally {
        logger.info('[Team Sync] ---> Finished hourly team sync.', { category: 'team-sync' });
    }
}

module.exports = { checkStreams, checkTeams };