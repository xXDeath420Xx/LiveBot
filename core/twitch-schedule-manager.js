import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { getStreamSchedule, getTwitchUser } from '../utils/platforms/twitch-api.js';

/**
 * Manages Twitch schedule syncing to Discord
 */
export default class TwitchScheduleManager {
  constructor(client) {
    this.client = client;
  }

  /**
   * Get all enabled schedule syncs for this bot's guilds
   * @returns {Promise<Array>}
   */
  async getEnabledSyncs() {
    try {
      let query = `
        SELECT
          tss.id,
          tss.guild_id,
          tss.streamer_id,
          tss.discord_channel_id,
          tss.mention_role_id,
          tss.custom_message,
          tss.last_synced,
          s.platform_user_id,
          s.username,
          s.profile_image_url
        FROM twitch_schedule_sync_config tss
        JOIN streamers s ON tss.streamer_id = s.streamer_id
        WHERE tss.is_enabled = 1 AND s.platform = 'twitch'
      `;

      const params = [];

      // Filter by this bot's assigned guilds
      if (!this.client.isDefaultBot && this.client.assignedGuilds) {
        query += ` AND tss.guild_id IN (${this.client.assignedGuilds.map(() => '?').join(',')})`;
        params.push(...this.client.assignedGuilds);
      } else if (this.client.isDefaultBot) {
        // Default bot should only process guilds without custom bots
        const [customGuilds] = await pool.execute('SELECT DISTINCT guild_id FROM guild_bot_mapping');
        if (customGuilds.length > 0) {
          const customGuildIds = customGuilds.map(r => r.guild_id);
          query += ` AND tss.guild_id NOT IN (${customGuildIds.map(() => '?').join(',')})`;
          params.push(...customGuildIds);
        }
      }

      const [syncs] = await pool.execute(query, params);
      return syncs;
    } catch (error) {
      logger.error('[TwitchScheduleManager] Error getting enabled syncs:', {
        error: error.message,
        botId: this.client.botId || 'default'
      });
      return [];
    }
  }

  /**
   * Get the Twitch user ID for a streamer
   * @param {Object} syncConfig - The sync configuration
   * @returns {Promise<string|null>}
   */
  async getTwitchUserId(syncConfig) {
    // If platform_user_id is temporary, fetch the real one
    if (syncConfig.platform_user_id && syncConfig.platform_user_id.startsWith('temp_')) {
      try {
        const userData = await getTwitchUser(syncConfig.username);
        if (userData && userData.id) {
          // Update the database with the real user ID
          await pool.execute(
            'UPDATE streamers SET platform_user_id = ? WHERE streamer_id = ?',
            [userData.id, syncConfig.streamer_id]
          );
          return userData.id;
        }
      } catch (error) {
        logger.warn(`[TwitchScheduleManager] Failed to fetch Twitch user ID for ${syncConfig.username}:`, error.message);
      }
    }

    // Return existing user ID if not temporary
    if (syncConfig.platform_user_id && !syncConfig.platform_user_id.startsWith('temp_')) {
      return syncConfig.platform_user_id;
    }

    return null;
  }

  /**
   * Sync a single schedule configuration
   * @param {Object} syncConfig - The sync configuration
   */
  async syncSchedule(syncConfig) {
    try {
      const twitchUserId = await this.getTwitchUserId(syncConfig);

      if (!twitchUserId) {
        logger.warn(`[TwitchScheduleManager] No valid Twitch user ID for streamer ${syncConfig.username}`);
        return;
      }

      // Fetch schedule from Twitch API
      const scheduleResponse = await getStreamSchedule(twitchUserId);

      if (!scheduleResponse || !scheduleResponse.data) {
        logger.debug(`[TwitchScheduleManager] No schedule data available for ${syncConfig.username}`);
        return;
      }

      const scheduleData = scheduleResponse.data.data;

      if (!scheduleData || !scheduleData.segments || scheduleData.segments.length === 0) {
        logger.debug(`[TwitchScheduleManager] No scheduled streams for ${syncConfig.username}`);
        return;
      }

      // Get the Discord channel
      const channel = await this.client.channels.fetch(syncConfig.discord_channel_id).catch(() => null);

      if (!channel) {
        logger.warn(`[TwitchScheduleManager] Channel ${syncConfig.discord_channel_id} not found for guild ${syncConfig.guild_id}`);
        return;
      }

      // Build embed with schedule
      const embed = await this.buildScheduleEmbed(syncConfig, scheduleData);

      // Build message content
      let messageContent = syncConfig.custom_message || `📅 **${syncConfig.username}**'s Stream Schedule`;

      if (syncConfig.mention_role_id) {
        messageContent = `<@&${syncConfig.mention_role_id}> ${messageContent}`;
      }

      // Send the schedule
      await channel.send({
        content: messageContent,
        embeds: [embed]
      });

      // Update last_synced timestamp
      await pool.execute(
        'UPDATE twitch_schedule_sync_config SET last_synced = NOW() WHERE id = ?',
        [syncConfig.id]
      );

      logger.info(`[TwitchScheduleManager] Synced schedule for ${syncConfig.username} in guild ${syncConfig.guild_id}`);
    } catch (error) {
      logger.error(`[TwitchScheduleManager] Error syncing schedule for ${syncConfig.username}:`, {
        error: error.message,
        stack: error.stack,
        guildId: syncConfig.guild_id
      });
    }
  }

  /**
   * Build an embed with the schedule information
   * @param {Object} syncConfig - The sync configuration
   * @param {Object} scheduleData - The schedule data from Twitch
   * @returns {Promise<EmbedBuilder>}
   */
  async buildScheduleEmbed(syncConfig, scheduleData) {
    const embed = new EmbedBuilder()
      .setColor('#9146FF') // Twitch purple
      .setTitle(`📅 ${syncConfig.username}'s Stream Schedule`)
      .setURL(`https://twitch.tv/${syncConfig.username}`)
      .setTimestamp();

    if (syncConfig.profile_image_url) {
      embed.setThumbnail(syncConfig.profile_image_url);
    }

    // Add scheduled streams (limit to next 10)
    const segments = scheduleData.segments.slice(0, 10);

    for (const segment of segments) {
      const startTime = new Date(segment.start_time);
      const discordTimestamp = Math.floor(startTime.getTime() / 1000);

      let fieldValue = `<t:${discordTimestamp}:F> (<t:${discordTimestamp}:R>)`;

      if (segment.title) {
        fieldValue += `\n**${segment.title}**`;
      }

      if (segment.category && segment.category.name) {
        fieldValue += `\n🎮 ${segment.category.name}`;
      }

      embed.addFields({
        name: segment.title || 'Scheduled Stream',
        value: fieldValue,
        inline: false
      });
    }

    if (scheduleData.segments.length > 10) {
      embed.setFooter({
        text: `Showing 10 of ${scheduleData.segments.length} scheduled streams`
      });
    }

    return embed;
  }

  /**
   * Process all enabled schedule syncs
   */
  async processAllSyncs() {
    try {
      const syncs = await this.getEnabledSyncs();

      if (syncs.length === 0) {
        logger.debug(`[TwitchScheduleManager] No enabled schedule syncs for bot ${this.client.botId || 'default'}`);
        return;
      }

      logger.info(`[TwitchScheduleManager] Processing ${syncs.length} schedule sync(s) for bot ${this.client.botId || 'default'}`);

      for (const sync of syncs) {
        // Only sync if it hasn't been synced in the last 12 hours
        if (sync.last_synced) {
          const lastSyncTime = new Date(sync.last_synced);
          const hoursSinceLastSync = (Date.now() - lastSyncTime.getTime()) / (1000 * 60 * 60);

          if (hoursSinceLastSync < 12) {
            logger.debug(`[TwitchScheduleManager] Skipping ${sync.username} - synced ${Math.floor(hoursSinceLastSync)} hours ago`);
            continue;
          }
        }

        await this.syncSchedule(sync);

        // Add a small delay between syncs to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      logger.error('[TwitchScheduleManager] Error processing syncs:', {
        error: error.message,
        stack: error.stack
      });
    }
  }
}
