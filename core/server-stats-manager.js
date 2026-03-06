import logger from '../utils/logger.js';
import pool from '../utils/db.js';

/**
 * Server Statistics Manager - Track and analyze server metrics
 */
class ServerStatsManager {
  constructor(client) {
    this.client = client;
    this.messageCache = new Map(); // Cache for batching message stats
    logger.info('[ServerStatsManager] Server statistics manager initialized');
  }

  /**
   * Track a message for statistics
   */
  async trackMessage(message) {
    try {
      if (!message.guild || message.author.bot) return;

      const guildId = message.guild.id;
      const channelId = message.channel.id;
      const userId = message.author.id;
      const content = message.content || '';
      const characterCount = content.length;
      const wordCount = content.trim().split(/\s+/).length;

      // Update message stats
      await pool.execute(
        `INSERT INTO message_stats (guild_id, channel_id, user_id, message_count, character_count, word_count, stat_date)
         VALUES (?, ?, ?, 1, ?, ?, CURDATE())
         ON DUPLICATE KEY UPDATE
           message_count = message_count + 1,
           character_count = character_count + ?,
           word_count = word_count + ?`,
        [guildId, channelId, userId, characterCount, wordCount, characterCount, wordCount]
      );

      // Update activity stats
      await pool.execute(
        `INSERT INTO activity_stats (guild_id, stat_date, messages_sent)
         VALUES (?, CURDATE(), 1)
         ON DUPLICATE KEY UPDATE messages_sent = messages_sent + 1`,
        [guildId]
      );

      // Update peak activity hours
      const now = new Date();
      const hour = now.getHours();
      const dayOfWeek = now.getDay();

      await pool.execute(
        `INSERT INTO peak_activity_hours (guild_id, hour_of_day, day_of_week, message_count, active_users)
         VALUES (?, ?, ?, 1, 1)
         ON DUPLICATE KEY UPDATE message_count = message_count + 1`,
        [guildId, hour, dayOfWeek]
      );
    } catch (error) {
      logger.error(`[ServerStatsManager] Error tracking message: ${error.message}`);
    }
  }

  /**
   * Track a command usage
   */
  async trackCommand(guildId) {
    try {
      await pool.execute(
        `INSERT INTO activity_stats (guild_id, stat_date, commands_used)
         VALUES (?, CURDATE(), 1)
         ON DUPLICATE KEY UPDATE commands_used = commands_used + 1`,
        [guildId]
      );
    } catch (error) {
      logger.error(`[ServerStatsManager] Error tracking command: ${error.message}`);
    }
  }

  /**
   * Track member join
   */
  async trackMemberJoin(guildId) {
    try {
      await pool.execute(
        `INSERT INTO activity_stats (guild_id, stat_date, members_joined)
         VALUES (?, CURDATE(), 1)
         ON DUPLICATE KEY UPDATE members_joined = members_joined + 1`,
        [guildId]
      );
    } catch (error) {
      logger.error(`[ServerStatsManager] Error tracking member join: ${error.message}`);
    }
  }

  /**
   * Track member leave
   */
  async trackMemberLeave(guildId) {
    try {
      await pool.execute(
        `INSERT INTO activity_stats (guild_id, stat_date, members_left)
         VALUES (?, CURDATE(), 1)
         ON DUPLICATE KEY UPDATE members_left = members_left + 1`,
        [guildId]
      );
    } catch (error) {
      logger.error(`[ServerStatsManager] Error tracking member leave: ${error.message}`);
    }
  }

  /**
   * Take a daily snapshot of server statistics
   */
  async takeSnapshot(guild) {
    try {
      const guildId = guild.id;

      // Count members
      const members = await guild.members.fetch();
      const bots = members.filter(m => m.user.bot).size;
      const humans = members.size - bots;
      const online = members.filter(m => m.presence?.status && m.presence.status !== 'offline').size;

      // Count channels
      const channels = guild.channels.cache;
      const textChannels = channels.filter(c => c.isTextBased()).size;
      const voiceChannels = channels.filter(c => c.isVoiceBased()).size;
      const categories = channels.filter(c => c.type === 4).size; // CategoryChannel type

      // Store snapshot
      await pool.execute(
        `INSERT INTO server_stats_snapshots
         (guild_id, snapshot_date, member_count, bot_count, human_count, online_count,
          role_count, channel_count, text_channel_count, voice_channel_count, category_count,
          emoji_count, sticker_count, boost_level, boost_count)
         VALUES (?, CURDATE(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           member_count = VALUES(member_count),
           bot_count = VALUES(bot_count),
           human_count = VALUES(human_count),
           online_count = VALUES(online_count),
           role_count = VALUES(role_count),
           channel_count = VALUES(channel_count),
           text_channel_count = VALUES(text_channel_count),
           voice_channel_count = VALUES(voice_channel_count),
           category_count = VALUES(category_count),
           emoji_count = VALUES(emoji_count),
           sticker_count = VALUES(sticker_count),
           boost_level = VALUES(boost_level),
           boost_count = VALUES(boost_count)`,
        [
          guildId,
          members.size,
          bots,
          humans,
          online,
          guild.roles.cache.size,
          channels.size,
          textChannels,
          voiceChannels,
          categories,
          guild.emojis.cache.size,
          guild.stickers.cache.size,
          guild.premiumTier,
          guild.premiumSubscriptionCount || 0
        ]
      );

      logger.info(`[ServerStatsManager] Took snapshot for guild ${guildId}`);
    } catch (error) {
      logger.error(`[ServerStatsManager] Error taking snapshot: ${error.message}`);
    }
  }

  /**
   * Take snapshots for all guilds
   */
  async takeAllSnapshots() {
    try {
      for (const [guildId, guild] of this.client.guilds.cache) {
        await this.takeSnapshot(guild);
      }
      logger.info(`[ServerStatsManager] Took snapshots for ${this.client.guilds.cache.size} guilds`);
    } catch (error) {
      logger.error(`[ServerStatsManager] Error taking all snapshots: ${error.message}`);
    }
  }

  /**
   * Get server growth statistics
   */
  async getGrowthStats(guildId, days = 30) {
    try {
      const [snapshots] = await pool.execute(
        `SELECT * FROM server_stats_snapshots
         WHERE guild_id = ? AND snapshot_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         ORDER BY snapshot_date ASC`,
        [guildId, days]
      );

      return snapshots;
    } catch (error) {
      logger.error(`[ServerStatsManager] Error getting growth stats: ${error.message}`);
      return [];
    }
  }

  /**
   * Get activity statistics
   */
  async getActivityStats(guildId, days = 7) {
    try {
      const [stats] = await pool.execute(
        `SELECT * FROM activity_stats
         WHERE guild_id = ? AND stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         ORDER BY stat_date ASC`,
        [guildId, days]
      );

      return stats;
    } catch (error) {
      logger.error(`[ServerStatsManager] Error getting activity stats: ${error.message}`);
      return [];
    }
  }

  /**
   * Get top users by messages
   */
  async getTopMessageUsers(guildId, days = 7, limit = 10) {
    try {
      const [users] = await pool.execute(
        `SELECT user_id, SUM(message_count) as total_messages, SUM(word_count) as total_words
         FROM message_stats
         WHERE guild_id = ? AND stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         GROUP BY user_id
         ORDER BY total_messages DESC
         LIMIT ?`,
        [guildId, days, limit]
      );

      return users;
    } catch (error) {
      logger.error(`[ServerStatsManager] Error getting top users: ${error.message}`);
      return [];
    }
  }

  /**
   * Get top channels by activity
   */
  async getTopChannels(guildId, days = 7, limit = 10) {
    try {
      const [channels] = await pool.execute(
        `SELECT channel_id, SUM(message_count) as total_messages
         FROM message_stats
         WHERE guild_id = ? AND stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         GROUP BY channel_id
         ORDER BY total_messages DESC
         LIMIT ?`,
        [guildId, days, limit]
      );

      return channels;
    } catch (error) {
      logger.error(`[ServerStatsManager] Error getting top channels: ${error.message}`);
      return [];
    }
  }

  /**
   * Get peak activity hours
   */
  async getPeakHours(guildId) {
    try {
      const [hours] = await pool.execute(
        `SELECT hour_of_day, day_of_week, message_count
         FROM peak_activity_hours
         WHERE guild_id = ?
         ORDER BY message_count DESC
         LIMIT 10`,
        [guildId]
      );

      return hours;
    } catch (error) {
      logger.error(`[ServerStatsManager] Error getting peak hours: ${error.message}`);
      return [];
    }
  }

  /**
   * Format day of week
   */
  formatDayOfWeek(day) {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[day] || 'Unknown';
  }

  /**
   * Format hour with AM/PM
   */
  formatHour(hour) {
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour % 12 || 12;
    return `${displayHour}:00 ${ampm}`;
  }
}

export default ServerStatsManager;
