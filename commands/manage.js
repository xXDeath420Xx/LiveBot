const { SlashCommandBuilder, PermissionsBitField, StringSelectMenuBuilder, ActionRowBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, ButtonBuilder, ButtonStyle, ComponentType, escapeMarkdown, ChannelType, AttachmentBuilder } = require('discord.js');
const db = require("../utils/db");
const logger = require("../utils/logger");
const { logInfraction } = require("../core/moderation-manager");
const { createSnapshot } = require("../core/backup-manager");
const { invalidateCommandCache } = require("../core/custom-command-handler");
const crypto = require("crypto");
const axios = require("axios");

// Helper to parse time strings like "10s", "5m", "1h" into seconds
function parseTimeToSeconds(timeStr) {
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

function parseDuration(durationStr) {
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


// In a real scenario, you would use a proper password hashing library like bcrypt.
// Using crypto for demonstration purposes as it's a built-in Node module.
function verifyPassword(plainPassword, hash) {
    const [salt, key] = hash.split(":");
    const keyBuffer = Buffer.from(key, "hex");
    const derivedKey = crypto.scryptSync(plainPassword, salt, 64);
    return crypto.timingSafeEqual(keyBuffer, derivedKey);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('manage')
        .setDescription('Server management commands.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
        .addSubcommandGroup(group => group
            .setName('permissions')
            .setDescription('Manage command permissions for roles on this server.')
            .addSubcommand(subcommand => subcommand
                .setName("grant")
                .setDescription("Grants a role permission to use a command.")
                .addRoleOption(option => option.setName("role").setDescription("The role to grant permission to.").setRequired(true))
                .addStringOption(option => option.setName("command").setDescription("The command to grant permission for.").setRequired(true).setAutocomplete(true))
            )
            .addSubcommand(subcommand => subcommand
                .setName("revoke")
                .setDescription("Revokes a role's permission to use a command.")
                .addRoleOption(option => option.setName("role").setDescription("The role to revoke permission from.").setRequired(true))
                .addStringOption(option => option.setName("command").setDescription("The command to revoke permission for.").setRequired(true).setAutocomplete(true))
            )
        )
        .addSubcommandGroup(group => group
            .setName('moderation')
            .setDescription('Moderation commands.')
            .addSubcommand(subcommand => subcommand
                .setName('ban')
                .setDescription('Bans a user from the server.')
                .addUserOption(option => option
                    .setName("user")
                    .setDescription("The user to ban.")
                    .setRequired(true)
                )
                .addStringOption(option => option
                    .setName("reason")
                    .setDescription("The reason for the ban.")
                    .setRequired(true)
                )
            )
            .addSubcommand(subcommand => subcommand
                .setName('unban')
                .setDescription('Revokes a ban for a user.')
                .addStringOption(option => option
                    .setName("user-id")
                    .setDescription("The ID of the user to unban.")
                    .setRequired(true)
                )
                .addStringOption(option => option
                    .setName("reason")
                    .setDescription("The reason for the unban.")
                    .setRequired(true)
                )
            )
            .addSubcommand(subcommand => subcommand
                .setName('kick')
                .setDescription('Kicks a user from the server.')
                .addUserOption(option => option
                    .setName("user")
                    .setDescription("The user to kick.")
                    .setRequired(true)
                )
                .addStringOption(option => option
                    .setName("reason")
                    .setDescription("The reason for the kick.")
                    .setRequired(true)
                )
            )
            .addSubcommand(subcommand => subcommand
                .setName('mute')
                .setDescription('Times out a user, preventing them from talking or speaking.')
                .addUserOption(option => option
                    .setName("user")
                    .setDescription("The user to mute.")
                    .setRequired(true)
                )
                .addStringOption(option => option
                    .setName("duration")
                    .setDescription("The duration of the mute (e.g., 5m, 1h, 3d). Max 28d.")
                    .setRequired(true)
                )
                .addStringOption(option => option
                    .setName("reason")
                    .setDescription("The reason for the mute.")
                    .setRequired(true)
                )
            )
            .addSubcommand(subcommand => subcommand
                .setName('unmute')
                .setDescription('Removes a timeout from a user.')
                .addUserOption(option => option
                    .setName("user")
                    .setDescription("The user to unmute.")
                    .setRequired(true)
                )
                .addStringOption(option => option
                    .setName("reason")
                    .setDescription("The reason for the unban.")
                    .setRequired(true)
                )
            )
            .addSubcommand(subcommand => subcommand
                .setName('warn')
                .setDescription('Issues a formal warning to a user.')
                .addUserOption(option => option
                    .setName("user")
                    .setDescription("The user to warn.")
                    .setRequired(true)
                )
                .addStringOption(option => option
                    .setName("reason")
                    .setDescription("The reason for the warning.")
                    .setRequired(true)
                )
            )
            .addSubcommand(subcommand => subcommand
                .setName('clearinfractions')
                .setDescription('Clears a user\'s moderation history.')
                .addUserOption(option => option
                    .setName("user")
                    .setDescription("The user whose history you want to clear.")
                    .setRequired(true)
                )
                .addStringOption(option => option
                    .setName("reason")
                    .setDescription("The reason for clearing the history.")
                    .setRequired(true)
                )
            )
            .addSubcommand(subcommand => subcommand
                .setName('history')
                .setDescription("Checks a user's moderation history.")
                .addUserOption(option => option
                    .setName("user")
                    .setDescription("The user to check.")
                    .setRequired(true)
                )
            )
            .addSubcommand(subcommand => subcommand
                .setName('purge')
                .setDescription('Advanced message cleaning with filters.')
                .addIntegerOption(option => option
                    .setName("amount")
                    .setDescription("Number of messages to scan (up to 100).")
                    .setRequired(true)
                    .setMinValue(1)
                    .setMaxValue(100)
                )
                .addStringOption(option => option
                    .setName("filter")
                    .setDescription("The type of message to clean.")
                    .setRequired(true)
                    .addChoices(
                        {name: "All", value: "all"},
                        {name: "User", value: "user"},
                        {name: "Bots", value: "bots"},
                        {name: "Contains Text", value: "text"},
                        {name: "Has Link", value: "links"},
                        {name: "Has Attachment", value: "files"}
                    )
                )
                .addUserOption(option => option
                    .setName("user")
                    .setDescription("The user whose messages to delete (required if filter is \"User\").")
                )
                .addStringOption(option => option
                    .setName("text")
                    .setDescription("The text to search for (required if filter is \"Contains Text\").")
                )
            )
            .addSubcommand(subcommand => subcommand
                .setName('quarantine')
                .setDescription('Quarantines a user, temporarily restricting their permissions.')
                .addUserOption(option => option
                    .setName("user")
                    .setDescription("The user to quarantine.")
                    .setRequired(true)
                )
                .addBooleanOption(option => option
                    .setName("enable")
                    .setDescription("Enable or disable quarantine for the user.")
                    .setRequired(true)
                )
            )
            .addSubcommand(subcommand => subcommand
                .setName('slowmode')
                .setDescription('Sets or removes a slowmode cooldown for the current channel.')
                .addStringOption(option => option
                    .setName("duration")
                    .setDescription("The slowmode duration (e.g., 10m, 5m, 1h) or \"off\".")
                    .setRequired(true)
                )
                .addStringOption(option => option
                    .setName("reason")
                    .setDescription("The reason for changing the slowmode.")
                )
            )
            .addSubcommand(subcommand => subcommand
                .setName('lock')
                .setDescription('Locks the current channel, preventing @everyone from sending messages.')
                .addStringOption(option => option
                    .setName("reason")
                    .setDescription("The reason for locking the channel.")
                )
            )
            .addSubcommand(subcommand => subcommand
                .setName('unlock')
                .setDescription('Unlocks the current channel, allowing @everyone to send messages.')
            )
            .addSubcommand(subcommand => subcommand
                .setName('lockdown')
                .setDescription('Locks the current channel, preventing messages. Requires a special password.')
                .addStringOption(option => option
                    .setName("password")
                    .setDescription("The password required to execute this sensitive action.")
                    .setRequired(true)
                )
                .addBooleanOption(option => option
                    .setName("unlock")
                    .setDescription("Set to true to unlock the channel.")
                    .setRequired(false)
                )
            )
            .addSubcommand(subcommand => subcommand
                .setName("announce")
                .setDescription("Sends an announcement to a specified channel.")
                .addChannelOption(option => option
                    .setName("channel")
                    .setDescription("The channel to send the announcement to.")
                    .addChannelTypes(ChannelType.GuildText)
                    .setRequired(true)
                )
                .addStringOption(option => option
                    .setName("message")
                    .setDescription("The main content of the announcement.")
                    .setRequired(true)
                )
                .addStringOption(option => option
                    .setName("title")
                    .setDescription("An optional title for the embed.")
                )
                .addStringOption(option => option
                    .setName("color")
                    .setDescription("An optional hex color for the embed (e.g., #3498DB).")
                )
                .addRoleOption(option => option
                    .setName("mention")
                    .setDescription("An optional role to mention with the announcement.")
                )
            )
        )
        .addSubcommandGroup(group => group
            .setName("backup")
            .setDescription("Manage server structure backups (roles & channels).")
            .addSubcommand(subcommand => subcommand
                .setName("create")
                .setDescription("Creates a new backup of the server's roles and channels.")
                .addStringOption(option => option.setName("name").setDescription("A descriptive name for this backup.").setRequired(true))
            )
            .addSubcommand(subcommand => subcommand
                .setName("list")
                .setDescription("Lists all available backups for this server.")
            )
            .addSubcommand(subcommand => subcommand
                .setName("load")
                .setDescription("Restores the server structure from a backup. THIS IS DESTRUCTIVE.")
                .addStringOption(option => option.setName("backup_id").setDescription("The ID of the backup to load.").setRequired(true))
            )
            .addSubcommand(subcommand => subcommand
                .setName("delete")
                .setDescription("Deletes a server backup.")
                .addStringOption(option => option.setName("backup_id").setDescription("The ID of the backup to delete.").setRequired(true))
            )
        )
        .addSubcommandGroup(group => group
            .setName('fun')
            .setDescription('Fun commands.')
            .addSubcommand(subcommand => subcommand
                .setName('coinflip')
                .setDescription('Flips a coin.')
            )
            .addSubcommand(subcommand => subcommand
                .setName('meme')
                .setDescription('Sends a random meme from Reddit.')
            )
            .addSubcommand(subcommand => subcommand
                .setName('roll')
                .setDescription('Rolls a dice.')
                .addIntegerOption(option => option.setName('sides').setDescription('The number of sides on the dice (default 6).').setMinValue(2).setMaxValue(100))
            )
            .addSubcommand(subcommand => subcommand
                .setName('cat')
                .setDescription('Sends a random cat picture.')
            )
        )
        .addSubcommandGroup(group => group
            .setName('events')
            .setDescription('Event management commands.')
            .addSubcommand(subcommand => subcommand
                .setName('giveaway')
                .setDescription('Start a giveaway.')
            )
            .addSubcommand(subcommand => subcommand
                .setName('remind')
                .setDescription('Set a reminder.')
                .addStringOption(option => option.setName('time').setDescription('When to remind (e.g., 1h, 30m).').setRequired(true))
                .addStringOption(option => option.setName('message').setDescription('What to remind you about.').setRequired(true))
            )
            .addSubcommand(subcommand => subcommand
                .setName('reactionroles')
                .setDescription('Manage reaction roles.')
            )
            .addSubcommand(subcommand => subcommand
                .setName('starboard')
                .setDescription('Manage starboard settings.')
            )
        )
        .addSubcommandGroup(group => group
            .setName('core')
            .setDescription('Core bot commands.')
            .addSubcommand(subcommand => subcommand
                .setName('stats')
                .setDescription('Display bot statistics.')
            )
            .addSubcommand(subcommand => subcommand
                .setName('status')
                .setDescription('Display bot status.')
            )
            .addSubcommand(subcommand => subcommand
                .setName('ping')
                .setDescription('Check bot latency.')
            )
            .addSubcommand(subcommand => subcommand
                .setName('globalreinit')
                .setDescription('Reinitialize global commands (Bot Owner Only).')
            )
            .addSubcommand(subcommand => subcommand
                .setName('reinit')
                .setDescription('Reinitialize guild commands (Admin Only).')
            )
            .addSubcommand(subcommand => subcommand
                .setName('resetdatabase')
                .setDescription('Reset the bot\'s database (Bot Owner Only).')
            )
        )
        .addSubcommandGroup(group => group
            .setName("custom-command")
            .setDescription("Manage custom commands for this server.")
            .addSubcommand(subcommand => subcommand
                .setName("create")
                .setDescription("Creates a new, advanced custom command.")
                .addStringOption(option => option.setName("name").setDescription("The name of the command.").setRequired(true))
                .addStringOption(option => option
                    .setName("action-type")
                    .setDescription("The action this command will perform.")
                    .setRequired(true)
                    .addChoices(
                        {name: "Reply with Text", value: "reply"},
                        {name: "Add Role to User", value: "add_role"},
                        {name: "Remove Role from User", value: "remove_role"}
                    )
                )
                .addStringOption(option => option.setName("response-or-role-id").setDescription("The text response or the ID of the role to manage.").setRequired(true))
                .addStringOption(option => option.setName("required-roles").setDescription("Comma-separated list of role IDs required to use this command."))
                .addStringOption(option => option.setName("allowed-channels").setDescription("Comma-separated list of channel IDs where this command can be used."))
            )
            .addSubcommand(subcommand => subcommand
                .setName("remove")
                .setDescription("Removes a custom command.")
                .addStringOption(option => option.setName("name").setDescription("The name of the command to remove.").setRequired(true).setAutocomplete(true))
            )
            .addSubcommand(subcommand => subcommand
                .setName("list")
                .setDescription("Lists all custom commands on this server.")
            )
        ),
    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        const subcommandGroup = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand(false);

        if (subcommandGroup === 'permissions' && (subcommand === 'grant' || subcommand === 'revoke') && focusedOption.name === "command") {
            const focusedValue = focusedOption.value;
            try {
                const commandNames = Array.from(interaction.client.commands.keys());
                const filtered = commandNames.filter(name => name.startsWith(focusedValue) && name !== "permissions");
                await interaction.respond(filtered.map(name => ({name, value: name})));
            } catch (error) {
                logger.error("[Permissions Command Autocomplete Error]", error);
                await interaction.respond([]);
            }
        } else if (subcommandGroup === 'custom-command' && subcommand === 'remove' && focusedOption.name === "name") {
            const focusedValue = focusedOption.value;
            try {
                const [commands] = await db.execute("SELECT command_name FROM custom_commands WHERE guild_id = ? AND command_name LIKE ? LIMIT 25", [interaction.guild.id, `${focusedValue}%`]);
                await interaction.respond(commands.map(cmd => ({name: cmd.command_name, value: cmd.command_name})));
            } catch (error) {
                await interaction.respond([]);
            }
        }
    },
    async execute(interaction) {
        const subcommandGroup = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();
        const guild = interaction.guild;

        if (subcommandGroup === 'permissions') {
            switch (subcommand) {
                case 'grant':
                case 'revoke': {
                    await interaction.deferReply({ephemeral: true});
                    const role = interaction.options.getRole("role");
                    const commandName = interaction.options.getString("command");

                    if (!interaction.client.commands.has(commandName) || commandName === "permissions") {
                        return interaction.editReply({content: "That is not a valid command to set permissions for."});
                    }

                    try {
                        if (subcommand === "grant") {
                            await db.execute(
                                "INSERT INTO bot_permissions (guild_id, role_id, command) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE command=command",
                                [interaction.guild.id, role.id, commandName]
                            );
                            await interaction.editReply({embeds: [new EmbedBuilder().setColor("#57F287").setTitle("✅ Permission Granted").setDescription(`The role ${role} can now use the \`/${commandName}\` command.`)]});
                        } else if (subcommand === "revoke") {
                            await db.execute(
                                "DELETE FROM bot_permissions WHERE guild_id = ? AND role_id = ? AND command = ?",
                                [interaction.guild.id, role.id, commandName]
                            );
                            await interaction.editReply({embeds: [new EmbedBuilder().setColor("#ED4245").setTitle("🗑️ Permission Revoked").setDescription(`The role ${role} can no longer use the \`/${commandName}\` command.`)]});
                        }
                    } catch (error) {
                        logger.error("[Permissions Command Error]", error);
                        await interaction.editReply({content: "An error occurred while updating permissions."});
                    }
                    break;
                }
                default:
                    await interaction.reply({ content: 'Invalid permissions subcommand.', ephemeral: true });
                    break;
            }
        } else if (subcommandGroup === 'moderation') {
            switch (subcommand) {
                case 'ban': {
                    await interaction.deferReply({ephemeral: true});

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
                            .addFields({name: "Reason", value: reason}, {name: "Moderator", value: interaction.user.tag})
                            .setTimestamp();
                        await targetUser.send({embeds: [dmEmbed]}).catch((e) => logger.warn(`Could not DM user ${targetUser.tag}: ${e.message}`));

                        // Ban the user
                        await interaction.guild.members.ban(targetUser, {reason});

                        // Log the infraction
                        await logInfraction(interaction, targetUser, "Ban", reason);

                        const replyEmbed = new EmbedBuilder()
                            .setColor("#57F287")
                            .setDescription(`✅ Successfully banned ${targetUser.tag}.`);

                        await interaction.editReply({embeds: [replyEmbed]});

                    } catch (error) {
                        logger.error("[Ban Command Error]", error);
                        await interaction.editReply("An unexpected error occurred while trying to ban this user.");
                    }
                    break;
                }
                case 'unban': {
                    await interaction.deferReply({ephemeral: true});

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

                        await interaction.editReply({embeds: [replyEmbed]});

                    } catch (error) {
                        logger.error("[Unban Command Error]", error);
                        if (error.code === 10026) { // Unknown Ban
                            await interaction.editReply("Could not find a ban for that user ID.");
                        } else {
                            await interaction.editReply("An error occurred. I may be missing Ban Members permission or the User ID is invalid.");
                        }
                    }
                    break;
                }
                case 'kick': {
                    await interaction.deferReply({ephemeral: true});

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
                            .addFields({name: "Reason", value: reason}, {name: "Moderator", value: interaction.user.tag})
                            .setTimestamp();
                        await targetUser.send({embeds: [dmEmbed]}).catch((e) => logger.warn(`Could not DM user ${targetUser.tag}: ${e.message}`));

                        // Kick the user
                        await member.kick(reason);

                        // Log the infraction
                        await logInfraction(interaction, targetUser, "Kick", reason);

                        const replyEmbed = new EmbedBuilder()
                            .setColor("#57F287")
                            .setDescription(`✅ Successfully kicked ${targetUser.tag}.`);

                        await interaction.editReply({embeds: [replyEmbed]});

                    } catch (error) {
                        logger.error("[Kick Command Error]", error);
                        await interaction.editReply("An unexpected error occurred while trying to kick this user.");
                    }
                    break;
                }
                case 'mute': {
                    await interaction.deferReply({ephemeral: true});

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
                                    {name: "Duration", value: durationStr},
                                    {name: "Reason", value: reason},
                                    {name: "Moderator", value: interaction.user.tag}
                                )
                                .setTimestamp();
                            await targetUser.send({embeds: [dmEmbed]});
                        } catch (dmError) {
                            logger.warn(`[Mute Command] Could not DM user ${targetUser.tag}: ${dmError.message}`);
                        }

                        const replyEmbed = new EmbedBuilder()
                            .setColor("#57F287")
                            .setDescription(`✅ Successfully muted ${targetUser.tag} for ${durationStr}. Reason: ${reason}`);

                        await interaction.editReply({embeds: [replyEmbed]});

                    } catch (error) {
                        logger.error("[Mute Command]", error);
                        await interaction.editReply("An unexpected error occurred while trying to mute this user.");
                    }
                    break;
                }
                case 'unmute': {
                    await interaction.deferReply({ephemeral: true});

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
                                .addFields({name: "Reason", value: reason}, {name: "Moderator", value: interaction.user.tag})
                                .setTimestamp();
                            await targetUser.send({embeds: [dmEmbed]});
                        } catch (dmError) {
                            logger.warn(`[Unmute Command] Could not DM user ${targetUser.tag}: ${dmError.message}`);
                        }

                        const replyEmbed = new EmbedBuilder()
                            .setColor("#57F287")
                            .setDescription(`✅ Successfully unmuted ${targetUser.tag}.`);

                        await interaction.editReply({embeds: [replyEmbed]});

                    } catch (error) {
                        logger.error("[Unmute Command]", error);
                        await interaction.editReply("An unexpected error occurred. I may be missing permissions to remove timeouts.");
                    }
                    break;
                }
                case 'warn': {
                    await interaction.deferReply({ephemeral: true});

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
                                {name: "Reason", value: reason},
                                {name: "Moderator", value: interaction.user.tag}
                            )
                            .setTimestamp();
                        await targetUser.send({embeds: [dmEmbed]});
                    } catch(e) {
                        logger.warn(`[Warn Command] Could not DM user ${targetUser.tag}: ${e.message}`)
                    }

                    const replyEmbed = new EmbedBuilder()
                        .setColor("#57F287")
                        .setDescription(`✅ Successfully warned ${targetUser.tag} for: ${reason}`);

                    await interaction.editReply({embeds: [replyEmbed]});
                    break;
                }
                case 'clearinfractions': {
                    await interaction.deferReply({ephemeral: true});

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

                            await interaction.editReply({embeds: [replyEmbed]});
                        } else {
                            await interaction.editReply(`${targetUser.tag} has no infractions to clear.`);
                        }

                    } catch (error) {
                        logger.error("[Clear Infractions Command Error]", error);
                        await interaction.editReply("An error occurred while trying to clear this user's history.");
                    }
                    break;
                }
                case 'history': {
                    await interaction.deferReply({ephemeral: true});

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
                        .setAuthor({name: `Moderation History for ${targetUser.tag}`, iconURL: targetUser.displayAvatarURL()})
                        .setDescription(infractions.map(inf =>
                            `**Case #${inf.id} | ${inf.type}** - <t:${Math.floor(new Date(inf.created_at).getTime() / 1000)}:R>\n` +
                            `**Moderator:** <@${inf.moderator_id}>\n` +
                            `**Reason:** ${inf.reason}`
                        ).join("\n\n"));

                    await interaction.editReply({embeds: [embed]});
                    break;
                }
                case 'purge': {
                    await interaction.deferReply({ephemeral: true});

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
                        const fetchedMessages = await channel.messages.fetch({limit: amount});
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

                        await interaction.editReply({embeds: [replyEmbed]});

                    } catch (error) {
                        console.error("[Clean Command Error]", error);
                        await interaction.editReply("An error occurred. I may not have permission to delete messages, or the messages are older than 14 days.");
                    }
                    break;
                }
                case 'quarantine': {
                    await interaction.deferReply({ephemeral: true});

                    const user = interaction.options.getUser("user");
                    const member = interaction.guild.members.cache.get(user.id);
                    const enable = interaction.options.getBoolean("enable");
                    const guildId = interaction.guild.id;

                    if (!member) {
                        return interaction.reply({content: "That user is not in this server.", ephemeral: true});
                    }

                    try {
                        const [[quarantineConfig]] = await db.execute("SELECT is_enabled, quarantine_role_id FROM quarantine_config WHERE guild_id = ?", [guildId]);

                        if (!quarantineConfig || !quarantineConfig.is_enabled) {
                            return interaction.reply({content: "The quarantine system is not enabled for this server.", ephemeral: true});
                        }

                        const quarantineRoleId = quarantineConfig.quarantine_role_id;
                        if (!quarantineRoleId) {
                            return interaction.reply({content: "No quarantine role is configured for this server. Please configure it in the dashboard.", ephemeral: true});
                        }

                        const quarantineRole = interaction.guild.roles.cache.get(quarantineRoleId);
                        if (!quarantineRole) {
                            return interaction.reply({content: "The configured quarantine role was not found in this server. Please check your dashboard settings.", ephemeral: true});
                        }

                        if (enable) {
                            // Remove all other roles and add the quarantine role
                            const rolesToRemove = member.roles.cache.filter(role => !role.managed && role.id !== interaction.guild.id);
                            await member.roles.remove(rolesToRemove);
                            await member.roles.add(quarantineRole);
                            await interaction.reply({content: `${user.tag} has been quarantined.`, ephemeral: true});
                        } else {
                            await member.roles.remove(quarantineRole);
                            await interaction.reply({content: `${user.tag} has been released from quarantine.`, ephemeral: true});
                        }
                    } catch (error) {
                        logger.error("[Quarantine Command Error]", error);
                        await interaction.reply({content: "An error occurred while trying to toggle quarantine for the user.", ephemeral: true});
                    }
                    break;
                }
                case 'slowmode': {
                    await interaction.deferReply({ephemeral: true});
                    const durationStr = interaction.options.getString("duration").toLowerCase();
                    const reason = interaction.options.getString("reason") || "No reason provided.";
                    const channel = interaction.channel;

                    if (channel.type !== ChannelType.GuildText) {
                        return interaction.editReply({content: "This command can only be used in text channels."});
                    }

                    const seconds = parseTimeToSeconds(durationStr);

                    if (seconds === null) {
                        return interaction.editReply({content: "Invalid duration format. Use formats like `10s`, `5m`, or `off`."});
                    }

                    if (seconds > 21600) { // Discord's max is 6 hours (21600 seconds)
                        return interaction.editReply({content: "The maximum slowmode duration is 6 hours (6h)."});
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

                        await interaction.editReply({embeds: [embed]});

                    } catch (error) {
                        logger.error("[Slowmode Command Error]", error);
                        await interaction.editReply({content: "Failed to set the slowmode. Do I have the Manage Channels permission?"});
                    }
                    break;
                }
                case 'lock': {
                    await interaction.deferReply({ephemeral: true});
                    const channel = interaction.channel;
                    const reason = interaction.options.getString("reason") || "No reason provided.";

                    if (channel.type !== ChannelType.GuildText) {
                        return interaction.editReply({content: "This command can only be used in text channels."});
                    }

                    try {
                        await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
                            SendMessages: false,
                        });

                        const embed = new EmbedBuilder()
                            .setColor("#E74C3C")
                            .setTitle("🔒 Channel Locked")
                            .setDescription(`This channel has been locked by a moderator.`)
                            .addFields({name: "Reason", value: reason})
                            .setTimestamp();

                        await channel.send({embeds: [embed]});
                        await interaction.editReply({content: "Channel locked successfully."});

                    } catch (error) {
                        logger.error("[Lock Command Error]", error);
                        await interaction.editReply({content: "Failed to lock the channel. Do I have the Manage Channels permission?"});
                    }
                    break;
                }
                case 'unlock': {
                    await interaction.deferReply({ephemeral: true});
                    const channel = interaction.channel;

                    if (channel.type !== ChannelType.GuildText) {
                        return interaction.editReply({content: "This command can only be used in text channels."});
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

                        await interaction.editReply({embeds: [embed]});

                    } catch (error) {
                        logger.error("[Unlock Command Error]", error);
                        await interaction.editReply({content: "Failed to unlock the channel. Do I have the Manage Channels permission?"});
                    }
                    break;
                }
                case 'lockdown': {
                    await interaction.deferReply({ephemeral: true});

                    const password = interaction.options.getString("password");
                    const shouldUnlock = interaction.options.getBoolean("unlock") || false;
                    const memberRoles = interaction.member.roles.cache;

                    try {
                        // This is a placeholder for the new table `protected_actions_config`
                        // We will simulate fetching a password hash for the user's highest role that has one.
                        const [protectedRoles] = await db.execute('SELECT role_id, password_hash FROM protected_actions_config WHERE guild_id = ?', [interaction.guild.id]);

                        const userProtectedRole = protectedRoles.find(p_role => memberRoles.has(p_role.role_id));

                        if (!userProtectedRole) {
                            return interaction.editReply({content: "You do not have a role configured for protected actions."});
                        }

                        const isVerified = verifyPassword(password, userProtectedRole.password_hash);

                        if (!isVerified) {
                            logger.warn(`Failed lockdown attempt by ${interaction.user.tag}. Incorrect password.`, {guildId: interaction.guild.id, category: "security"});
                            return interaction.editReply({content: "❌ Incorrect password."});
                        }

                        const channel = interaction.channel;
                        await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
                            SendMessages: shouldUnlock ? null : false
                        });

                        const action = shouldUnlock ? "unlocked" : "locked down";
                        await interaction.editReply(`✅ Channel has been ${action}.`);
                        logger.info(`Channel ${channel.name} was ${action} by ${interaction.user.tag} using a protected command.`, {guildId: interaction.guild.id, category: "security"});

                    } catch (error) {
                        if (error.code === "ER_NO_SUCH_TABLE") {
                            await interaction.editReply({content: "This feature has not been configured by the bot owner yet."});
                        }
                        else {
                            logger.error("[Lockdown Command Error]", error);
                            await interaction.editReply({content: "An error occurred executing this command."});
                        }
                    }
                    break;
                }
                case 'announce': {
                    await interaction.deferReply({ephemeral: true});

                    const channel = interaction.options.getChannel("channel");
                    const message = interaction.options.getString("message");
                    const title = interaction.options.getString("title");
                    let color = interaction.options.getString("color");
                    const mentionRole = interaction.options.getRole("mention");

                    // Validate color input
                    if (color && !/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(color)) {
                        return interaction.editReply({content: "❌ Invalid color format. Please use a valid hex color code (e.g., #3498DB).", ephemeral: true});
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
                        console.error("[Announce Command Error]", error);
                        await interaction.editReply("Failed to send the announcement. Please check my permissions for that channel.");
                    }
                    break;
                }
                default:
                    await interaction.reply({ content: 'Invalid moderation subcommand.', ephemeral: true });
                    break;
            }
        } else if (subcommandGroup === 'backup') {
            try {
                if (subcommand === "create") {
                    await interaction.deferReply({ephemeral: true});
                    const name = interaction.options.getString("name");

                    let snapshot;
                    try {
                        snapshot = await createSnapshot(guild);
                    } catch (snapshotError) {
                        logger.error(`[Backup Command] Error creating snapshot for guild ${guild.id}:`, {error: snapshotError});
                        return interaction.editReply({content: "❌ Failed to create backup snapshot. Please check bot permissions and try again."});
                    }

                    await db.execute(
                        "INSERT INTO server_backups (guild_id, snapshot_name, snapshot_json, created_by_id) VALUES (?, ?, ?, ?)",
                        [guild.id, name, JSON.stringify(snapshot), interaction.user.id]
                    );

                    await interaction.editReply(`✅ Successfully created backup named **${name}**.`);

                } else if (subcommand === "list") {
                    await interaction.deferReply({ephemeral: true});
                    const [backups] = await db.execute("SELECT id, snapshot_name, created_at, created_by_id FROM server_backups WHERE guild_id = ? ORDER BY created_at DESC", [guild.id]);

                    if (backups.length === 0) {
                        return interaction.editReply("No backups found for this server.");
                    }

                    const description = backups.map(b => `**ID:** \`${b.id}\`\n**Name:** ${b.snapshot_name}\n**Date:** ${new Date(b.created_at).toLocaleString()}`).join("\n\n");
                    const embed = new EmbedBuilder()
                        .setTitle(`Backups for ${guild.name}`)
                        .setColor("#5865F2")
                        .setDescription(description);

                    await interaction.editReply({embeds: [embed]});

                } else if (subcommand === "load") {
                    const backupId = interaction.options.getString("backup_id");
                    const [[backup]] = await db.execute("SELECT * FROM server_backups WHERE id = ? AND guild_id = ?", [backupId, guild.id]);

                    if (!backup) {
                        return interaction.reply({content: "Backup not found.", ephemeral: true});
                    }

                    const confirmationEmbed = new EmbedBuilder()
                        .setTitle("⚠️ FINAL CONFIRMATION REQUIRED ⚠️")
                        .setDescription(`You are about to restore the server to the state from **${new Date(backup.created_at).toLocaleString()}** named **"${backup.snapshot_name}"**.\n\n**THIS WILL DELETE ALL CURRENT ROLES AND CHANNELS** and replace them with the ones from the backup. This action is irreversible.\n\nOnly the server owner can confirm this action.`)
                        .setColor("Red");

                    const confirmButton = new ButtonBuilder().setCustomId(`backup_confirm_${backupId}`).setLabel("Confirm & Restore Server").setStyle(ButtonStyle.Danger);
                    const cancelButton = new ButtonBuilder().setCustomId("backup_cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary);
                    const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

                    await interaction.reply({embeds: [confirmationEmbed], components: [row], ephemeral: true});

                } else if (subcommand === "delete") {
                    await interaction.deferReply({ephemeral: true});
                    const backupId = interaction.options.getString("backup_id");
                    const [result] = await db.execute("DELETE FROM server_backups WHERE id = ? AND guild_id = ?", [backupId, guild.id]);
                    if (result.affectedRows > 0) {
                        await interaction.editReply(`✅ Successfully deleted backup with ID \`${backupId}\`.`);
                    } else {
                        await interaction.editReply(`❌ No backup found with ID \`${backupId}\` for this server.`);
                    }
                }
            } catch (error) {
                logger.error(`[Backup Command] Subcommand: ${subcommand}`, {error});
                await interaction.editReply({content: "An error occurred while executing this command."});
            }
        } else if (subcommandGroup === 'fun') {
            switch (subcommand) {
                case 'coinflip': {
                    const result = Math.random() < 0.5 ? "Heads" : "Tails";
                    const imageUrl = result === "Heads"
                        ? "https://i.imgur.com/vH3y3b9.png" // Example Heads image
                        : "https://i.imgur.com/wixK1sI.png"; // Example Tails image

                    const embed = new EmbedBuilder()
                        .setColor(result === "Heads" ? "#E67E22" : "#3498DB")
                        .setTitle("Coin Flip")
                        .setDescription(`The coin landed on... **${result}**!`)
                        .setThumbnail(imageUrl);

                    await interaction.reply({embeds: [embed]});
                    break;
                }
                case 'meme': {
                    await interaction.deferReply();

                    try {
                        // Fetching from a popular meme subreddit's JSON endpoint
                        const response = await axios.get("https://www.reddit.com/r/memes/random/.json");
                        const post = response.data[0].data.children[0].data;

                        if (!post || post.over_18) {
                            return interaction.editReply("Could not find a suitable meme, please try again.");
                        }

                        const embed = new EmbedBuilder()
                            .setColor("#FF4500") // Reddit Orange
                            .setTitle(post.title)
                            .setURL(`https://www.reddit.com${post.permalink}`)
                            .setImage(post.url)
                            .setFooter({text: `👍 ${post.score} | 💬 ${post.num_comments} | Posted in r/${post.subreddit}`});

                        await interaction.editReply({embeds: [embed]});

                    } catch (error) {
                        console.error("[Meme Command Error]", error);
                        await interaction.editReply("Sorry, I couldn't fetch a meme right now. The meme-lords are resting.");
                    }
                    break;
                }
                case 'roll': {
                    await interaction.deferReply();
                    const sides = interaction.options.getInteger("sides") || 6;
                    const result = Math.floor(Math.random() * sides) + 1;

                    const embed = new EmbedBuilder()
                        .setColor("#2ECC71")
                        .setTitle(`🎲 Dice Roll (1-${sides})`)
                        .setDescription(`You rolled a **${result}**!`);

                    await interaction.editReply({embeds: [embed]});
                    break;
                }
                case 'cat': {
                    await interaction.deferReply();
                    try {
                        const response = await axios.get('https://api.thecatapi.com/v1/images/search');
                        const catImageUrl = response.data[0].url;

                        const embed = new EmbedBuilder()
                            .setColor('Random')
                            .setTitle('Meow!')
                            .setImage(catImageUrl)
                            .setFooter({text: 'Powered by thecatapi.com'});

                        await interaction.editReply({embeds: [embed]});
                    } catch (error) {
                        console.error('[Cat Command Error]', error);
                        await interaction.editReply('Sorry, I couldn\'t fetch a cat picture right now.');
                    }
                    break;
                }
                default:
                    await interaction.reply({ content: 'Invalid fun subcommand.', ephemeral: true });
                    break;
            }
        } else if (subcommandGroup === 'events') {
            await interaction.reply({ content: 'This command group is not yet implemented.', ephemeral: true });
        } else if (subcommandGroup === 'core') {
            await interaction.reply({ content: 'This command group is not yet implemented.', ephemeral: true });
        } else if (subcommandGroup === 'custom-command') {
            try {
                if (subcommand === "create") {
                    await interaction.deferReply({ephemeral: true});
                    const name = interaction.options.getString("name").toLowerCase();
                    const actionType = interaction.options.getString("action-type");
                    const actionContent = interaction.options.getString("response-or-role-id");
                    const requiredRoles = interaction.options.getString("required-roles")?.split(",").map(id => id.trim());
                    const allowedChannels = interaction.options.getString("allowed-channels")?.split(",").map(id => id.trim());

                    await db.execute(
                        `INSERT INTO custom_commands (guild_id, command_name, action_type, action_content, required_roles, allowed_channels) \n                     VALUES (?, ?, ?, ?, ?, ?) \n                     ON DUPLICATE KEY UPDATE action_type=VALUES(action_type), action_content=VALUES(action_content), required_roles=VALUES(required_roles), allowed_channels=VALUES(allowed_channels)`,
                        [guild.id, name, actionType, actionContent, JSON.stringify(requiredRoles || []), JSON.stringify(allowedChannels || [])]
                    );
                    invalidateCommandCache(guild.id, name);
                    await interaction.editReply(`✅ Advanced custom command \`${name}\` has been created/updated.`);

                } else if (subcommand === "remove") {
                    await interaction.deferReply({ephemeral: true});
                    const name = interaction.options.getString("name").toLowerCase();
                    const [result] = await db.execute("DELETE FROM custom_commands WHERE guild_id = ? AND command_name = ?", [guild.id, name]);
                    if (result.affectedRows > 0) {
                        invalidateCommandCache(guild.id, name);
                        await interaction.editReply(`🗑️ Custom command \`${name}\` has been deleted.`);
                    } else {
                        await interaction.editReply(`❌ No custom command found with the name \`${name}\`.`);
                    }

                } else if (subcommand === "list") {
                    await interaction.deferReply({ephemeral: true});
                    const [commands] = await db.execute("SELECT command_name, action_type FROM custom_commands WHERE guild_id = ? ORDER BY command_name", [guild.id]);
                    if (commands.length === 0) {
                        return interaction.editReply("There are no custom commands on this server.");
                    }
                    const embed = new EmbedBuilder()
                        .setColor("#5865F2")
                        .setTitle(`Custom Commands for ${interaction.guild.name}`)
                        .setDescription(commands.map(cmd => `\`${cmd.command_name}\` (*${cmd.action_type}*)`).join("\n"));
                    await interaction.editReply({embeds: [embed]});
                }
            } catch (error) {
                if (error.code === "ER_BAD_FIELD_ERROR" || error.code === "ER_NO_SUCH_TABLE") {
                    await interaction.editReply("The database tables for this feature have not been fully updated yet. Please ask the bot owner to update the schema.");
                } else {
                    logger.error("[CustomCommand Error]", error);
                    await interaction.editReply({content: "An error occurred while managing custom commands."});
                }
            }
        } else {
            await interaction.reply({ content: 'Invalid manage subcommand group.', ephemeral: true });
        }
    },
};