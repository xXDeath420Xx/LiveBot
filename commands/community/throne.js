import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import * as throneHandlers from './throne-handler.js';

export default {
    category: 'community',
    data: new SlashCommandBuilder()
        .setName('throne')
        .setDescription('Throne wishlist lookup, tracking, and notifications')

        // ── Lookup subcommands ──
        .addSubcommand(sub =>
            sub.setName('profile')
                .setDescription('View a Throne user\'s profile')
                .addStringOption(opt =>
                    opt.setName('username').setDescription('Throne username (or use /throne link)').setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('wishlist')
                .setDescription('Browse a Throne user\'s wishlist items')
                .addStringOption(opt =>
                    opt.setName('username').setDescription('Throne username (or use /throne link)').setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('collections')
                .setDescription('View a Throne user\'s collections')
                .addStringOption(opt =>
                    opt.setName('username').setDescription('Throne username (or use /throne link)').setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('gifts')
                .setDescription('View a Throne user\'s gift history')
                .addStringOption(opt =>
                    opt.setName('username').setDescription('Throne username (or use /throne link)').setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('leaderboard')
                .setDescription('View a Throne user\'s gifter leaderboard')
                .addStringOption(opt =>
                    opt.setName('username').setDescription('Throne username (or use /throne link)').setRequired(false)
                )
                .addStringOption(opt =>
                    opt.setName('period').setDescription('Time period for the leaderboard')
                        .addChoices(
                            { name: 'All Time', value: 'allTime' },
                            { name: 'Last Month', value: 'lastMonth' },
                            { name: 'Last Week', value: 'lastWeek' },
                        )
                )
        )

        // ── Account linking ──
        .addSubcommand(sub =>
            sub.setName('link')
                .setDescription('Link your Discord account to a Throne username')
                .addStringOption(opt =>
                    opt.setName('username').setDescription('Your Throne username').setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('unlink')
                .setDescription('Remove your Throne account link')
        )
        .addSubcommand(sub =>
            sub.setName('me')
                .setDescription('Quick profile lookup using your linked Throne username')
        )

        // ── Notification tracking ──
        .addSubcommand(sub =>
            sub.setName('track')
                .setDescription('Track a Throne user and post notifications to a channel')
                .addStringOption(opt =>
                    opt.setName('username').setDescription('Throne username to track').setRequired(true)
                )
                .addChannelOption(opt =>
                    opt.setName('channel').setDescription('Channel to post notifications')
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('untrack')
                .setDescription('Stop tracking a Throne user\'s notifications')
                .addStringOption(opt =>
                    opt.setName('username').setDescription('Throne username to stop tracking').setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('tracked')
                .setDescription('List all tracked Throne users in this server')
        )

        // ── Guild featured wishlist ──
        .addSubcommand(sub =>
            sub.setName('featured')
                .setDescription('Set or view this server\'s featured Throne wishlist')
                .addStringOption(opt =>
                    opt.setName('action').setDescription('Action to perform')
                        .addChoices(
                            { name: 'View', value: 'view' },
                            { name: 'Set', value: 'set' },
                            { name: 'Clear', value: 'clear' },
                        )
                        .setRequired(true)
                )
                .addStringOption(opt =>
                    opt.setName('username').setDescription('Throne username (required for set)')
                )
        )

        // ── Extra lookup subcommands ──
        .addSubcommand(sub =>
            sub.setName('random')
                .setDescription('Pick a random available item from a Throne wishlist')
                .addStringOption(opt =>
                    opt.setName('username').setDescription('Throne username (or use /throne link)').setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('search')
                .setDescription('Search a Throne wishlist by keyword')
                .addStringOption(opt =>
                    opt.setName('query').setDescription('Search keyword').setRequired(true)
                )
                .addStringOption(opt =>
                    opt.setName('username').setDescription('Throne username (or use /throne link)').setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('stats')
                .setDescription('View wishlist statistics for a Throne user')
                .addStringOption(opt =>
                    opt.setName('username').setDescription('Throne username (or use /throne link)').setRequired(false)
                )
        ),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        try {
            switch (subcommand) {
                // Lookups
                case 'profile': return await throneHandlers.handleProfile(interaction);
                case 'wishlist': return await throneHandlers.handleWishlist(interaction);
                case 'collections': return await throneHandlers.handleCollections(interaction);
                case 'gifts': return await throneHandlers.handleGifts(interaction);
                case 'leaderboard': return await throneHandlers.handleLeaderboard(interaction);

                // Account
                case 'link': return await throneHandlers.handleLink(interaction);
                case 'unlink': return await throneHandlers.handleUnlink(interaction);
                case 'me': return await throneHandlers.handleMe(interaction);

                // Notifications
                case 'track': return await throneHandlers.handleTrack(interaction);
                case 'untrack': return await throneHandlers.handleUntrack(interaction);
                case 'tracked': return await throneHandlers.handleTracked(interaction);

                // Featured
                case 'featured': return await throneHandlers.handleFeatured(interaction);

                // Extra lookups
                case 'random': return await throneHandlers.handleRandom(interaction);
                case 'search': return await throneHandlers.handleSearch(interaction);
                case 'stats': return await throneHandlers.handleStats(interaction);

                default:
                    return await interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
            }
        } catch (error) {
            const logger = (await import('../../utils/logger.js')).default;
            logger.error('[Throne Command] Unhandled error', { error: error.message, stack: error.stack, subcommand });

            const reply = interaction.deferred || interaction.replied
                ? interaction.editReply.bind(interaction)
                : interaction.reply.bind(interaction);

            await reply({ content: 'Something went wrong while processing your request.', ephemeral: true }).catch(() => {});
        }
    },
};
