import { 
    EmbedBuilder, 
    ChatInputCommandInteraction, 
    Message, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    StringSelectMenuBuilder,
    User,
    TextChannel,
    Client,
    Guild,
    GuildMember,
    PermissionsBitField,
    Role,
    Collection,
    ChannelType,
    VoiceChannel,
    CategoryChannel
} from "discord.js";
import db from "../../utils/db";
import logger from "../../utils/logger";

const { logInfraction } = require("../../core/moderation-manager");
const crypto = require("crypto");
// Helper function to parse time strings like "10s", "5m", "1h" into seconds
export function parseTimeToSeconds(timeStr): any {
    if (timeStr === "off" || timeStr === "0") {
        return 0;
    }
    const match = timeStr.match(/^(\d+)(s|m|h)$/);
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

// Helper function to parse duration strings into milliseconds
export function parseDuration(durationStr): any {
    const match = durationStr.match(/^(\d+)(s|m|h|d)$/);
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

// Helper function to verify password
export function verifyPassword(plainPassword, hash): any {
    const [salt, key] = hash.split(":");
    const keyBuffer = Buffer.from(key, "hex");
    const derivedKey = crypto.scryptSync(plainPassword, salt, 64);
    return crypto.timingSafeEqual(keyBuffer, derivedKey);
}

/**
 * Handles banning a user from the server
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleBan(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (member && !member.bannable) {
        return interaction.editReply("I cannot ban this user. They may have a higher role than me or I lack permissions.");
    }
    if (member && member.id === interaction.user.id) {
        return interaction.editReply("You cannot ban yourself.");
    }

    try {
        // Attempt to DM the user first
        const dmEmbed = new EmbedBuilder()
            .setColor("#E74C3C")
            .setTitle(`You have been banned from ${interaction.guild.name}`)
            .addFields(
                { name: "Reason", value: reason },
                { name: "Moderator", value: interaction.user.tag }
            )
            .setTimestamp();
        await targetUser.send({ embeds: [dmEmbed] }).catch((e) => logger.warn(`Could not DM user ${targetUser.tag}: ${e.message}`));

        // Ban the user
        await interaction.guild.members.ban(targetUser, { reason });

        // Log the infraction
        await logInfraction(interaction, targetUser, "Ban", reason);

        const replyEmbed = new EmbedBuilder()
            .setColor("#57F287")
            .setDescription(`✅ Successfully banned ${targetUser.tag}.`);

        await interaction.editReply({ embeds: [replyEmbed] });

    } catch (error) {
        logger.error("[Ban Command Error]", error as Record<string, any>);
        await interaction.editReply("An unexpected _error occurred while trying to ban this user.");
    }
}

/**
 * Handles unbanning a user from the server
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleUnban(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const targetUserId = interaction.options.getString("user-id");
    const reason = interaction.options.getString("reason");

    try {
        // Fetch the user to get their tag for logging purposes
        const targetUser = await interaction.client.users.fetch(targetUserId);

        // Unban the user
        await interaction.guild.members.unban(targetUser, reason);

        // Log the action
        await logInfraction(interaction, targetUser, "Unban", reason);

        const replyEmbed = new EmbedBuilder()
            .setColor("#57F287")
            .setDescription(`✅ Successfully unbanned ${targetUser.tag}.`);

        await interaction.editReply({ embeds: [replyEmbed] });

    } catch (error) {
        logger.error("[Unban Command Error]", error as Record<string, any>);
        if (_error.code === 10026) { // Unknown Ban
            await interaction.editReply("Could not find a ban for that user ID.");
        } else {
            await interaction.editReply("An _error occurred. I may be missing Ban Members permission or the User ID is invalid.");
        }
    }
}

/**
 * Handles kicking a user from the server
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleKick(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (!member) {
        return interaction.editReply("Could not find that user in the server.");
    }
    if (member.id === interaction.user.id) {
        return interaction.editReply("You cannot kick yourself.");
    }
    if (!member.kickable) {
        return interaction.editReply("I cannot kick this user. They may have a higher role than me or I lack permissions.");
    }

    try {
        // Attempt to DM the user first
        const dmEmbed = new EmbedBuilder()
            .setColor("#E67E22")
            .setTitle(`You have been kicked from ${interaction.guild.name}`)
            .addFields(
                { name: "Reason", value: reason },
                { name: "Moderator", value: interaction.user.tag }
            )
            .setTimestamp();
        await targetUser.send({ embeds: [dmEmbed] }).catch((e) => logger.warn(`Could not DM user ${targetUser.tag}: ${e.message}`));

        // Kick the user
        await member.kick(reason);

        // Log the infraction
        await logInfraction(interaction, targetUser, "Kick", reason);

        const replyEmbed = new EmbedBuilder()
            .setColor("#57F287")
            .setDescription(`✅ Successfully kicked ${targetUser.tag}.`);

        await interaction.editReply({ embeds: [replyEmbed] });

    } catch (error) {
        logger.error("[Kick Command Error]", error as Record<string, any>);
        await interaction.editReply("An unexpected _error occurred while trying to kick this user.");
    }
}

/**
 * Handles muting (timing out) a user
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleMute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser("user");
    const durationStr = interaction.options.getString("duration");
    const reason = interaction.options.getString("reason");
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (!member) {
        return interaction.editReply("Could not find that user in the server.");
    }
    if (member.id === interaction.user.id) {
        return interaction.editReply("You cannot mute yourself.");
    }
    if (member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        return interaction.editReply("You cannot mute another moderator.");
    }
    if (!member.moderatable) {
        return interaction.editReply("I cannot mute this user. They may have a higher role than me.");
    }

    const durationMs = parseDuration(durationStr);
    if (!durationMs) {
        return interaction.editReply("Invalid duration format. Use formats like `10m`, `2h`, `1d`.");
    }

    try {
        // Apply the timeout
        await member.timeout(durationMs, reason);

        // Log the infraction
        const durationMinutes = Math.floor(durationMs / (60 * 1000));
        await logInfraction(interaction, targetUser, "Mute", reason, durationMinutes);

        // Attempt to DM the user
        try {
            const dmEmbed = new EmbedBuilder()
                .setColor("#E74C3C")
                .setTitle(`You have been muted in ${interaction.guild.name}`)
                .addFields(
                    { name: "Duration", value: durationStr },
                    { name: "Reason", value: reason },
                    { name: "Moderator", value: interaction.user.tag }
                )
                .setTimestamp();
            await targetUser.send({ embeds: [dmEmbed] });
        } catch (dmError) {
            logger.warn(`[Mute Command] Could not DM user ${targetUser.tag}: ${dmError.message}`);
        }

        const replyEmbed = new EmbedBuilder()
            .setColor("#57F287")
            .setDescription(`✅ Successfully muted ${targetUser.tag} for ${durationStr}. Reason: ${reason}`);

        await interaction.editReply({ embeds: [replyEmbed] });

    } catch (error) {
        logger.error("[Mute Command]", error as Record<string, any>);
        await interaction.editReply("An unexpected _error occurred while trying to mute this user.");
    }
}

/**
 * Handles unmuting (removing timeout from) a user
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleUnmute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (!member) {
        return interaction.editReply("Could not find that user in the server.");
    }
    if (!member.communicationDisabledUntilTimestamp) {
        return interaction.editReply("This user is not currently muted.");
    }

    try {
        // Remove the timeout
        await member.timeout(null, reason);

        // Log the action as a new type of "infraction" for record-keeping
        await logInfraction(interaction, targetUser, "Unmute", reason);

        // Attempt to DM the user
        try {
            const dmEmbed = new EmbedBuilder()
                .setColor("#2ECC71")
                .setTitle(`You have been unmuted in ${interaction.guild.name}`)
                .addFields(
                    { name: "Reason", value: reason },
                    { name: "Moderator", value: interaction.user.tag }
                )
                .setTimestamp();
            await targetUser.send({ embeds: [dmEmbed] });
        } catch (dmError) {
            logger.warn(`[Unmute Command] Could not DM user ${targetUser.tag}: ${dmError.message}`);
        }

        const replyEmbed = new EmbedBuilder()
            .setColor("#57F287")
            .setDescription(`✅ Successfully unmuted ${targetUser.tag}.`);

        await interaction.editReply({ embeds: [replyEmbed] });

    } catch (error) {
        logger.error("[Unmute Command]", error as Record<string, any>);
        await interaction.editReply("An unexpected _error occurred. I may be missing permissions to remove timeouts.");
    }
}

/**
 * Handles issuing a formal warning to a user
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleWarn(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");

    if (targetUser.id === interaction.user.id) {
        return interaction.editReply("You cannot warn yourself.");
    }
    if (targetUser.bot) {
        return interaction.editReply("You cannot warn a bot.");
    }

    // Log the infraction
    await logInfraction(interaction, targetUser, "Warning", reason);

    // Attempt to DM the user
    try {
        const dmEmbed = new EmbedBuilder()
            .setColor("#E67E22")
            .setTitle(`You have been warned in ${interaction.guild.name}`)
            .addFields(
                { name: "Reason", value: reason },
                { name: "Moderator", value: interaction.user.tag }
            )
            .setTimestamp();
        await targetUser.send({ embeds: [dmEmbed] });
    } catch (e) {
        logger.warn(`[Warn Command] Could not DM user ${targetUser.tag}: ${e.message}`);
    }

    const replyEmbed = new EmbedBuilder()
        .setColor("#57F287")
        .setDescription(`✅ Successfully warned ${targetUser.tag} for: ${reason}`);

    await interaction.editReply({ embeds: [replyEmbed] });
}

/**
 * Handles clearing a user's moderation history
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleClearInfractions(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");

    try {
        const [result] = await db.execute(
            "DELETE FROM infractions WHERE guild_id = ? AND user_id = ?",
            [interaction.guild.id, targetUser.id]
        );

        if (result.affectedRows > 0) {
            // Log this action for accountability
            await logInfraction(interaction, targetUser, "ClearInfractions", reason);

            const replyEmbed = new EmbedBuilder()
                .setColor("#57F287")
                .setDescription(`✅ Successfully cleared all ${result.affectedRows} infractions for ${targetUser.tag}.`);

            await interaction.editReply({ embeds: [replyEmbed] });
        } else {
            await interaction.editReply(`${targetUser.tag} has no infractions to clear.`);
        }

    } catch (error) {
        logger.error("[Clear Infractions Command Error]", error as Record<string, any>);
        await interaction.editReply("An _error occurred while trying to clear this user's history.");
    }
}

/**
 * Handles viewing a user's moderation history
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleHistory(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser("user");

    const [infractions] = await db.execute(
        "SELECT id, moderator_id, type, reason, created_at FROM infractions WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 10",
        [interaction.guild.id, targetUser.id]
    );

    if (infractions.length === 0) {
        return interaction.editReply(`${targetUser.tag} has a clean record.`);
    }

    const embed = new EmbedBuilder()
        .setColor("#5865F2")
        .setAuthor({ name: `Moderation History for ${targetUser.tag}`, iconURL: targetUser.displayAvatarURL() })
        .setDescription(infractions.map(inf =>
            `**Case #${inf.id} | ${inf.type}** - <t:${Math.floor(new Date(inf.created_at).getTime() / 1000)}:R>\n` +
            `**Moderator:** <@${inf.moderator_id}>\n` +
            `**Reason:** ${inf.reason}`
        ).join("\n\n"));

    await interaction.editReply({ embeds: [embed] });
}

/**
 * Handles purging messages with filters
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handlePurge(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const amount = interaction.options.getInteger("amount");
    const filter = interaction.options.getString("filter");
    const targetUser = interaction.options.getUser("user");
    const searchText = interaction.options.getString("text");
    const channel = interaction.channel;

    if (channel.type !== ChannelType.GuildText) {
        return interaction.editReply("This command can only be used in text channels.");
    }

    if (filter === "user" && !targetUser) {
        return interaction.editReply("You must specify a user when using the \"User\" filter.");
    }
    if (filter === "text" && !searchText) {
        return interaction.editReply("You must specify text to search for when using the \"Contains Text\" filter.");
    }

    try {
        const fetchedMessages = await channel.messages.fetch({ limit: amount });
        let messagesToDelete;

        switch (filter) {
            case "all":
                messagesToDelete = fetchedMessages;
                break;
            case "user":
                messagesToDelete = fetchedMessages.filter(msg => msg.author.id === targetUser.id);
                break;
            case "bots":
                messagesToDelete = fetchedMessages.filter(msg => msg.author.bot);
                break;
            case "text":
                messagesToDelete = fetchedMessages.filter(msg => msg.content.toLowerCase().includes(searchText.toLowerCase()));
                break;
            case "links":
                messagesToDelete = fetchedMessages.filter(msg => /https?:\/\/[^\s]+/g.test(msg.content));
                break;
            case "files":
                messagesToDelete = fetchedMessages.filter(msg => msg.attachments.size > 0);
                break;
            default:
                messagesToDelete = fetchedMessages;
        }

        if (messagesToDelete.size === 0) {
            return interaction.editReply("No messages found matching the specified filter.");
        }

        const deleted = await channel.bulkDelete(messagesToDelete, true);

        const replyEmbed = new EmbedBuilder()
            .setColor("#57F287")
            .setDescription(`✅ Successfully cleaned **${deleted.size}** message(s) using the \`${filter}\` filter.`);

        await interaction.editReply({ embeds: [replyEmbed] });

    } catch (error) {
        logger.error("[Purge Command Error]", error as Record<string, any>);
        await interaction.editReply("An _error occurred. I may not have permission to delete messages, or the messages are older than 14 days.");
    }
}

/**
 * Handles quarantining a user (restricting permissions)
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleQuarantine(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const user = interaction.options.getUser("user");
    const member = interaction.guild.members.cache.get(user.id);
    const enable = interaction.options.getBoolean("enable");
    const guildId = interaction.guild.id;

    if (!member) {
        return interaction.editReply({ content: "That user is not in this server." });
    }

    try {
        const [[quarantineConfig]] = await db.execute("SELECT is_enabled, quarantine_role_id FROM quarantine_config WHERE guild_id = ?", [guildId]);

        if (!quarantineConfig || !quarantineConfig.is_enabled) {
            return interaction.editReply({ content: "The quarantine system is not enabled for this server." });
        }

        const quarantineRoleId = quarantineConfig.quarantine_role_id;
        if (!quarantineRoleId) {
            return interaction.editReply({ content: "No quarantine role is configured for this server. Please configure it in the dashboard." });
        }

        const quarantineRole = interaction.guild.roles.cache.get(quarantineRoleId);
        if (!quarantineRole) {
            return interaction.editReply({ content: "The configured quarantine role was not found in this server. Please check your dashboard settings." });
        }

        if (enable) {
            // Remove all other roles and add the quarantine role
            const rolesToRemove = member.roles.cache.filter(role => !role.managed && role.id !== interaction.guild.id);
            await member.roles.remove(rolesToRemove);
            await member.roles.add(quarantineRole);
            await interaction.editReply({ content: `${user.tag} has been quarantined.` });
        } else {
            await member.roles.remove(quarantineRole);
            await interaction.editReply({ content: `${user.tag} has been released from quarantine.` });
        }
    } catch (error) {
        logger.error("[Quarantine Command Error]", error as Record<string, any>);
        await interaction.editReply({ content: "An _error occurred while trying to toggle quarantine for the user." });
    }
}

/**
 * Handles setting channel slowmode
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleSlowmode(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const durationStr = interaction.options.getString("duration").toLowerCase();
    const reason = interaction.options.getString("reason") || "No reason provided.";
    const channel = interaction.channel;

    if (channel.type !== ChannelType.GuildText) {
        return interaction.editReply({ content: "This command can only be used in text channels." });
    }

    const seconds = parseTimeToSeconds(durationStr);

    if (seconds === null) {
        return interaction.editReply({ content: "Invalid duration format. Use formats like `10s`, `5m`, or `off`." });
    }

    if (seconds > 21600) { // Discord's max is 6 hours (21600 seconds)
        return interaction.editReply({ content: "The maximum slowmode duration is 6 hours (6h)." });
    }

    try {
        await channel.setRateLimitPerUser(seconds, reason);

        const embed = new EmbedBuilder()
            .setColor(seconds > 0 ? "#E67E22" : "#2ECC71");

        if (seconds > 0) {
            embed.setTitle("⏳ Channel Slowmode Enabled")
                .setDescription(`Users must now wait **${durationStr}** between messages.`);
        } else {
            embed.setTitle("✅ Channel Slowmode Disabled")
                .setDescription("The slowmode cooldown has been removed.");
        }

        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        logger.error("[Slowmode Command Error]", error as Record<string, any>);
        await interaction.editReply({ content: "Failed to set the slowmode. Do I have the Manage Channels permission?" });
    }
}

/**
 * Handles locking a channel
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleLock(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const channel = interaction.channel;
    const reason = interaction.options.getString("reason") || "No reason provided.";

    if (channel.type !== ChannelType.GuildText) {
        return interaction.editReply({ content: "This command can only be used in text channels." });
    }

    try {
        await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
            SendMessages: false,
        });

        const embed = new EmbedBuilder()
            .setColor("#E74C3C")
            .setTitle("🔒 Channel Locked")
            .setDescription(`This channel has been locked by a moderator.`)
            .addFields({ name: "Reason", value: reason })
            .setTimestamp();

        await channel.send({ embeds: [embed] });
        await interaction.editReply({ content: "Channel locked successfully." });

    } catch (error) {
        logger.error("[Lock Command Error]", error as Record<string, any>);
        await interaction.editReply({ content: "Failed to lock the channel. Do I have the Manage Channels permission?" });
    }
}

/**
 * Handles unlocking a channel
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleUnlock(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const channel = interaction.channel;

    if (channel.type !== ChannelType.GuildText) {
        return interaction.editReply({ content: "This command can only be used in text channels." });
    }

    try {
        await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
            SendMessages: null, // Use null to revert to the category/default permissions
        });

        const embed = new EmbedBuilder()
            .setColor("#2ECC71")
            .setTitle("🔓 Channel Unlocked")
            .setDescription("This channel has been unlocked. You may now send messages.")
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        logger.error("[Unlock Command Error]", error as Record<string, any>);
        await interaction.editReply({ content: "Failed to unlock the channel. Do I have the Manage Channels permission?" });
    }
}

/**
 * Handles lockdown with password protection
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleLockdown(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const password = interaction.options.getString("password");
    const shouldUnlock = interaction.options.getBoolean("unlock") || false;
    const memberRoles = interaction.member.roles.cache;

    try {
        // Fetch password hash for the user's highest role that has one
        const [protectedRoles] = await db.execute('SELECT role_id, password_hash FROM protected_actions_config WHERE guild_id = ?', [interaction.guild.id]);

        const userProtectedRole = protectedRoles.find(p_role => memberRoles.has(p_role.role_id));

        if (!userProtectedRole) {
            return interaction.editReply({ content: "You do not have a role configured for protected actions." });
        }

        const isVerified = verifyPassword(password, userProtectedRole.password_hash);

        if (!isVerified) {
            logger.warn(`Failed lockdown attempt by ${interaction.user.tag}. Incorrect password.`, { guildId: interaction.guild.id, category: "security" });
            return interaction.editReply({ content: "❌ Incorrect password." });
        }

        const channel = interaction.channel;
        await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
            SendMessages: shouldUnlock ? null : false
        });

        const action = shouldUnlock ? "unlocked" : "locked down";
        await interaction.editReply(`✅ Channel has been ${action}.`);
        logger.info(`Channel ${channel.name} was ${action} by ${interaction.user.tag} using a protected command.`, { guildId: interaction.guild.id, category: "security" });

    } catch (error) {
        if (_error.code === "ER_NO_SUCH_TABLE") {
            await interaction.editReply({ content: "This feature has not been configured by the bot owner yet." });
        } else {
            logger.error("[Lockdown Command Error]", error as Record<string, any>);
            await interaction.editReply({ content: "An _error occurred executing this command." });
        }
    }
}

/**
 * Handles sending announcements to channels
 * @param {Interaction} interaction - Discord interaction object
 */
export async function handleAnnounce(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const channel = interaction.options.getChannel("channel");
    const message = interaction.options.getString("message");
    const title = interaction.options.getString("title");
    let color = interaction.options.getString("color");
    const mentionRole = interaction.options.getRole("mention");

    // Validate color input
    if (color && !/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(color)) {
        return interaction.editReply({ content: "❌ Invalid color format. Please use a valid hex color code (e.g., #3498DB)." });
    }

    try {
        const announcementContent = {
            content: mentionRole ? `${mentionRole}` : undefined,
        };

        if (title) {
            // If a title is provided, send as an embed
            const embed = new EmbedBuilder()
                .setTitle(title)
                .setDescription(message)
                .setColor(color || "#5865F2") // Default color if none provided
                .setTimestamp();

            announcementContent.embeds = [embed];
        } else {
            // Otherwise, send as a plain message
            announcementContent.content = `${announcementContent.content || ""} ${message}`.trim();
        }

        await channel.send(announcementContent);

        await interaction.editReply(`✅ Announcement successfully sent to ${channel}.`);

    } catch (error) {
        logger.error("[Announce Command Error]", error as Record<string, any>);
        await interaction.editReply("Failed to send the announcement. Please check my permissions for that channel.");
    }
}

module.exports = {
    handleBan,
    handleUnban,
    handleKick,
    handleMute,
    handleUnmute,
    handleWarn,
    handleClearInfractions,
    handleHistory,
    handlePurge,
    handleQuarantine,
    handleSlowmode,
    handleLock,
    handleUnlock,
    handleLockdown,
    handleAnnounce,
};
