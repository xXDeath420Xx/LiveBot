import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import * as commandsHandler from './manage-commands-handler.js';
import * as giveawayHandler from './manage-giveaway-handler.js';
import * as pollHandler from './manage-poll-handler.js';
import * as rolesHandler from './manage-roles-handler.js';
import * as welcomeHandler from './manage-welcome-handler.js';

export default {
    category: 'community',
    data: new SlashCommandBuilder()
        .setName('manage')
        .setDescription('Server management tools — commands, giveaways, polls, roles, and welcome')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

        // ─── commands group (4 subcmds) ───
        .addSubcommandGroup(group =>
            group
                .setName('commands')
                .setDescription('Manage custom commands for the server')
                .addSubcommand(sub =>
                    sub
                        .setName('create')
                        .setDescription('Create a new custom command')
                        .addStringOption(opt => opt.setName('name').setDescription('The name of the custom command').setRequired(true))
                        .addStringOption(opt =>
                            opt.setName('action-type').setDescription('The type of action to perform').setRequired(true)
                                .addChoices(
                                    { name: 'Reply with message', value: 'reply' },
                                    { name: 'Add role to user', value: 'add_role' },
                                    { name: 'Remove role from user', value: 'remove_role' }
                                ))
                        .addStringOption(opt => opt.setName('response-or-role-id').setDescription('The response message (for reply) or role ID (for role actions)').setRequired(true))
                        .addStringOption(opt => opt.setName('required-roles').setDescription('Comma-separated role IDs required to use this command (optional)').setRequired(false))
                        .addStringOption(opt => opt.setName('allowed-channels').setDescription('Comma-separated channel IDs where this command can be used (optional)').setRequired(false))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('edit')
                        .setDescription('Edit an existing custom command')
                        .addStringOption(opt => opt.setName('name').setDescription('The name of the custom command to edit').setRequired(true))
                        .addStringOption(opt =>
                            opt.setName('action-type').setDescription('The type of action to perform').setRequired(true)
                                .addChoices(
                                    { name: 'Reply with message', value: 'reply' },
                                    { name: 'Add role to user', value: 'add_role' },
                                    { name: 'Remove role from user', value: 'remove_role' }
                                ))
                        .addStringOption(opt => opt.setName('response-or-role-id').setDescription('The response message (for reply) or role ID (for role actions)').setRequired(true))
                        .addStringOption(opt => opt.setName('required-roles').setDescription('Comma-separated role IDs required to use this command (optional)').setRequired(false))
                        .addStringOption(opt => opt.setName('allowed-channels').setDescription('Comma-separated channel IDs where this command can be used (optional)').setRequired(false))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('delete')
                        .setDescription('Delete a custom command')
                        .addStringOption(opt => opt.setName('name').setDescription('The name of the custom command to delete').setRequired(true))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('list')
                        .setDescription('List all custom commands for this server')
                )
        )

        // ─── giveaway group (5 subcmds) ───
        .addSubcommandGroup(group =>
            group
                .setName('giveaway')
                .setDescription('Manage giveaways')
                .addSubcommand(sub =>
                    sub
                        .setName('start')
                        .setDescription('Start a new giveaway')
                        .addStringOption(opt => opt.setName('prize').setDescription('What is being given away').setRequired(true))
                        .addIntegerOption(opt => opt.setName('winners').setDescription('Number of winners').setRequired(true).setMinValue(1).setMaxValue(20))
                        .addIntegerOption(opt => opt.setName('months').setDescription('Months (30 days each)').setMinValue(0).setMaxValue(12))
                        .addIntegerOption(opt => opt.setName('weeks').setDescription('Weeks').setMinValue(0).setMaxValue(52))
                        .addIntegerOption(opt => opt.setName('days').setDescription('Days').setMinValue(0).setMaxValue(365))
                        .addIntegerOption(opt => opt.setName('hours').setDescription('Hours').setMinValue(0).setMaxValue(23))
                        .addIntegerOption(opt => opt.setName('minutes').setDescription('Minutes').setMinValue(0).setMaxValue(59))
                        .addIntegerOption(opt => opt.setName('seconds').setDescription('Seconds').setMinValue(0).setMaxValue(59))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('end')
                        .setDescription('End a giveaway early')
                        .addStringOption(opt => opt.setName('message-id').setDescription('The message ID of the giveaway').setRequired(true))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('reroll')
                        .setDescription('Reroll the winners of a giveaway')
                        .addStringOption(opt => opt.setName('message-id').setDescription('The message ID of the giveaway').setRequired(true))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('list')
                        .setDescription('List all active giveaways')
                )
                .addSubcommand(sub =>
                    sub
                        .setName('cancel')
                        .setDescription('Cancel a giveaway')
                        .addStringOption(opt => opt.setName('message-id').setDescription('The message ID of the giveaway').setRequired(true))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('delete')
                        .setDescription('Delete a giveaway and remove its message from the channel')
                        .addStringOption(opt => opt.setName('message-id').setDescription('The message ID of the giveaway').setRequired(true))
                )
        )

        // ─── poll group (3 subcmds) ───
        .addSubcommandGroup(group =>
            group
                .setName('poll')
                .setDescription('Create and manage polls')
                .addSubcommand(sub =>
                    sub
                        .setName('create')
                        .setDescription('Create a new poll')
                        .addStringOption(opt => opt.setName('question').setDescription('The poll question').setRequired(true))
                        .addStringOption(opt => opt.setName('options').setDescription('Poll options separated by semicolons (;) - 2 to 10 options').setRequired(true))
                        .addStringOption(opt => opt.setName('duration').setDescription('How long the poll should last (e.g., 30m, 2h, 1d)').setRequired(false))
                        .addBooleanOption(opt => opt.setName('multiple-choice').setDescription('Allow users to vote for multiple options').setRequired(false))
                        .addBooleanOption(opt => opt.setName('anonymous').setDescription('Make votes anonymous').setRequired(false))
                        .addBooleanOption(opt => opt.setName('allow-write-in').setDescription('Allow users to submit custom answers').setRequired(false))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('end')
                        .setDescription('End an active poll')
                        .addStringOption(opt => opt.setName('message-id').setDescription('The message ID of the poll to end').setRequired(true))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('results')
                        .setDescription('View poll results')
                        .addStringOption(opt => opt.setName('message-id').setDescription('The message ID of the poll').setRequired(true))
                )
        )

        // ─── roles group (5 subcmds) ───
        .addSubcommandGroup(group =>
            group
                .setName('roles')
                .setDescription('Manage reaction role panels for self-assignable roles')
                .addSubcommand(sub =>
                    sub
                        .setName('create-panel')
                        .setDescription('Create a new reaction role panel')
                        .addChannelOption(opt => opt.setName('channel').setDescription('The channel to post the panel in').addChannelTypes(ChannelType.GuildText).setRequired(true))
                        .addStringOption(opt => opt.setName('name').setDescription('A name for this panel (for management purposes)').setRequired(true))
                        .addStringOption(opt =>
                            opt.setName('type').setDescription('The interaction type for role assignment').setRequired(true)
                                .addChoices(
                                    { name: 'Buttons', value: 'button' },
                                    { name: 'Select Menu', value: 'select_menu' },
                                    { name: 'Reactions', value: 'reaction' }
                                ))
                        .addStringOption(opt =>
                            opt.setName('mode').setDescription('Role assignment mode').setRequired(true)
                                .addChoices(
                                    { name: 'Normal (multiple roles)', value: 'normal' },
                                    { name: 'Unique (one role only)', value: 'unique' }
                                ))
                        .addStringOption(opt => opt.setName('title').setDescription('The title of the embed').setRequired(false))
                        .addStringOption(opt => opt.setName('description').setDescription('The description of the embed').setRequired(false))
                        .addStringOption(opt => opt.setName('color').setDescription('The embed color (hex format, e.g., #5865F2)').setRequired(false))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('add-role')
                        .setDescription('Add a role to an existing panel')
                        .addStringOption(opt => opt.setName('message-id').setDescription('The message ID of the panel').setRequired(true))
                        .addRoleOption(opt => opt.setName('role').setDescription('The role to add').setRequired(true))
                        .addStringOption(opt => opt.setName('emoji').setDescription('The emoji for this role').setRequired(true))
                        .addStringOption(opt => opt.setName('label').setDescription('The label for buttons (or select menu option)').setRequired(false))
                        .addStringOption(opt => opt.setName('description').setDescription('The description for select menu options').setRequired(false))
                        .addStringOption(opt =>
                            opt.setName('style').setDescription('The button style (for button panels)').setRequired(false)
                                .addChoices(
                                    { name: 'Primary (Blurple)', value: 'primary' },
                                    { name: 'Secondary (Gray)', value: 'secondary' },
                                    { name: 'Success (Green)', value: 'success' },
                                    { name: 'Danger (Red)', value: 'danger' }
                                ))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('remove-role')
                        .setDescription('Remove a role from an existing panel')
                        .addStringOption(opt => opt.setName('message-id').setDescription('The message ID of the panel').setRequired(true))
                        .addRoleOption(opt => opt.setName('role').setDescription('The role to remove').setRequired(true))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('delete-panel')
                        .setDescription('Delete an entire reaction role panel')
                        .addStringOption(opt => opt.setName('message-id').setDescription('The message ID of the panel to delete').setRequired(true))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('list')
                        .setDescription('List all reaction role panels in this server')
                )
        )

        // ─── welcome group (5 subcmds) ───
        .addSubcommandGroup(group =>
            group
                .setName('welcome')
                .setDescription('Configure welcome and goodbye messages for new members')
                .addSubcommand(sub =>
                    sub
                        .setName('set-welcome')
                        .setDescription('Set up the welcome message and banner')
                        .addChannelOption(opt => opt.setName('channel').setDescription('The channel where welcome messages will be sent').addChannelTypes(ChannelType.GuildText).setRequired(true))
                        .addStringOption(opt => opt.setName('message').setDescription('The welcome message. Use {mention}, {user}, {server}, {memberCount} as variables.').setRequired(true))
                        .addBooleanOption(opt => opt.setName('enable-banner').setDescription('Enable or disable the welcome banner image').setRequired(false))
                        .addAttachmentOption(opt => opt.setName('background').setDescription('Upload a custom background for the welcome banner').setRequired(false))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('set-goodbye')
                        .setDescription('Set up the goodbye message for leaving members')
                        .addChannelOption(opt => opt.setName('channel').setDescription('The channel where goodbye messages will be sent').addChannelTypes(ChannelType.GuildText).setRequired(true))
                        .addStringOption(opt => opt.setName('message').setDescription('The goodbye message. Use {user}, {server} as variables.').setRequired(true))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('set-autorole')
                        .setDescription('Set a role to automatically assign to new members')
                        .addRoleOption(opt => opt.setName('role').setDescription('The role to assign to new members').setRequired(true))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('disable')
                        .setDescription('Disable welcome or goodbye messages')
                        .addStringOption(opt =>
                            opt.setName('type').setDescription('What to disable').setRequired(true)
                                .addChoices(
                                    { name: 'Welcome Messages', value: 'welcome' },
                                    { name: 'Goodbye Messages', value: 'goodbye' },
                                    { name: 'Auto Role', value: 'autorole' },
                                    { name: 'Banner', value: 'banner' },
                                    { name: 'All', value: 'all' }
                                ))
                )
                .addSubcommand(sub =>
                    sub
                        .setName('test')
                        .setDescription('Test the current welcome message with a preview')
                )
        ),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();

        switch (group) {
            // ─── commands ───
            case 'commands':
                switch (subcommand) {
                    case 'create': return commandsHandler.handleCreate(interaction);
                    case 'edit': return commandsHandler.handleEdit(interaction);
                    case 'delete': return commandsHandler.handleDelete(interaction);
                    case 'list': return commandsHandler.handleListCommands(interaction);
                }
                break;

            // ─── giveaway ───
            case 'giveaway':
                switch (subcommand) {
                    case 'start': return giveawayHandler.handleStart(interaction);
                    case 'end': return giveawayHandler.handleEnd(interaction);
                    case 'reroll': return giveawayHandler.handleReroll(interaction);
                    case 'list': return giveawayHandler.handleListGiveaways(interaction);
                    case 'cancel': return giveawayHandler.handleCancel(interaction);
                    case 'delete': return giveawayHandler.handleDelete(interaction);
                }
                break;

            // ─── poll ───
            case 'poll':
                switch (subcommand) {
                    case 'create': return pollHandler.handleCreate(interaction);
                    case 'end': return pollHandler.handleEnd(interaction);
                    case 'results': return pollHandler.handleResults(interaction);
                }
                break;

            // ─── roles ───
            case 'roles':
                switch (subcommand) {
                    case 'create-panel': return rolesHandler.handleCreatePanel(interaction);
                    case 'add-role': return rolesHandler.handleAddRole(interaction);
                    case 'remove-role': return rolesHandler.handleRemoveRole(interaction);
                    case 'delete-panel': return rolesHandler.handleDeletePanel(interaction);
                    case 'list': return rolesHandler.handleListPanels(interaction);
                }
                break;

            // ─── welcome ───
            case 'welcome':
                switch (subcommand) {
                    case 'set-welcome': return welcomeHandler.handleSetWelcome(interaction);
                    case 'set-goodbye': return welcomeHandler.handleSetGoodbye(interaction);
                    case 'set-autorole': return welcomeHandler.handleSetAutorole(interaction);
                    case 'disable': return welcomeHandler.handleDisable(interaction);
                    case 'test': return welcomeHandler.handleTest(interaction);
                }
                break;
        }
    }
};
