import { SlashCommandBuilder, PermissionsBitField, ChannelType } from 'discord.js';
import { execute as handleScheduled } from './alerts/announce.js';
import { execute as handleAutoPublish } from './alerts/autopublish.js';
import { execute as handleFreeGames } from './alerts/freegames.js';
import { execute as handleGameNews, autocomplete as gameNewsAutocomplete } from './alerts/gamenews.js';
import { execute as handleClips } from './alerts/clips.js';
import logger from '../../utils/logger.js';

export default {
    category: 'admin',
    data: new SlashCommandBuilder()
        .setName('alerts')
        .setDescription('Manage announcements, auto-publish, free games, game news & Twitch clips')
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
                        .addStringOption(opt => opt.setName('stores').setDescription('steam,epic,gog,prime'))
                        .addStringOption(opt => opt.setName('platforms').setDescription('windows,mac,linux'))
                        .addBooleanOption(opt => opt.setName('free-to-keep').setDescription('Include free-to-keep games'))
                        .addBooleanOption(opt => opt.setName('free-weekend').setDescription('Include free weekend/temporary games'))
                        .addBooleanOption(opt => opt.setName('dlc').setDescription('Include DLC')))
                .addSubcommand(sub => sub.setName('check').setDescription('Manually check for new free games'))
                .addSubcommand(sub => sub.setName('current').setDescription('Show currently available free games')))

        // ── Game News / Patch Notes Group ──
        .addSubcommandGroup(group =>
            group.setName('gamenews')
                .setDescription('Auto-post patch notes and game news')
                .addSubcommand(sub =>
                    sub.setName('add')
                        .setDescription('Watch a game or source for patch notes and news')
                        .addChannelOption(opt => opt.setName('channel').setDescription('Channel to post news in').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
                        .addStringOption(opt => opt.setName('game').setDescription('Pick from the catalogue — start typing to search').setAutocomplete(true))
                        .addRoleOption(opt => opt.setName('ping-role').setDescription('Role to mention on each post'))
                        .addStringOption(opt => opt.setName('feed-url').setDescription('Custom source: any RSS or Atom feed URL'))
                        .addIntegerOption(opt => opt.setName('steam-appid').setDescription('Custom source: a Steam appid, e.g. 548430'))
                        .addStringOption(opt => opt.setName('account').setDescription('Custom source: an X/Twitter account name, without the @'))
                        .addStringOption(opt => opt.setName('name').setDescription('Display name (required for a custom source)'))
                        .addIntegerOption(opt => opt.setName('interval').setDescription('Minutes between checks (5-1440, default 15)').setMinValue(5).setMaxValue(1440))
                        .addStringOption(opt => opt.setName('only-if').setDescription('Only post when the item mentions these words (comma-separated)'))
                        .addStringOption(opt => opt.setName('never-if').setDescription('Never post when the item mentions these words (comma-separated)')))
                .addSubcommand(sub => sub.setName('list').setDescription('List this server\'s game news watchers'))
                .addSubcommand(sub =>
                    sub.setName('remove')
                        .setDescription('Stop watching a source')
                        .addIntegerOption(opt => opt.setName('id').setDescription('Watcher ID from /alerts gamenews list').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('toggle')
                        .setDescription('Pause or resume a watcher')
                        .addIntegerOption(opt => opt.setName('id').setDescription('Watcher ID from /alerts gamenews list').setRequired(true))
                        .addBooleanOption(opt => opt.setName('enabled').setDescription('Resume (true) or pause (false)').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('test')
                        .setDescription('Fetch a watcher\'s source now and show what it sees, without posting')
                        .addIntegerOption(opt => opt.setName('id').setDescription('Watcher ID from /alerts gamenews list').setRequired(true)))
                .addSubcommand(sub => sub.setName('catalogue').setDescription('Show every game and source available by name')))

        // ── Twitch Clips Group ──
        .addSubcommandGroup(group => {
            const streamer = opt => opt.setName('streamer').setDescription('Twitch name or channel link');
            const who = opt => opt.setName('who').setDescription('Whose clips to post')
                .addChoices({ name: 'Anyone\'s clips', value: 'anyone' }, { name: 'Only the streamer\'s own', value: 'broadcaster_only' });
            const minViews = opt => opt.setName('min-views').setDescription('Only post clips with at least this many views').setMinValue(0).setMaxValue(1000000);
            const channel = opt => opt.setName('channel').setDescription('Channel to post clips in').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
            const id = opt => opt.setName('id').setDescription('Feed ID from /alerts clips list').setRequired(true);
            return group.setName('clips')
                .setDescription('Auto-post new Twitch clips')
                .addSubcommand(sub => sub.setName('add').setDescription('Post a streamer\'s new clips to a channel')
                    .addStringOption(o => streamer(o).setRequired(true))
                    .addChannelOption(o => channel(o).setRequired(true))
                    .addStringOption(who)
                    .addIntegerOption(minViews))
                .addSubcommand(sub => sub.setName('list').setDescription('List this server\'s clip feeds'))
                .addSubcommand(sub => sub.setName('edit').setDescription('Change a clip feed\'s settings')
                    .addIntegerOption(id)
                    .addChannelOption(channel)
                    .addStringOption(streamer)
                    .addStringOption(who)
                    .addIntegerOption(minViews))
                .addSubcommand(sub => sub.setName('toggle').setDescription('Pause or resume a clip feed')
                    .addIntegerOption(id)
                    .addBooleanOption(o => o.setName('enabled').setDescription('Resume (true) or pause (false)').setRequired(true)))
                .addSubcommand(sub => sub.setName('remove').setDescription('Delete a clip feed')
                    .addIntegerOption(id))
                .addSubcommand(sub => sub.setName('preview').setDescription('Show what a feed sees right now, without posting')
                    .addIntegerOption(id));
        }),

    async autocomplete(interaction) {
        if (interaction.options.getSubcommandGroup() === 'gamenews') {
            return gameNewsAutocomplete(interaction);
        }
        return interaction.respond([]);
    },

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
                case 'gamenews':
                    return await handleGameNews(interaction);
                case 'clips':
                    return await handleClips(interaction);
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
