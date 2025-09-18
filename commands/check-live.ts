import { SlashCommandBuilder, EmbedBuilder, escapeMarkdown, ChatInputCommandInteraction, Guild } from 'discord.js';
import db from '../utils/db';
import * as apiChecks from '../utils/api_checks';
import { getBrowser, closeBrowser } from '../utils/browserManager';
import { refreshAppAccessToken, getAppAccessToken } from '../utils/kickAuth'; // Import centralized Kick auth
import axios from 'axios';

interface StreamerSubscription {
    streamer_id: number;
    platform: string;
    username: string;
    discord_user_id: string | null;
    platform_user_id: string;
    // Add other properties from your DB query if needed
}

export = {
  data: new SlashCommandBuilder()
    .setName('check-live')
    .setDescription('Instantly lists all currently live streamers for this server.'),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    let browser: any = null; // TODO: Type Playwright Browser

    try {
      const guild = interaction.guild as Guild;
      // 1. Get all subscriptions for this guild to find out who is being tracked.
      const [subscriptions]: [StreamerSubscription[], any] = await db.execute(`
        SELECT s.streamer_id, s.platform, s.username, s.discord_user_id, s.platform_user_id
        FROM subscriptions sub
        JOIN streamers s ON sub.streamer_id = s.streamer_id
        WHERE sub.guild_id = ?`,
        [guild.id]
      );

      if (subscriptions.length === 0) {
        return interaction.editReply('There are no streamers being tracked on this server.');
      }

      // 2. De-duplicate the list to ensure we only check each streamer once.
      const uniqueStreamersMap = new Map<number, StreamerSubscription>();
      for (const streamer of subscriptions) {
        uniqueStreamersMap.set(streamer.streamer_id, streamer);
      }
      const streamersToCheck = Array.from(uniqueStreamersMap.values());

      // 3. Set up API connections if necessary, based on the unique list.
      // Ensure appAccessToken is available for Kick API calls
      if (streamersToCheck.some(s => s.platform === 'kick')) {
          await refreshAppAccessToken(); // Use centralized refresh
          if (!getAppAccessToken()) { // Use centralized getter
              console.error("❌ Aborting check-live: App Access Token could not be obtained for Kick API.");
              return interaction.editReply('A critical error occurred: Could not obtain Kick API access token.');
          }
      }
      if (streamersToCheck.some(s => s.platform === 'tiktok' || s.platform === 'youtube' || s.platform === 'trovo')) browser = await getBrowser();

      // 4. Fetch fresh live data for each unique streamer.
      const checkPromises = streamersToCheck.map(async (streamer) => {
        let liveData: apiChecks.LiveStatusResponse = { isLive: false, platform: streamer.platform, username: streamer.username, url: 'N/A', title: 'N/A', game: 'N/A', thumbnailUrl: null, viewers: 0, profileImageUrl: null };
        
        try {
            if (streamer.platform === 'twitch') {
              liveData = await apiChecks.checkTwitch(streamer);
            } else if (streamer.platform === 'kick') {
              const currentAppAccessToken = getAppAccessToken(); // Get token from centralized source
              if (!currentAppAccessToken) return null; // Should have been caught above, but for type safety
              liveData = await apiChecks.checkKick(currentAppAccessToken, streamer.username);
            } else if (streamer.platform === 'youtube' && browser) {
              liveData = await apiChecks.checkYouTube(streamer.platform_user_id);
            } else if (streamer.platform === 'tiktok' && browser) {
              liveData = await apiChecks.checkTikTok(streamer.username);
            } else if (streamer.platform === 'trovo' && browser) {
              liveData = await apiChecks.checkTrovo(streamer.username);
            }
        } catch (e: any) {
            console.error(`[Check-Live API Check Error] for ${streamer.username} on ${streamer.platform}:`, e);
            return null; // Treat API errors as not live for this command
        }

        if (liveData.isLive) {
          return { ...streamer, ...liveData };
        }
        return null; // Return null if not live
      });

      const results = await Promise.allSettled(checkPromises);
      const liveStreamers = results
        .filter(result => result.status === 'fulfilled' && result.value !== null)
        .map(result => result.value as (StreamerSubscription & apiChecks.LiveStatusResponse));
      
      // 5. If after checking, no one is live, display the appropriate message.
      if (liveStreamers.length === 0) {
        const embed = new EmbedBuilder()
          .setColor('#ED4245')
          .setTitle('No One is Live')
          .setDescription('None of the tracked streamers on this server are currently live.');
        return interaction.editReply({ embeds: [embed] });
      }

      // Map platforms to their respective colored circle emojis
      const platformEmojis: { [key: string]: string } = {
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

    } catch (e: any) {
      console.error('--- Critical Error in /check-live ---', e);
      await interaction.editReply({ content: 'A critical error occurred while fetching live statuses.' });
    } finally {
        if (browser) {
          try {
            await closeBrowser();
          } catch (e: any) {
            console.error('Error closing browser:', e);
          }
        }
    }
  },
};