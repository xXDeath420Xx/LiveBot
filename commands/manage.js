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
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
// Import all handler modules
const permissionsHandlers = __importStar(require("../handlers/manage/permissions"));
const moderationHandlers = __importStar(require("../handlers/manage/moderation"));
const backupHandlers = __importStar(require("../handlers/manage/backup"));
const funHandlers = __importStar(require("../handlers/manage/fun"));
const eventsHandlers = __importStar(require("../handlers/manage/events"));
const coreHandlers = __importStar(require("../handlers/manage/core"));
const customCommandHandlers = __importStar(require("../handlers/manage/custom-command"));
module.exports = {
    data: new discord_js_1.SlashCommandBuilder()
        .setName('manage')
        .setDescription('Server management commands.')
        .setDefaultMemberPermissions(discord_js_1.PermissionsBitField.Flags.ManageGuild)
        .addSubcommandGroup(group => group
        .setName('permissions')
        .setDescription('Manage command permissions for roles on this server.')
        .addSubcommand(subcommand => subcommand
        .setName("grant")
        .setDescription("Grants a role permission to use a command.")
        .addRoleOption(option => option.setName("role").setDescription("The role to grant permission to.").setRequired(true))
        .addStringOption(option => option.setName("command").setDescription("The command to grant permission for.").setRequired(true).setAutocomplete(true)))
        .addSubcommand(subcommand => subcommand
        .setName("revoke")
        .setDescription("Revokes a role's permission to use a command.")
        .addRoleOption(option => option.setName("role").setDescription("The role to revoke permission from.").setRequired(true))
        .addStringOption(option => option.setName("command").setDescription("The command to revoke permission for.").setRequired(true).setAutocomplete(true))))
        .addSubcommandGroup(group => group
        .setName('moderation')
        .setDescription('Moderation commands.')
        .addSubcommand(subcommand => subcommand
        .setName('ban')
        .setDescription('Bans a user from the server.')
        .addUserOption(option => option
        .setName("user")
        .setDescription("The user to ban.")
        .setRequired(true))
        .addStringOption(option => option
        .setName("reason")
        .setDescription("The reason for the ban.")
        .setRequired(true)))
        .addSubcommand(subcommand => subcommand
        .setName('unban')
        .setDescription('Revokes a ban for a user.')
        .addStringOption(option => option
        .setName("user-id")
        .setDescription("The ID of the user to unban.")
        .setRequired(true))
        .addStringOption(option => option
        .setName("reason")
        .setDescription("The reason for the unban.")
        .setRequired(true)))
        .addSubcommand(subcommand => subcommand
        .setName('kick')
        .setDescription('Kicks a user from the server.')
        .addUserOption(option => option
        .setName("user")
        .setDescription("The user to kick.")
        .setRequired(true))
        .addStringOption(option => option
        .setName("reason")
        .setDescription("The reason for the kick.")
        .setRequired(true)))
        .addSubcommand(subcommand => subcommand
        .setName('mute')
        .setDescription('Times out a user, preventing them from talking or speaking.')
        .addUserOption(option => option
        .setName("user")
        .setDescription("The user to mute.")
        .setRequired(true))
        .addStringOption(option => option
        .setName("duration")
        .setDescription("The duration of the mute (e.g., 5m, 1h, 3d). Max 28d.")
        .setRequired(true))
        .addStringOption(option => option
        .setName("reason")
        .setDescription("The reason for the mute.")
        .setRequired(true)))
        .addSubcommand(subcommand => subcommand
        .setName('unmute')
        .setDescription('Removes a timeout from a user.')
        .addUserOption(option => option
        .setName("user")
        .setDescription("The user to unmute.")
        .setRequired(true))
        .addStringOption(option => option
        .setName("reason")
        .setDescription("The reason for the unban.")
        .setRequired(true)))
        .addSubcommand(subcommand => subcommand
        .setName('warn')
        .setDescription('Issues a formal warning to a user.')
        .addUserOption(option => option
        .setName("user")
        .setDescription("The user to warn.")
        .setRequired(true))
        .addStringOption(option => option
        .setName("reason")
        .setDescription("The reason for the warning.")
        .setRequired(true)))
        .addSubcommand(subcommand => subcommand
        .setName('clearinfractions')
        .setDescription('Clears a user\'s moderation history.')
        .addUserOption(option => option
        .setName("user")
        .setDescription("The user whose history you want to clear.")
        .setRequired(true))
        .addStringOption(option => option
        .setName("reason")
        .setDescription("The reason for clearing the history.")
        .setRequired(true)))
        .addSubcommand(subcommand => subcommand
        .setName('history')
        .setDescription("Checks a user's moderation history.")
        .addUserOption(option => option
        .setName("user")
        .setDescription("The user to check.")
        .setRequired(true)))
        .addSubcommand(subcommand => subcommand
        .setName('purge')
        .setDescription('Advanced message cleaning with filters.')
        .addIntegerOption(option => option
        .setName("amount")
        .setDescription("Number of messages to scan (up to 100).")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100))
        .addStringOption(option => option
        .setName("filter")
        .setDescription("The type of message to clean.")
        .setRequired(true)
        .addChoices({ name: "All", value: "all" }, { name: "User", value: "user" }, { name: "Bots", value: "bots" }, { name: "Contains Text", value: "text" }, { name: "Has Link", value: "links" }, { name: "Has Attachment", value: "files" }))
        .addUserOption(option => option
        .setName("user")
        .setDescription("The user whose messages to delete (required if filter is \"User\")."))
        .addStringOption(option => option
        .setName("text")
        .setDescription("The text to search for (required if filter is \"Contains Text\").")))
        .addSubcommand(subcommand => subcommand
        .setName('quarantine')
        .setDescription('Quarantines a user, temporarily restricting their permissions.')
        .addUserOption(option => option
        .setName("user")
        .setDescription("The user to quarantine.")
        .setRequired(true))
        .addBooleanOption(option => option
        .setName("enable")
        .setDescription("Enable or disable quarantine for the user.")
        .setRequired(true)))
        .addSubcommand(subcommand => subcommand
        .setName('slowmode')
        .setDescription('Sets or removes a slowmode cooldown for the current channel.')
        .addStringOption(option => option
        .setName("duration")
        .setDescription("The slowmode duration (e.g., 10m, 5m, 1h) or \"off\".")
        .setRequired(true))
        .addStringOption(option => option
        .setName("reason")
        .setDescription("The reason for changing the slowmode.")))
        .addSubcommand(subcommand => subcommand
        .setName('lock')
        .setDescription('Locks the current channel, preventing @everyone from sending messages.')
        .addStringOption(option => option
        .setName("reason")
        .setDescription("The reason for locking the channel.")))
        .addSubcommand(subcommand => subcommand
        .setName('unlock')
        .setDescription('Unlocks the current channel, allowing @everyone to send messages.'))
        .addSubcommand(subcommand => subcommand
        .setName('lockdown')
        .setDescription('Locks the current channel, preventing messages. Requires a special password.')
        .addStringOption(option => option
        .setName("password")
        .setDescription("The password required to execute this sensitive action.")
        .setRequired(true))
        .addBooleanOption(option => option
        .setName("unlock")
        .setDescription("Set to true to unlock the channel.")
        .setRequired(false)))
        .addSubcommand(subcommand => subcommand
        .setName("announce")
        .setDescription("Sends an announcement to a specified channel.")
        .addChannelOption(option => option
        .setName("channel")
        .setDescription("The channel to send the announcement to.")
        .addChannelTypes(0) // GuildText
        .setRequired(true))
        .addStringOption(option => option
        .setName("message")
        .setDescription("The main content of the announcement.")
        .setRequired(true))
        .addStringOption(option => option
        .setName("title")
        .setDescription("An optional title for the embed."))
        .addStringOption(option => option
        .setName("color")
        .setDescription("An optional hex color for the embed (e.g., #3498DB)."))
        .addRoleOption(option => option
        .setName("mention")
        .setDescription("An optional role to mention with the announcement."))))
        .addSubcommandGroup(group => group
        .setName("backup")
        .setDescription("Manage server structure backups (roles & channels).")
        .addSubcommand(subcommand => subcommand
        .setName("create")
        .setDescription("Creates a new backup of the server's roles and channels.")
        .addStringOption(option => option.setName("name").setDescription("A descriptive name for this backup.").setRequired(true)))
        .addSubcommand(subcommand => subcommand
        .setName("list")
        .setDescription("Lists all available backups for this server."))
        .addSubcommand(subcommand => subcommand
        .setName("load")
        .setDescription("Restores the server structure from a backup. THIS IS DESTRUCTIVE.")
        .addStringOption(option => option.setName("backup_id").setDescription("The ID of the backup to load.").setRequired(true)))
        .addSubcommand(subcommand => subcommand
        .setName("delete")
        .setDescription("Deletes a server backup.")
        .addStringOption(option => option.setName("backup_id").setDescription("The ID of the backup to delete.").setRequired(true))))
        .addSubcommandGroup(group => group
        .setName('fun')
        .setDescription('Fun commands.')
        .addSubcommand(subcommand => subcommand
        .setName('coinflip')
        .setDescription('Flips a coin.'))
        .addSubcommand(subcommand => subcommand
        .setName('meme')
        .setDescription('Sends a random meme from Reddit.'))
        .addSubcommand(subcommand => subcommand
        .setName('roll')
        .setDescription('Rolls a dice.')
        .addIntegerOption(option => option.setName('sides').setDescription('The number of sides on the dice (default 6).').setMinValue(2).setMaxValue(100)))
        .addSubcommand(subcommand => subcommand
        .setName('cat')
        .setDescription('Sends a random cat picture.')))
        .addSubcommandGroup(group => group
        .setName('events')
        .setDescription('Event management commands.')
        .addSubcommand(subcommand => subcommand
        .setName('giveaway')
        .setDescription('Start a giveaway.'))
        .addSubcommand(subcommand => subcommand
        .setName('remind')
        .setDescription('Set a reminder.')
        .addStringOption(option => option.setName('time').setDescription('When to remind (e.g., 1h, 30m).').setRequired(true))
        .addStringOption(option => option.setName('message').setDescription('What to remind you about.').setRequired(true)))
        .addSubcommand(subcommand => subcommand
        .setName('reactionroles')
        .setDescription('Manage reaction roles.'))
        .addSubcommand(subcommand => subcommand
        .setName('starboard')
        .setDescription('Manage starboard settings.')))
        .addSubcommandGroup(group => group
        .setName('core')
        .setDescription('Core bot commands.')
        .addSubcommand(subcommand => subcommand
        .setName('stats')
        .setDescription('Display bot statistics.'))
        .addSubcommand(subcommand => subcommand
        .setName('status')
        .setDescription('Display bot status.'))
        .addSubcommand(subcommand => subcommand
        .setName('ping')
        .setDescription('Check bot latency.'))
        .addSubcommand(subcommand => subcommand
        .setName('globalreinit')
        .setDescription('Reinitialize global commands (Bot Owner Only).'))
        .addSubcommand(subcommand => subcommand
        .setName('reinit')
        .setDescription('Reinitialize guild commands (Admin Only).'))
        .addSubcommand(subcommand => subcommand
        .setName('resetdatabase')
        .setDescription('Reset the bot\'s database (Bot Owner Only).')))
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
        .addChoices({ name: "Reply with Text", value: "reply" }, { name: "Add Role to User", value: "add_role" }, { name: "Remove Role from User", value: "remove_role" }))
        .addStringOption(option => option.setName("response-or-role-id").setDescription("The text response or the ID of the role to manage.").setRequired(true))
        .addStringOption(option => option.setName("required-roles").setDescription("Comma-separated list of role IDs required to use this command."))
        .addStringOption(option => option.setName("allowed-channels").setDescription("Comma-separated list of channel IDs where this command can be used.")))
        .addSubcommand(subcommand => subcommand
        .setName("remove")
        .setDescription("Removes a custom command.")
        .addStringOption(option => option.setName("name").setDescription("The name of the command to remove.").setRequired(true).setAutocomplete(true)))
        .addSubcommand(subcommand => subcommand
        .setName("list")
        .setDescription("Lists all custom commands on this server."))),
    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        const subcommandGroup = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand(false);
        if (subcommandGroup === 'permissions' && (subcommand === 'grant' || subcommand === 'revoke') && focusedOption.name === "command") {
            const focusedValue = focusedOption.value;
            try {
                const commandNames = Array.from(interaction.client.commands.keys());
                const filtered = commandNames.filter(name => name.startsWith(focusedValue) && name !== "permissions");
                await interaction.respond(filtered.map(name => ({ name, value: name })));
            }
            catch (error) {
                logger_1.default.error("[Permissions Command Autocomplete Error]", error);
                await interaction.respond([]);
            }
        }
        else if (subcommandGroup === 'custom-command' && subcommand === 'remove' && focusedOption.name === "name") {
            const focusedValue = focusedOption.value;
            try {
                const [commands] = await db_1.default.execute("SELECT command_name FROM custom_commands WHERE guild_id = ? AND command_name LIKE ? LIMIT 25", [interaction.guild?.id, `${focusedValue}%`]);
                await interaction.respond(commands.map(cmd => ({ name: cmd.command_name, value: cmd.command_name })));
            }
            catch (error) {
                await interaction.respond([]);
            }
        }
    },
    async execute(interaction) {
        const subcommandGroup = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();
        try {
            // Route to appropriate handler based on subcommand group
            switch (subcommandGroup) {
                case 'permissions':
                    if (subcommand === 'grant') {
                        await permissionsHandlers.handleGrant(interaction);
                    }
                    else if (subcommand === 'revoke') {
                        await permissionsHandlers.handleRevoke(interaction);
                    }
                    break;
                case 'moderation':
                    switch (subcommand) {
                        case 'ban':
                            await moderationHandlers.handleBan(interaction);
                            break;
                        case 'unban':
                            await moderationHandlers.handleUnban(interaction);
                            break;
                        case 'kick':
                            await moderationHandlers.handleKick(interaction);
                            break;
                        case 'mute':
                            await moderationHandlers.handleMute(interaction);
                            break;
                        case 'unmute':
                            await moderationHandlers.handleUnmute(interaction);
                            break;
                        case 'warn':
                            await moderationHandlers.handleWarn(interaction);
                            break;
                        case 'clearinfractions':
                            await moderationHandlers.handleClearInfractions(interaction);
                            break;
                        case 'history':
                            await moderationHandlers.handleHistory(interaction);
                            break;
                        case 'purge':
                            await moderationHandlers.handlePurge(interaction);
                            break;
                        case 'quarantine':
                            await moderationHandlers.handleQuarantine(interaction);
                            break;
                        case 'slowmode':
                            await moderationHandlers.handleSlowmode(interaction);
                            break;
                        case 'lock':
                            await moderationHandlers.handleLock(interaction);
                            break;
                        case 'unlock':
                            await moderationHandlers.handleUnlock(interaction);
                            break;
                        case 'lockdown':
                            await moderationHandlers.handleLockdown(interaction);
                            break;
                        case 'announce':
                            await moderationHandlers.handleAnnounce(interaction);
                            break;
                        default:
                            await interaction.reply({ content: 'Invalid moderation subcommand.', ephemeral: true });
                    }
                    break;
                case 'backup':
                    switch (subcommand) {
                        case 'create':
                            await backupHandlers.handleCreate(interaction);
                            break;
                        case 'list':
                            await backupHandlers.handleList(interaction);
                            break;
                        case 'load':
                            await backupHandlers.handleLoad(interaction);
                            break;
                        case 'delete':
                            await backupHandlers.handleDelete(interaction);
                            break;
                        default:
                            await interaction.reply({ content: 'Invalid backup subcommand.', ephemeral: true });
                    }
                    break;
                case 'fun':
                    switch (subcommand) {
                        case 'coinflip':
                            await funHandlers.handleCoinflip(interaction);
                            break;
                        case 'meme':
                            await funHandlers.handleMeme(interaction);
                            break;
                        case 'roll':
                            await funHandlers.handleRoll(interaction);
                            break;
                        case 'cat':
                            await funHandlers.handleCat(interaction);
                            break;
                        default:
                            await interaction.reply({ content: 'Invalid fun subcommand.', ephemeral: true });
                    }
                    break;
                case 'events':
                    switch (subcommand) {
                        case 'giveaway':
                            await eventsHandlers.handleGiveaway(interaction);
                            break;
                        case 'remind':
                            await eventsHandlers.handleRemind(interaction);
                            break;
                        case 'reactionroles':
                            await eventsHandlers.handleReactionRoles(interaction);
                            break;
                        case 'starboard':
                            await eventsHandlers.handleStarboard(interaction);
                            break;
                        default:
                            await interaction.reply({ content: 'Invalid events subcommand.', ephemeral: true });
                    }
                    break;
                case 'core':
                    switch (subcommand) {
                        case 'stats':
                            await coreHandlers.handleStats(interaction);
                            break;
                        case 'status':
                            await coreHandlers.handleStatus(interaction);
                            break;
                        case 'ping':
                            await coreHandlers.handlePing(interaction);
                            break;
                        case 'globalreinit':
                            await coreHandlers.handleGlobalReinit(interaction);
                            break;
                        case 'reinit':
                            await coreHandlers.handleReinit(interaction);
                            break;
                        case 'resetdatabase':
                            await coreHandlers.handleResetDatabase(interaction);
                            break;
                        default:
                            await interaction.reply({ content: 'Invalid core subcommand.', ephemeral: true });
                    }
                    break;
                case 'custom-command':
                    switch (subcommand) {
                        case 'create':
                            await customCommandHandlers.handleCreate(interaction);
                            break;
                        case 'remove':
                            await customCommandHandlers.handleRemove(interaction);
                            break;
                        case 'list':
                            await customCommandHandlers.handleList(interaction);
                            break;
                        default:
                            await interaction.reply({ content: 'Invalid custom-command subcommand.', ephemeral: true });
                    }
                    break;
                default:
                    await interaction.reply({ content: 'Invalid manage subcommand group.', ephemeral: true });
            }
        }
        catch (error) {
            logger_1.default.error(`[Manage Command] Error in ${subcommandGroup}/${subcommand}:`, error);
            const errorMessage = { content: 'An unexpected error occurred while executing this command.', ephemeral: true };
            if (interaction.deferred) {
                await interaction.editReply(errorMessage);
            }
            else if (!interaction.replied) {
                await interaction.reply(errorMessage);
            }
        }
    },
    category: 'management'
};
