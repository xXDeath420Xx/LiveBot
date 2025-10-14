const { SlashCommandBuilder, PermissionsBitField, ChannelType, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const db = require("../utils/db");
const logger = require("../utils/logger");
const apiChecks = require("../utils/api_checks");
const twitchApi = require("../utils/twitch-api");
const kickApi = require("../utils/kick-api");
const { getYouTubeChannelId } = require("../utils/api_checks");
const { exitCycleTLSInstance } = require("../utils/tls-manager");
const { getBrowser } = require("../utils/browserManager");
const axios = require("axios");
const Papa = require("papaparse");

module.exports = {
    data: new SlashCommandBuilder()
        .setName('team')
        .setDescription('Manage streaming teams.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
        .addSubcommand(subcommand => subcommand
            .setName('add')
            .setDescription('Adds all members of a Twitch Team to the announcement list for a channel.')
            .addStringOption(option => option
                .setName("team")
                .setDescription("The name of the Twitch Team (e.g., the \"reeferrealm\" in twitch.tv/team/reeferrealm).")
                .setRequired(true)
            )
            .addChannelOption(option => option
                .setName("channel")
                .setDescription("The channel where the team members will be announced.")
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true)
            )
        )
        .addSubcommand(subcommand => subcommand
            .setName('remove')
            .setDescription('Removes all members of a Twitch Team from a channel and purges their active announcements.')
            .addStringOption(option => option
                .setName("team")
                .setDescription("The name of the Twitch Team to remove (e.g., reeferrealm).")
                .setRequired(true)
            )
            .addChannelOption(option => option
                .setName("channel")
                .setDescription("The channel to remove the team members and announcements from.")
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true)
            )
        )
        .addSubcommand(subcommand => subcommand
            .setName('subscribe')
            .setDescription('Automate syncing a Twitch Team with a channel (adds/removes members).')
            .addStringOption(option => option
                .setName("team")
                .setDescription("The name of the Twitch Team to monitor (e.g., reeferrealm).")
                .setRequired(true)
            )
            .addChannelOption(option => option
                .setName("channel")
                .setDescription("The channel the team was synced with.")
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true)
            )
        )
        .addSubcommand(subcommand => subcommand
            .setName('unsubscribe')
            .setDescription('Stops automatically syncing a Twitch Team with a channel.')
            .addStringOption(option => option
                .setName("team")
                .setDescription("The name of the Twitch Team to stop monitoring.")
                .setRequired(true)
            )
            .addChannelOption(option => option
                .setName("channel")
                .setDescription("The channel the team was synced with.")
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true)
            )
        )
        .addSubcommand(subcommand => subcommand
            .setName('importcsv')
            .setDescription('Syncs a specific channel with a CSV, adding/updating and removing streamers.')
            .addAttachmentOption(o => o.setName("csvfile")
                .setDescription("CSV with headers: platform, username, discord_user_id, etc.")
                .setRequired(true)
            )
            .addChannelOption(o => o.setName("channel")
                .setDescription("The single channel to sync this team with.")
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true)
            )
        ),
    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const guild = interaction.guild;

        switch (subcommand) {
            case 'add': {
                await interaction.deferReply({ephemeral: true});

                const teamName = interaction.options.getString("team").toLowerCase();
                const channel = interaction.options.getChannel("channel");
                const guildId = interaction.guild.id;

                const added = [], updated = [], failed = [];

                try {
                    const teamMembers = await apiChecks.getTwitchTeamMembers(teamName);
                    if (!teamMembers) {
                        return interaction.editReply({content: `❌ Could not find a Twitch Team named \`${teamName}\`. Please check the name and try again.`});
                    }
                    if (teamMembers.length === 0) {
                        return interaction.editReply({content: `ℹ️ The Twitch Team \`${teamName}\` does not have any members.`});
                    }

                    for (const member of teamMembers) {
                        try {
                            await db.execute(
                                `INSERT INTO streamers (platform, platform_user_id, username) VALUES ('twitch', ?, ?)
                                 ON DUPLICATE KEY UPDATE username = VALUES(username)`,
                                [member.user_id, member.user_login]
                            );

                            const [[streamer]] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?", ["twitch", member.user_id]);

                            const [subResult] = await db.execute(
                                `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)
                                 ON DUPLICATE KEY UPDATE streamer_id = VALUES(streamer_id)`,
                                [guildId, streamer.streamer_id, channel.id]
                            );

                            if (subResult.affectedRows > 1) { // This indicates an UPDATE happened on duplicate key
                                updated.push(member.user_login);
                            } else {
                                added.push(member.user_login);
                            }

                        } catch (dbError) {
                            console.error(`Error processing team member ${member.user_login}:`, dbError);
                            failed.push(`${member.user_login} (DB Error)`);
                        }
                    }

                    const embed = new EmbedBuilder()
                        .setTitle(`Twitch Team Import Report for "${teamName}"`)
                        .setDescription(`All members have been added/updated for announcements in ${channel}.`)
                        .setColor("#5865F2")
                        .addFields(
                            {name: `✅ Added (${added.length})`, value: added.length > 0 ? added.join(", ").substring(0, 1020) : "None"},
                            {name: `🔄 Updated/Already Existed (${updated.length})`, value: updated.length > 0 ? updated.join(", ").substring(0, 1020) : "None"},
                            {name: `❌ Failed (${failed.length})`, value: failed.length > 0 ? failed.join(", ") : "None"}
                        )
                        .setTimestamp();

                    await interaction.editReply({embeds: [embed]});

                } catch (error) {
                    console.error("AddTeam Command Error:", error);
                    await interaction.editReply({content: "A critical error occurred while executing the command."});
                }
                break;
            }
            case 'remove': {
                await interaction.deferReply({ephemeral: true});

                const teamName = interaction.options.getString("team").toLowerCase();
                const channel = interaction.options.getChannel("channel");
                const guildId = interaction.guild.id;
                let purgedMessageCount = 0;

                try {
                    const teamMembers = await apiChecks.getTwitchTeamMembers(teamName);
                    if (!teamMembers) {
                        return interaction.editReply({content: `❌ Could not find a Twitch Team named \`${teamName}\`.`});
                    }
                    if (teamMembers.length === 0) {
                        return interaction.editReply({content: `ℹ️ The Twitch Team \`${teamName}\` has no members to remove.`});
                    }

                    const memberUserIds = teamMembers.map(m => m.user_id);
                    if (memberUserIds.length === 0) {
                        return interaction.editReply({content: `ℹ️ No valid members found for team \`${teamName}\`.`});
                    }

                    const placeholders = memberUserIds.map(() => "?").join(",");
                    const [streamers] = await db.execute(`SELECT streamer_id FROM streamers WHERE platform = 'twitch' AND platform_user_id IN (${placeholders})`, [...memberUserIds]);

                    if (streamers.length === 0) {
                        return interaction.editReply({content: `ℹ️ None of the members of team \`${teamName}\` were found in this server's subscription list for that channel.`});
                    }

                    const streamerIdsToRemove = streamers.map(s => s.streamer_id);
                    const subPlaceholders = streamerIdsToRemove.map(() => "?").join(",");

                    await db.query("START TRANSACTION");

                    const [announcementsToPurge] = await db.execute(
                        `SELECT message_id, channel_id FROM announcements WHERE guild_id = ? AND channel_id = ? AND streamer_id IN (${subPlaceholders})`,
                        [guildId, channel.id, ...streamerIdsToRemove]
                    );

                    if (announcementsToPurge.length > 0) {
                        const purgePromises = announcementsToPurge.map(announcement => {
                            return interaction.client.channels.fetch(announcement.channel_id)
                                .then(announcementChannel => announcementChannel?.messages.delete(announcement.message_id))
                                .catch(e => logger.warn(`[RemoveTeam] Failed to delete message ${announcement.message_id} in channel ${announcement.channel_id}: ${e.message}`));
                        });
                        await Promise.allSettled(purgePromises);
                        purgedMessageCount = announcementsToPurge.length;
                    }

                    const [deleteResult] = await db.execute(
                        `DELETE FROM subscriptions WHERE guild_id = ? AND announcement_channel_id = ? AND streamer_id IN (${subPlaceholders})`,
                        [guildId, channel.id, ...streamerIdsToRemove]
                    );

                    await db.query("COMMIT");

                    const embed = new EmbedBuilder()
                        .setTitle(`Twitch Team Removal Report for "${teamName}"`)
                        .setDescription(`Successfully processed team removal from ${channel}.`)
                        .setColor("#ED4245")
                        .addFields(
                            {name: "Subscriptions Removed", value: `${deleteResult.affectedRows}`, inline: true},
                            {name: "Announcements Purged", value: `${purgedMessageCount}`, inline: true}
                        )
                        .setTimestamp();

                    await interaction.editReply({embeds: [embed]});

                } catch (error) {
                    await db.query("ROLLBACK");
                    logger.error("[RemoveTeam Command Error]", error);
                    await interaction.editReply({content: "A critical error occurred while executing the command. The operation has been rolled back."});
                }
                break;
            }
            case 'subscribe': {
                await interaction.deferReply({ephemeral: true});

                const teamName = interaction.options.getString("team").toLowerCase();
                const channel = interaction.options.getChannel("channel");

                try {
                    await db.execute(
                        "INSERT INTO twitch_teams (guild_id, team_name, announcement_channel_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE team_name = VALUES(team_name), announcement_channel_id = VALUES(announcement_channel_id)",
                        [interaction.guild.id, teamName, channel.id]
                    );

                    const embed = new EmbedBuilder()
                        .setColor("#57F287")
                        .setTitle("✅ Team Subscription Activated")
                        .setDescription(`I will now automatically keep the member list for the Twitch Team **${teamName}** in sync with ${channel}.`)
                        .setFooter({text: "The team will be checked for updates approximately every 15 minutes."});

                    await interaction.editReply({embeds: [embed]});

                } catch (error) {
                    logger.error("[SubscribeTeam command error]", error);
                    await interaction.editReply({content: "A database error occurred while trying to subscribe to the team."});
                }
                break;
            }
            case 'unsubscribe': {
                await interaction.deferReply({ephemeral: true});

                const teamName = interaction.options.getString("team").toLowerCase();
                const channel = interaction.options.getChannel("channel");

                try {
                    const [result] = await db.execute(
                        "DELETE FROM twitch_teams WHERE guild_id = ? AND announcement_channel_id = ? AND team_name = ?",
                        [interaction.guild.id, channel.id, teamName]
                    );

                    if (result.affectedRows > 0) {
                        const embed = new EmbedBuilder()
                            .setColor("#ED4245")
                            .setTitle("🗑️ Team Subscription Deactivated")
                            .setDescription(`I will no longer automatically sync the Twitch Team **${teamName}** with the channel ${channel}. Note: Existing streamers will not be removed.`);
                        await interaction.editReply({embeds: [embed]});
                    } else {
                        await interaction.editReply({content: `No subscription was found for the Twitch Team **${teamName}** in that channel.`});
                    }
                } catch (error) {
                    logger.error("[UnsubscribeTeam command error]", error);
                    await interaction.editReply({content: "A database error occurred while trying to unsubscribe from the team."});
                }
                break;
            }
            case 'importcsv': {
                const file = interaction.options.getAttachment("csvfile");
                if (!file.name.endsWith(".csv")) {
                    return interaction.reply({content: "Invalid file type. Must be a `.csv` file.", flags: [MessageFlags.Ephemeral]});
                }

                await interaction.deferReply({ephemeral: true});

                const added = [], updated = [], failed = [], removed = [];
                let browser = null;

                try {
                    const fileContent = await axios.get(file.url, {responseType: "text"}).then(res => res.data);
                    const {data: rows} = Papa.parse(fileContent, {header: true, skipEmptyLines: true});
                    if (!rows || rows.length === 0) {
                        return interaction.editReply({content: "CSV is empty or does not contain valid data rows."});
                    }

                    const platformsInCsv = new Set(rows.map(r => r.platform).filter(Boolean));

                    if (platformsInCsv.has("youtube")) {
                        browser = await getBrowser();
                    }

                    const targetChannelId = interaction.options.getChannel("channel").id;

                    const [existingSubsInChannel] = await db.execute(
                        "SELECT s.streamer_id, s.username FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id WHERE sub.guild_id = ? AND sub.announcement_channel_id = ?",
                        [interaction.guild.id, targetChannelId]
                    );
                    const dbStreamerMap = new Map(existingSubsInChannel.map(sub => [sub.streamer_id, sub.username]));

                    const csvStreamerIds = new Set();

                    for (const row of rows) {
                        const {platform, username, discord_user_id, custom_message, override_nickname, override_avatar_url} = row;
                        if (!platform || !username) {
                            failed.push(`(Skipped row: missing platform/username)`);
                            continue;
                        }

                        const correctedDiscordId = /^[0-9]+$/.test(discord_user_id) ? discord_user_id : null;
                        if (discord_user_id && !correctedDiscordId) {
                            failed.push(`${username} (Invalid Discord ID)`);
                        }

                        try {
                            let streamerInfo = null;
                            let [[existingStreamer]] = await db.execute("SELECT streamer_id, platform_user_id, username FROM streamers WHERE platform = ? AND username = ?", [platform, username]);

                            if (existingStreamer) {
                                streamerInfo = {id: existingStreamer.streamer_id, puid: existingStreamer.platform_user_id, dbUsername: existingStreamer.username};
                            } else {
                                let apiResult;
                                if (platform === "twitch") {
                                    apiResult = await twitchApi.getTwitchUser(username);
                                    if (apiResult) streamerInfo = {puid: apiResult.id, dbUsername: apiResult.login};
                                } else if (platform === "kick") {
                                    apiResult = await kickApi.getKickUser(username);
                                    if (apiResult) streamerInfo = {puid: apiResult.id.toString(), dbUsername: apiResult.user.username};
                                } else if (platform === "youtube") {
                                    apiResult = await getYouTubeChannelId(username);
                                    if (apiResult?.channelId) streamerInfo = {puid: apiResult.channelId, dbUsername: apiResult.channelName || username};
                                } else if (["tiktok", "trovo"].includes(platform)) {
                                    streamerInfo = {puid: username, dbUsername: username};
                                }

                                if (!streamerInfo || !streamerInfo.puid) {
                                    failed.push(`${username} (${platform}, Not Found via API)`);
                                    continue;
                                }

                                const [result] = await db.execute(
                                    `INSERT INTO streamers (platform, platform_user_id, username, discord_user_id) VALUES (?, ?, ?, ?)
                                     ON DUPLICATE KEY UPDATE username=VALUES(username), discord_user_id=VALUES(discord_user_id)`,
                                    [platform, streamerInfo.puid, streamerInfo.dbUsername, correctedDiscordId]
                                );
                                const streamerId = result.insertId || (await db.execute("SELECT streamer_id FROM streamers WHERE platform=? AND platform_user_id=?", [platform, streamerInfo.puid]))[0][0].streamer_id;

                                csvStreamerIds.add(streamerId);

                                const [subResult] = await db.execute(
                                    `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, custom_message, override_nickname, override_avatar_url) VALUES (?, ?, ?, ?, ?, ?)
                                     ON DUPLICATE KEY UPDATE custom_message=VALUES(custom_message), override_nickname=VALUES(override_nickname), override_avatar_url=VALUES(override_avatar_url)`,
                                    [interaction.guild.id, streamerId, targetChannelId, custom_message || null, override_nickname || null, override_avatar_url || null]
                                );

                                if (subResult.affectedRows > 1) {
                                    updated.push(username);
                                } else {
                                    added.push(username);
                                }
                            }
                        } catch (err) {
                            logger.error(`[Import Team CSV] Row Error for ${username}:`, err);
                            failed.push(`${username} (DB Error)`);
                        }
                    }

                    const idsToRemove = [];
                    for (const [streamerId, streamerUsername] of dbStreamerMap.entries()) {
                        if (!csvStreamerIds.has(streamerId)) {
                            idsToRemove.push(streamerId);
                            removed.push(streamerUsername);
                        }
                    }

                    if (idsToRemove.length > 0) {
                        const placeholders = idsToRemove.map(() => "?").join(",");
                        await db.execute(
                            `DELETE FROM subscriptions WHERE guild_id = ? AND announcement_channel_id = ? AND streamer_id IN (${placeholders})`,
                            [interaction.guild.id, targetChannelId, ...idsToRemove]
                        );
                    }

                } catch (e) {
                    logger.error("[Import Team CSV] Main Error:", e);
                    return await interaction.editReply({content: `A critical error occurred processing the file: ${e.message}`});
                } finally {
                    if (browser) await browser.close();
                    await exitCycleTLSInstance();
                }

                const embed = new EmbedBuilder().setTitle(`Team Sync Complete for #${interaction.options.getChannel("channel").name}`).setColor("#5865F2");
                const field = (l) => l.length > 0 ? [...new Set(l)].join(", ").substring(0, 1020) : "None";
                embed.addFields(
                    {name: `✅ Added (${[...new Set(added)].length})`, value: field(added)},
                    {name: `🔄 Updated (${[...new Set(updated)].length} subscriptions)`, value: field(updated)},
                    {name: `❌ Failed (${[...new Set(failed)].length} rows)`, value: field(failed)}
                );
                await interaction.editReply({embeds: [embed]});
                break;
            }
            default:
                await interaction.reply({ content: 'Invalid team subcommand.', ephemeral: true });
                break;
        }
    },
};