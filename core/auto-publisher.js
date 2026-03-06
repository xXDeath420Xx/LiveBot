import { ChannelType } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

/**
 * Handles automatic publishing/crossposting of messages in announcement channels
 * @param {Message} message - The Discord message object
 */
export async function handleAutoPublisher(message) {
  // Only act on announcement channels
  if (message.channel.type !== ChannelType.GuildAnnouncement) {
    return;
  }

  // Don't try to publish messages from bots
  if (message.author.bot) {
    return;
  }

  if (!message.guild) return;

  const guildId = message.guild.id;

  try {
    const [rows] = await pool.execute(
      'SELECT is_enabled FROM auto_publisher_config WHERE guild_id = ?',
      [guildId]
    );
    const config = rows[0];

    if (config && config.is_enabled) {
      await message.crosspost();
      logger.info(`[AutoPublisher] Automatically published message ${message.id} in channel ${message.channel.id}`, {
        guildId,
        channelId: message.channel.id,
        messageId: message.id
      });
    }
  } catch (error) {
    // Error code 50024: Cannot crosspost message (already published or other reason)
    if (error.code === 50024) {
      logger.warn(`[AutoPublisher] Failed to publish message ${message.id}. It may have already been published.`, {
        guildId,
        channelId: message.channel.id
      });
    } else {
      logger.error(`[AutoPublisher] Error processing message ${message.id}`, {
        guildId,
        channelId: message.channel.id,
        error: error.message,
        stack: error.stack
      });
    }
  }
}

/**
 * Enable auto-publisher for a guild
 * @param {string} guildId - The guild ID
 * @returns {Promise<boolean>} - Success status
 */
export async function enableAutoPublisher(guildId) {
  try {
    await pool.execute(
      'INSERT INTO auto_publisher_config (guild_id, is_enabled) VALUES (?, 1) ON DUPLICATE KEY UPDATE is_enabled = 1',
      [guildId]
    );
    logger.info(`[AutoPublisher] Enabled auto-publisher for guild ${guildId}`);
    return true;
  } catch (error) {
    logger.error(`[AutoPublisher] Failed to enable auto-publisher: ${error.message}`, { guildId });
    return false;
  }
}

/**
 * Disable auto-publisher for a guild
 * @param {string} guildId - The guild ID
 * @returns {Promise<boolean>} - Success status
 */
export async function disableAutoPublisher(guildId) {
  try {
    await pool.execute(
      'INSERT INTO auto_publisher_config (guild_id, is_enabled) VALUES (?, 0) ON DUPLICATE KEY UPDATE is_enabled = 0',
      [guildId]
    );
    logger.info(`[AutoPublisher] Disabled auto-publisher for guild ${guildId}`);
    return true;
  } catch (error) {
    logger.error(`[AutoPublisher] Failed to disable auto-publisher: ${error.message}`, { guildId });
    return false;
  }
}

/**
 * Get auto-publisher status for a guild
 * @param {string} guildId - The guild ID
 * @returns {Promise<boolean>} - Whether auto-publisher is enabled
 */
export async function getAutoPublisherStatus(guildId) {
  try {
    const [rows] = await pool.execute(
      'SELECT is_enabled FROM auto_publisher_config WHERE guild_id = ?',
      [guildId]
    );
    return rows[0]?.is_enabled === 1 || false;
  } catch (error) {
    logger.error(`[AutoPublisher] Failed to get auto-publisher status: ${error.message}`, { guildId });
    return false;
  }
}

export default {
  handleAutoPublisher,
  enableAutoPublisher,
  disableAutoPublisher,
  getAutoPublisherStatus
};
