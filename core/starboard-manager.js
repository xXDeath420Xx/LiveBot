import { EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import configCache from '../utils/configCache.js';

/**
 * Starboard Manager - Highlights popular messages with star reactions
 */
class StarboardManager {
  constructor(client) {
    this.client = client;
    logger.info('[StarboardManager] Starboard manager initialized');
  }

  /**
   * Get starboard configuration for a guild (cached - 60s TTL)
   */
  async getConfig(guildId) {
    try {
      return await configCache.get('starboard_config', guildId, async () => {
        const [rows] = await pool.execute(
          'SELECT * FROM starboard_config WHERE guild_id = ?',
          [guildId]
        );
        return rows[0] || null;
      });
    } catch (error) {
      logger.error(`[StarboardManager] Failed to get config: ${error.message}`, { guildId });
      return null;
    }
  }

  /**
   * Set/update starboard configuration
   */
  async setConfig(guildId, channelId, threshold = 3, emoji = '⭐', enabled = true) {
    try {
      await pool.execute(
        `INSERT INTO starboard_config (guild_id, channel_id, star_threshold, emoji, enabled)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           channel_id = VALUES(channel_id),
           star_threshold = VALUES(star_threshold),
           emoji = VALUES(emoji),
           enabled = VALUES(enabled)`,
        [guildId, channelId, threshold, emoji, enabled ? 1 : 0]
      );
      // Invalidate cache so next lookup gets fresh data
      configCache.invalidate('starboard_config', guildId);
      logger.info(`[StarboardManager] Updated config for guild ${guildId}`);
      return true;
    } catch (error) {
      logger.error(`[StarboardManager] Failed to set config: ${error.message}`, { guildId });
      return false;
    }
  }

  /**
   * Disable starboard for a guild
   */
  async disableStarboard(guildId) {
    try {
      await pool.execute(
        'UPDATE starboard_config SET enabled = 0 WHERE guild_id = ?',
        [guildId]
      );
      // Invalidate cache
      configCache.invalidate('starboard_config', guildId);
      logger.info(`[StarboardManager] Disabled starboard for guild ${guildId}`);
      return true;
    } catch (error) {
      logger.error(`[StarboardManager] Failed to disable starboard: ${error.message}`, { guildId });
      return false;
    }
  }

  /**
   * Handle when a star reaction is added
   */
  async handleReactionAdd(reaction, user) {
    try {
      if (user.bot) return;
      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();

      const message = reaction.message;
      if (!message.guild) return;

      const config = await this.getConfig(message.guild.id);
      if (!config || !config.enabled) return;

      // Check if this is the star emoji
      if (reaction.emoji.name !== config.emoji && reaction.emoji.toString() !== config.emoji) return;

      // Check if channel is in ignore list
      const ignoreChannels = config.ignore_channels ? JSON.parse(config.ignore_channels) : [];
      if (ignoreChannels.includes(message.channel.id)) return;

      // Check if self-starring is disabled
      if (!config.self_star && message.author.id === user.id) {
        await reaction.users.remove(user.id);
        return;
      }

      const starCount = reaction.count || 0;

      // Check if message is already on starboard
      const [existing] = await pool.execute(
        'SELECT * FROM starboard_messages WHERE guild_id = ? AND original_message_id = ?',
        [message.guild.id, message.id]
      );

      if (existing.length > 0) {
        if (starCount >= config.star_threshold) {
          await this.updateStarboardMessage(message, existing[0], starCount, config);
        } else {
          // Star count dropped below threshold, remove from starboard
          await this.removeStarboardMessage(existing[0], config);
        }
      } else {
        if (starCount >= config.star_threshold) {
          await this.createStarboardMessage(message, starCount, config);
        }
      }
    } catch (error) {
      logger.error(`[StarboardManager] Reaction add error: ${error.message}`);
    }
  }

  /**
   * Handle when a star reaction is removed
   */
  async handleReactionRemove(reaction, user) {
    try {
      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();

      const message = reaction.message;
      if (!message.guild) return;

      const config = await this.getConfig(message.guild.id);
      if (!config || !config.enabled) return;

      // Check if this is the star emoji
      if (reaction.emoji.name !== config.emoji && reaction.emoji.toString() !== config.emoji) return;

      const starCount = reaction.count || 0;

      // Check if message is on starboard
      const [existing] = await pool.execute(
        'SELECT * FROM starboard_messages WHERE guild_id = ? AND original_message_id = ?',
        [message.guild.id, message.id]
      );

      if (existing.length > 0) {
        if (starCount >= config.star_threshold) {
          await this.updateStarboardMessage(message, existing[0], starCount, config);
        } else {
          // Star count dropped below threshold, remove from starboard
          await this.removeStarboardMessage(existing[0], config);
        }
      }
    } catch (error) {
      logger.error(`[StarboardManager] Reaction remove error: ${error.message}`);
    }
  }

  /**
   * Create a new starboard message
   */
  async createStarboardMessage(message, starCount, config) {
    try {
      const starboardChannel = await message.guild.channels.fetch(config.channel_id).catch(() => null);
      if (!starboardChannel || !starboardChannel.isTextBased()) return;

      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
        .setDescription(message.content || '*No text content*')
        .addFields({ name: 'Source', value: `[Jump to message](${message.url}) in ${message.channel}` })
        .setTimestamp(message.createdAt);

      // Add first image attachment if present
      const attachment = message.attachments.find(att => att.contentType?.startsWith('image/'));
      if (attachment) {
        embed.setImage(attachment.url);
      }

      const starboardMessage = await starboardChannel.send({
        content: `${config.emoji} **${starCount}** ${message.channel}`,
        embeds: [embed]
      });

      await pool.execute(
        `INSERT INTO starboard_messages (guild_id, original_message_id, original_channel_id, starboard_message_id, star_count)
         VALUES (?, ?, ?, ?, ?)`,
        [message.guild.id, message.id, message.channel.id, starboardMessage.id, starCount]
      );

      logger.info(`[StarboardManager] Created starboard entry for message ${message.id}`, { guildId: message.guild.id, starCount });
    } catch (error) {
      logger.error(`[StarboardManager] Failed to create starboard message: ${error.message}`);
    }
  }

  /**
   * Update existing starboard message
   */
  async updateStarboardMessage(message, existing, starCount, config) {
    try {
      const starboardChannel = await message.guild.channels.fetch(config.channel_id).catch(() => null);
      if (!starboardChannel || !starboardChannel.isTextBased()) return;

      const starboardMessage = await starboardChannel.messages.fetch(existing.starboard_message_id).catch(() => null);
      if (!starboardMessage) {
        // Starboard message was deleted, remove from database
        await pool.execute('DELETE FROM starboard_messages WHERE id = ?', [existing.id]);
        return;
      }

      await starboardMessage.edit({
        content: `${config.emoji} **${starCount}** ${message.channel}`
      });

      await pool.execute(
        'UPDATE starboard_messages SET star_count = ? WHERE id = ?',
        [starCount, existing.id]
      );

      logger.debug(`[StarboardManager] Updated starboard message for ${message.id}`, { starCount });
    } catch (error) {
      logger.error(`[StarboardManager] Failed to update starboard message: ${error.message}`);
    }
  }

  /**
   * Remove message from starboard
   */
  async removeStarboardMessage(existing, config) {
    try {
      const guild = await this.client.guilds.fetch(existing.guild_id).catch(() => null);
      if (!guild) return;

      const starboardChannel = await guild.channels.fetch(config.channel_id).catch(() => null);
      if (!starboardChannel || !starboardChannel.isTextBased()) return;

      const starboardMessage = await starboardChannel.messages.fetch(existing.starboard_message_id).catch(() => null);
      if (starboardMessage) {
        await starboardMessage.delete();
      }

      await pool.execute('DELETE FROM starboard_messages WHERE id = ?', [existing.id]);
      logger.info(`[StarboardManager] Removed starboard message for ${existing.original_message_id}`);
    } catch (error) {
      logger.error(`[StarboardManager] Failed to remove starboard message: ${error.message}`);
    }
  }

  /**
   * Handle when original message is deleted
   */
  async handleMessageDelete(message) {
    try {
      if (!message.guild) return;

      const [existing] = await pool.execute(
        'SELECT * FROM starboard_messages WHERE guild_id = ? AND original_message_id = ?',
        [message.guild.id, message.id]
      );

      if (existing.length > 0) {
        const config = await this.getConfig(message.guild.id);
        if (config) {
          await this.removeStarboardMessage(existing[0], config);
        }
      }
    } catch (error) {
      logger.error(`[StarboardManager] Message delete error: ${error.message}`);
    }
  }

  /**
   * Get starboard statistics
   */
  async getStats(guildId) {
    try {
      const [stats] = await pool.execute(
        `SELECT
           COUNT(*) as total_starred,
           SUM(star_count) as total_stars,
           AVG(star_count) as avg_stars,
           MAX(star_count) as max_stars
         FROM starboard_messages
         WHERE guild_id = ?`,
        [guildId]
      );
      return stats[0];
    } catch (error) {
      logger.error(`[StarboardManager] Stats error: ${error.message}`, { guildId });
      return null;
    }
  }

  /**
   * Get top starred messages
   */
  async getTopMessages(guildId, limit = 10) {
    try {
      const [messages] = await pool.execute(
        `SELECT * FROM starboard_messages
         WHERE guild_id = ?
         ORDER BY star_count DESC
         LIMIT ?`,
        [guildId, limit]
      );
      return messages;
    } catch (error) {
      logger.error(`[StarboardManager] Top messages error: ${error.message}`, { guildId });
      return [];
    }
  }
}

export default StarboardManager;
