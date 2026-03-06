import { EmbedBuilder } from 'discord.js';
import GitHubAPIService from '../../utils/services/github-api.js';

const githubAPI = new GitHubAPIService();

export async function handleRepo(interaction) {
  const repository = interaction.options.getString('repository');
  const parts = repository.split('/');

  if (parts.length !== 2) {
    return interaction.editReply({
      content: '❌ Invalid repository format. Use: `owner/repo` (e.g., `discord/discord-api-docs`)'
    });
  }

  const [owner, repo] = parts;

  try {
    const repoData = await githubAPI.getRepository(owner, repo);
    const formatted = githubAPI.formatRepositoryData(repoData);

    const embed = new EmbedBuilder()
      .setColor('#238636')
      .setTitle(formatted.fullName)
      .setURL(formatted.url)
      .setDescription(formatted.description.length > 4096 ? formatted.description.substring(0, 4093) + '...' : formatted.description)
      .addFields(
        { name: '⭐ Stars', value: formatted.stars, inline: true },
        { name: '🍴 Forks', value: formatted.forks, inline: true },
        { name: '👁️ Watchers', value: formatted.watchers, inline: true },
        { name: '🐛 Open Issues', value: formatted.issues, inline: true },
        { name: '💻 Language', value: formatted.language, inline: true },
        { name: '📜 License', value: formatted.license, inline: true },
        { name: '📅 Created', value: formatted.createdAt, inline: true },
        { name: '🔄 Last Updated', value: formatted.updatedAt, inline: true },
        { name: '🌿 Default Branch', value: formatted.defaultBranch, inline: true }
      )
      .setFooter({ text: `Owner: ${formatted.owner}` })
      .setTimestamp();

    if (formatted.homepage) embed.addFields({ name: '🏠 Homepage', value: formatted.homepage });
    if (repoData.owner.avatar_url) embed.setThumbnail(repoData.owner.avatar_url);

    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('[GitHub - Repo Error]', error);
    return interaction.editReply({
      content: '❌ Failed to get repository information. Please check the repository name and try again.'
    });
  }
}

export async function handleUser(interaction) {
  const username = interaction.options.getString('username');

  try {
    const userData = await githubAPI.getUserProfile(username);
    const formatted = githubAPI.formatUserData(userData);
    const repos = await githubAPI.getUserRepositories(username, 5);

    const embed = new EmbedBuilder()
      .setColor('#238636')
      .setTitle(formatted.name)
      .setURL(formatted.profileUrl)
      .setDescription(formatted.bio.length > 4096 ? formatted.bio.substring(0, 4093) + '...' : formatted.bio)
      .addFields(
        { name: '👥 Followers', value: formatted.followers, inline: true },
        { name: '👣 Following', value: formatted.following, inline: true },
        { name: '📦 Public Repos', value: formatted.publicRepos, inline: true },
        { name: '🏢 Company', value: formatted.company, inline: true },
        { name: '📍 Location', value: formatted.location, inline: true },
        { name: '📅 Joined', value: formatted.createdAt, inline: true }
      )
      .setThumbnail(formatted.avatarUrl)
      .setFooter({ text: `@${formatted.login}` })
      .setTimestamp();

    if (formatted.blog && formatted.blog !== 'N/A') {
      embed.addFields({ name: '🔗 Website', value: formatted.blog });
    }

    if (repos.length > 0) {
      const repoList = repos.slice(0, 5).map(r =>
        `• **${r.name}** - ⭐ ${r.stargazers_count?.toLocaleString() || 0} | ${r.language || 'N/A'}`
      ).join('\n');
      embed.addFields({ name: '📦 Top Repositories', value: repoList });
    }

    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('[GitHub - User Error]', error);
    return interaction.editReply({
      content: '❌ Failed to get user information. Please check the username and try again.'
    });
  }
}

export async function handleSearch(interaction) {
  const query = interaction.options.getString('query');

  try {
    const results = await githubAPI.searchRepositories(query, 5);

    if (results.length === 0) {
      return interaction.editReply({ content: `❌ No repositories found matching "${query}".` });
    }

    const embed = new EmbedBuilder()
      .setColor('#238636')
      .setTitle(`🔍 Search Results for "${query}"`)
      .setDescription('Top repositories matching your search')
      .setFooter({ text: 'Powered by GitHub API' })
      .setTimestamp();

    results.forEach((repo, index) => {
      const stars = repo.stargazers_count?.toLocaleString() || '0';
      const language = repo.language || 'N/A';
      const description = repo.description || 'No description';

      embed.addFields({
        name: `${index + 1}. ${repo.full_name}`,
        value: `${description.length > 100 ? description.substring(0, 97) + '...' : description}\n⭐ ${stars} | 💻 ${language}\n[View Repository](${repo.html_url})`,
        inline: false
      });
    });

    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('[GitHub - Search Error]', error);
    return interaction.editReply({
      content: '❌ Failed to search repositories. Please try again later.'
    });
  }
}

export async function handleTrending(interaction) {
  const language = interaction.options.getString('language') || '';

  try {
    const results = await githubAPI.getTrendingRepositories(language, 'weekly');

    if (results.length === 0) {
      return interaction.editReply({ content: '❌ No trending repositories found.' });
    }

    const embed = new EmbedBuilder()
      .setColor('#238636')
      .setTitle(`📈 Trending GitHub Repositories${language ? ` (${language})` : ''}`)
      .setDescription('Created in the last week, sorted by stars')
      .setFooter({ text: 'Powered by GitHub API' })
      .setTimestamp();

    results.slice(0, 8).forEach((repo, index) => {
      const stars = repo.stargazers_count?.toLocaleString() || '0';
      const lang = repo.language || 'N/A';

      embed.addFields({
        name: `${index + 1}. ${repo.full_name}`,
        value: `⭐ ${stars} | 💻 ${lang}\n[View Repository](${repo.html_url})`,
        inline: false
      });
    });

    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('[GitHub - Trending Error]', error);
    return interaction.editReply({
      content: '❌ Failed to get trending repositories. Please try again later.'
    });
  }
}
