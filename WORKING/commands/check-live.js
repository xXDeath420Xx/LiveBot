// commands/check-live.js (REWRITTEN - With Multi-Channel Subscription Fix)
const { SlashCommandBuilder, EmbedBuilder, escapeMarkdown } = require('discord.js');
const db = require('../utils/db');
const apiChecks = require('../utils/api_checks');
const initCycleTLS = require('cycletls');
const { getBrowser, closeBrowser } = require('../utils/browserManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('check-live')
    .setDescription('Instantly lists all currently live streamers for this server.'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    let browser = null;
    let cycleTLS = null;

    try {
      // --- THIS IS THE NEW LOGIC ---
      // 1. Get all subscriptions for this guild to find out who is being tracked.
      // Assuming db.execute returns an array where the first element contains the rows (e.g., mysql2/promise)
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

      // 2. De-duplicate the list to ensure we only check each streamer once.
      const uniqueStreamersMap = new Map();
      for (const streamer of subscriptions) {
        uniqueStreamersMap.set(streamer.streamer_id, streamer);
      }
      const streamersToCheck = Array.from(uniqueStreamersMap.values());

      // 3. Set up API connections if necessary, based on the unique list.
      if (streamersToCheck.some(s => s.platform === 'kick')) cycleTLS = await initCycleTLS({ timeout: 60000 });
      if (streamersToCheck.some(s => s.platform === 'tiktok' || s.platform === 'youtube')) browser = await getBrowser();

      // 4. Fetch fresh live data for each unique streamer.
      // Using Promise.allSettled to parallelize API calls for better performance.
      const checkPromises = streamersToCheck.map(async (streamer) => {
        let liveData = { isLive: false };
        if (streamer.platform === 'twitch') {
          // IMPORTANT: apiChecks.checkTwitch MUST correctly use process.env.TWITCH_CLIENT_ID
          // and TWITCH_CLIENT_SECRET to acquire and use an app access token.
          liveData = await apiChecks.checkTwitch(streamer);
        } else if (streamer.platform === 'kick' && cycleTLS) {
          liveData = await apiChecks.checkKick(cycleTLS, streamer.username);
        } else if (streamer.platform === 'youtube' && browser) {
          liveData = await apiChecks.checkYouTube(browser, streamer.platform_user_id);
        } else if (streamer.platform === 'tiktok' && browser) {
          liveData = await apiChecks.checkTikTok(browser, streamer.username);
        } else if (streamer.platform === 'trovo') {
          liveData = await apiChecks.checkTrovo(streamer.username);
        }

        if (liveData.isLive) {
          return { ...streamer, ...liveData };
        }
        return null; // Return null if not live
      });

      const results = await Promise.allSettled(checkPromises);
      const liveStreamers = results
        .filter(result => result.status === 'fulfilled' && result.value !== null)
        .map(result => result.value);
      
      // 5. If after checking, no one is live, display the appropriate message.
      if (liveStreamers.length === 0) {
        const embed = new EmbedBuilder()
          .setColor('#ED4245')
          .setTitle('No One is Live')
          .setDescription('None of the tracked streamers on this server are currently live.');
        return interaction.editReply({ embeds: [embed] });
      }

      // Map platforms to their respective colored circle emojis
      const platformEmojis = {
          twitch: '🟣',
          kick: '🟢',
          youtube: '🔴',
          tiktok: '⚫',
          trovo: '🟢',
          default: '⚪'
      };

      // 6. Build the final description list from the unique list of live streamers.
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
        if (cycleTLS) try { cycleTLS.exit(); } catch(e){ console.error('Error exiting CycleTLS:', e); /* Log error but proceed with other cleanup */ }
        if (browser) {
          try {
            await closeBrowser();
          } catch (e) {
            console.error('Error closing browser:', e);
          }
        }
    }
  },
};