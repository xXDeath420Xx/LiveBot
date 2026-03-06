import { EmbedBuilder } from 'discord.js';
import axios from 'axios';

export async function execute(interaction) {
    await interaction.deferReply();

    const subcommand = interaction.options.getSubcommand();

    try {
        switch (subcommand) {
            case 'search':
                return await searchAnime(interaction);
            case 'manga':
                return await searchManga(interaction);
            case 'character':
                return await searchCharacter(interaction);
            case 'trending':
                return await getTrending(interaction);
        }
    } catch (error) {
        console.error('[Anime Command Error]', error);
        return interaction.editReply({
            content: '❌ Failed to fetch anime data. Please try again later.',
            ephemeral: true
        });
    }
}

async function searchAnime(interaction) {
    const query = interaction.options.getString('query');

    const graphqlQuery = `
      query ($search: String) {
        Media (search: $search, type: ANIME) {
          id
          title { romaji english native }
          description
          episodes
          duration
          status
          season
          seasonYear
          averageScore
          genres
          coverImage { large }
          bannerImage
          siteUrl
          format
          studios(isMain: true) { nodes { name } }
        }
      }
    `;

    const response = await axios.post('https://graphql.anilist.co', {
        query: graphqlQuery,
        variables: { search: query }
    }, { timeout: 10000 });

    const anime = response.data.data.Media;

    if (!anime) {
        return interaction.editReply({ content: '❌ No anime found with that name.', ephemeral: true });
    }

    const description = anime.description
        ? anime.description.replace(/<[^>]*>/g, '').substring(0, 400) + '...'
        : 'No description available';

    const title = anime.title.english || anime.title.romaji;
    const studio = anime.studios.nodes[0]?.name || 'Unknown';

    const embed = new EmbedBuilder()
        .setColor('#02A9FF')
        .setTitle(`📺 ${title}`)
        .setURL(anime.siteUrl)
        .setDescription(description)
        .setThumbnail(anime.coverImage.large)
        .addFields(
            { name: '📊 Score', value: anime.averageScore ? `${anime.averageScore}/100` : 'N/A', inline: true },
            { name: '📺 Episodes', value: anime.episodes ? anime.episodes.toString() : 'Unknown', inline: true },
            { name: '⏱️ Duration', value: anime.duration ? `${anime.duration} min/ep` : 'Unknown', inline: true },
            { name: '📡 Status', value: formatStatus(anime.status), inline: true },
            { name: '📅 Release', value: anime.seasonYear && anime.season ? `${anime.season} ${anime.seasonYear}` : anime.seasonYear || 'Unknown', inline: true },
            { name: '🎬 Studio', value: studio, inline: true },
            { name: '🎭 Genres', value: anime.genres.slice(0, 5).join(', ') || 'Unknown', inline: false }
        )
        .setFooter({ text: 'Powered by AniList' })
        .setTimestamp();

    if (anime.bannerImage) {
        embed.setImage(anime.bannerImage);
    }

    return interaction.editReply({ embeds: [embed] });
}

async function searchManga(interaction) {
    const query = interaction.options.getString('query');

    const graphqlQuery = `
      query ($search: String) {
        Media (search: $search, type: MANGA) {
          id
          title { romaji english native }
          description
          chapters
          volumes
          status
          startDate { year month day }
          averageScore
          genres
          coverImage { large }
          bannerImage
          siteUrl
          format
        }
      }
    `;

    const response = await axios.post('https://graphql.anilist.co', {
        query: graphqlQuery,
        variables: { search: query }
    }, { timeout: 10000 });

    const manga = response.data.data.Media;

    if (!manga) {
        return interaction.editReply({ content: '❌ No manga found with that name.', ephemeral: true });
    }

    const description = manga.description
        ? manga.description.replace(/<[^>]*>/g, '').substring(0, 400) + '...'
        : 'No description available';

    const title = manga.title.english || manga.title.romaji;

    const embed = new EmbedBuilder()
        .setColor('#FF6740')
        .setTitle(`📖 ${title}`)
        .setURL(manga.siteUrl)
        .setDescription(description)
        .setThumbnail(manga.coverImage.large)
        .addFields(
            { name: '📊 Score', value: manga.averageScore ? `${manga.averageScore}/100` : 'N/A', inline: true },
            { name: '📚 Chapters', value: manga.chapters ? manga.chapters.toString() : 'Unknown', inline: true },
            { name: '📗 Volumes', value: manga.volumes ? manga.volumes.toString() : 'Unknown', inline: true },
            { name: '📡 Status', value: formatStatus(manga.status), inline: true },
            { name: '📅 Start Date', value: manga.startDate.year ? `${manga.startDate.year}` : 'Unknown', inline: true },
            { name: '📑 Format', value: formatFormat(manga.format), inline: true },
            { name: '🎭 Genres', value: manga.genres.slice(0, 5).join(', ') || 'Unknown', inline: false }
        )
        .setFooter({ text: 'Powered by AniList' })
        .setTimestamp();

    if (manga.bannerImage) {
        embed.setImage(manga.bannerImage);
    }

    return interaction.editReply({ embeds: [embed] });
}

async function searchCharacter(interaction) {
    const name = interaction.options.getString('name');

    const graphqlQuery = `
      query ($search: String) {
        Character (search: $search) {
          id
          name { full native }
          description
          image { large }
          favourites
          siteUrl
          media(page: 1, perPage: 3) {
            nodes { title { romaji } type }
          }
        }
      }
    `;

    const response = await axios.post('https://graphql.anilist.co', {
        query: graphqlQuery,
        variables: { search: name }
    }, { timeout: 10000 });

    const character = response.data.data.Character;

    if (!character) {
        return interaction.editReply({ content: '❌ No character found with that name.', ephemeral: true });
    }

    const description = character.description
        ? character.description.replace(/<[^>]*>/g, '').substring(0, 600) + '...'
        : 'No description available';

    const appearances = character.media.nodes
        .map(m => `${m.title.romaji} (${m.type})`)
        .join('\n') || 'None listed';

    const embed = new EmbedBuilder()
        .setColor('#E13A9D')
        .setTitle(`👤 ${character.name.full}`)
        .setURL(character.siteUrl)
        .setDescription(description)
        .setThumbnail(character.image.large)
        .addFields(
            { name: '🌏 Native Name', value: character.name.native || 'N/A', inline: true },
            { name: '❤️ Favorites', value: character.favourites.toLocaleString(), inline: true },
            { name: '📺 Appears In', value: appearances, inline: false }
        )
        .setFooter({ text: 'Powered by AniList' })
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

async function getTrending(interaction) {
    const graphqlQuery = `
      query {
        Page(page: 1, perPage: 5) {
          media(sort: TRENDING_DESC, type: ANIME) {
            id
            title { romaji english }
            averageScore
            episodes
            status
            genres
            coverImage { large }
            siteUrl
          }
        }
      }
    `;

    const response = await axios.post('https://graphql.anilist.co', {
        query: graphqlQuery
    }, { timeout: 10000 });

    const trending = response.data.data.Page.media;

    const embed = new EmbedBuilder()
        .setColor('#F39C12')
        .setTitle('🔥 Trending Anime')
        .setDescription('Most trending anime right now on AniList')
        .setFooter({ text: 'Powered by AniList' })
        .setTimestamp();

    trending.forEach((anime, index) => {
        const title = anime.title.english || anime.title.romaji;
        embed.addFields({
            name: `${index + 1}. ${title}`,
            value: `Score: ${anime.averageScore || 'N/A'}/100 • Episodes: ${anime.episodes || 'N/A'}\nGenres: ${anime.genres.slice(0, 3).join(', ')}\n[View on AniList](${anime.siteUrl})`,
            inline: false
        });
    });

    return interaction.editReply({ embeds: [embed] });
}

function formatStatus(status) {
    const statusMap = {
        'FINISHED': '✅ Finished',
        'RELEASING': '📡 Airing',
        'NOT_YET_RELEASED': '📅 Not Yet Released',
        'CANCELLED': '❌ Cancelled',
        'HIATUS': '⏸️ Hiatus'
    };
    return statusMap[status] || status;
}

function formatFormat(format) {
    const formatMap = {
        'MANGA': 'Manga',
        'NOVEL': 'Light Novel',
        'ONE_SHOT': 'One Shot'
    };
    return formatMap[format] || format;
}
