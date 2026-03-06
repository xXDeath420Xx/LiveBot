import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import * as twitterHandlers from './social-twitter-handler.js';
import * as feedHandlers from './social-feed-handler.js';
import * as tiktokHandlers from './social-tiktok-handler.js';
import * as streamerHandlers from './social-streamer-handler.js';

const { platformChoices } = streamerHandlers;

export default {
    category: 'community',
    data: new SlashCommandBuilder()
        .setName('socials')
        .setDescription('Social media feeds, streamer tracking, and platform lookups')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

        // ── Twitter group ──
        .addSubcommandGroup(group =>
            group
                .setName('twitter')
                .setDescription('Twitter/X feed tracking and lookups')
                .addSubcommand(sub =>
                    sub.setName('add')
                        .setDescription('Add a Twitter user to track')
                        .addStringOption(opt =>
                            opt.setName('username').setDescription('Twitter username').setRequired(true)
                        )
                        .addChannelOption(opt =>
                            opt.setName('channel').setDescription('Channel for tweet notifications')
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                                .setRequired(true)
                        )
                        .addBooleanOption(opt =>
                            opt.setName('filter_retweets').setDescription('Filter out retweets (default: true)')
                        )
                        .addBooleanOption(opt =>
                            opt.setName('filter_replies').setDescription('Filter out replies (default: true)')
                        )
                        .addBooleanOption(opt =>
                            opt.setName('media_only').setDescription('Only post tweets with media (default: false)')
                        )
                        .addStringOption(opt =>
                            opt.setName('custom_message').setDescription('Custom message to include with tweets')
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('remove')
                        .setDescription('Remove a Twitter user from tracking')
                        .addStringOption(opt =>
                            opt.setName('username').setDescription('Twitter username').setRequired(true).setAutocomplete(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('List all tracked Twitter users')
                )
                .addSubcommand(sub =>
                    sub.setName('edit')
                        .setDescription('Edit Twitter feed settings')
                        .addStringOption(opt =>
                            opt.setName('username').setDescription('Twitter username').setRequired(true).setAutocomplete(true)
                        )
                        .addChannelOption(opt =>
                            opt.setName('channel').setDescription('Change notification channel')
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                        )
                        .addBooleanOption(opt =>
                            opt.setName('filter_retweets').setDescription('Filter out retweets')
                        )
                        .addBooleanOption(opt =>
                            opt.setName('filter_replies').setDescription('Filter out replies')
                        )
                        .addBooleanOption(opt =>
                            opt.setName('media_only').setDescription('Only post tweets with media')
                        )
                        .addBooleanOption(opt =>
                            opt.setName('include_images').setDescription('Include images in embeds')
                        )
                        .addStringOption(opt =>
                            opt.setName('custom_message').setDescription('Custom message (type "none" to clear)')
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('test')
                        .setDescription('Preview the latest tweet from a user')
                        .addStringOption(opt =>
                            opt.setName('username').setDescription('Twitter username').setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('lookup')
                        .setDescription('Look up a Twitter user profile')
                        .addStringOption(opt =>
                            opt.setName('username').setDescription('Twitter username').setRequired(true)
                        )
                )
        )

        // ── Feed group (Reddit + YouTube) ──
        .addSubcommandGroup(group =>
            group
                .setName('feed')
                .setDescription('Reddit and YouTube feed subscriptions')
                .addSubcommand(sub =>
                    sub.setName('reddit-add')
                        .setDescription('Subscribe to a subreddit')
                        .addStringOption(opt =>
                            opt.setName('subreddit').setDescription('Subreddit name (without r/)').setRequired(true)
                        )
                        .addChannelOption(opt =>
                            opt.setName('channel').setDescription('Channel for posts')
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                                .setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('reddit-remove')
                        .setDescription('Unsubscribe from a subreddit')
                        .addStringOption(opt =>
                            opt.setName('subreddit').setDescription('Subreddit name').setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('reddit-list')
                        .setDescription('List all Reddit feed subscriptions')
                )
                .addSubcommand(sub =>
                    sub.setName('youtube-add')
                        .setDescription('Subscribe to a YouTube channel')
                        .addStringOption(opt =>
                            opt.setName('channel-id').setDescription('YouTube channel ID').setRequired(true)
                        )
                        .addChannelOption(opt =>
                            opt.setName('channel').setDescription('Discord channel for notifications')
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                                .setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('youtube-remove')
                        .setDescription('Unsubscribe from a YouTube channel')
                        .addStringOption(opt =>
                            opt.setName('channel-id').setDescription('YouTube channel ID').setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('youtube-list')
                        .setDescription('List all YouTube feed subscriptions')
                )
        )

        // ── TikTok group ──
        .addSubcommandGroup(group =>
            group
                .setName('tiktok')
                .setDescription('TikTok user lookups')
                .addSubcommand(sub =>
                    sub.setName('lookup')
                        .setDescription('Look up a TikTok user profile and recent videos')
                        .addStringOption(opt =>
                            opt.setName('username').setDescription('TikTok username').setRequired(true)
                        )
                )
        )

        // ── Streamer group ──
        .addSubcommandGroup(group =>
            group
                .setName('streamer')
                .setDescription('Manage streamer tracking and live notifications')
                .addSubcommand(sub =>
                    sub.setName('setup')
                        .setDescription('Configure stream announcement settings')
                        .addChannelOption(opt =>
                            opt.setName('channel').setDescription('Channel for stream announcements')
                                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                        )
                        .addRoleOption(opt =>
                            opt.setName('live-role').setDescription('Role to assign when streamers go live')
                        )
                        .addStringOption(opt =>
                            opt.setName('message').setDescription('Custom announcement message (use {username}, {url}, {game}, {title})')
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('add')
                        .setDescription('Add a streamer to track')
                        .addStringOption(opt =>
                            opt.setName('platform').setDescription('Streaming platform').setRequired(true)
                                .addChoices(...platformChoices)
                        )
                        .addStringOption(opt =>
                            opt.setName('username').setDescription('Streamer username or channel ID').setRequired(true)
                        )
                        .addUserOption(opt =>
                            opt.setName('discord-user').setDescription('Link to a Discord user (optional)')
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('remove')
                        .setDescription('Remove a streamer from tracking')
                        .addStringOption(opt =>
                            opt.setName('platform').setDescription('Streaming platform').setRequired(true)
                                .addChoices(...platformChoices)
                        )
                        .addStringOption(opt =>
                            opt.setName('username').setDescription('Streamer username').setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('List all tracked streamers')
                        .addStringOption(opt =>
                            opt.setName('platform').setDescription('Filter by platform')
                                .addChoices(...platformChoices)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('check-live')
                        .setDescription('Show currently live streamers')
                )
                .addSubcommand(sub =>
                    sub.setName('edit')
                        .setDescription('Edit streamer settings')
                        .addStringOption(opt =>
                            opt.setName('platform').setDescription('Streaming platform').setRequired(true)
                                .addChoices(...platformChoices)
                        )
                        .addStringOption(opt =>
                            opt.setName('username').setDescription('Streamer username').setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('massadd')
                        .setDescription('Add multiple streamers at once')
                        .addStringOption(opt =>
                            opt.setName('platform').setDescription('Streaming platform').setRequired(true)
                                .addChoices(...platformChoices)
                        )
                        .addStringOption(opt =>
                            opt.setName('usernames').setDescription('Comma-separated list of usernames').setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('massremove')
                        .setDescription('Remove multiple streamers at once')
                        .addStringOption(opt =>
                            opt.setName('platform').setDescription('Streaming platform').setRequired(true)
                                .addChoices(...platformChoices)
                        )
                        .addStringOption(opt =>
                            opt.setName('usernames').setDescription('Comma-separated list of usernames').setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('clear')
                        .setDescription('Remove all tracked streamers (use with caution!)')
                        .addStringOption(opt =>
                            opt.setName('platform').setDescription('Only clear this platform')
                                .addChoices(...platformChoices)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('import')
                        .setDescription('Import streamers from CSV file')
                        .addAttachmentOption(opt =>
                            opt.setName('file').setDescription('CSV file with columns: platform,username,discord_user_id').setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('export')
                        .setDescription('Export tracked streamers to CSV')
                        .addStringOption(opt =>
                            opt.setName('platform').setDescription('Only export this platform')
                                .addChoices(...platformChoices)
                        )
                )
        ),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();

        try {
            switch (group) {
                case 'twitter':
                    switch (subcommand) {
                        case 'add': return await twitterHandlers.handleTwitterAdd(interaction);
                        case 'remove': return await twitterHandlers.handleTwitterRemove(interaction);
                        case 'list': return await twitterHandlers.handleTwitterList(interaction);
                        case 'edit': return await twitterHandlers.handleTwitterEdit(interaction);
                        case 'test': return await twitterHandlers.handleTwitterTest(interaction);
                        case 'lookup': return await twitterHandlers.handleTwitterLookup(interaction);
                    }
                    break;

                case 'feed':
                    switch (subcommand) {
                        case 'reddit-add': return await feedHandlers.handleRedditAdd(interaction);
                        case 'reddit-remove': return await feedHandlers.handleRedditRemove(interaction);
                        case 'reddit-list': return await feedHandlers.handleRedditList(interaction);
                        case 'youtube-add': return await feedHandlers.handleYoutubeAdd(interaction);
                        case 'youtube-remove': return await feedHandlers.handleYoutubeRemove(interaction);
                        case 'youtube-list': return await feedHandlers.handleYoutubeList(interaction);
                    }
                    break;

                case 'tiktok':
                    switch (subcommand) {
                        case 'lookup': return await tiktokHandlers.handleTiktokLookup(interaction);
                    }
                    break;

                case 'streamer':
                    switch (subcommand) {
                        case 'setup': return await streamerHandlers.handleSetup(interaction);
                        case 'add': return await streamerHandlers.handleAdd(interaction);
                        case 'remove': return await streamerHandlers.handleRemove(interaction);
                        case 'list': return await streamerHandlers.handleList(interaction);
                        case 'check-live': return await streamerHandlers.handleCheckLive(interaction);
                        case 'edit': return await streamerHandlers.handleEdit(interaction);
                        case 'massadd': return await streamerHandlers.handleMassAdd(interaction);
                        case 'massremove': return await streamerHandlers.handleMassRemove(interaction);
                        case 'clear': return await streamerHandlers.handleClear(interaction);
                        case 'import': return await streamerHandlers.handleImport(interaction);
                        case 'export': return await streamerHandlers.handleExport(interaction);
                    }
                    break;
            }
        } catch (error) {
            console.error('[Social Command Error]', error);
            const method = interaction.deferred || interaction.replied ? 'editReply' : 'reply';
            return interaction[method]({
                content: '\u274c An error occurred. Please try again.',
                ephemeral: true
            });
        }
    },

    async autocomplete(interaction) {
        const group = interaction.options.getSubcommandGroup();

        if (group === 'twitter') {
            return await twitterHandlers.handleTwitterAutocomplete(interaction);
        }
    }
};
