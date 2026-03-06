import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { execute as handleAnime } from './media/anime.js';
import { execute as handleMovie } from './media/movie.js';
import { execute as handleBooks } from './media/books.js';
import { execute as handleGame } from './media/game.js';
import { execute as handleSteam } from './media/steam.js';
import logger from '../../utils/logger.js';

export default {
    category: 'info',
    data: new SlashCommandBuilder()
        .setName('media')
        .setDescription('Anime, movies, books, games & Steam tracking')

        // ── Anime Group ──
        .addSubcommandGroup(group =>
            group.setName('anime')
                .setDescription('Search for anime and manga information')
                .addSubcommand(sub =>
                    sub.setName('search')
                        .setDescription('Search for an anime')
                        .addStringOption(opt => opt.setName('query').setDescription('Name of the anime').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('manga')
                        .setDescription('Search for a manga')
                        .addStringOption(opt => opt.setName('query').setDescription('Name of the manga').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('character')
                        .setDescription('Search for an anime/manga character')
                        .addStringOption(opt => opt.setName('name').setDescription('Name of the character').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('trending')
                        .setDescription('Get trending anime')))

        // ── Movie/TV Group ──
        .addSubcommandGroup(group =>
            group.setName('movie')
                .setDescription('Movie and TV show information')
                .addSubcommand(sub =>
                    sub.setName('search')
                        .setDescription('Search for a movie')
                        .addStringOption(opt => opt.setName('query').setDescription('Movie title to search for').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('info')
                        .setDescription('Get detailed information about a movie')
                        .addIntegerOption(opt => opt.setName('movie_id').setDescription('TMDb movie ID (use /media movie search first)').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('tv')
                        .setDescription('Search for a TV show')
                        .addStringOption(opt => opt.setName('query').setDescription('TV show name to search for').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('tvinfo')
                        .setDescription('Get detailed information about a TV show')
                        .addIntegerOption(opt => opt.setName('tv_id').setDescription('TMDb TV show ID (use /media movie tv first)').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('trending')
                        .setDescription('View trending movies and TV shows')
                        .addStringOption(opt => opt.setName('type').setDescription('Movies or TV shows').setRequired(true)
                            .addChoices({ name: 'Movies', value: 'movie' }, { name: 'TV Shows', value: 'tv' }))
                        .addStringOption(opt => opt.setName('timeframe').setDescription('Trending this week or today')
                            .addChoices({ name: 'This Week', value: 'week' }, { name: 'Today', value: 'day' })))
                .addSubcommand(sub =>
                    sub.setName('recommend')
                        .setDescription('Get movie recommendations based on a movie you like')
                        .addIntegerOption(opt => opt.setName('movie_id').setDescription('TMDb movie ID').setRequired(true))))

        // ── Books Group ──
        .addSubcommandGroup(group =>
            group.setName('book')
                .setDescription('Book search, recommendations, and information')
                .addSubcommand(sub =>
                    sub.setName('search')
                        .setDescription('Search for books by title, author, or subject')
                        .addStringOption(opt => opt.setName('query').setDescription('Book title, author name, or subject').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('bygenre')
                        .setDescription('Find books by genre')
                        .addStringOption(opt => opt.setName('genre').setDescription('Book genre').setRequired(true)
                            .addChoices(
                                { name: 'Fiction', value: 'fiction' }, { name: 'Mystery', value: 'mystery' },
                                { name: 'Romance', value: 'romance' }, { name: 'Science Fiction', value: 'science+fiction' },
                                { name: 'Fantasy', value: 'fantasy' }, { name: 'Horror', value: 'horror' },
                                { name: 'Biography', value: 'biography' }, { name: 'History', value: 'history' },
                                { name: 'Self-Help', value: 'self-help' }, { name: 'Business', value: 'business' },
                                { name: 'Cooking', value: 'cooking' }, { name: 'Travel', value: 'travel' })))
                .addSubcommand(sub =>
                    sub.setName('bestsellers')
                        .setDescription('Get current bestselling books'))
                .addSubcommand(sub =>
                    sub.setName('random')
                        .setDescription('Get a random book recommendation')))

        // ── Video Games Group ──
        .addSubcommandGroup(group =>
            group.setName('game')
                .setDescription('Video game information and search')
                .addSubcommand(sub =>
                    sub.setName('search')
                        .setDescription('Search for a game')
                        .addStringOption(opt => opt.setName('query').setDescription('Game name to search for').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('info')
                        .setDescription('Get detailed information about a specific game')
                        .addIntegerOption(opt => opt.setName('game_id').setDescription('RAWG game ID (use /media game search first)').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('upcoming')
                        .setDescription('View upcoming game releases'))
                .addSubcommand(sub =>
                    sub.setName('recent')
                        .setDescription('View recently released games'))
                .addSubcommand(sub =>
                    sub.setName('popular')
                        .setDescription('View popular highly-rated games'))
                .addSubcommand(sub =>
                    sub.setName('random')
                        .setDescription('Get a random popular game recommendation')))

        // ── Steam Group ──
        .addSubcommandGroup(group =>
            group.setName('steam')
                .setDescription('Steam app tracking and notifications')
                .addSubcommand(sub =>
                    sub.setName('watch')
                        .setDescription('Add a Steam watcher for notifications')
                        .addStringOption(opt => opt.setName('app').setDescription('Steam App ID or Name (e.g., "730" or "Counter-Strike")').setRequired(true))
                        .addStringOption(opt => opt.setName('type').setDescription('What to watch for').setRequired(true)
                            .addChoices(
                                { name: 'News Updates', value: 'app_news' }, { name: 'Price Changes', value: 'app_price' },
                                { name: 'Workshop Items', value: 'app_workshop' }, { name: 'Free Promotions', value: 'free_promotions' },
                                { name: 'Valve News', value: 'valve_news' }))
                        .addChannelOption(opt => opt.setName('channel').setDescription('Channel for notifications').addChannelTypes(ChannelType.GuildText).setRequired(true))
                        .addRoleOption(opt => opt.setName('mention-role').setDescription('Role to mention in notifications (optional)')))
                .addSubcommand(sub =>
                    sub.setName('unwatch')
                        .setDescription('Remove a Steam watcher')
                        .addIntegerOption(opt => opt.setName('watcher-id').setDescription('Watcher ID from /media steam watchers').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('watchers')
                        .setDescription('List all active Steam watchers')
                        .addChannelOption(opt => opt.setName('channel').setDescription('Filter by channel (optional)')))
                .addSubcommand(sub =>
                    sub.setName('news')
                        .setDescription('Get latest news for a Steam app')
                        .addStringOption(opt => opt.setName('app').setDescription('Steam App ID or Name (e.g., "730" or "Counter-Strike")').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('price')
                        .setDescription('Get current price for a Steam app')
                        .addStringOption(opt => opt.setName('app').setDescription('Steam App ID or Name (e.g., "730" or "Counter-Strike")').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('search')
                        .setDescription('Search for Steam apps')
                        .addStringOption(opt => opt.setName('query').setDescription('Search query').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('currency')
                        .setDescription('Set preferred currency for price tracking')
                        .addStringOption(opt => opt.setName('currency').setDescription('Currency code').setRequired(true)
                            .addChoices(
                                { name: 'USD (United States)', value: 'us' }, { name: 'EUR (Europe)', value: 'eu' },
                                { name: 'GBP (United Kingdom)', value: 'uk' }, { name: 'CAD (Canada)', value: 'ca' },
                                { name: 'AUD (Australia)', value: 'au' }, { name: 'JPY (Japan)', value: 'jp' },
                                { name: 'RUB (Russia)', value: 'ru' }, { name: 'BRL (Brazil)', value: 'br' })))
                .addSubcommand(sub =>
                    sub.setName('check')
                        .setDescription('Manually trigger a Steam Watch check'))
                .addSubcommand(sub =>
                    sub.setName('mentions')
                        .setDescription('Configure mentions for a watcher')
                        .addIntegerOption(opt => opt.setName('watcher-id').setDescription('Watcher ID from /media steam watchers').setRequired(true))
                        .addRoleOption(opt => opt.setName('add-role').setDescription('Add a role to mention'))
                        .addUserOption(opt => opt.setName('add-user').setDescription('Add a user to mention'))
                        .addBooleanOption(opt => opt.setName('clear-all').setDescription('Clear all mentions')))),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup();

        try {
            // Steam group requires ManageChannels permission
            if (group === 'steam') {
                if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
                    return interaction.reply({
                        content: 'You need **Manage Channels** permission to use Steam commands.',
                        ephemeral: true
                    });
                }
            }

            switch (group) {
                case 'anime':
                    return await handleAnime(interaction);
                case 'movie':
                    return await handleMovie(interaction);
                case 'book':
                    return await handleBooks(interaction);
                case 'game':
                    return await handleGame(interaction);
                case 'steam':
                    return await handleSteam(interaction);
            }
        } catch (error) {
            logger.error('[Media Command] Error:', { error: error.message, group, stack: error.stack });

            const reply = { content: `Error: ${error.message}`, ephemeral: true };
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(reply);
            } else {
                await interaction.reply(reply);
            }
        }
    }
};
