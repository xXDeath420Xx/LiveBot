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
        const [guilds] = await connection.query('SELECT guild_id FROM guilds');

        for (const g of guilds) {
            const guild = await client.guilds.fetch(g.guild_id).catch(() => null);
            if (!guild) continue;

            const [guildRoles] = await connection.query('SELECT live_role_id FROM guilds WHERE guild_id = ? AND live_role_id IS NOT NULL', [guild.id]);
            const [teamRoles] = await connection.query('SELECT live_role_id FROM twitch_teams WHERE guild_id = ? AND live_role_id IS NOT NULL', [guild.id]);
            const [subRoles] = await connection.query('SELECT live_role_id FROM subscriptions WHERE guild_id = ? AND live_role_id IS NOT NULL', [guild.id]);
            
            const allRoleIds = new Set([...guildRoles.map(r => r.live_role_id), ...teamRoles.map(r => r.live_role_id), ...subRoles.map(r => r.live_role_id)]);

            if (allRoleIds.size === 0) continue;

            await guild.members.fetch();

            const membersToCheck = new Map();
            for (const roleId of allRoleIds) {
                const role = await guild.roles.fetch(roleId).catch(() => null);
                if (!role) continue;

                if (role.members.size > 0) {
                    logger.info(`Found ${role.members.size} members with role '${role.name}' for potential cleanup.`, { guildId: guild.id, category: "streams" });
                }

                for (const [memberId, member] of role.members) {
                    if (!membersToCheck.has(memberId)) {
                        membersToCheck.set(memberId, member);
                    }
                }
            }

            if (membersToCheck.size > 0) {
                logger.info(`Checking a total of ${membersToCheck.size} unique members in guild ${guild.name}.`, { guildId: guild.id, category: "streams" });
            }

            for (const member of membersToCheck.values()) {
                try {
                    const [streamerRows] = await connection.query('SELECT username, platform FROM streamers WHERE discord_user_id = ?', [member.id]);
                    
                    let isActuallyLive = false;
                    if (streamerRows.length > 0) {
                        for (const streamer of streamerRows) {
                            const api = platformModules[streamer.platform];
                            if (api && await api.isStreamerLive(streamer.username)) {
                                isActuallyLive = true;
                                break;
                            }
                        }
                    }

                    if (!isActuallyLive) {
                        for (const roleId of allRoleIds) {
                            if (member.roles.cache.has(roleId)) {
                                const roleToRemove = await guild.roles.fetch(roleId).catch(() => null);
                                if (roleToRemove) {
                                    logger.info(`Removing stale role '${roleToRemove.name}' from ${member.user.tag}.`, { guildId: guild.id, userId: member.id, category: "streams" });
                                    await member.roles.remove(roleToRemove);
                                }
                            }
                        }
                    }
                } catch (e) {
                    logger.error(`Error processing member ${member.id} in cleanup`, { error: e, guildId: guild.id, category: "streams" });
                }
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
        const [subscriptions] = await connection.query(
            `SELECT sub.guild_id, sub.announcement_channel_id AS sub_channel_id, sub.live_role_id AS sub_role_id, sub.override_nickname, sub.override_avatar_url, sub.team_subscription_id, s.discord_user_id, s.username, s.platform
             FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id 
             WHERE s.discord_user_id IS NOT NULL`
        );
        const [teams] = await connection.query('SELECT id, announcement_channel_id AS team_channel_id, live_role_id AS team_role_id, webhook_name AS team_webhook_name, webhook_avatar_url AS team_webhook_avatar FROM twitch_teams');
        const [guildSettings] = await connection.query('SELECT guild_id, announcement_channel_id AS guild_channel_id, live_role_id AS guild_role_id, bot_nickname AS guild_webhook_name, webhook_avatar_url AS guild_webhook_avatar FROM guilds');

        const teamsMap = new Map(teams.map(t => [t.id, t]));
        const guildsMap = new Map(guildSettings.map(g => [g.guild_id, g]));

        for (const sub of subscriptions) {
            const guildDefault = guildsMap.get(sub.guild_id);
            if (!guildDefault) continue;

            const team = sub.team_subscription_id ? teamsMap.get(sub.team_subscription_id) : null;
            const finalChannelId = sub.sub_channel_id || team?.team_channel_id || guildDefault.guild_channel_id;
            const finalRoleId = sub.sub_role_id || team?.team_role_id || guildDefault.guild_role_id;

            if (!finalChannelId || !finalRoleId) continue;

            const guild = await client.guilds.fetch(sub.guild_id).catch(() => null);
            if (!guild) continue;

            const announcementChannel = await guild.channels.fetch(finalChannelId).catch(() => null);
            const liveRole = await guild.roles.fetch(finalRoleId).catch(() => null);

            if (!announcementChannel || !liveRole) continue;
            
            const webhookConfig = {
                username: sub.override_nickname || team?.team_webhook_name || guildDefault.guild_webhook_name || client.user.username,
                avatarURL: sub.override_avatar_url || team?.team_webhook_avatar || guildDefault.guild_webhook_avatar || client.user.displayAvatarURL()
            };

            await processStreamer(guild, { discord_user_id: sub.discord_user_id, username: sub.username, platform: sub.platform }, announcementChannel, liveRole, webhookConfig);
        }
    } catch (error) {
        logger.error("Failed to run stream checker process:", { error, category: "streams" });
    } finally {
        if (connection) connection.release();
    }
}

async function processStreamer(guild, streamer, channel, role, webhookConfig) {
    try {
        const api = platformModules[streamer.platform];
        if (!api) return;

        const isLive = await api.isStreamerLive(streamer.username);
        const member = await guild.members.fetch(streamer.discord_user_id).catch(() => null);
        if (!member) return;

        const hasLiveRole = member.roles.cache.has(role.id);
        const announcementKey = `${guild.id}-${member.id}-${streamer.platform}`;
        const announcementId = liveAnnouncements.get(announcementKey);

        if (isLive) {
            if (!hasLiveRole) {
                await member.roles.add(role).catch(e => logger.error(`Failed to add role:`, { error: e, guildId: guild.id, memberId: member.id, roleId: role.id, category: "streams" }));
            }
            if (!announcementId) {
                const streamData = await api.getStreamDetails(streamer.username);
                if (!streamData) return;

                const embed = new EmbedBuilder()
                    .setColor(streamer.platform === 'kick' ? 0x00FF00 : 0x6441A5)
                    .setAuthor({ name: `${member.displayName} is now live on ${streamer.platform.charAt(0).toUpperCase() + streamer.platform.slice(1)}!`, iconURL: member.user.displayAvatarURL() })
                    .setTitle(streamData.title)
                    .setURL(streamer.platform === 'kick' ? `https://kick.com/${streamer.username}` : `https://twitch.tv/${streamer.username}`)
                    .setImage(streamData.thumbnail_url?.replace("{width}", "1280").replace("{height}", "720"))
                    .addFields(
                        { name: "Game", value: streamData.game_name || "Not Set", inline: true },
                        { name: "Viewers", value: `${streamData.viewer_count}`, inline: true }
                    )
                    .setTimestamp();
                
                const message = await sendWithWebhook(channel, { ...webhookConfig, embeds: [embed] });
                if (message) liveAnnouncements.set(announcementKey, message.id);
            }
        } else { 
            if (hasLiveRole) {
                await member.roles.remove(role).catch(e => logger.error(`Failed to remove role:`, { error: e, guildId: guild.id, memberId: member.id, roleId: role.id, category: "streams" }));
            }
            if (announcementId) {
                const message = await channel.messages.fetch(announcementId).catch(() => null);
                if (message) {
                    await message.delete().catch(e => logger.error(`Failed to delete announcement:`, { error: e, guildId: guild.id, messageId: announcementId, category: "streams" }));
                }
                liveAnnouncements.delete(announcementKey);
            }
        }
    } catch (error) {
        logger.error(`Error processing streamer ${streamer.username}:`, { error, guildId: guild.id, streamer: streamer.username, category: "streams" });
    }
}

async function init(client) {
    logger.info("Initializing aggressive stream manager...");
    
    await aggressiveCleanup(client);
    await purgeOldAnnouncements(client);
    await checkStreamers(client);
}

module.exports = { init };