const { SlashCommandBuilder, PermissionsBitField, ChannelType, EmbedBuilder, AttachmentBuilder, MessageFlagsBitField } = require('discord.js');
const db = require("../utils/db");
const logger = require("../utils/logger");
const crypto = require("crypto");

// Simple time string parser (e.g., "5m", "1h", "2d")
function parseDuration(durationStr) {
    const match = durationStr.match(/^(\\d+)(s|m|h|d)$/);
    if (!match) {
        return null;
    }

    const value = parseInt(match[1]);
    const unit = match[2];
    let milliseconds = 0;

    switch (unit) {
        case "s":
            milliseconds = value * 1000;
            break;
        case "m":
            milliseconds = value * 60 * 1000;
            break;
        case "h":
            milliseconds = value * 60 * 60 * 1000;
            break;
        case "d":
            milliseconds = value * 24 * 60 * 60 * 1000;
            break;
    }
    // Discord timeout max is 28 days
    if (milliseconds > 28 * 24 * 60 * 60 * 1000) {
        return 28 * 24 * 60 * 60 * 1000;
    }
    return milliseconds;
}

// Helper to parse time strings like "10s", "5m", "1h" into seconds
function parseTimeToSeconds(timeStr) {
    if (timeStr === "off" || timeStr === "0") {
        return 0;
    }
    const match = timeStr.match(/^(\\d+)(s|m|h)$/);
    if (!match) {
        return null;
    }

    const value = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
        case "s":
            return value;
        case "m":
            return value * 60;
        case "h":
            return value * 60 * 60;
    }
    return null;
}

// In a real scenario, you would use a proper password hashing library like bcrypt.
// Using crypto for demonstration purposes as it's a built-in Node module.
function verifyPassword(plainPassword, hash) {
    const [salt, key] = hash.split(":");
    const keyBuffer = Buffer.from(key, "hex");
    const derivedKey = crypto.scryptSync(plainPassword, salt, 64);
    return crypto.timingSafeEqual(keyBuffer, derivedKey);
}

const logOptions = [
    {name: "Message Deleted", value: "messageDelete"},
    {name: "Message Edited", value: "messageUpdate"},
    {name: "Member Roles Updated", value: "memberUpdate"},
    // Add more loggable events here in the future
];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('config')
        .setDescription('Manage server-specific configurations.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
        .addSubcommand(subcommand => subcommand
            .setName('setchannel')
            .setDescription('Sets the channel for live stream announcements.')
            .addChannelOption(o => o.setName("channel").setDescription("The channel for notifications").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        )
        .addSubcommand(subcommand => subcommand
            .setName('setliverole')
            .setDescription('Sets or clears the role to be assigned when a linked user goes live.')
            .addRoleOption(option => option.setName("role").setDescription("The role to assign. Leave blank to clear/disable.").setRequired(false))
        )
        .addSubcommand(subcommand => subcommand
            .setName('set-dj-role')
            .setDescription("Sets the DJ role. Users with this role can manage the music queue.")
            .addRoleOption(option => option.setName("role").setDescription("The role to set as the DJ role.").setRequired(true))
        )
        .addSubcommand(subcommand => subcommand
            .setName("logging")
            .setDescription("Configure the server audit log.")
            .addChannelOption(option => option
                .setName("channel")
                .setDescription("The channel where logs will be sent.")
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
            )
            .addStringOption(option => option
                .setName("event1")
                .setDescription("The first event to log.")
                .setRequired(true)
                .addChoices(...logOptions)
            )
            .addStringOption(option => option.setName("event2").setDescription("An additional event to log.").addChoices(...logOptions))
            .addStringOption(option => option.setName("event3").setDescription("An additional event to log.").addChoices(...logOptions))
        )
        .addSubcommand(subcommand => subcommand
            .setName('customizebot')
            .setDescription('Changes the bot\'s appearance (nickname/avatar) on this server.')
            .addStringOption(option => option
                .setName("nickname")
                .setDescription("The new nickname for the bot on this server (32 chars max). Type \"reset\" to remove.")
                .setRequired(false)
            )
            .addAttachmentOption(option => option
                .setName("avatar")
                .setDescription("The new avatar the bot will use for announcements.")
                .setRequired(false)
            )
            .addBooleanOption(option => option
                .setName("reset_avatar")
                .setDescription("Set to true to reset the custom announcement avatar to bot default.")
                .setRequired(false)
            )
        )
        .addSubcommand(subcommand => subcommand
            .setName('customizechannel')
            .setDescription('Sets a default webhook appearance for all announcements in a specific channel.')
            .addChannelOption(option => option
                .setName("channel")
                .setDescription("The channel to customize.")
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true)
            )
            .addStringOption(option => option.setName("nickname").setDescription("Default name for announcements in this channel. Type \"reset\" to clear."))
            .addAttachmentOption(option => option.setName("avatar").setDescription("Default avatar for announcements in this channel (upload file)."))
            .addStringOption(option => option.setName("avatar_url_text").setDescription("Default avatar URL (overrides file upload). Type \"reset\" to clear."))
        )
        .addSubcommand(subcommand => subcommand
            .setName('customizestreamer')
            .setDescription('Sets a custom name, avatar, or message for a specific streamer\'s announcements.')
            .addStringOption(option => option
                .setName("platform")
                .setDescription("The platform of the streamer to customize.")
                .setRequired(true)
                .addChoices(
                    {name: "Twitch", value: "twitch"}, {name: "Kick", value: "kick"},
                    {name: "YouTube", value: "youtube"}, {name: "tiktok", value: "tiktok"},
                    {name: "Trovo", value: "trovo"}
                )
            )
            .addStringOption(option => option.setName("username").setDescription("The username of the streamer to customize.").setRequired(true).setAutocomplete(true))
            .addChannelOption(option => option
                .setName("channel")
                .setDescription("The specific channel to customize. Leave blank for the server default channel.")
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(false)
            )
            .addStringOption(option => option.setName("nickname").setDescription("Custom name for announcements (max 80 chars). Type \"reset\" to clear.").setMaxLength(80))
            .addAttachmentOption(option => option
                .setName("avatar").setDescription("Custom avatar for announcements (upload file).")
            )
            .addStringOption(option => option
                .setName("avatar_url_text").setDescription("Custom avatar URL (overrides file upload). Type \"reset\" to clear.")
            )
            .addStringOption(option => option.setName("message").setDescription("Custom message. Placeholders: {username}, {url}, etc. Type \"reset\" to clear."))
        ),
    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        const subcommand = interaction.options.getSubcommand(false);

        if (subcommand === 'customizestreamer' && focusedOption.name === "username") {
            const platform = interaction.options.getString("platform");
            const focusedValue = focusedOption.value;
            if (!platform) return await interaction.respond([]);
            try {
                const [streamers] = await db.execute("SELECT username FROM streamers WHERE guild_id = ? AND platform = ? AND username LIKE ? LIMIT 25", [interaction.guild.id, platform, `${focusedValue}%`]);
                await interaction.respond(streamers.map(s => ({name: s.username, value: s.username})));
            } catch (error) {
                await interaction.respond([]);
            }
        }
    },
    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const guild = interaction.guild;

        switch (subcommand) {
            case 'setchannel': {
                const channel = interaction.options.getChannel("channel");
                const guildId = interaction.guild.id;

                await interaction.deferReply({flags: [MessageFlagsBitField.Flags.Ephemeral]});

                try {
                    await db.execute(
                        "INSERT INTO guilds (guild_id, announcement_channel_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE announcement_channel_id = VALUES(announcement_channel_id)",
                        [guildId, channel.id]
                    );

                    const embed = new EmbedBuilder()
                        .setColor("#00FF00")
                        .setTitle("✅ Channel Set!")
                        .setDescription(`Announcements will now be sent to ${channel}.`);
                    await interaction.editReply({embeds: [embed]});

                } catch (e) {
                    logger.error("[SetChannel Error]", e);
                    await interaction.editReply({content: "An error occurred while setting the channel."});
                }
                break;
            }
            case 'setliverole': {
                const role = interaction.options.getRole("role");
                const roleId = role ? role.id : null;
                const guildId = interaction.guild.id;

                await interaction.deferReply({flags: [MessageFlagsBitField.Flags.Ephemeral]});

                try {
                    if (role) {
                        const botMember = await interaction.guild.members.fetch(interaction.client.user.id);
                        if (role.position >= botMember.roles.highest.position) {
                            return interaction.editReply({content: `Error: The \"${role.name}\" role is higher than my role in the server hierarchy, so I cannot assign it.`});
                        }
                    }

                    await db.execute(
                        "INSERT INTO guilds (guild_id, live_role_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE live_role_id = VALUES(live_role_id)",
                        [guildId, roleId]
                    );

                    const embed = new EmbedBuilder().setColor(role ? "#57F287" : "#ED4245").setTitle("Live Role Updated");
                    embed.setDescription(role ? `The live role has been set to ${role}.` : "The live role has been cleared and is now disabled.");
                    await interaction.editReply({embeds: [embed]});

                } catch (e) {
                    logger.error("[SetLiveRole Error]", e);
                    await interaction.editReply({content: "A critical database error occurred."});
                }
                break;
            }
            case 'set-dj-role': {
                const role = interaction.options.getRole("role");
                const guildId = interaction.guild.id;

                try {
                    await db.execute("INSERT INTO music_config (guild_id, dj_role_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE dj_role_id = ?", [guildId, role.id, role.id]);
                    await interaction.reply({content: `✅ The DJ role has been set to <@&${role.id}>.`, flags: [MessageFlagsBitField.Flags.Ephemeral]});
                } catch (error) {
                    logger.error("[Config DJ Role Error]", error);
                    await interaction.reply({content: "❌ An error occurred while setting the DJ role.", flags: [MessageFlagsBitField.Flags.Ephemeral]});
                }
                break;
            }
            case 'logging': {
                await interaction.deferReply({flags: [MessageFlagsBitField.Flags.Ephemeral]});

                const channel = interaction.options.getChannel("channel");
                const enabledLogs = [
                    interaction.options.getString("event1"),
                    interaction.options.getString("event2"),
                    interaction.options.getString("event3"),
                ].filter(Boolean); // Filter out null values

                try {
                    await db.execute(
                        "INSERT INTO log_config (guild_id, log_channel_id, enabled_logs) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE log_channel_id = VALUES(log_channel_id), enabled_logs = VALUES(enabled_logs)",
                        [interaction.guild.id, channel.id, JSON.stringify(enabledLogs)]
                    );

                    const embed = new EmbedBuilder()
                        .setColor("#57F287")
                        .setTitle("✅ Logging Settings Updated")
                        .setDescription(`Logs will now be sent to ${channel}.`)
                        .addFields({name: "Enabled Events", value: enabledLogs.map(log => `\`${log}\``).join(", ")});

                    await interaction.editReply({embeds: [embed]});

                } catch (error) {
                    logger.error("[Logging Command Error]", error);
                    await interaction.editReply({content: "An error occurred while saving logging settings."});
                }
                break;
            }
            case 'customizebot': {
                await interaction.deferReply({flags: [MessageFlagsBitField.Flags.Ephemeral]});

                const newNickname = interaction.options.getString("nickname");
                const newAvatar = interaction.options.getAttachment("avatar");
                const resetAvatarFlag = interaction.options.getBoolean("reset_avatar");
                const guildId = interaction.guild.id;

                const shouldResetNickname = newNickname?.toLowerCase() === "reset";

                let nicknameUpdated = false;
                let avatarUpdated = false;
                let avatarReset = false;
                let finalAvatarUrlForEmbed = null;

                try {
                    const botMember = await interaction.guild.members.fetch(interaction.client.user.id);

                    if (shouldResetNickname) {
                        try {
                            await botMember.setNickname(null);
                            await db.execute("UPDATE guilds SET bot_nickname = NULL WHERE guild_id = ?", [guildId]);
                            nicknameUpdated = true;
                        } catch (e) {
                            logger.error("[Customize Bot Command] Failed to reset nickname:", e);
                            return interaction.editReply({content: "Failed to reset nickname. My role is likely not high enough in the role list or I lack permissions."});
                        }
                    } else if (newNickname) {
                        try {
                            await botMember.setNickname(newNickname);
                            await db.execute("UPDATE guilds SET bot_nickname = ? WHERE guild_id = ?", [newNickname, guildId]);
                            nicknameUpdated = true;
                        }
                        catch (e) {
                            logger.error("[Customize Bot Command] Failed to set nickname:", e);
                            return interaction.editReply({content: "Failed to set nickname. My role is likely not high enough in the role list."});
                        }
                    }

                    let permanentAvatarUrl = undefined;
                    if (resetAvatarFlag) {
                        permanentAvatarUrl = null;
                        avatarReset = true;
                    }
                    else if (newAvatar) {
                        if (!newAvatar.contentType.startsWith("image/")) {
                            return interaction.editReply({content: "Avatar must be an image file (PNG, JPG, GIF)."});
                        }
                        const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
                        if (!tempUploadChannelId) {
                            return interaction.editReply({content: "Temporary upload channel ID is not configured. Please set TEMP_UPLOAD_CHANNEL_ID in your .env file."});
                        }
                        try {
                            const tempChannel = await interaction.client.channels.fetch(tempUploadChannelId);
                            if (!tempChannel) {
                                throw new Error("Temporary upload channel not found.");
                            }
                            const tempMessage = await tempChannel.send({files: [{attachment: newAvatar.url, name: newAvatar.name}]});
                            permanentAvatarUrl = tempMessage.attachments.first().url;
                            avatarUpdated = true;
                        } catch (uploadError) {
                            logger.error("[Customize Bot Command] Error uploading temporary avatar to Discord:", uploadError);
                            return interaction.editReply({content: "Failed to upload custom avatar. Please check bot's permissions or TEMP_UPLOAD_CHANNEL_ID."});
                        }
                    }

                    if (permanentAvatarUrl !== undefined) {
                        await db.execute("UPDATE guilds SET webhook_avatar_url = ? WHERE guild_id = ?", [permanentAvatarUrl, guildId]);
                        finalAvatarUrlForEmbed = permanentAvatarUrl;
                    }

                    if (!nicknameUpdated && !avatarUpdated && !avatarReset) {
                        return interaction.editReply({content: "No changes were requested."});
                    }

                    const embed = new EmbedBuilder().setColor("#57F287").setTitle("Bot Appearance Updated!");
                    let description = "";
                    if (shouldResetNickname) {
                        description += "Bot nickname has been reset to default.\n";
                    } else if (nicknameUpdated) {
                        description += `Nickname set to: **${newNickname}**\n`;
                    }

                    if (avatarReset) {
                        description += "Announcement avatar has been reset to default.\n";
                    } else if (avatarUpdated) {
                        description += "Announcement avatar has been updated.\n";
                    }

                    embed.setDescription(description.trim());

                    if (avatarUpdated && finalAvatarUrlForEmbed) {
                        embed.setThumbnail(finalAvatarUrlForEmbed);
                    }
                    await interaction.editReply({embeds: [embed]});

                } catch (error) {
                    logger.error('Customize Bot Error:', error);
                    await interaction.editReply({content: `An error occurred: ${error.message}`});
                }
                break;
            }
            case 'customizechannel': {
                await interaction.deferReply({flags: [MessageFlagsBitField.Flags.Ephemeral]});

                const channel = interaction.options.getChannel("channel");
                const newNickname = interaction.options.getString("nickname");
                const newAvatarAttachment = interaction.options.getAttachment("avatar");
                const newAvatarUrlText = interaction.options.getString("avatar_url_text");

                if (newNickname === null && newAvatarAttachment === null && newAvatarUrlText === null) {
                    return interaction.editReply("You must provide a nickname, an avatar file, or an avatar URL to set/reset.");
                }

                let finalAvatarUrl = undefined;

                try {
                    if (newAvatarAttachment) {
                        if (!newAvatarAttachment.contentType?.startsWith("image/")) {
                            return interaction.editReply({content: "Avatar must be an image file (PNG, JPG, GIF)."});
                        }
                        const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
                        if (!tempUploadChannelId) {
                            logger.error("[Customize Channel Command] TEMP_UPLOAD_CHANNEL_ID is not configured.");
                            return interaction.editReply({content: "Temporary upload channel ID is not configured. Please set TEMP_UPLOAD_CHANNEL_ID in your .env file."});
                        }
                        try {
                            const tempChannel = await interaction.client.channels.fetch(tempUploadChannelId);
                            if (!tempChannel) {
                                throw new Error("Temporary upload channel not found.");
                            }
                            const tempMessage = await tempChannel.send({files: [{attachment: newAvatarAttachment.url, name: newAvatarAttachment.name}]});
                            finalAvatarUrl = tempMessage.attachments.first().url;
                        } catch (uploadError) {
                            logger.error("[Customize Channel Command] Error uploading temporary avatar to Discord:", uploadError);
                            return interaction.editReply({content: "Failed to upload custom avatar. Please check bot's permissions or TEMP_UPLOAD_CHANNEL_ID."});
                        }
                    } else if (newAvatarUrlText !== null) {
                        if (newAvatarUrlText?.toLowerCase() === "reset" || newAvatarUrlText === "") {
                            finalAvatarUrl = null;
                        }
                        else {
                            if (!newAvatarUrlText.startsWith('http://') && !newAvatarUrlText.startsWith('https://')) {
                                return interaction.editReply("The provided avatar URL must start with `http://` or `https://`.");
                            }
                            finalAvatarUrl = newAvatarUrlText;
                        }
                    }

                    const insertColumns = ["channel_id", "guild_id"];
                    const insertPlaceholders = ["?", "?"];
                    const insertValues = [channel.id, interaction.guild.id];
                    const updateClauses = [];
                    const updateValuesForDuplicateKey = [];

                    if (newNickname !== null) {
                        insertColumns.push("override_nickname");
                        insertPlaceholders.push("?");
                        const nicknameToSet = newNickname?.toLowerCase() === "reset" ? null : newNickname;
                        insertValues.push(nicknameToSet);
                        updateClauses.push("override_nickname = ?");
                        updateValuesForDuplicateKey.push(nicknameToSet);
                    }

                    if (finalAvatarUrl !== undefined) {
                        insertColumns.push("override_avatar_url");
                        insertPlaceholders.push("?");
                        insertValues.push(finalAvatarUrl);
                        updateClauses.push("override_avatar_url = ?");
                        updateValuesForDuplicateKey.push(finalAvatarUrl);
                    }

                    await db.execute(
                        `INSERT INTO channel_settings (${insertColumns.join(", ")}) VALUES (${insertPlaceholders.join(", ")}) ON DUPLICATE KEY UPDATE ${updateClauses.join(", ")}`,
                        [...insertValues, ...updateValuesForDuplicateKey]
                    );

                    const embed = new EmbedBuilder().setColor("#57F287").setTitle(`Channel Customization Updated for #${channel.name}`);
                    let description = "";

                    if (newNickname?.toLowerCase() === "reset") {
                        description += "Nickname has been reset to default.\n";
                    } else if (newNickname) {
                        description += `Nickname set to: **${newNickname}**\n`;
                    }
                    if (finalAvatarUrl === null) {
                        description += "Avatar has been reset to default.\n";
                    } else if (finalAvatarUrl !== undefined) {
                        description += "Avatar has been updated.\n";
                    }

                    embed.setDescription(description.trim());
                    if (finalAvatarUrl) {
                        embed.setThumbnail(finalAvatarUrl);
                    }

                    await interaction.editReply({embeds: [embed]});

                } catch (error) {
                    logger.error("[Customize Channel Error]", error);
                    await interaction.editReply(`An error occurred while updating the channel customization: ${error.message}.`);
                }
                break;
            }
            case 'customizestreamer': {
                await interaction.deferReply({flags: [MessageFlagsBitField.Flags.Ephemeral]});

                const platform = interaction.options.getString("platform");
                const username = interaction.options.getString("username");
                const channel = interaction.options.getChannel("channel");
                const targetChannelId = channel ? channel.id : null;

                const newNickname = interaction.options.getString("nickname");
                const newAvatarAttachment = interaction.options.getAttachment("avatar");
                const newAvatarUrlText = interaction.options.getString("avatar_url_text");
                const newMessage = interaction.options.getString("message");

                if (newNickname === null && newAvatarAttachment === null && newAvatarUrlText === null && newMessage === null) {
                    return interaction.editReply("You must provide at least one item to customize (nickname, avatar, or message).");
                }

                let finalAvatarUrl = undefined;

                try {
                    if (newAvatarUrlText !== null) {
                        const lowerCaseText = newAvatarUrlText.toLowerCase();
                        if (lowerCaseText === "reset" || lowerCaseText === "") {
                            finalAvatarUrl = null;
                        }
                        else {
                            if (!newAvatarUrlText.startsWith('http://') && !newAvatarUrlText.startsWith('https://')) {
                                return interaction.editReply("The provided avatar URL must start with `http://` or `https://`.");
                            }
                            finalAvatarUrl = newAvatarUrlText;
                        }
                    } else if (newAvatarAttachment) {
                        if (!newAvatarAttachment.contentType?.startsWith("image/")) {
                            return interaction.editReply({content: "Avatar must be an image file (PNG, JPG, GIF)."});
                        }
                        const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
                        if (!tempUploadChannelId) {
                            logger.error("[Customize Streamer Command] TEMP_UPLOAD_CHANNEL_ID is not configured.");
                            return interaction.editReply({content: "Temporary upload channel ID is not configured. Please set TEMP_UPLOAD_CHANNEL_ID in your .env file."});
                        }
                        try {
                            const tempChannel = await interaction.client.channels.fetch(tempUploadChannelId);
                            if (!tempChannel) {
                                throw new Error("Temporary upload channel not found.");
                            }
                            const tempMessage = await tempChannel.send({files: [{attachment: newAvatarAttachment.url, name: newAvatarAttachment.name}]});
                            finalAvatarUrl = tempMessage.attachments.first().url;
                        } catch (uploadError) {
                            logger.error("[Customize Streamer Command] Error uploading temporary avatar to Discord:", uploadError);
                            return interaction.editReply({content: "Failed to upload custom avatar. Please check bot's permissions or TEMP_UPLOAD_CHANNEL_ID."});
                        }
                    }

                    const [[streamer]] = await db.execute("SELECT s.streamer_id FROM streamers s WHERE s.platform = ? AND s.username = ?", [platform, username]);
                    if (!streamer) {
                        return interaction.editReply(`Streamer \`${username}\` (${platform}) was not found.`);
                    }

                    const [[subscription]] = await db.execute("SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ? AND announcement_channel_id <=> ?", [interaction.guild.id, streamer.streamer_id, targetChannelId]);
                    if (!subscription) {
                        const channelName = channel ? `in ${channel}` : "in the server default channel";
                        return interaction.editReply(`That streamer is not configured to announce ${channelName}.`);
                    }

                    const updates = [];
                    const values = [];

                    if (newNickname !== null) {
                        updates.push("override_nickname = ?");
                        values.push(newNickname?.toLowerCase() === "reset" ? null : newNickname);
                    }
                    if (finalAvatarUrl !== undefined) {
                        updates.push("override_avatar_url = ?");
                        values.push(finalAvatarUrl);
                    }
                    if (newMessage !== null) {
                        updates.push("custom_message = ?");
                        values.push(newMessage?.toLowerCase() === "reset" ? null : newMessage);
                    }

                    if (updates.length === 0) {
                        return interaction.editReply("No changes were made.");
                    }

                    values.push(interaction.guild.id, streamer.streamer_id, targetChannelId);

                    await db.execute(`UPDATE subscriptions SET ${updates.join(", ")} WHERE guild_id = ? AND streamer_id = ? AND announcement_channel_id <=> ?`, values);

                    const embed = new EmbedBuilder()
                        .setColor("#57F287")
                        .setTitle(`Customization updated for ${username}`)
                        .setDescription(`Settings for announcements ${channel ? `in ${channel}` : "in the server default channel"} have been updated.`);

                    if (finalAvatarUrl) {
                        embed.setThumbnail(finalAvatarUrl);
                    }

                    await interaction.editReply({embeds: [embed]});

                } catch (error) {
                    logger.error("[Customize Streamer Error]", error);
                    await interaction.editReply(`An error occurred while updating the streamer customization: ${error.message}`);
                }
                break;
            }
            default:
                await interaction.reply({ content: 'Invalid config subcommand.', flags: [MessageFlagsBitField.Flags.Ephemeral] });
                break;
        }
    },
};
