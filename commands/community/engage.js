import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import * as achievementHandlers from './engage-achievement-handler.js';
import * as birthdayHandlers from './engage-birthday-handler.js';
import * as reportHandlers from './engage-report-handler.js';
import * as suggestHandlers from './engage-suggest-handler.js';
import * as tagsHandlers from './engage-tags-handler.js';
import * as tradeHandlers from './engage-trade-handler.js';
import * as voiceHandlers from './engage-voice-handler.js';

export default {
    category: 'community',
    data: new SlashCommandBuilder()
        .setName('engage')
        .setDescription('Community engagement: achievements, birthdays, reports, suggestions, tags, trades, voice')

        // ── Achievement group (7 subcmds) ──
        .addSubcommandGroup(group =>
            group
                .setName('achievement')
                .setDescription('View and track achievements')
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('View your achievements')
                        .addStringOption(opt =>
                            opt.setName('category').setDescription('Filter by category').setRequired(false)
                                .addChoices(
                                    { name: 'Social', value: 'social' },
                                    { name: 'Economy', value: 'economy' },
                                    { name: 'RPG', value: 'rpg' },
                                    { name: 'Music', value: 'music' },
                                    { name: 'Fun', value: 'fun' },
                                    { name: 'Gaming', value: 'gaming' },
                                    { name: 'Special', value: 'special' }
                                )
                        )
                        .addUserOption(opt =>
                            opt.setName('user').setDescription('View another user\'s achievements').setRequired(false)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('progress')
                        .setDescription('View your achievement progress')
                        .addUserOption(opt =>
                            opt.setName('user').setDescription('View another user\'s progress').setRequired(false)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('leaderboard')
                        .setDescription('View the achievement leaderboard')
                )
                .addSubcommand(sub =>
                    sub.setName('recent')
                        .setDescription('View recently completed achievements')
                )
                .addSubcommand(sub =>
                    sub.setName('stats')
                        .setDescription('View server achievement statistics')
                )
                .addSubcommand(sub =>
                    sub.setName('info')
                        .setDescription('Get detailed info about an achievement')
                        .addStringOption(opt =>
                            opt.setName('name').setDescription('Achievement name (partial match)').setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('setup')
                        .setDescription('Configure achievement system (Admin)')
                        .addBooleanOption(opt =>
                            opt.setName('enabled').setDescription('Enable or disable achievement notifications').setRequired(false)
                        )
                        .addChannelOption(opt =>
                            opt.setName('announcement_channel').setDescription('Channel for achievement announcements').setRequired(false)
                        )
                )
        )

        // ── Birthday group (6 subcmds) ──
        .addSubcommandGroup(group =>
            group
                .setName('birthday')
                .setDescription('Birthday tracking and announcements')
                .addSubcommand(sub =>
                    sub.setName('set')
                        .setDescription('Set your birthday')
                        .addStringOption(opt =>
                            opt.setName('date').setDescription('Your birthday in MM-DD format (e.g., 03-15)').setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('remove')
                        .setDescription('Remove your birthday from the system')
                )
                .addSubcommand(sub =>
                    sub.setName('view')
                        .setDescription('View a birthday')
                        .addUserOption(opt =>
                            opt.setName('user').setDescription('The user to check (defaults to you)').setRequired(false)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('View upcoming birthdays')
                        .addIntegerOption(opt =>
                            opt.setName('days').setDescription('Number of days to look ahead (default: 7)').setRequired(false)
                                .setMinValue(1).setMaxValue(365)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('setup')
                        .setDescription('Configure birthday announcements (Admin)')
                        .addChannelOption(opt =>
                            opt.setName('channel').setDescription('Channel for birthday announcements').setRequired(true)
                        )
                        .addRoleOption(opt =>
                            opt.setName('role').setDescription('Birthday role (optional, granted for 24 hours)').setRequired(false)
                        )
                        .addStringOption(opt =>
                            opt.setName('message').setDescription('Custom birthday message template').setRequired(false)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('disable')
                        .setDescription('Disable birthday announcements (Admin)')
                )
        )

        // ── Report group (6 subcmds) ──
        .addSubcommandGroup(group =>
            group
                .setName('report')
                .setDescription('Report scammers, bad vendors, and bugs')
                .addSubcommand(sub =>
                    sub.setName('scammer')
                        .setDescription('Report a scammer or suspicious user')
                        .addUserOption(opt =>
                            opt.setName('user').setDescription('The user you want to report').setRequired(true)
                        )
                        .addStringOption(opt =>
                            opt.setName('type').setDescription('Type of scam').setRequired(true)
                                .addChoices(
                                    { name: 'Fake Seeds/Clones', value: 'fake_seeds' },
                                    { name: 'Payment Scam (Never Shipped)', value: 'payment_scam' },
                                    { name: 'Bad Seed Bank/Vendor', value: 'bad_vendor' },
                                    { name: 'Trade Scam', value: 'trade_scam' },
                                    { name: 'Identity Theft/Impersonation', value: 'impersonation' },
                                    { name: 'Phishing/Malicious Links', value: 'phishing' },
                                    { name: 'Other', value: 'other' }
                                )
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('vendor')
                        .setDescription('Report a bad seed bank or vendor')
                        .addStringOption(opt =>
                            opt.setName('name').setDescription('Name of the vendor/seed bank').setRequired(true)
                        )
                        .addStringOption(opt =>
                            opt.setName('website').setDescription('Website URL if known').setRequired(false)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('View known scammers and bad vendors (Staff Only)')
                )
                .addSubcommand(sub =>
                    sub.setName('check')
                        .setDescription('Check if a user or vendor is on the watchlist')
                        .addUserOption(opt =>
                            opt.setName('user').setDescription('User to check').setRequired(false)
                        )
                        .addStringOption(opt =>
                            opt.setName('vendor').setDescription('Vendor name to check').setRequired(false)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('review')
                        .setDescription('Review pending reports (Staff Only)')
                )
                .addSubcommand(sub =>
                    sub.setName('bug')
                        .setDescription('Report a bug with the bot')
                )
        )

        // ── Suggest group (9 subcmds) ──
        .addSubcommandGroup(group =>
            group
                .setName('suggest')
                .setDescription('Make and manage suggestions')
                .addSubcommand(sub =>
                    sub.setName('submit')
                        .setDescription('Submit a new suggestion')
                        .addStringOption(opt =>
                            opt.setName('suggestion').setDescription('Your suggestion').setRequired(true).setMaxLength(1000)
                        )
                        .addBooleanOption(opt =>
                            opt.setName('anonymous').setDescription('Submit anonymously').setRequired(false)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('view')
                        .setDescription('View a specific suggestion')
                        .addIntegerOption(opt =>
                            opt.setName('id').setDescription('Suggestion ID').setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('List suggestions')
                        .addStringOption(opt =>
                            opt.setName('status').setDescription('Filter by status').setRequired(false)
                                .addChoices(
                                    { name: 'Pending', value: 'pending' },
                                    { name: 'Under Review', value: 'under_review' },
                                    { name: 'Approved', value: 'approved' },
                                    { name: 'Rejected', value: 'rejected' },
                                    { name: 'Implemented', value: 'implemented' }
                                )
                        )
                        .addUserOption(opt =>
                            opt.setName('user').setDescription('Filter by user').setRequired(false)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('approve')
                        .setDescription('Approve a suggestion (Staff only)')
                        .addIntegerOption(opt =>
                            opt.setName('id').setDescription('Suggestion ID').setRequired(true)
                        )
                        .addStringOption(opt =>
                            opt.setName('response').setDescription('Staff response/comment').setRequired(false)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('reject')
                        .setDescription('Reject a suggestion (Staff only)')
                        .addIntegerOption(opt =>
                            opt.setName('id').setDescription('Suggestion ID').setRequired(true)
                        )
                        .addStringOption(opt =>
                            opt.setName('reason').setDescription('Reason for rejection').setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('implement')
                        .setDescription('Mark suggestion as implemented (Staff only)')
                        .addIntegerOption(opt =>
                            opt.setName('id').setDescription('Suggestion ID').setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('duplicate')
                        .setDescription('Mark suggestion as duplicate (Staff only)')
                        .addIntegerOption(opt =>
                            opt.setName('id').setDescription('Suggestion ID').setRequired(true)
                        )
                        .addIntegerOption(opt =>
                            opt.setName('original_id').setDescription('Original suggestion ID').setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('stats')
                        .setDescription('View suggestion statistics')
                        .addUserOption(opt =>
                            opt.setName('user').setDescription('User to view stats for').setRequired(false)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('setup')
                        .setDescription('Setup suggestions system (Admin only)')
                        .addChannelOption(opt =>
                            opt.setName('channel').setDescription('Channel for suggestions').setRequired(true)
                        )
                        .addBooleanOption(opt =>
                            opt.setName('allow_anonymous').setDescription('Allow anonymous suggestions').setRequired(false)
                        )
                        .addBooleanOption(opt =>
                            opt.setName('require_approval').setDescription('Require staff approval before posting').setRequired(false)
                        )
                )
        )

        // ── Tags group (8 subcmds) ──
        .addSubcommandGroup(group =>
            group
                .setName('tags')
                .setDescription('Manage and use server tags')
                .addSubcommand(sub =>
                    sub.setName('create')
                        .setDescription('Create a new tag')
                        .addStringOption(opt => opt.setName('name').setDescription('The name of the tag').setRequired(true))
                        .addStringOption(opt => opt.setName('content').setDescription('The content of the tag').setRequired(true))
                        .addStringOption(opt => opt.setName('embed-title').setDescription('Optional: Embed title').setRequired(false))
                        .addStringOption(opt => opt.setName('embed-description').setDescription('Optional: Embed description').setRequired(false))
                        .addStringOption(opt => opt.setName('embed-color').setDescription('Optional: Embed color (hex like #5865F2)').setRequired(false))
                )
                .addSubcommand(sub =>
                    sub.setName('get')
                        .setDescription('Display a tag')
                        .addStringOption(opt =>
                            opt.setName('name').setDescription('The name of the tag').setRequired(true).setAutocomplete(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('edit')
                        .setDescription('Edit one of your tags')
                        .addStringOption(opt =>
                            opt.setName('name').setDescription('The name of the tag to edit').setRequired(true).setAutocomplete(true)
                        )
                        .addStringOption(opt => opt.setName('content').setDescription('The new content of the tag').setRequired(true))
                        .addStringOption(opt => opt.setName('embed-title').setDescription('Optional: Embed title').setRequired(false))
                        .addStringOption(opt => opt.setName('embed-description').setDescription('Optional: Embed description').setRequired(false))
                        .addStringOption(opt => opt.setName('embed-color').setDescription('Optional: Embed color (hex like #5865F2)').setRequired(false))
                )
                .addSubcommand(sub =>
                    sub.setName('delete')
                        .setDescription('Delete one of your tags')
                        .addStringOption(opt =>
                            opt.setName('name').setDescription('The name of the tag to delete').setRequired(true).setAutocomplete(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('List all tags in this server')
                        .addIntegerOption(opt =>
                            opt.setName('page').setDescription('Page number').setRequired(false).setMinValue(1)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('search')
                        .setDescription('Search for tags by name')
                        .addStringOption(opt => opt.setName('query').setDescription('Search query').setRequired(true))
                )
                .addSubcommand(sub =>
                    sub.setName('info')
                        .setDescription('Get information about a tag')
                        .addStringOption(opt =>
                            opt.setName('name').setDescription('The name of the tag').setRequired(true).setAutocomplete(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('top')
                        .setDescription('Show the most used tags')
                        .addIntegerOption(opt =>
                            opt.setName('limit').setDescription('Number of tags to show (default: 10)').setRequired(false)
                                .setMinValue(1).setMaxValue(25)
                        )
                )
        )

        // ── Trade group (12 subcmds) ──
        .addSubcommandGroup(group =>
            group
                .setName('trade')
                .setDescription('Trading with escrow protection')
                .addSubcommand(sub =>
                    sub.setName('create')
                        .setDescription('Create a new trade with escrow')
                        .addUserOption(opt => opt.setName('partner').setDescription('Who are you trading with?').setRequired(true))
                        .addStringOption(opt => opt.setName('you_offer').setDescription('What are you offering?').setRequired(true))
                        .addStringOption(opt => opt.setName('they_offer').setDescription('What are they offering?').setRequired(true))
                        .addStringOption(opt => opt.setName('description').setDescription('Additional trade details').setRequired(false))
                )
                .addSubcommand(sub =>
                    sub.setName('confirm')
                        .setDescription('Confirm your side of a trade')
                        .addIntegerOption(opt => opt.setName('trade_id').setDescription('Trade ID to confirm').setRequired(true))
                )
                .addSubcommand(sub =>
                    sub.setName('cancel')
                        .setDescription('Cancel a trade (before completion)')
                        .addIntegerOption(opt => opt.setName('trade_id').setDescription('Trade ID to cancel').setRequired(true))
                )
                .addSubcommand(sub =>
                    sub.setName('dispute')
                        .setDescription('Dispute a trade - request staff mediation')
                        .addIntegerOption(opt => opt.setName('trade_id').setDescription('Trade ID to dispute').setRequired(true))
                        .addStringOption(opt => opt.setName('reason').setDescription('Reason for the dispute').setRequired(true))
                )
                .addSubcommand(sub =>
                    sub.setName('view')
                        .setDescription('View trade details')
                        .addIntegerOption(opt => opt.setName('trade_id').setDescription('Trade ID to view').setRequired(true))
                )
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('View your active trades')
                )
                .addSubcommand(sub =>
                    sub.setName('history')
                        .setDescription('View your trade history')
                        .addUserOption(opt => opt.setName('user').setDescription('View another user\'s public trade history').setRequired(false))
                )
                .addSubcommand(sub =>
                    sub.setName('review')
                        .setDescription('Leave a review after a completed trade')
                        .addIntegerOption(opt => opt.setName('trade_id').setDescription('Trade ID').setRequired(true))
                        .addIntegerOption(opt =>
                            opt.setName('rating').setDescription('Rating 1-5 stars').setRequired(true)
                                .addChoices(
                                    { name: '1 - Poor', value: 1 },
                                    { name: '2 - Fair', value: 2 },
                                    { name: '3 - Good', value: 3 },
                                    { name: '4 - Great', value: 4 },
                                    { name: '5 - Excellent', value: 5 }
                                )
                        )
                        .addStringOption(opt => opt.setName('comment').setDescription('Review comment').setRequired(false))
                )
                .addSubcommand(sub =>
                    sub.setName('resolve')
                        .setDescription('Resolve a disputed trade (Staff Only)')
                        .addIntegerOption(opt => opt.setName('trade_id').setDescription('Trade ID').setRequired(true))
                        .addStringOption(opt =>
                            opt.setName('resolution').setDescription('Resolution action').setRequired(true)
                                .addChoices(
                                    { name: 'Complete Trade', value: 'complete' },
                                    { name: 'Cancel Trade', value: 'cancel' },
                                    { name: 'Favor Seller', value: 'favor_seller' },
                                    { name: 'Favor Buyer', value: 'favor_buyer' }
                                )
                        )
                        .addStringOption(opt => opt.setName('notes').setDescription('Resolution notes').setRequired(true))
                )
                .addSubcommand(sub =>
                    sub.setName('vouch')
                        .setDescription('Vouch for someone (for trades outside the bot)')
                        .addUserOption(opt => opt.setName('user').setDescription('The trader to vouch for').setRequired(true))
                        .addStringOption(opt =>
                            opt.setName('type').setDescription('Type of transaction').setRequired(true)
                                .addChoices(
                                    { name: 'I bought from them', value: 'purchase' },
                                    { name: 'I sold to them', value: 'sale' },
                                    { name: 'We traded items', value: 'trade' }
                                )
                        )
                        .addIntegerOption(opt =>
                            opt.setName('rating').setDescription('Rating 1-5 stars').setRequired(true)
                                .addChoices(
                                    { name: '1 - Poor', value: 1 },
                                    { name: '2 - Fair', value: 2 },
                                    { name: '3 - Good', value: 3 },
                                    { name: '4 - Great', value: 4 },
                                    { name: '5 - Excellent', value: 5 }
                                )
                        )
                        .addStringOption(opt => opt.setName('comment').setDescription('Comment about the trade').setRequired(false))
                )
                .addSubcommand(sub =>
                    sub.setName('leaderboard')
                        .setDescription('View top traders in the community')
                )
                .addSubcommand(sub =>
                    sub.setName('reputation')
                        .setDescription('Check a user\'s trade reputation')
                        .addUserOption(opt => opt.setName('user').setDescription('User to check').setRequired(true))
                )
        )

        // ── Voice group (3 subcmds) ──
        .addSubcommandGroup(group =>
            group
                .setName('voice')
                .setDescription('Voice activity tracking')
                .addSubcommand(sub =>
                    sub.setName('stats')
                        .setDescription('View voice activity statistics')
                        .addUserOption(opt => opt.setName('user').setDescription('The user to check (defaults to you)').setRequired(false))
                        .addStringOption(opt =>
                            opt.setName('period').setDescription('Time period for stats').setRequired(false)
                                .addChoices(
                                    { name: 'All Time', value: 'all' },
                                    { name: 'Daily', value: 'daily' },
                                    { name: 'Weekly', value: 'weekly' },
                                    { name: 'Monthly', value: 'monthly' }
                                )
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('leaderboard')
                        .setDescription('View top voice users')
                        .addStringOption(opt =>
                            opt.setName('period').setDescription('Time period for leaderboard').setRequired(false)
                                .addChoices(
                                    { name: 'All Time', value: 'all' },
                                    { name: 'Daily', value: 'daily' },
                                    { name: 'Weekly', value: 'weekly' },
                                    { name: 'Monthly', value: 'monthly' }
                                )
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('channels')
                        .setDescription('View most active voice channels')
                        .addStringOption(opt =>
                            opt.setName('period').setDescription('Time period for stats').setRequired(false)
                                .addChoices(
                                    { name: 'All Time', value: 'all' },
                                    { name: 'Daily', value: 'daily' },
                                    { name: 'Weekly', value: 'weekly' },
                                    { name: 'Monthly', value: 'monthly' }
                                )
                        )
                )
        ),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();

        try {
            switch (group) {
                case 'achievement':
                    switch (subcommand) {
                        case 'list': return await achievementHandlers.handleList(interaction);
                        case 'progress': return await achievementHandlers.handleProgress(interaction);
                        case 'leaderboard': return await achievementHandlers.handleLeaderboard(interaction);
                        case 'recent': return await achievementHandlers.handleRecent(interaction);
                        case 'stats': return await achievementHandlers.handleStats(interaction);
                        case 'info': return await achievementHandlers.handleInfo(interaction);
                        case 'setup': return await achievementHandlers.handleSetup(interaction);
                    }
                    break;

                case 'birthday':
                    switch (subcommand) {
                        case 'set': return await birthdayHandlers.handleSet(interaction);
                        case 'remove': return await birthdayHandlers.handleRemove(interaction);
                        case 'view': return await birthdayHandlers.handleView(interaction);
                        case 'list': return await birthdayHandlers.handleList(interaction);
                        case 'setup': return await birthdayHandlers.handleSetup(interaction);
                        case 'disable': return await birthdayHandlers.handleDisable(interaction);
                    }
                    break;

                case 'report':
                    switch (subcommand) {
                        case 'scammer': return await reportHandlers.handleScammerReport(interaction);
                        case 'vendor': return await reportHandlers.handleVendorReport(interaction);
                        case 'list': return await reportHandlers.handleListReports(interaction);
                        case 'check': return await reportHandlers.handleCheck(interaction);
                        case 'review': return await reportHandlers.handleReview(interaction);
                        case 'bug': return await reportHandlers.handleBugReport(interaction);
                    }
                    break;

                case 'suggest':
                    switch (subcommand) {
                        case 'submit': return await suggestHandlers.handleSubmit(interaction);
                        case 'view': return await suggestHandlers.handleView(interaction);
                        case 'list': return await suggestHandlers.handleList(interaction);
                        case 'approve': return await suggestHandlers.handleApprove(interaction);
                        case 'reject': return await suggestHandlers.handleReject(interaction);
                        case 'implement': return await suggestHandlers.handleImplement(interaction);
                        case 'duplicate': return await suggestHandlers.handleDuplicate(interaction);
                        case 'stats': return await suggestHandlers.handleStats(interaction);
                        case 'setup': return await suggestHandlers.handleSetup(interaction);
                    }
                    break;

                case 'tags':
                    switch (subcommand) {
                        case 'create': return await tagsHandlers.handleCreate(interaction);
                        case 'get': return await tagsHandlers.handleGet(interaction);
                        case 'edit': return await tagsHandlers.handleEdit(interaction);
                        case 'delete': return await tagsHandlers.handleDelete(interaction);
                        case 'list': return await tagsHandlers.handleListTags(interaction);
                        case 'search': return await tagsHandlers.handleSearch(interaction);
                        case 'info': return await tagsHandlers.handleInfo(interaction);
                        case 'top': return await tagsHandlers.handleTop(interaction);
                    }
                    break;

                case 'trade':
                    switch (subcommand) {
                        case 'create': return await tradeHandlers.handleCreate(interaction);
                        case 'confirm': return await tradeHandlers.handleConfirm(interaction);
                        case 'cancel': return await tradeHandlers.handleCancel(interaction);
                        case 'dispute': return await tradeHandlers.handleDispute(interaction);
                        case 'view': return await tradeHandlers.handleView(interaction);
                        case 'list': return await tradeHandlers.handleListTrades(interaction);
                        case 'history': return await tradeHandlers.handleHistory(interaction);
                        case 'review': return await tradeHandlers.handleReview(interaction);
                        case 'resolve': return await tradeHandlers.handleResolve(interaction);
                        case 'vouch': return await tradeHandlers.handleVouch(interaction);
                        case 'leaderboard': return await tradeHandlers.handleLeaderboard(interaction);
                        case 'reputation': return await tradeHandlers.handleReputation(interaction);
                    }
                    break;

                case 'voice':
                    switch (subcommand) {
                        case 'stats': return await voiceHandlers.handleStats(interaction);
                        case 'leaderboard': return await voiceHandlers.handleLeaderboard(interaction);
                        case 'channels': return await voiceHandlers.handleChannels(interaction);
                    }
                    break;
            }
        } catch (error) {
            console.error('[Engage Command Error]', error);
            const method = interaction.deferred || interaction.replied ? 'editReply' : 'reply';
            return interaction[method]({
                content: '\u274c An error occurred. Please try again.',
                ephemeral: true
            }).catch(() => {});
        }
    },

    async autocomplete(interaction) {
        const group = interaction.options.getSubcommandGroup();

        if (group === 'tags') {
            return await tagsHandlers.handleTagsAutocomplete(interaction);
        }
    }
};
