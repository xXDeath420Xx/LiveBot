import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import configCache from '../utils/configCache.js';

/**
 * Birthday Manager - Handles birthday tracking and announcements
 */
class BirthdayManager {
  constructor(client) {
    this.client = client;
    this.checkScheduled = false;
    this.intervals = [];
    this.timeouts = [];
  }

  /**
   * Stop all scheduled tasks (call on shutdown)
   */
  stop() {
    for (const interval of this.intervals) {
      clearInterval(interval);
    }
    for (const timeout of this.timeouts) {
      clearTimeout(timeout);
    }
    this.intervals = [];
    this.timeouts = [];
    this.checkScheduled = false;
    logger.info('[BirthdayManager] Stopped and cleaned up');
  }

  /**
   * Start the birthday checker (runs daily at midnight)
   */
  async start() {
    if (this.checkScheduled) {
      logger.warn('[BirthdayManager] Birthday checker already scheduled');
      return;
    }

    // Calculate time until next midnight
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    const msUntilMidnight = tomorrow.getTime() - now.getTime();

    logger.info(`[BirthdayManager] Scheduling first birthday check in ${Math.floor(msUntilMidnight / 1000 / 60)} minutes`);

    // Schedule first check at midnight
    const initialTimeout = setTimeout(() => {
      this.checkBirthdays();
      // Then check daily
      const dailyInterval = setInterval(() => this.checkBirthdays(), 24 * 60 * 60 * 1000);
      this.intervals.push(dailyInterval);
    }, msUntilMidnight);
    this.timeouts.push(initialTimeout);

    this.checkScheduled = true;
  }

  /**
   * Check for birthdays today and announce them
   * Supports multi-bot system - filters guilds by bot assignment
   * @param {Client} client - The bot client to use (default or custom bot)
   */
  async checkBirthdays(client = this.client) {
    const today = new Date();
    const month = today.getMonth() + 1;
    const day = today.getDate();

    const botInfo = client.isDefaultBot ? 'default bot' : `custom bot ${client.botId}`;
    logger.info(`[BirthdayManager] Checking birthdays for ${month}/${day} (${botInfo})`);

    try {
      // Build guild filter based on bot assignment to prevent race conditions
      let guildFilter = '';
      const params = [month, day];

      if (client.isDefaultBot) {
        // Default bot handles guilds NOT assigned to any custom bot
        // Use COLLATE to prevent collation mismatch between tables
        guildFilter = `AND guild_id COLLATE utf8mb4_unicode_ci NOT IN (SELECT guild_id COLLATE utf8mb4_unicode_ci FROM guild_bot_mapping)`;
      } else if (client.botId) {
        // Custom bot only handles its assigned guilds
        guildFilter = `AND guild_id COLLATE utf8mb4_unicode_ci IN (SELECT guild_id COLLATE utf8mb4_unicode_ci FROM guild_bot_mapping WHERE bot_id = ?)`;
        params.push(client.botId);
      }

      const [birthdays] = await pool.execute(
        `SELECT user_id, guild_id FROM user_birthdays WHERE month = ? AND day = ? ${guildFilter}`,
        params
      );

      if (birthdays.length === 0) {
        logger.info(`[BirthdayManager] No birthdays today for ${botInfo}`);
        return;
      }

      logger.info(`[BirthdayManager] Found ${birthdays.length} birthdays today for ${botInfo}`);

      for (const { user_id, guild_id } of birthdays) {
        // Get the correct bot client for this guild
        const guildClient = global.botManager?.getClientForGuild(guild_id) || client;
        await this.announceBirthday(user_id, guild_id, guildClient);
      }
    } catch (error) {
      logger.error(`[BirthdayManager] Error checking birthdays: ${error.message}`);
    }
  }

  /**
   * Announce a birthday
   * @param {string} userId - The user ID
   * @param {string} guildId - The guild ID
   * @param {Client} guildClient - The bot client for this guild (supports multi-bot)
   */
  async announceBirthday(userId, guildId, guildClient = this.client) {
    try {
      const guild = await guildClient.guilds.fetch(guildId).catch(() => null);
      if (!guild) {
        logger.warn(`[BirthdayManager] Guild ${guildId} not found`);
        return;
      }

      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) {
        logger.warn(`[BirthdayManager] Member ${userId} not found in guild ${guildId}`);
        return;
      }

      // Get birthday config (cached - 60s TTL)
      const config = await configCache.get('birthday_config', guildId, async () => {
        const [configRows] = await pool.execute(
          'SELECT announcement_channel_id, enabled, message_template, birthday_role_id FROM birthday_config WHERE guild_id = ?',
          [guildId]
        );
        return configRows[0] || { enabled: true, announcement_channel_id: null, message_template: null, birthday_role_id: null };
      });

      if (!config.enabled) {
        logger.info(`[BirthdayManager] Birthdays disabled for guild ${guildId}`);
        return;
      }

      let channelId = config.announcement_channel_id;

      // If no channel configured, try to find a suitable one
      if (!channelId) {
        const channel = guild.channels.cache.find(ch =>
          ch.isTextBased() && (
            ch.name.includes('birthday') ||
            ch.name === 'general' ||
            ch.id === guild.systemChannelId
          )
        );

        if (!channel) {
          logger.warn(`[BirthdayManager] No suitable channel found for birthday announcement in guild ${guildId}`);
          return;
        }

        channelId = channel.id;
      }

      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        logger.warn(`[BirthdayManager] Invalid channel ${channelId} for guild ${guildId}`);
        return;
      }

      // Create birthday embed
      const embed = new EmbedBuilder()
        .setTitle(`Happy Birthday ${member.displayName}!`)
        .setDescription(`Join us in wishing <@${userId}> a very happy birthday!`)
        .setColor('#FF69B4')
        .setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 256 }))
        .setFooter({ text: `${guild.name} • Birthday Celebration` })
        .setTimestamp();

      await channel.send({
        content: `<@${userId}>`,
        embeds: [embed]
      });

      // Assign birthday role if configured
      if (config.birthday_role_id) {
        const role = guild.roles.cache.get(config.birthday_role_id);
        if (role) {
          await member.roles.add(role).catch(err => {
            logger.warn(`[BirthdayManager] Failed to add birthday role: ${err.message}`);
          });

          // Schedule role removal after 24 hours
          setTimeout(async () => {
            const stillMember = await guild.members.fetch(userId).catch(() => null);
            if (stillMember && stillMember.roles.cache.has(role.id)) {
              await stillMember.roles.remove(role).catch(err => {
                logger.warn(`[BirthdayManager] Failed to remove birthday role: ${err.message}`);
              });
              logger.info(`[BirthdayManager] Removed birthday role from ${userId}`);
            }
          }, 24 * 60 * 60 * 1000);
        }
      }

      logger.info(`[BirthdayManager] Announced birthday for ${member.user.tag} in ${guild.name}`);
    } catch (error) {
      logger.error(`[BirthdayManager] Error announcing birthday: ${error.message}`);
    }
  }

  /**
   * Set a user's birthday
   */
  async setBirthday(userId, guildId, month, day) {
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      throw new Error('Invalid date. Month must be 1-12, day must be 1-31.');
    }

    try {
      await pool.execute(
        `INSERT INTO user_birthdays (user_id, guild_id, month, day)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE month = VALUES(month), day = VALUES(day)`,
        [userId, guildId, month, day]
      );

      logger.info(`[BirthdayManager] Set birthday for user ${userId} in guild ${guildId}: ${month}/${day}`);
      return true;
    } catch (error) {
      logger.error(`[BirthdayManager] Error setting birthday: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get a user's birthday
   */
  async getBirthday(userId, guildId) {
    try {
      const [rows] = await pool.execute(
        'SELECT month, day FROM user_birthdays WHERE user_id = ? AND guild_id = ?',
        [userId, guildId]
      );

      return rows[0] || null;
    } catch (error) {
      logger.error(`[BirthdayManager] Error getting birthday: ${error.message}`);
      return null;
    }
  }

  /**
   * Remove a user's birthday
   */
  async removeBirthday(userId, guildId) {
    try {
      await pool.execute(
        'DELETE FROM user_birthdays WHERE user_id = ? AND guild_id = ?',
        [userId, guildId]
      );

      logger.info(`[BirthdayManager] Removed birthday for user ${userId} in guild ${guildId}`);
      return true;
    } catch (error) {
      logger.error(`[BirthdayManager] Error removing birthday: ${error.message}`);
      return false;
    }
  }

  /**
   * Get all upcoming birthdays for a guild
   */
  async getUpcomingBirthdays(guildId, days = 7) {
    try {
      const today = new Date();
      const upcomingBirthdays = [];

      const [allBirthdays] = await pool.execute(
        'SELECT user_id, month, day FROM user_birthdays WHERE guild_id = ?',
        [guildId]
      );

      for (const birthday of allBirthdays) {
        const birthdayDate = new Date(today.getFullYear(), birthday.month - 1, birthday.day);

        // If birthday has passed this year, check next year
        if (birthdayDate < today) {
          birthdayDate.setFullYear(today.getFullYear() + 1);
        }

        const daysUntil = Math.floor((birthdayDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

        if (daysUntil <= days) {
          upcomingBirthdays.push({
            userId: birthday.user_id,
            month: birthday.month,
            day: birthday.day,
            daysUntil
          });
        }
      }

      return upcomingBirthdays.sort((a, b) => a.daysUntil - b.daysUntil);
    } catch (error) {
      logger.error(`[BirthdayManager] Error getting upcoming birthdays: ${error.message}`);
      return [];
    }
  }

  /**
   * Configure birthday settings for a guild
   */
  async configureBirthdays(guildId, channelId, enabled = true, roleId = null, template = null) {
    try {
      await pool.execute(
        `INSERT INTO birthday_config (guild_id, announcement_channel_id, enabled, birthday_role_id, message_template)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            announcement_channel_id = VALUES(announcement_channel_id),
            enabled = VALUES(enabled),
            birthday_role_id = VALUES(birthday_role_id),
            message_template = VALUES(message_template)`,
        [guildId, channelId, enabled ? 1 : 0, roleId, template]
      );

      logger.info(`[BirthdayManager] Configured birthdays for guild ${guildId}`);
      return true;
    } catch (error) {
      logger.error(`[BirthdayManager] Error configuring birthdays: ${error.message}`);
      return false;
    }
  }

  /**
   * Disable birthday system for a guild
   */
  async disableBirthdays(guildId) {
    try {
      await pool.execute(
        'UPDATE birthday_config SET enabled = 0 WHERE guild_id = ?',
        [guildId]
      );

      logger.info(`[BirthdayManager] Disabled birthdays for guild ${guildId}`);
      return true;
    } catch (error) {
      logger.error(`[BirthdayManager] Error disabling birthdays: ${error.message}`);
      return false;
    }
  }

  /**
   * Get birthday configuration for a guild
   */
  async getConfig(guildId) {
    try {
      const [rows] = await pool.execute(
        'SELECT * FROM birthday_config WHERE guild_id = ?',
        [guildId]
      );
      return rows[0] || null;
    } catch (error) {
      logger.error(`[BirthdayManager] Error getting config: ${error.message}`);
      return null;
    }
  }
}

export default BirthdayManager;
