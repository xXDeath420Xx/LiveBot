import { EmbedBuilder } from 'discord.js';
import RAWGAPIService from '../../../utils/services/rawg-api.js';

const rawgAPI = new RAWGAPIService();

export async function execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    try {
        await interaction.deferReply();

        if (subcommand === 'search') {
            const query = interaction.options.getString('query');

            try {
                const results = await rawgAPI.searchGames(query, 5);

                if (results.length === 0) {
                    return interaction.editReply({ content: `❌ No games found matching "${query}".` });
                }

                const embed = new EmbedBuilder()
                    .setColor('#FF6B35')
                    .setTitle(`🎮 Search Results for "${query}"`)
                    .setDescription('Use `/media game info <game_id>` for detailed information')
                    .setFooter({ text: 'Powered by RAWG.io' })
                    .setTimestamp();

                results.forEach((game, index) => {
                    const platforms = game.platforms?.slice(0, 3).map(p => p.platform.name).join(', ') || 'N/A';
                    const releaseDate = game.released || 'TBA';
                    const rating = game.rating ? `⭐ ${game.rating}/5` : 'No rating';

                    embed.addFields({
                        name: `${index + 1}. ${game.name}`,
                        value: `**ID:** ${game.id}\n**Released:** ${releaseDate}\n**Platforms:** ${platforms}\n**Rating:** ${rating}`,
                        inline: false
                    });
                });

                return interaction.editReply({ embeds: [embed] });

            } catch (error) {
                console.error('[Game Command - Search Error]', error);
                return interaction.editReply({ content: '❌ Failed to search for games. Please try again later.' });
            }

        } else if (subcommand === 'info') {
            const gameId = interaction.options.getInteger('game_id');

            try {
                const game = await rawgAPI.getGameDetails(gameId);
                const formatted = rawgAPI.formatGameData(game);

                let description = formatted.description;
                if (description.length > 2000) {
                    description = description.substring(0, 1997) + '...';
                }

                const embed = new EmbedBuilder()
                    .setColor('#FF6B35')
                    .setTitle(formatted.name)
                    .setURL(formatted.rawgUrl)
                    .setDescription(description.length > 4096 ? description.substring(0, 4093) + '...' : description)
                    .addFields(
                        { name: '📅 Release Date', value: formatted.releaseDate, inline: true },
                        { name: '⭐ Rating', value: formatted.rating, inline: true },
                        { name: '📊 Metacritic', value: formatted.metacritic, inline: true },
                        { name: '🎮 Platforms', value: formatted.platforms.length > 1024 ? formatted.platforms.substring(0, 1021) + '...' : formatted.platforms, inline: false },
                        { name: '🏷️ Genres', value: formatted.genres, inline: true },
                        { name: '🔞 ESRB', value: formatted.esrb, inline: true },
                        { name: '⏱️ Avg Playtime', value: formatted.playtime, inline: true }
                    )
                    .setFooter({ text: 'Powered by RAWG.io' })
                    .setTimestamp();

                if (formatted.image) {
                    embed.setImage(formatted.image);
                }

                return interaction.editReply({ embeds: [embed] });

            } catch (error) {
                console.error('[Game Command - Info Error]', error);
                return interaction.editReply({ content: '❌ Failed to get game information. Please check the game ID and try again.' });
            }

        } else if (subcommand === 'upcoming') {
            try {
                const games = await rawgAPI.getUpcomingReleases(8);

                if (games.length === 0) {
                    return interaction.editReply({ content: '❌ No upcoming releases found.' });
                }

                const embed = new EmbedBuilder()
                    .setColor('#4ECDC4')
                    .setTitle('🗓️ Upcoming Game Releases')
                    .setDescription('Releasing in the next month')
                    .setFooter({ text: 'Powered by RAWG.io' })
                    .setTimestamp();

                games.forEach(game => {
                    const releaseDate = game.released || 'TBA';
                    const platforms = game.platforms?.slice(0, 2).map(p => p.platform.name).join(', ') || 'N/A';
                    const rating = game.rating ? `⭐ ${game.rating}/5` : 'Not rated yet';

                    embed.addFields({
                        name: game.name,
                        value: `**ID:** ${game.id} | **Release:** ${releaseDate}\n**Platforms:** ${platforms} | ${rating}`,
                        inline: false
                    });
                });

                return interaction.editReply({ embeds: [embed] });

            } catch (error) {
                console.error('[Game Command - Upcoming Error]', error);
                return interaction.editReply({ content: '❌ Failed to get upcoming releases. Please try again later.' });
            }

        } else if (subcommand === 'recent') {
            try {
                const games = await rawgAPI.getRecentReleases(8);

                if (games.length === 0) {
                    return interaction.editReply({ content: '❌ No recent releases found.' });
                }

                const embed = new EmbedBuilder()
                    .setColor('#95E1D3')
                    .setTitle('🆕 Recently Released Games')
                    .setDescription('Released in the last month')
                    .setFooter({ text: 'Powered by RAWG.io' })
                    .setTimestamp();

                games.forEach(game => {
                    const releaseDate = game.released || 'Unknown';
                    const platforms = game.platforms?.slice(0, 2).map(p => p.platform.name).join(', ') || 'N/A';
                    const rating = game.rating ? `⭐ ${game.rating}/5` : 'No rating';

                    embed.addFields({
                        name: game.name,
                        value: `**ID:** ${game.id} | **Released:** ${releaseDate}\n**Platforms:** ${platforms} | ${rating}`,
                        inline: false
                    });
                });

                return interaction.editReply({ embeds: [embed] });

            } catch (error) {
                console.error('[Game Command - Recent Error]', error);
                return interaction.editReply({ content: '❌ Failed to get recent releases. Please try again later.' });
            }

        } else if (subcommand === 'popular') {
            try {
                const games = await rawgAPI.getPopularGames(8);

                if (games.length === 0) {
                    return interaction.editReply({ content: '❌ No popular games found.' });
                }

                const embed = new EmbedBuilder()
                    .setColor('#F38181')
                    .setTitle('🔥 Popular Highly-Rated Games')
                    .setDescription('Top-rated games on RAWG')
                    .setFooter({ text: 'Powered by RAWG.io' })
                    .setTimestamp();

                games.forEach((game, index) => {
                    const releaseDate = game.released || 'Unknown';
                    const platforms = game.platforms?.slice(0, 2).map(p => p.platform.name).join(', ') || 'N/A';
                    const rating = game.rating ? `⭐ ${game.rating}/5` : 'No rating';
                    const metacritic = game.metacritic ? `📊 ${game.metacritic}/100` : '';

                    embed.addFields({
                        name: `${index + 1}. ${game.name}`,
                        value: `**ID:** ${game.id} | **Released:** ${releaseDate}\n**Platforms:** ${platforms}\n${rating} ${metacritic}`,
                        inline: false
                    });
                });

                return interaction.editReply({ embeds: [embed] });

            } catch (error) {
                console.error('[Game Command - Popular Error]', error);
                return interaction.editReply({ content: '❌ Failed to get popular games. Please try again later.' });
            }

        } else if (subcommand === 'random') {
            try {
                const games = await rawgAPI.getPopularGames(20);

                if (games.length === 0) {
                    return interaction.editReply({ content: '❌ Failed to get random game.' });
                }

                const randomGame = games[Math.floor(Math.random() * games.length)];
                const game = await rawgAPI.getGameDetails(randomGame.id);
                const formatted = rawgAPI.formatGameData(game);

                let description = formatted.description;
                if (description.length > 2000) {
                    description = description.substring(0, 1997) + '...';
                }

                const embed = new EmbedBuilder()
                    .setColor('#AA96DA')
                    .setTitle(`🎲 Random Game: ${formatted.name}`)
                    .setURL(formatted.rawgUrl)
                    .setDescription(description.length > 4096 ? description.substring(0, 4093) + '...' : description)
                    .addFields(
                        { name: '📅 Release Date', value: formatted.releaseDate, inline: true },
                        { name: '⭐ Rating', value: formatted.rating, inline: true },
                        { name: '📊 Metacritic', value: formatted.metacritic, inline: true },
                        { name: '🎮 Platforms', value: formatted.platforms.length > 1024 ? formatted.platforms.substring(0, 1021) + '...' : formatted.platforms, inline: false },
                        { name: '🏷️ Genres', value: formatted.genres, inline: true }
                    )
                    .setFooter({ text: 'Powered by RAWG.io' })
                    .setTimestamp();

                if (formatted.image) {
                    embed.setImage(formatted.image);
                }

                return interaction.editReply({ embeds: [embed] });

            } catch (error) {
                console.error('[Game Command - Random Error]', error);
                return interaction.editReply({ content: '❌ Failed to get random game. Please try again later.' });
            }
        }

    } catch (error) {
        console.error('[Game Command Error]', error);

        const replyMethod = interaction.deferred ? 'editReply' : 'reply';
        return interaction[replyMethod]({
            content: '❌ An error occurred while processing your game request.',
            ephemeral: true
        });
    }
}
