const db = require('../utils/db');
const apiChecks = require('../utils/api_checks');
const { connection: redis, redisOptions } = require('../utils/cache');
const logger = require('../utils/logger');
const { Queue } = require('bullmq');
const { syncTwitchTeam } = require('./team-sync');
const { processRole } = require('./role-manager');
const { EmbedBuilder } = require('discord.js');

let aggressiveCheckCounter = 0;
const AGGRESSIVE_CHECK_INTERVAL = 10; // Every 10 minutes with a 1-minute stream check cycle

async function checkStreams(client) {
    logger.info('[Check] ---> Starting stream check @ ' + new Date().toLocaleTimeString(), { category: 'stream-check' });
    try {
        const [subscriptions] = await db.execute('SELECT sub.*, s.platform_user_id, s.username, s.platform, s.kick_username, s.discord_user_id FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id');
        const [existingAnnouncements] = await db.execute('SELECT * FROM announcements');
        const [guildSettings] = await db.execute('SELECT * FROM guilds');
        const [teamSettings] = await db.execute('SELECT * FROM twitch_teams');

        const uniqueStreamers = [...new Map(subscriptions.map(s => [`${s.platform}:${s.username}`, s])).values()];

        const statuses = new Map();
        for (const streamer of uniqueStreamers) {
            const cacheKey = `api:${streamer.platform}:${streamer.username}`;
            let status = await redis.get(cacheKey);
            if (status) status = JSON.parse(status);

            if (!status) {
                switch (streamer.platform) {
                    case 'twitch': status = await apiChecks.checkTwitch(streamer); break;
                    case 'kick': status = await apiChecks.checkKick(streamer.kick_username); break;
                    case 'youtube': status = await apiChecks.checkYouTube(streamer.platform_user_id); break;
                    case 'tiktok': status = await apiChecks.checkTikTok(streamer.username); break;
                    case 'trovo': status = await apiChecks.checkTrovo(streamer.username); break;
                    default: status = { isLive: false };
                }
                await redis.set(cacheKey, JSON.stringify(status), 'EX', 300);
            }

            const consecutiveFailsCacheKey = `consecutive_fails:${streamer.platform}:${streamer.username}`;
            let consecutiveFails = await redis.get(consecutiveFailsCacheKey);
            consecutiveFails = consecutiveFails ? parseInt(consecutiveFails, 10) : 0;

            if (status.isLive === true) {
                await redis.del(consecutiveFailsCacheKey);
            } else {
                consecutiveFails++;
                await redis.set(consecutiveFailsCacheKey, consecutiveFails, 'EX', 900);
                if (consecutiveFails < 2) {
                    status.isLive = 'unknown';
                } else {
                    await redis.del(consecutiveFailsCacheKey);
                    status.isLive = false;
                }
            }
            statuses.set(`${streamer.platform}:${streamer.username}`, status);
        }

        // AGGRESSIVE ROLE CLEANUP
        aggressiveCheckCounter++;
        if (aggressiveCheckCounter >= AGGRESSIVE_CHECK_INTERVAL) {
            aggressiveCheckCounter = 0;
            logger.info('[Role-Check] Starting aggressive role cleanup.', { category: 'role-check' });
            const allGuildsWithLiveRole = guildSettings.filter(gs => gs.live_role_id);

            for (const guildSetting of allGuildsWithLiveRole) {
                try {
                    const guild = await client.guilds.fetch(guildSetting.guild_id).catch(() => null);
                    if (!guild) {
                        logger.warn(`[Role-Check] Could not fetch guild ${guildSetting.guild_id}.`, { guildId: guildSetting.guild_id, category: 'role-check' });
                        continue;
                    }

                    const liveRole = await guild.roles.fetch(guildSetting.live_role_id).catch(() => null);
                    if (!liveRole) {
                        logger.warn(`[Role-Check] Live role ${guildSetting.live_role_id} not found in guild ${guild.id}.`, { guildId: guild.id, category: 'role-check' });
                        continue;
                    }

                    const members = await guild.members.fetch().catch(err => {
                        logger.error(`[Role-Check] Failed to fetch members for guild ${guild.id}:`, { error: err, guildId: guild.id, category: 'role-check' });
                        return null;
                    });
                    if (!members) continue;

                    const membersWithRole = members.filter(member => member.roles.cache.has(liveRole.id));

                    for (const member of membersWithRole.values()) {
                        const isSubscribedAndLiveInThisGuild = subscriptions.some(sub => {
                            if (sub.discord_user_id !== member.id) return false;

                            const liveData = statuses.get(`${sub.platform}:${sub.username}`);
                            if (!liveData || liveData.isLive !== true) return false;

                            // Direct subscription in this guild
                            if (sub.guild_id === guild.id) return true;

                            // Team subscription in this guild
                            if (sub.team_subscription_id) {
                                const team = teamSettings.find(t => t.id === sub.team_subscription_id && t.guild_id === guild.id);
                                if (team) return true;
                            }

                            return false;
                        });

                        if (!isSubscribedAndLiveInThisGuild) {
                            logger.info(`[Role-Check] Aggressively removing live role from ${member.user.tag} in guild ${guild.name}.`, { guildId: guild.id, userId: member.id, category: 'role-check' });
                            await processRole(member, [liveRole.id], 'remove', guild.id);
                        }
                    }
                } catch (error) {
                    logger.error(`[Role-Check] Error during aggressive role cleanup for guild ${guildSetting.guild_id}:`, { error, guildId: guildSetting.guild_id, category: 'role-check' });
                }
            }
            logger.info('[Role-Check] Finished aggressive role cleanup.', { category: 'role-check' });
        }
        // END AGGRESSIVE ROLE CLEANUP

        const announcementQueue = [];
        for (const sub of subscriptions) {
            const liveData = statuses.get(`${sub.platform}:${sub.username}`);
            if (liveData && liveData.isLive === true) {
                // FIX: Prevent duplicate announcements by checking if one already exists
                const isAlreadyAnnounced = existingAnnouncements.some(ann => ann.subscription_id === sub.subscription_id);
                if (isAlreadyAnnounced) {
                    continue;
                }

                // FIX: Corrected typo from game_fame_filter to game_filter
                if (sub.game_filter && liveData.game && liveData.game.toLowerCase() !== sub.game_filter.toLowerCase()) continue;
                if (sub.title_filter && liveData.title && !liveData.title.toLowerCase().includes(sub.title_filter.toLowerCase())) continue;

                let targetChannelId = sub.announcement_channel_id;
                if (sub.team_subscription_id) {
                    const team = teamSettings.find(t => t.id === sub.team_subscription_id);
                    if (team) targetChannelId = team.announcement_channel_id;
                }
                if (!targetChannelId) continue;

                announcementQueue.push({ name: `announcement-${sub.subscription_id}`, data: { sub, liveData } });
            }
        }

        const endedStreams = existingAnnouncements.filter(ann => {
            const sub = subscriptions.find(s => s.subscription_id === ann.subscription_id);
            if (!sub) return true;
            const status = statuses.get(`${sub.platform}:${sub.username}`);
            return !status || status.isLive === false;
        });

        if (endedStreams.length > 0) {
            const announcementIdsToDelete = [];
            for (const ann of endedStreams) {
                const sub = subscriptions.find(s => s.subscription_id === ann.subscription_id);
                if (sub) {
                    const rolesToRemove = [];
                    const guildSetting = guildSettings.find(gs => gs.guild_id === sub.guild_id);
                    if (guildSetting?.live_role_id) rolesToRemove.push(guildSetting.live_role_id);
                    if (sub.team_subscription_id) {
                        const teamSetting = teamSettings.find(ts => ts.id === sub.team_subscription_id);
                        if (teamSetting?.live_role_id) rolesToRemove.push(teamSetting.live_role_id);
                    }
                    const uniqueRolesToRemove = [...new Set(rolesToRemove)];
                    if (uniqueRolesToRemove.length > 0 && sub.discord_user_id) {
                        try {
                            const guild = await client.guilds.fetch(sub.guild_id);
                            const member = await guild.members.fetch(sub.discord_user_id).catch(() => null);
                            if (member) await processRole(member, uniqueRolesToRemove, "remove", sub.guild_id);
                        } catch (roleError) {
                            logger.error(`[Check] Failed to remove live roles from ${sub.username}:`, { error: roleError, guildId: sub.guild_id });
                        }
                    }
                }

                try {
                    const channel = await client.channels.fetch(ann.channel_id).catch(() => null);
                    if (channel) {
                        const messageToProcess = await channel.messages.fetch(ann.message_id).catch(() => null);
                        if (messageToProcess) {
                            // FIX: Correctly handle message update or deletion
                            if (sub && !sub.delete_on_end && messageToProcess.editable) {
                                const embed = messageToProcess.embeds[0];
                                if (embed) {
                                    const updatedEmbed = new EmbedBuilder(embed.toJSON())
                                        .setColor('#95A5A6')
                                        .setDescription(`${embed.description}\\n\\n**Stream Ended.**`)
                                        .setFields([]);
                                    await messageToProcess.edit({ embeds: [updatedEmbed], components: [] });
                                }
                            } else {
                                await messageToProcess.delete().catch(err => {
                                    // Ignore error if message is already deleted
                                    if (err.code !== 10008) logger.warn(`[Check] Failed to delete message ${ann.message_id}:`, { error: err, guildId: sub.guild_id });
                                });
                            }
                        }
                    }
                    announcementIdsToDelete.push(ann.announcement_id);
                } catch (e) {
                    logger.error(`[Check] Error during cleanup for announcement ${ann.announcement_id}:`, { error: e, guildId: sub ? sub.guild_id : 'N/A' });
                    // If channel or message is gone, just remove from DB
                    if (e.code === 10003 || e.code === 10008) {
                        announcementIdsToDelete.push(ann.announcement_id);
                    }
                }
            }
            if (announcementIdsToDelete.length > 0) {
                const placeholders = announcementIdsToDelete.map(() => '?').join(',');
                await db.execute(`DELETE FROM announcements WHERE announcement_id IN (${placeholders})`, announcementIdsToDelete);
            }
        }

        if (announcementQueue.length > 0) {
            const announcementBullQueue = new Queue('announcement-queue', { connection: redisOptions });
            await announcementBullQueue.addBulk(announcementQueue);
            await announcementBullQueue.close();
        }

    } catch (error) {
        logger.error('[Check] CRITICAL ERROR in checkStreams:', { error });
    } finally {
        logger.info('[Check] ---> Finished stream check', { category: 'stream-check' });
    }
}

async function checkTeams(client) {
    logger.info('[Team Sync] ---> Starting hourly team sync @ ' + new Date().toLocaleTimeString(), { category: 'team-sync' });
    try {
        const [teamSubscriptions] = await db.execute('SELECT id FROM twitch_teams');
        if (teamSubscriptions && teamSubscriptions.length > 0) {
            const syncPromises = teamSubscriptions.map(team => syncTwitchTeam(team.id, db));
            await Promise.allSettled(syncPromises);
        }
    } catch (error) {
        logger.error('[Team Sync] CRITICAL ERROR in checkTeams:', { error });
    } finally {
        logger.info('[Team Sync] ---> Finished hourly team sync.', { category: 'team-sync' });
    }
}

module.exports = { checkStreams, checkTeams };
