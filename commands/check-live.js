const { SlashCommandBuilder, EmbedBuilder, escapeMarkdown } = require('discord.js');
const db = require('../utils/db');
const apiChecks = require('../utils/api_checks');
const { getBrowser } = require('../utils/browserManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('check-live')
    .setDescription('Instantly lists all currently live streamers for this server.'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    let browser;

    try {
      const [subscriptions] = await db.execute(`
        SELECT s.streamer_id, s.platform, s.username, s.discord_user_id, s.platform_user_id
        FROM subscriptions sub
        JOIN streamers s ON sub.streamer_id = s.streamer_id
        WHERE sub.guild_id = ?`,
        [interaction.guild.id]
      );

      if (subscriptions.length === 0) {
        return interaction.editReply('There are no streamers being tracked on this server.');
      }

      const uniqueStreamersMap = new Map();
      subscriptions.forEach(streamer => {
        uniqueStreamersMap.set(streamer.streamer_id, streamer);
      });
      const streamersToCheck = Array.from(uniqueStreamersMap.values());
      
      if (streamersToCheck.some(s => ['tiktok', 'youtube', 'trovo'].includes(s.platform))) browser = await getBrowser();

      const checkPromises = streamersToCheck.map(async (streamer) => {
        let liveData = { isLive: false };
        if (streamer.platform === 'twitch') {
          liveData = await apiChecks.checkTwitch(streamer);
        } else if (streamer.platform === 'kick') {
          liveData = await apiChecks.checkKick(streamer.username);
        } else if (streamer.platform === 'youtube' && browser) {
          liveData = await apiChecks.checkYouTube(streamer.platform_user_id);
        } else if (streamer.platform === 'tiktok' && browser) {
          liveData = await apiChecks.checkTikTok(streamer.username);
        } else if (streamer.platform === 'trovo' && browser) {
          liveData = await apiChecks.checkTikTok(streamer.username);
        } else if (streamer.platform === 'trovo' && browser) {
          liveData = await apiChecks.checkTrovo(streamer.username);
        }

        if (liveData.isLive) {
          return { ...streamer, ...liveData };
        }
        return null;
      });

      const results = await Promise.allSettled(checkPromises);
      const liveStreamers = results
        .filter(result => result.status === 'fulfilled' && result.value !== null)
        .map(result => result.value);
      
      if (liveStreamers.length === 0) {
        const embed = new EmbedBuilder()
          .setColor('#ED4245')
          .setTitle('No One is Live')
          .setDescription('None of the tracked streamers on this server are currently live.');
        return interaction.editReply({ embeds: [embed] });
      }

      const platformEmojis = { twitch: '🟣', kick: '🟢', youtube: '🔴', tiktok: '⚫', trovo: '🟢', default: '⚪' };

      const descriptionLines = liveStreamers.sort((a,b) => a.username.localeCompare(b.username)).map(s => {
        const statusEmoji = platformEmojis[s.platform] || platformEmojis.default;
        const discordLink = s.discord_user_id ? ` (<@${s.discord_user_id}>)` : '';
        const platformName = s.platform.charAt(0).toUpperCase() + s.platform.slice(1);
        return `${statusEmoji} [**${escapeMarkdown(s.username)}**](${s.url}) (${platformName})${discordLink}`;
      });
      
      const embed = new EmbedBuilder()
        .setColor('#57F287')
        .setTitle(`🟢 ${liveStreamers.length} Streamer(s) Currently Live`)
        .setDescription(descriptionLines.join('\n'))
        .setTimestamp();
        
      await interaction.editReply({ embeds: [embed] });

    } catch (e) {
      console.error('--- Critical Error in /check-live ---', e);
      await interaction.editReply({ content: 'A critical error occurred while fetching live statuses.' });
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  },
};