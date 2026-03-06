import { EmbedBuilder } from 'discord.js';
import TMDbAPIService from '../../../utils/services/tmdb-api.js';

const tmdbAPI = new TMDbAPIService();

export async function execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    try {
      await interaction.deferReply();

      if (subcommand === 'search') {
        const query = interaction.options.getString('query');

        try {
          const results = await tmdbAPI.searchMovies(query);

          if (results.length === 0) {
            return interaction.editReply({
              content: `❌ No movies found matching "${query}".`
            });
          }

          const embed = new EmbedBuilder()
            .setColor('#E74C3C')
            .setTitle(`🎬 Movie Search Results for "${query}"`)
            .setDescription('Use `/media movie info <movie_id>` for detailed information')
            .setFooter({ text: 'Powered by TMDb' })
            .setTimestamp();

          results.slice(0, 5).forEach((movie, index) => {
            const releaseYear = movie.release_date ? movie.release_date.split('-')[0] : 'Unknown';
            const rating = movie.vote_average ? `⭐ ${movie.vote_average.toFixed(1)}/10` : 'No rating';

            embed.addFields({
              name: `${index + 1}. ${movie.title} (${releaseYear})`,
              value: `**ID:** ${movie.id}\n**Rating:** ${rating}\n${movie.overview ? (movie.overview.length > 100 ? movie.overview.substring(0, 97) + '...' : movie.overview) : 'No overview'}`,
              inline: false
            });
          });

          return interaction.editReply({ embeds: [embed] });

        } catch (error) {
          console.error('[Movie Command - Search Error]', error);
          return interaction.editReply({
            content: '❌ Failed to search for movies. Please try again later or check if TMDb API key is configured.'
          });
        }

      } else if (subcommand === 'info') {
        const movieId = interaction.options.getInteger('movie_id');

        try {
          const movie = await tmdbAPI.getMovieDetails(movieId);
          const formatted = tmdbAPI.formatMovieData(movie);

          const embed = new EmbedBuilder()
            .setColor('#E74C3C')
            .setTitle(formatted.title)
            .setURL(formatted.tmdbUrl)
            .setDescription(formatted.overview.length > 4096 ? formatted.overview.substring(0, 4093) + '...' : formatted.overview)
            .addFields(
              { name: '📅 Release Date', value: formatted.releaseDate, inline: true },
              { name: '⏱️ Runtime', value: formatted.runtime, inline: true },
              { name: '⭐ Rating', value: `${formatted.rating} ${formatted.voteCount}`, inline: true },
              { name: '🏷️ Genres', value: formatted.genres, inline: true },
              { name: '🎬 Director', value: formatted.director, inline: true },
              { name: '🎭 Cast', value: formatted.cast.length > 1024 ? formatted.cast.substring(0, 1021) + '...' : formatted.cast, inline: false }
            )
            .setFooter({ text: 'Powered by TMDb' })
            .setTimestamp();

          if (formatted.posterUrl) {
            embed.setThumbnail(formatted.posterUrl);
          }

          if (formatted.backdropUrl) {
            embed.setImage(formatted.backdropUrl);
          }

          if (formatted.trailerUrl) {
            embed.addFields({ name: '🎥 Trailer', value: formatted.trailerUrl });
          }

          return interaction.editReply({ embeds: [embed] });

        } catch (error) {
          console.error('[Movie Command - Info Error]', error);
          return interaction.editReply({
            content: '❌ Failed to get movie information. Please check the movie ID and try again.'
          });
        }

      } else if (subcommand === 'tv') {
        const query = interaction.options.getString('query');

        try {
          const results = await tmdbAPI.searchTV(query);

          if (results.length === 0) {
            return interaction.editReply({
              content: `❌ No TV shows found matching "${query}".`
            });
          }

          const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle(`📺 TV Show Search Results for "${query}"`)
            .setDescription('Use `/media movie tvinfo <tv_id>` for detailed information')
            .setFooter({ text: 'Powered by TMDb' })
            .setTimestamp();

          results.slice(0, 5).forEach((show, index) => {
            const firstAirYear = show.first_air_date ? show.first_air_date.split('-')[0] : 'Unknown';
            const rating = show.vote_average ? `⭐ ${show.vote_average.toFixed(1)}/10` : 'No rating';

            embed.addFields({
              name: `${index + 1}. ${show.name} (${firstAirYear})`,
              value: `**ID:** ${show.id}\n**Rating:** ${rating}\n${show.overview ? (show.overview.length > 100 ? show.overview.substring(0, 97) + '...' : show.overview) : 'No overview'}`,
              inline: false
            });
          });

          return interaction.editReply({ embeds: [embed] });

        } catch (error) {
          console.error('[Movie Command - TV Search Error]', error);
          return interaction.editReply({
            content: '❌ Failed to search for TV shows. Please try again later.'
          });
        }

      } else if (subcommand === 'tvinfo') {
        const tvId = interaction.options.getInteger('tv_id');

        try {
          const tv = await tmdbAPI.getTVDetails(tvId);
          const formatted = tmdbAPI.formatTVData(tv);

          const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle(formatted.title)
            .setURL(formatted.tmdbUrl)
            .setDescription(formatted.overview.length > 4096 ? formatted.overview.substring(0, 4093) + '...' : formatted.overview)
            .addFields(
              { name: '📅 First Air Date', value: formatted.firstAirDate, inline: true },
              { name: '📊 Status', value: formatted.status, inline: true },
              { name: '⭐ Rating', value: `${formatted.rating} ${formatted.voteCount}`, inline: true },
              { name: '📺 Seasons', value: formatted.seasons.toString(), inline: true },
              { name: '🎬 Episodes', value: formatted.episodes.toString(), inline: true },
              { name: '🏷️ Genres', value: formatted.genres, inline: true },
              { name: '🎭 Cast', value: formatted.cast.length > 1024 ? formatted.cast.substring(0, 1021) + '...' : formatted.cast, inline: false }
            )
            .setFooter({ text: 'Powered by TMDb' })
            .setTimestamp();

          if (formatted.posterUrl) {
            embed.setThumbnail(formatted.posterUrl);
          }

          if (formatted.backdropUrl) {
            embed.setImage(formatted.backdropUrl);
          }

          if (formatted.trailerUrl) {
            embed.addFields({ name: '🎥 Trailer', value: formatted.trailerUrl });
          }

          return interaction.editReply({ embeds: [embed] });

        } catch (error) {
          console.error('[Movie Command - TV Info Error]', error);
          return interaction.editReply({
            content: '❌ Failed to get TV show information. Please check the TV show ID and try again.'
          });
        }

      } else if (subcommand === 'trending') {
        const type = interaction.options.getString('type');
        const timeframe = interaction.options.getString('timeframe') || 'week';

        try {
          const results = type === 'movie'
            ? await tmdbAPI.getTrendingMovies(timeframe)
            : await tmdbAPI.getTrendingTV(timeframe);

          if (results.length === 0) {
            return interaction.editReply({
              content: '❌ No trending content found.'
            });
          }

          const embed = new EmbedBuilder()
            .setColor(type === 'movie' ? '#E74C3C' : '#3498DB')
            .setTitle(`📈 Trending ${type === 'movie' ? 'Movies' : 'TV Shows'} - ${timeframe === 'week' ? 'This Week' : 'Today'}`)
            .setFooter({ text: 'Powered by TMDb' })
            .setTimestamp();

          results.slice(0, 8).forEach((item, index) => {
            const title = type === 'movie' ? item.title : item.name;
            const date = type === 'movie' ? item.release_date : item.first_air_date;
            const year = date ? date.split('-')[0] : 'Unknown';
            const rating = item.vote_average ? `⭐ ${item.vote_average.toFixed(1)}/10` : 'No rating';

            embed.addFields({
              name: `${index + 1}. ${title} (${year})`,
              value: `**ID:** ${item.id} | ${rating}`,
              inline: false
            });
          });

          return interaction.editReply({ embeds: [embed] });

        } catch (error) {
          console.error('[Movie Command - Trending Error]', error);
          return interaction.editReply({
            content: '❌ Failed to get trending content. Please try again later.'
          });
        }

      } else if (subcommand === 'recommend') {
        const movieId = interaction.options.getInteger('movie_id');

        try {
          const recommendations = await tmdbAPI.getMovieRecommendations(movieId);

          if (recommendations.length === 0) {
            return interaction.editReply({
              content: '❌ No recommendations found for this movie.'
            });
          }

          const embed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle('🎬 Movie Recommendations')
            .setDescription('Movies similar to your selection')
            .setFooter({ text: 'Powered by TMDb' })
            .setTimestamp();

          recommendations.slice(0, 8).forEach((movie, index) => {
            const year = movie.release_date ? movie.release_date.split('-')[0] : 'Unknown';
            const rating = movie.vote_average ? `⭐ ${movie.vote_average.toFixed(1)}/10` : 'No rating';

            embed.addFields({
              name: `${index + 1}. ${movie.title} (${year})`,
              value: `**ID:** ${movie.id} | ${rating}`,
              inline: false
            });
          });

          return interaction.editReply({ embeds: [embed] });

        } catch (error) {
          console.error('[Movie Command - Recommend Error]', error);
          return interaction.editReply({
            content: '❌ Failed to get recommendations. Please try again later.'
          });
        }
      }

    } catch (error) {
      console.error('[Movie Command Error]', error);

      const replyMethod = interaction.deferred ? 'editReply' : 'reply';
      return interaction[replyMethod]({
        content: '❌ An error occurred while processing your movie request.',
        ephemeral: true
      });
    }
}
