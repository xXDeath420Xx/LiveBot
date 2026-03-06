import logger from '../utils/logger.js';
import pool from '../utils/db.js';

/**
 * Emoji Statistics Manager - Track emoji usage and create leaderboards
 */
class EmojiStatsManager {
  constructor(client) {
    this.client = client;
    logger.info('[EmojiStatsManager] Emoji statistics manager initialized');
  }

  /**
   * Track emoji usage in a message
   */
  async trackMessage(message) {
    try {
      if (!message.guild || message.author.bot) return;

      const guildId = message.guild.id;
      const userId = message.author.id;
      const channelId = message.channel.id;

      // Extract emojis from message
      const customEmojiRegex = /<a?:(\w+):(\d+)>/g;
      const unicodeEmojiRegex = /(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)/gu;

      let match;

      // Track custom emojis
      while ((match = customEmojiRegex.exec(message.content)) !== null) {
        const emojiName = match[1];
        const emojiId = match[2];
        const isAnimated = match[0].startsWith('<a:');

        await this.trackEmoji(guildId, emojiId, emojiName, userId, channelId, true, isAnimated);
      }

      // Track unicode emojis
      const unicodeEmojis = message.content.match(unicodeEmojiRegex);
      if (unicodeEmojis) {
        for (const emoji of unicodeEmojis) {
          // Use the emoji itself as both ID and name for unicode emojis
          await this.trackEmoji(guildId, emoji, emoji, userId, channelId, false, false);
        }
      }
    } catch (error) {
      logger.error(`[EmojiStatsManager] Error tracking message: ${error.message}`);
    }
  }

  /**
   * Track a single emoji usage
   */
  async trackEmoji(guildId, emojiId, emojiName, userId, channelId, isCustom, isAnimated) {
    try {
      await pool.execute(
        `INSERT INTO emoji_usage (guild_id, emoji_id, emoji_name, is_custom, is_animated, user_id, channel_id, usage_count, stat_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURDATE())
         ON DUPLICATE KEY UPDATE usage_count = usage_count + 1`,
        [guildId, emojiId, emojiName, isCustom, isAnimated, userId, channelId]
      );
    } catch (error) {
      logger.error(`[EmojiStatsManager] Error tracking emoji: ${error.message}`);
    }
  }

  /**
   * Get top emojis for a guild
   */
  async getTopEmojis(guildId, days = 7, limit = 10, customOnly = false) {
    try {
      let query = `
        SELECT emoji_id, emoji_name, is_custom, is_animated,
               SUM(usage_count) as total_uses,
               COUNT(DISTINCT user_id) as unique_users
        FROM emoji_usage
        WHERE guild_id = ? AND stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      `;
      const params = [guildId, days];

      if (customOnly) {
        query += ' AND is_custom = TRUE';
      }

      query += ' GROUP BY emoji_id ORDER BY total_uses DESC LIMIT ?';
      params.push(limit);

      const [emojis] = await pool.execute(query, params);
      return emojis;
    } catch (error) {
      logger.error(`[EmojiStatsManager] Error getting top emojis: ${error.message}`);
      return [];
    }
  }

  /**
   * Get user's most used emojis
   */
  async getUserTopEmojis(guildId, userId, days = 30, limit = 10) {
    try {
      const [emojis] = await pool.execute(
        `SELECT emoji_id, emoji_name, is_custom, is_animated, SUM(usage_count) as total_uses
         FROM emoji_usage
         WHERE guild_id = ? AND user_id = ? AND stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         GROUP BY emoji_id
         ORDER BY total_uses DESC
         LIMIT ?`,
        [guildId, userId, days, limit]
      );

      return emojis;
    } catch (error) {
      logger.error(`[EmojiStatsManager] Error getting user top emojis: ${error.message}`);
      return [];
    }
  }

  /**
   * Get emoji usage statistics for a specific emoji
   */
  async getEmojiStats(guildId, emojiId, days = 30) {
    try {
      const [stats] = await pool.execute(
        `SELECT
           SUM(usage_count) as total_uses,
           COUNT(DISTINCT user_id) as unique_users,
           COUNT(DISTINCT stat_date) as days_used
         FROM emoji_usage
         WHERE guild_id = ? AND emoji_id = ? AND stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
        [guildId, emojiId, days]
      );

      return stats[0] || null;
    } catch (error) {
      logger.error(`[EmojiStatsManager] Error getting emoji stats: ${error.message}`);
      return null;
    }
  }

  /**
   * Get most active emoji users
   */
  async getTopEmojiUsers(guildId, days = 7, limit = 10) {
    try {
      const [users] = await pool.execute(
        `SELECT user_id,
                SUM(usage_count) as total_emojis,
                COUNT(DISTINCT emoji_id) as unique_emojis
         FROM emoji_usage
         WHERE guild_id = ? AND stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         GROUP BY user_id
         ORDER BY total_emojis DESC
         LIMIT ?`,
        [guildId, days, limit]
      );

      return users;
    } catch (error) {
      logger.error(`[EmojiStatsManager] Error getting top emoji users: ${error.message}`);
      return [];
    }
  }

  /**
   * Get emoji usage trend
   */
  async getEmojiTrend(guildId, emojiId, days = 7) {
    try {
      const [trend] = await pool.execute(
        `SELECT stat_date, SUM(usage_count) as daily_uses
         FROM emoji_usage
         WHERE guild_id = ? AND emoji_id = ? AND stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         GROUP BY stat_date
         ORDER BY stat_date ASC`,
        [guildId, emojiId, days]
      );

      return trend;
    } catch (error) {
      logger.error(`[EmojiStatsManager] Error getting emoji trend: ${error.message}`);
      return [];
    }
  }

  /**
   * Format emoji for display
   */
  formatEmoji(emoji) {
    if (emoji.is_custom) {
      const animated = emoji.is_animated ? 'a' : '';
      return `<${animated}:${emoji.emoji_name}:${emoji.emoji_id}>`;
    }
    return emoji.emoji_name; // Unicode emoji
  }
}

export default EmojiStatsManager;
