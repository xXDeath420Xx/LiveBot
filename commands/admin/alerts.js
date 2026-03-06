import { SlashCommandBuilder, PermissionsBitField, ChannelType } from 'discord.js';
import { execute as handleScheduled } from './alerts/announce.js';
import { execute as handleAutoPublish } from './alerts/autopublish.js';
import { execute as handleFreeGames } from './alerts/freegames.js';
import logger from '../../utils/logger.js';

export default {
    category: 'admin',
    data: new SlashCommandBuilder()
        .setName('alerts')
        .setDescription('Manage announcements, auto-publish & free game notifications')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)

        // ── Scheduled Announcements Group ──
        .addSubcommandGroup(group =>
            group.setName('scheduled')
                .setDescription('Manage scheduled announcements')
                .addSubcommand(sub =>
                    sub.setName('create')
                        .setDescription('Create a new scheduled announcement')
                        .addChannelOption(opt => opt.setName('channel').setDescription('The channel to send the announcement in').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
                        .addStringOption(opt => opt.setName('message').setDescription('The message content').setRequired(true))
                        .addStringOption(opt => opt.setName('schedule-type').setDescription('How often to send').setRequired(true)
                            .addChoices({ name: 'Once', value: 'once' }, { name: 'Daily', value: 'daily' }, { name: 'Weekly', value: 'weekly' }, { name: 'Monthly', value: 'monthly' }, { name: 'Interval', value: 'interval' }))
                        .addStringOption(opt => opt.setName('schedule-value').setDescription('Format: daily="14:00", weekly="Monday 14:00", monthly="15 12:00", interval=minutes').setRequired(true))
                        .addStringOption(opt => opt.setName('embed-title').setDescription('Optional embed title'))
                        .addStringOption(opt => opt.setName('embed-description').setDescription('Optional embed description'))
                        .addStringOption(opt => opt.setName('embed-color').setDescription('Optional embed color (hex code like #FF5733)'))
                        .addStringOption(opt => opt.setName('embed-image').setDescription('Optional embed image URL'))
                        .addStringOption(opt => opt.setName('embed-thumbnail').setDescription('Optional embed thumbnail URL')))
                .addSubcommand(sub => sub.setName('list').setDescription('List all scheduled announcements'))
                .addSubcommand(sub =>
                    sub.setName('delete')
                        .setDescription('Delete a scheduled announcement')
                        .addIntegerOption(opt => opt.setName('announcement-id').setDescription('The announcement ID to delete').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('toggle')
                        .setDescription('Enable or disable a scheduled announcement')
                        .addIntegerOption(opt => opt.setName('announcement-id').setDescription('The announcement ID to toggle').setRequired(true))
                        .addBooleanOption(opt => opt.setName('enabled').setDescription('Enable or disable').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('edit')
                        .setDescription('Edit a scheduled announcement')
                        .addIntegerOption(opt => opt.setName('announcement-id').setDescription('The announcement ID to edit').setRequired(true))
                        .addStringOption(opt => opt.setName('message').setDescription('New message content'))
                        .addStringOption(opt => opt.setName('schedule-type').setDescription('New schedule type')
                            .addChoices({ name: 'Once', value: 'once' }, { name: 'Daily', value: 'daily' }, { name: 'Weekly', value: 'weekly' }, { name: 'Monthly', value: 'monthly' }, { name: 'Interval', value: 'interval' }))
                        .addStringOption(opt => opt.setName('schedule-value').setDescription('New schedule value'))))

        // ── Auto-Publish Group ──
        .addSubcommandGroup(group =>
            group.setName('autopublish')
                .setDescription('Auto-publish messages in announcement channels')
                .addSubcommand(sub => sub.setName('enable').setDescription('Enable auto-publishing'))
                .addSubcommand(sub => sub.setName('disable').setDescription('Disable auto-publishing'))
                .addSubcommand(sub => sub.setName('status').setDescription('Check auto-publish status')))

        // ── Free Games Group ──
        .addSubcommandGroup(group =>
            group.setName('freegames')
                .setDescription('Free game notification subscriptions')
                .addSubcommand(sub =>
                    sub.setName('subscribe')
                        .setDescription('Subscribe to free game notifications')
                        .addChannelOption(opt => opt.setName('channel').setDescription('Channel to post notifications in').addChannelTypes(ChannelType.GuildText).setRequired(true))
                        .addRoleOption(opt => opt.setName('mention-role').setDescription('Role to mention when posting'))
                        .addStringOption(opt => opt.setName('custom-message').setDescription('Custom message to include')))
                .addSubcommand(sub =>
                    sub.setName('unsubscribe')
                        .setDescription('Unsubscribe from free game notifications')
                        .addChannelOption(opt => opt.setName('channel').setDescription('Channel to remove subscription from').addChannelTypes(ChannelType.GuildText).setRequired(true)))
                .addSubcommand(sub => sub.setName('list').setDescription('List all free game subscriptions'))
                .addSubcommand(sub =>
                    sub.setName('filters')
                        .setDescription('Configure subscription filters')
                        .addChannelOption(opt => opt.setName('channel').setDescription('Channel to configure').addChannelTypes(ChannelType.GuildText).setRequired(true))
                        .addStringOption(opt => opt.setName('stores').setDescription('Stores to enable (comma-separated: steam,epic,gog,humble,prime)'))
                        .addStringOption(opt => opt.setName('platforms').setDescription('Platforms to filter (comma-separated: windows,mac,linux)'))
                        .addBooleanOption(opt => opt.setName('free-to-keep').setDescription('Include free-to-keep games'))
                        .addBooleanOption(opt => opt.setName('free-weekend').setDescription('Include free weekend/temporary games'))
                        .addBooleanOption(opt => opt.setName('dlc').setDescription('Include DLC')))
                .addSubcommand(sub => sub.setName('check').setDescription('Manually check for new free games'))
                .addSubcommand(sub => sub.setName('current').setDescription('Show currently available free games'))),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup();

        try {
            switch (group) {
                case 'scheduled':
                    return await handleScheduled(interaction);
                case 'autopublish':
                    return await handleAutoPublish(interaction);
                case 'freegames':
                    return await handleFreeGames(interaction);
            }
        } catch (error) {
            logger.error('[Alerts Command] Error:', { error: error.message, group, stack: error.stack });

            const reply = { content: `Error: ${error.message}`, ephemeral: true };
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(reply);
            } else {
                await interaction.reply(reply);
            }
        }
    }
};
