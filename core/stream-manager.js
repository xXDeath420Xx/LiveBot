const { EmbedBuilder } = require("discord.js");
const db = require("../utils/db");
const twitchApi = require("../utils/twitch-api");
const kickApi = require("../utils/kick-api");
const logger = require("../utils/logger");
const { sendWithWebhook } = require("./webhook-manager.js");

const liveAnnouncements = new Map();

const platformModules = {
    twitch: twitchApi,
    kick: kickApi,
};

async function aggressiveCleanup(client) {
    logger.info("Starting aggressive cleanup of stale live roles...", { category: "streams" });
    let connection;
    try {
        connection = await db.getConnection();
        const [allGuilds] = await connection.query('SELECT guild_id FROM guilds');

        const membersToProcess = new Map(); // Map<memberId, { member: GuildMember, guilds: Map<guildId, Set<roleId>> }>
        const liveStatusCache = new Map(); // Cache for live status to avoid re-checking the same streamer account

        // Phase 1: Gather all members with live roles across all guilds
        for (const g of allGuilds) {
            const guild = await client.guilds.fetch(g.guild_id).catch(() => null);
            if (!guild) continue;

            const [guildRoles] = await connection.query('SELECT live_role_id FROM guilds WHERE guild_id = ? AND live_role_id IS NOT NULL', [guild.id]);
            const [teamRoles] = await connection.query('SELECT live_role_id FROM twitch_teams WHERE guild_id = ? AND live_role_id IS NOT NULL', [guild.id]);
            const [subRoles] = await connection.query('SELECT live_role_id FROM subscriptions WHERE guild_id = ? AND live_role_id IS NOT NULL', [guild.id]);
            
            const allRoleIds = new Set([...guildRoles.map(r => r.live_role_id), ...teamRoles.map(r => r.live_role_id), ...subRoles.map(r => r.live_role_id)]);

            if (allRoleIds.size === 0) continue;

            const members = await guild.members.fetch().catch(() => {
                logger.warn(`Failed to fetch members for guild ${guild.id}.`, { guildId: guild.id, category: "streams" });
                return new Map();
            });

            for (const member of members.values()) {
                const memberRoles = member.roles.cache.filter(role => allRoleIds.has(role.id));
                if (memberRoles.size > 0) {
                    if (!membersToProcess.has(member.id)) {
                        membersToProcess.set(member.id, { member, guilds: new Map() });
                    }
                    membersToProcess.get(member.id).guilds.set(guild.id, new Set(memberRoles.keys()));
                }
            }
        }

        logger.info(`Found ${membersToProcess.size} unique members with live roles across all guilds for cleanup check.`);

        // Phase 2: Process unique members
        for (const { member, guilds } of membersToProcess.values()) {
            try {
                const [streamerRows] = await connection.query('SELECT username, platform FROM streamers WHERE discord_user_id = ?', [member.id]);
                
                let isActuallyLive = false;
                if (streamerRows.length > 0) {
                    for (const streamer of streamerRows) {
                        const cacheKey = `${streamer.platform}:${streamer.username}`;
                        if (liveStatusCache.has(cacheKey)) {
                            isActuallyLive = liveStatusCache.get(cacheKey);
                        } else {
                            const api = platformModules[streamer.platform];
                            if (api) {
                                const liveStatus = await api.isStreamerLive(streamer.username);
                                liveStatusCache.set(cacheKey, liveStatus);
                                isActuallyLive = liveStatus;
                            }
                        }
                        if (isActuallyLive) break; // If any account is live, no need to check others
                    }
                }

                if (!isActuallyLive) {
                    // User is not live on any platform, remove all live roles from all relevant guilds
                    for (const [guildId, roleIds] of guilds.entries()) {
                        const guild = await client.guilds.fetch(guildId).catch(() => null);
                        if (!guild) continue;

                        // Refetch member for this specific guild to be safe
                        const guildMember = await guild.members.fetch(member.id).catch(() => null);
                        if (!guildMember) continue;

                        for (const roleId of roleIds) {
                            if (guildMember.roles.cache.has(roleId)) {
                                const roleToRemove = await guild.roles.fetch(roleId).catch(() => null);
                                if (roleToRemove) {
                                    logger.info(`Removing stale role '${roleToRemove.name}' from ${guildMember.user.tag} in guild ${guild.name}.`, { guildId: guild.id, userId: guildMember.id, category: "streams" });
                                    await guildMember.roles.remove(roleToRemove).catch(e => logger.error(`Failed to remove role ${roleId} from member ${guildMember.id} in guild ${guild.id}`, { error: e }));
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                logger.error(`Error processing member ${member.id} in global cleanup`, { error: e, userId: member.id, category: "streams" });
            }
        }

    } catch (error) {
        logger.error("Critical error during aggressive cleanup.", { error, category: "streams" });
    } finally {
        if (connection) connection.release();
        logger.info("Aggressive role cleanup finished.", { category: "streams" });
    }
}

async function purgeOldAnnouncements(client) {
    logger.info("Purging all old bot announcements from configured channels...", { category: "streams" });
    let connection;
    try {
        connection = await db.getConnection();
        const [guildCh] = await connection.query('SELECT announcement_channel_id FROM guilds WHERE announcement_channel_id IS NOT NULL');
        const [teamCh] = await connection.query('SELECT announcement_channel_id FROM twitch_teams WHERE announcement_channel_id IS NOT NULL');
        const [subCh] = await connection.query('SELECT announcement_channel_id FROM subscriptions WHERE announcement_channel_id IS NOT NULL');
        
        const allChannelIds = new Set([...guildCh.map(r => r.announcement_channel_id), ...teamCh.map(r => r.announcement_channel_id), ...subCh.map(r => r.announcement_channel_id)]);

        for (const channelId of allChannelIds) {
            try {
                const channel = await client.channels.fetch(channelId);
                const messages = await channel.messages.fetch({ limit: 100 });
                const botMessages = messages.filter(m => m.author.id === client.user.id || m.webhookId);
                if (botMessages.size > 0) {
                    await channel.bulkDelete(botMessages);
                    logger.info(`Purged ${botMessages.size} old announcements from #${channel.name}.`, { category: "streams" });
                }
            } catch (e) {
                logger.warn(`Could not purge announcements from channel ${channelId}. It may no longer exist or permissions are missing.`, { error: e.message, category: "streams" });
            }
        }
    } catch (error) {
        logger.error("Critical error during announcement purge.", { error, category: "streams" });
    } finally {
        if (connection) connection.release();
        logger.info("Announcement purge finished.", { category: "streams" });
    }
}

async function checkStreamers(client) {
    let connection;
    try {
        connection = await db.getConnection();
        const [subscriptions, teams, guildSettings] = await Promise.all([
            connection.query(
                `SELECT sub.guild_id, sub.announcement_channel_id AS sub_channel_id, sub.live_role_id AS sub_role_id, sub.override_nickname, sub.override_avatar_url, sub.team_subscription_id, s.streamer_id, s.discord_user_id, s.username, s.platform
                 FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id`
            ),
            connection.query('SELECT id, announcement_channel_id AS team_channel_id, live_role_id AS team_role_id, webhook_name AS team_webhook_name, webhook_avatar_url AS team_webhook_avatar FROM twitch_teams'),
            connection.query('SELECT guild_id, announcement_channel_id AS guild_channel_id, live_role_id AS guild_role_id, bot_nickname AS guild_webhook_name, webhook_avatar_url AS guild_webhook_avatar FROM guilds')
        ]);

        const teamsMap = new Map(teams[0].map(t => [t.id, t]));
        const guildsMap = new Map(guildSettings[0].map(g => [g.guild_id, g]));

        const streamersToCheck = new Map();
        for (const sub of subscriptions[0]) {
            const key = `${sub.platform}-${sub.username}`;
            if (!streamersToCheck.has(key)) {
                streamersToCheck.set(key, {
                    streamerInfo: {
                        streamer_id: sub.streamer_id,
                        discord_user_id: sub.discord_user_id,
                        username: sub.username,
                        platform: sub.platform,
                    },
                    subscriptions: []
                });
            }
            streamersToCheck.get(key).subscriptions.push(sub);
        }

        for (const { streamerInfo, subscriptions } of streamersToCheck.values()) {
            await processUniqueStreamer(client, streamerInfo, subscriptions, guildsMap, teamsMap);
        }

    } catch (error) {
        logger.error("Failed to run stream checker process:", { error, category: "streams" });
    } finally {
        if (connection) connection.release();
    }
}

async function processUniqueStreamer(client, streamer, subscriptions, guildsMap, teamsMap) {
    const api = platformModules[streamer.platform];
    if (!api) return;

    try {
        const isLive = await api.isStreamerLive(streamer.username);
        let streamData = null;
        if (isLive) {
            streamData = await api.getStreamDetails(streamer.username);
            if (!streamData) {
                logger.warn(`[Stream Manager] Streamer ${streamer.username} on ${streamer.platform} reported live but getStreamDetails returned null. Skipping announcement.`, { category: "streams" });
            }
        }

        for (const sub of subscriptions) {
            const guildDefault = guildsMap.get(sub.guild_id);
            if (!guildDefault) continue;

            const guild = await client.guilds.fetch(sub.guild_id).catch(() => null);
            if (!guild) continue;

            let member = null;
            if (streamer.discord_user_id) {
                member = await guild.members.fetch(streamer.discord_user_id).catch(() => null);
            }

            const team = sub.team_subscription_id ? teamsMap.get(sub.team_subscription_id) : null;

            const finalRoleId = sub.sub_role_id || team?.team_role_id || guildDefault.guild_role_id;
            const finalChannelId = sub.sub_channel_id || team?.team_channel_id || guildDefault.guild_channel_id;

            if (!finalRoleId && !finalChannelId) continue;

            const announcementKey = `${guild.id}-${streamer.platform}-${streamer.username}-${finalChannelId}`;
            const announcementData = liveAnnouncements.get(announcementKey);

            let liveRole = null;
            if (finalRoleId) {
                liveRole = await guild.roles.fetch(finalRoleId).catch(() => null);
            }

            const hasLiveRole = member && liveRole ? member.roles.cache.has(liveRole.id) : false;

            if (isLive && streamData) {
                if (member && liveRole && !hasLiveRole) {
                    await member.roles.add(liveRole).catch(e => logger.error(`Failed to add role:`, { error: e, guildId: guild.id, memberId: member.id, roleId: liveRole.id, category: "streams" }));
                }

                if (finalChannelId && !announcementData) {
                    const announcementChannel = await guild.channels.fetch(finalChannelId).catch(() => null);
                    if (announcementChannel) {
                        const webhookConfig = {
                            username: member?.displayName || streamer.username,
                            avatarURL: member?.user?.displayAvatarURL() || client.user.displayAvatarURL()
                        };

                        const embed = new EmbedBuilder()
                            .setColor(streamer.platform === 'kick' ? 0x00FF00 : 0x6441A5)
                            .setAuthor({ name: `${streamer.username} is now live on ${streamer.platform.charAt(0).toUpperCase() + streamer.platform.slice(1)}!`, iconURL: webhookConfig.avatarURL })
                            .setTitle(streamData.title)
                            .setURL(streamer.platform === 'kick' ? `https://kick.com/${streamer.username}` : `https://twitch.tv/${streamer.username}`)
                            .setImage(streamData.thumbnail_url?.replace("{width}", "1280").replace("{height}", "720"))
                            .addFields(
                                { name: "Game", value: streamData.game_name || "Not Set", inline: true },
                                { name: "Viewers", value: `${streamData.viewer_count}`, inline: true }
                            )
                            .setTimestamp();
                        
                        const message = await sendWithWebhook(announcementChannel, { ...webhookConfig, embeds: [embed] });
                        if (message) {
                            liveAnnouncements.set(announcementKey, {
                                messageId: message.id,
                                streamerId: streamer.streamer_id,
                                platform: streamer.platform,
                                username: streamer.username,
                                discordUserId: streamer.discord_user_id
                            });
                        }
                    }
                }
            } else {
                if (member && liveRole && hasLiveRole) {
                    await member.roles.remove(liveRole).catch(e => logger.error(`Failed to remove role:`, { error: e, guildId: guild.id, memberId: member.id, roleId: liveRole.id, category: "streams" }));
                }
                if (announcementData) {
                    const announcementChannel = await guild.channels.fetch(finalChannelId).catch(() => null);
                    if (announcementChannel) {
                        const message = await announcementChannel.messages.fetch(announcementData.messageId).catch(() => null);
                        if (message) {
                            await message.delete().catch(e => logger.error(`Failed to delete announcement:`, { error: e, guildId: guild.id, messageId: announcementData.messageId, category: "streams" }));
                        }
                    }
                    liveAnnouncements.delete(announcementKey);
                }
            }
        }
    } catch (error) {
        logger.error(`Error processing unique streamer ${streamer.username} on ${streamer.platform}:`, { error, category: "streams" });
    }
}

async function init(client) {
    logger.info("Initializing aggressive stream manager...");
    
    await aggressiveCleanup(client);
    await purgeOldAnnouncements(client);
    await checkStreamers(client);
}

function getLiveAnnouncements() {
    return liveAnnouncements;
}

module.exports = { 
    init,
    getLiveAnnouncements
};