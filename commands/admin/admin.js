import {
    SlashCommandBuilder,
    PermissionsBitField,
    ChannelType,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import * as backupHandler from './admin-backup-handler.js';
import * as embedHandler from './admin-embed-handler.js';
import * as modHandler from './admin-mod-handler.js';
import * as teamsyncHandler from './admin-teamsync-handler.js';
import * as vcsoundsHandler from './admin-vcsounds-handler.js';

function requireAdmin(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        interaction.reply({ content: 'This command requires Administrator permission.', ephemeral: true });
        return false;
    }
    return true;
}

export default {
    category: 'admin',
    data: new SlashCommandBuilder()
        .setName('admin')
        .setDescription('Administrative commands for server management.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)

        // ─── flat: setup-requests ───
        .addSubcommand(subcommand =>
            subcommand
                .setName('setup-requests')
                .setDescription('Creates the panel for users to request live announcements.')
                .addChannelOption(option =>
                    option.setName('panel-channel')
                        .setDescription('The channel where the request panel will be posted.')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true))
                .addChannelOption(option =>
                    option.setName('requests-channel')
                        .setDescription('The channel where the bot will post the requests for approval.')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true))
        )

        // ─── backup group (5 subcmds) ───
        .addSubcommandGroup(group =>
            group
                .setName('backup')
                .setDescription('Server backup and restore system')
                .addSubcommand(sub =>
                    sub.setName('create').setDescription('Create a backup of the server')
                        .addStringOption(opt => opt.setName('name').setDescription('Name for this backup').setRequired(true).setMaxLength(100)))
                .addSubcommand(sub => sub.setName('list').setDescription('View all server backups'))
                .addSubcommand(sub =>
                    sub.setName('restore').setDescription('Restore from a backup (DESTRUCTIVE)')
                        .addIntegerOption(opt => opt.setName('backup_id').setDescription('ID of the backup to restore').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('delete').setDescription('Delete a backup')
                        .addIntegerOption(opt => opt.setName('backup_id').setDescription('ID of the backup to delete').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('info').setDescription('View detailed information about a backup')
                        .addIntegerOption(opt => opt.setName('backup_id').setDescription('ID of the backup to view').setRequired(true)))
        )

        // ─── embed group (5 subcmds) ───
        .addSubcommandGroup(group =>
            group
                .setName('embed')
                .setDescription('Create, edit, and send custom embeds')
                .addSubcommand(sub =>
                    sub.setName('create').setDescription('Create a new embed with a form')
                        .addChannelOption(opt =>
                            opt.setName('channel').setDescription('Channel to send the embed to (defaults to current)')
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
                .addSubcommand(sub =>
                    sub.setName('quick').setDescription('Quickly create a simple embed')
                        .addStringOption(opt => opt.setName('title').setDescription('Embed title').setRequired(true))
                        .addStringOption(opt => opt.setName('description').setDescription('Embed description').setRequired(true))
                        .addStringOption(opt => opt.setName('color').setDescription('Hex color code (e.g. #ff0000)'))
                        .addStringOption(opt => opt.setName('image').setDescription('Image URL'))
                        .addStringOption(opt => opt.setName('thumbnail').setDescription('Thumbnail URL'))
                        .addStringOption(opt => opt.setName('footer').setDescription('Footer text'))
                        .addChannelOption(opt =>
                            opt.setName('channel').setDescription('Channel to send to (defaults to current)')
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
                .addSubcommand(sub =>
                    sub.setName('edit').setDescription('Edit an existing embed sent by the bot')
                        .addStringOption(opt => opt.setName('message_id').setDescription('The message ID of the embed to edit').setRequired(true))
                        .addChannelOption(opt =>
                            opt.setName('channel').setDescription('Channel the message is in (defaults to current)')
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
                .addSubcommand(sub =>
                    sub.setName('json').setDescription('Create an embed from raw JSON')
                        .addStringOption(opt => opt.setName('data').setDescription('JSON embed data').setRequired(true))
                        .addChannelOption(opt =>
                            opt.setName('channel').setDescription('Channel to send to (defaults to current)')
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
                .addSubcommand(sub =>
                    sub.setName('copy').setDescription('Copy an embed from a message')
                        .addStringOption(opt => opt.setName('message_id').setDescription('Message ID to copy the embed from').setRequired(true))
                        .addChannelOption(opt =>
                            opt.setName('source_channel').setDescription('Channel the source message is in (defaults to current)')
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
                        .addChannelOption(opt =>
                            opt.setName('target_channel').setDescription('Channel to send the copy to (defaults to current)')
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
        )

        // ─── mod group (15 subcmds) ───
        .addSubcommandGroup(group =>
            group
                .setName('mod')
                .setDescription('Moderation commands')
                .addSubcommand(sub =>
                    sub.setName('ban').setDescription('Bans a user from the server.')
                        .addUserOption(opt => opt.setName('user').setDescription('The user to ban.').setRequired(true))
                        .addStringOption(opt => opt.setName('reason').setDescription('The reason for the ban.').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('unban').setDescription('Revokes a ban for a user.')
                        .addStringOption(opt => opt.setName('user-id').setDescription('The ID of the user to unban.').setRequired(true))
                        .addStringOption(opt => opt.setName('reason').setDescription('The reason for the unban.').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('kick').setDescription('Kicks a user from the server.')
                        .addUserOption(opt => opt.setName('user').setDescription('The user to kick.').setRequired(true))
                        .addStringOption(opt => opt.setName('reason').setDescription('The reason for the kick.').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('mute').setDescription('Times out a user, preventing them from talking or speaking.')
                        .addUserOption(opt => opt.setName('user').setDescription('The user to mute.').setRequired(true))
                        .addStringOption(opt => opt.setName('duration').setDescription('The duration of the mute (e.g., 5m, 1h, 3d). Max 28d.').setRequired(true))
                        .addStringOption(opt => opt.setName('reason').setDescription('The reason for the mute.').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('unmute').setDescription('Removes a timeout from a user.')
                        .addUserOption(opt => opt.setName('user').setDescription('The user to unmute.').setRequired(true))
                        .addStringOption(opt => opt.setName('reason').setDescription('The reason for the unmute.').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('warn').setDescription('Issues a formal warning to a user.')
                        .addUserOption(opt => opt.setName('user').setDescription('The user to warn.').setRequired(true))
                        .addStringOption(opt => opt.setName('reason').setDescription('The reason for the warning.').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('clearinfractions').setDescription('Clears a user\'s moderation history.')
                        .addUserOption(opt => opt.setName('user').setDescription('The user whose history you want to clear.').setRequired(true))
                        .addStringOption(opt => opt.setName('reason').setDescription('The reason for clearing the history.').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('history').setDescription('Checks a user\'s moderation history.')
                        .addUserOption(opt => opt.setName('user').setDescription('The user to check.').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('purge').setDescription('Advanced message cleaning with filters.')
                        .addIntegerOption(opt => opt.setName('amount').setDescription('Number of messages to scan (up to 100).').setRequired(true).setMinValue(1).setMaxValue(100))
                        .addStringOption(opt =>
                            opt.setName('filter').setDescription('The type of message to clean.').setRequired(true)
                                .addChoices(
                                    { name: 'All', value: 'all' },
                                    { name: 'User', value: 'user' },
                                    { name: 'Bots', value: 'bots' },
                                    { name: 'Contains Text', value: 'text' },
                                    { name: 'Has Link', value: 'links' },
                                    { name: 'Has Attachment', value: 'files' }
                                ))
                        .addUserOption(opt => opt.setName('user').setDescription('The user whose messages to delete (required if filter is "User").'))
                        .addStringOption(opt => opt.setName('text').setDescription('The text to search for (required if filter is "Contains Text").')))
                .addSubcommand(sub =>
                    sub.setName('quarantine').setDescription('Quarantines a user, temporarily restricting their permissions.')
                        .addUserOption(opt => opt.setName('user').setDescription('The user to quarantine.').setRequired(true))
                        .addBooleanOption(opt => opt.setName('enable').setDescription('Enable or disable quarantine for the user.').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('slowmode').setDescription('Sets or removes a slowmode cooldown for the current channel.')
                        .addStringOption(opt => opt.setName('duration').setDescription('The slowmode duration (e.g., 10m, 5m, 1h) or "off".').setRequired(true))
                        .addStringOption(opt => opt.setName('reason').setDescription('The reason for changing the slowmode.')))
                .addSubcommand(sub =>
                    sub.setName('lock').setDescription('Locks the current channel, preventing @everyone from sending messages.')
                        .addStringOption(opt => opt.setName('reason').setDescription('The reason for locking the channel.')))
                .addSubcommand(sub => sub.setName('unlock').setDescription('Unlocks the current channel, allowing @everyone to send messages.'))
                .addSubcommand(sub =>
                    sub.setName('lockdown').setDescription('Locks the current channel. Requires a special password.')
                        .addStringOption(opt => opt.setName('password').setDescription('The password required to execute this sensitive action.').setRequired(true))
                        .addBooleanOption(opt => opt.setName('unlock').setDescription('Set to true to unlock the channel.')))
                .addSubcommand(sub =>
                    sub.setName('announce').setDescription('Sends an announcement to a specified channel.')
                        .addChannelOption(opt => opt.setName('channel').setDescription('The channel to send the announcement to.').addChannelTypes(ChannelType.GuildText).setRequired(true))
                        .addStringOption(opt => opt.setName('message').setDescription('The main content of the announcement.').setRequired(true))
                        .addStringOption(opt => opt.setName('title').setDescription('An optional title for the embed.'))
                        .addStringOption(opt => opt.setName('color').setDescription('An optional hex color for the embed (e.g., #3498DB).'))
                        .addRoleOption(opt => opt.setName('mention').setDescription('An optional role to mention with the announcement.')))
        )

        // ─── teamsync group (3 subcmds) ───
        .addSubcommandGroup(group =>
            group
                .setName('teamsync')
                .setDescription('Synchronize tracked teams and members across all bots')
                .addSubcommand(sub => sub.setName('all').setDescription('Sync all teams across all bots'))
                .addSubcommand(sub =>
                    sub.setName('team').setDescription('Sync a specific team')
                        .addStringOption(opt => opt.setName('team_name').setDescription('The name of the Twitch team to sync').setRequired(true).setAutocomplete(true)))
                .addSubcommand(sub => sub.setName('status').setDescription('Show current team sync status and next scheduled run'))
        )

        // ─── temp-channel group (2 subcmds) ───
        .addSubcommandGroup(group =>
            group
                .setName('temp-channel')
                .setDescription('Manages the automatic temporary voice channel system.')
                .addSubcommand(sub =>
                    sub.setName('setup').setDescription('Sets up the temp channel creator.')
                        .addChannelOption(opt =>
                            opt.setName('creator-channel').setDescription('The voice channel users join to create a new channel.')
                                .addChannelTypes(ChannelType.GuildVoice).setRequired(true))
                        .addChannelOption(opt =>
                            opt.setName('category').setDescription('The category where new temp channels will be created.')
                                .addChannelTypes(ChannelType.GuildCategory).setRequired(true))
                        .addStringOption(opt =>
                            opt.setName('naming-template').setDescription('The name for new channels. Use {user} for the user\'s name.')))
                .addSubcommand(sub => sub.setName('disable').setDescription('Disables the temp channel system.'))
        )

        // ─── verification group (1 subcmd) ───
        .addSubcommandGroup(group =>
            group
                .setName('verification')
                .setDescription('Manages the server verification gate.')
                .addSubcommand(sub =>
                    sub.setName('setup').setDescription('Creates the verification panel in a channel.')
                        .addChannelOption(opt =>
                            opt.setName('channel').setDescription('The channel where users will verify.')
                                .addChannelTypes(ChannelType.GuildText).setRequired(true))
                        .addRoleOption(opt =>
                            opt.setName('role').setDescription('The role to grant to users upon verification.').setRequired(true)))
        )

        // ─── vcsounds group (14 subcmds) ───
        .addSubcommandGroup(group =>
            group
                .setName('vcsounds')
                .setDescription('Configure VC sound drops (random/scheduled sounds in voice channels)')
                .addSubcommand(sub =>
                    sub.setName('enable').setDescription('Enable VC sound drops')
                        .addStringOption(opt =>
                            opt.setName('mode').setDescription('Drop mode').setRequired(true)
                                .addChoices(
                                    { name: 'Random - drops at random intervals', value: 'random' },
                                    { name: 'Scheduled - drops at specific times', value: 'scheduled' },
                                    { name: 'Both - random + scheduled', value: 'both' }
                                )))
                .addSubcommand(sub => sub.setName('disable').setDescription('Disable VC sound drops'))
                .addSubcommand(sub => sub.setName('status').setDescription('View current VC sound drop configuration'))
                .addSubcommand(sub =>
                    sub.setName('interval').setDescription('Set the random drop interval range')
                        .addIntegerOption(opt => opt.setName('min').setDescription('Minimum minutes between drops').setRequired(true).setMinValue(5).setMaxValue(1440))
                        .addIntegerOption(opt => opt.setName('max').setDescription('Maximum minutes between drops').setRequired(true).setMinValue(10).setMaxValue(1440)))
                .addSubcommand(sub =>
                    sub.setName('schedule').setDescription('Set scheduled drop times (24h format)')
                        .addStringOption(opt => opt.setName('times').setDescription('Comma-separated times, e.g. "12:00,17:00,21:30"').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('volume').setDescription('Set the playback volume')
                        .addIntegerOption(opt => opt.setName('level').setDescription('Volume percentage (1-100)').setRequired(true).setMinValue(1).setMaxValue(100)))
                .addSubcommand(sub =>
                    sub.setName('minusers').setDescription('Set minimum users required in a VC to trigger a drop')
                        .addIntegerOption(opt => opt.setName('count').setDescription('Minimum number of non-bot users').setRequired(true).setMinValue(1).setMaxValue(50)))
                .addSubcommand(sub =>
                    sub.setName('blacklist').setDescription('Blacklist a voice channel from sound drops')
                        .addChannelOption(opt => opt.setName('channel').setDescription('Voice channel to blacklist').setRequired(true).addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)))
                .addSubcommand(sub =>
                    sub.setName('unblacklist').setDescription('Remove a voice channel from the blacklist')
                        .addChannelOption(opt => opt.setName('channel').setDescription('Voice channel to unblacklist').setRequired(true).addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)))
                .addSubcommand(sub =>
                    sub.setName('addsound').setDescription('Add a sound file (upload a .mp3/.wav/.ogg file)')
                        .addStringOption(opt => opt.setName('name').setDescription('Name for this sound').setRequired(true))
                        .addAttachmentOption(opt => opt.setName('file').setDescription('The audio file (.mp3, .wav, .ogg)').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('removesound').setDescription('Remove a sound file')
                        .addStringOption(opt => opt.setName('name').setDescription('Name of the sound to remove').setRequired(true)))
                .addSubcommand(sub => sub.setName('listsounds').setDescription('List all available sounds'))
                .addSubcommand(sub =>
                    sub.setName('test').setDescription('Test a sound drop in your current voice channel')
                        .addStringOption(opt => opt.setName('sound').setDescription('Specific sound name (random if not specified)')))
                .addSubcommand(sub => sub.setName('log').setDescription('View recent sound drop history'))
        ),

    async autocomplete(interaction) {
        const group = interaction.options.getSubcommandGroup(false);
        if (group === 'teamsync') {
            return teamsyncHandler.handleAutocomplete(interaction);
        }
    },

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup(false);
        const subcommand = interaction.options.getSubcommand();

        // ─── flat subcommands (admin-only) ───
        if (!group) {
            if (subcommand === 'setup-requests') {
                if (!requireAdmin(interaction)) return;

                const panelChannel = interaction.options.getChannel('panel-channel');
                const requestsChannel = interaction.options.getChannel('requests-channel');

                if (!panelChannel || !requestsChannel) {
                    return interaction.reply({
                        content: 'Could not resolve one or both of the channels. Please make sure I have permissions to view both channels and try again.',
                        ephemeral: true
                    });
                }

                const embed = new EmbedBuilder()
                    .setColor('#5865F2')
                    .setTitle('Request Live Stream Announcements')
                    .setDescription('Click the button below to open a form and add your stream to the announcement list for this server.')
                    .setFooter({ text: 'CertiFried Utility | User Requests' });

                const requestButton = new ButtonBuilder()
                    .setCustomId(`request_announcement_button_${requestsChannel.id}`)
                    .setLabel('Request Announcements')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('📡');

                const row = new ActionRowBuilder().addComponents(requestButton);

                try {
                    await panelChannel.send({ embeds: [embed], components: [row] });
                    await interaction.reply({
                        content: `Successfully posted the request panel in ${panelChannel} and requests will be sent to ${requestsChannel}.`,
                        ephemeral: true
                    });
                } catch (error) {
                    logger.error('[Admin Command] Failed to post request panel', { error: error.message, stack: error.stack });
                    await interaction.reply({
                        content: `Could not post the panel in ${panelChannel}. Please ensure I have permissions to send messages and embeds there.`,
                        ephemeral: true
                    });
                }
            }
            return;
        }

        switch (group) {
            // ─── backup (admin-only) ───
            case 'backup':
                if (!requireAdmin(interaction)) return;
                switch (subcommand) {
                    case 'create': return backupHandler.handleCreate(interaction);
                    case 'list': return backupHandler.handleList(interaction);
                    case 'restore': return backupHandler.handleRestore(interaction);
                    case 'delete': return backupHandler.handleDelete(interaction);
                    case 'info': return backupHandler.handleInfo(interaction);
                }
                break;

            // ─── embed ───
            case 'embed':
                switch (subcommand) {
                    case 'create': return embedHandler.handleCreate(interaction);
                    case 'quick': return embedHandler.handleQuick(interaction);
                    case 'edit': return embedHandler.handleEdit(interaction);
                    case 'json': return embedHandler.handleJson(interaction);
                    case 'copy': return embedHandler.handleCopy(interaction);
                }
                break;

            // ─── mod ───
            case 'mod':
                switch (subcommand) {
                    case 'ban': return modHandler.handleBan(interaction);
                    case 'unban': return modHandler.handleUnban(interaction);
                    case 'kick': return modHandler.handleKick(interaction);
                    case 'mute': return modHandler.handleMute(interaction);
                    case 'unmute': return modHandler.handleUnmute(interaction);
                    case 'warn': return modHandler.handleWarn(interaction);
                    case 'clearinfractions': return modHandler.handleClearInfractions(interaction);
                    case 'history': return modHandler.handleHistory(interaction);
                    case 'purge': return modHandler.handlePurge(interaction);
                    case 'quarantine': return modHandler.handleQuarantine(interaction);
                    case 'slowmode': return modHandler.handleSlowmode(interaction);
                    case 'lock': return modHandler.handleLock(interaction);
                    case 'unlock': return modHandler.handleUnlock(interaction);
                    case 'lockdown': return modHandler.handleLockdown(interaction);
                    case 'announce': return modHandler.handleAnnounce(interaction);
                }
                break;

            // ─── teamsync (admin-only) ───
            case 'teamsync':
                if (!requireAdmin(interaction)) return;
                switch (subcommand) {
                    case 'all': return teamsyncHandler.handleAll(interaction);
                    case 'team': return teamsyncHandler.handleTeam(interaction);
                    case 'status': return teamsyncHandler.handleStatus(interaction);
                }
                break;

            // ─── temp-channel (admin-only) ───
            case 'temp-channel':
                if (!requireAdmin(interaction)) return;
                await interaction.deferReply({ ephemeral: true });
                try {
                    if (subcommand === 'setup') {
                        const creatorChannel = interaction.options.getChannel('creator-channel');
                        const category = interaction.options.getChannel('category');
                        const template = interaction.options.getString('naming-template') || "{user}'s Channel";

                        await pool.execute(
                            'INSERT INTO temp_channel_config (guild_id, creator_channel_id, category_id, naming_template) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE creator_channel_id = VALUES(creator_channel_id), category_id = VALUES(category_id), naming_template = VALUES(naming_template)',
                            [interaction.guild.id, creatorChannel.id, category.id, template]
                        );

                        await interaction.editReply(`System enabled! Users joining ${creatorChannel} will now create a temporary channel in the **${category.name}** category.`);
                    } else if (subcommand === 'disable') {
                        await pool.execute('DELETE FROM temp_channel_config WHERE guild_id = ?', [interaction.guild.id]);
                        await interaction.editReply('The temporary channel system has been disabled.');
                    }
                } catch (error) {
                    logger.error('[Admin Command] Temp channel error', { error: error.message, stack: error.stack, subcommand });
                    await interaction.editReply({ content: 'An error occurred while managing the temporary channel system.' });
                }
                break;

            // ─── verification (admin-only) ───
            case 'verification':
                if (!requireAdmin(interaction)) return;
                if (subcommand === 'setup') {
                    await interaction.deferReply({ ephemeral: true });
                    const channel = interaction.options.getChannel('channel');
                    const role = interaction.options.getRole('role');

                    if (!role.editable) {
                        await interaction.editReply('I cannot assign this role. Please make sure my role is higher than the verification role.');
                        return;
                    }

                    try {
                        await pool.execute(
                            `INSERT INTO join_gate_config (guild_id, verification_enabled, verification_role_id, verification_channel_id)
                             VALUES (?, 1, ?, ?)
                             ON DUPLICATE KEY UPDATE
                                verification_enabled = 1,
                                verification_role_id = VALUES(verification_role_id),
                                verification_channel_id = VALUES(verification_channel_id)`,
                            [interaction.guild.id, role.id, channel.id]
                        );

                        const verifyEmbed = new EmbedBuilder()
                            .setColor('#2ECC71')
                            .setTitle(`Welcome to ${interaction.guild.name}!`)
                            .setDescription('To gain access to the rest of the server, please click the button below to verify that you are human.')
                            .setFooter({ text: 'This helps protect our community from raids and bots.' });

                        const verifyRow = new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId('verify_member')
                                    .setLabel('Verify')
                                    .setStyle(ButtonStyle.Success)
                                    .setEmoji('✅')
                            );

                        await channel.send({ embeds: [verifyEmbed], components: [verifyRow] });
                        await interaction.editReply(`Verification panel has been created in ${channel}.`);

                    } catch (error) {
                        logger.error('[Admin Command] Verification setup error', { error: error.message, stack: error.stack });
                        await interaction.editReply('An error occurred. I may be missing permissions to send messages in that channel.');
                    }
                }
                break;

            // ─── vcsounds (admin-only) ───
            case 'vcsounds':
                if (!requireAdmin(interaction)) return;
                switch (subcommand) {
                    case 'enable': return vcsoundsHandler.handleEnable(interaction);
                    case 'disable': return vcsoundsHandler.handleDisable(interaction);
                    case 'status': return vcsoundsHandler.handleStatus(interaction);
                    case 'interval': return vcsoundsHandler.handleInterval(interaction);
                    case 'schedule': return vcsoundsHandler.handleSchedule(interaction);
                    case 'volume': return vcsoundsHandler.handleVolume(interaction);
                    case 'minusers': return vcsoundsHandler.handleMinusers(interaction);
                    case 'blacklist': return vcsoundsHandler.handleBlacklist(interaction);
                    case 'unblacklist': return vcsoundsHandler.handleUnblacklist(interaction);
                    case 'addsound': return vcsoundsHandler.handleAddsound(interaction);
                    case 'removesound': return vcsoundsHandler.handleRemovesound(interaction);
                    case 'listsounds': return vcsoundsHandler.handleListsounds(interaction);
                    case 'test': return vcsoundsHandler.handleTest(interaction);
                    case 'log': return vcsoundsHandler.handleLog(interaction);
                }
                break;
        }
    }
};
