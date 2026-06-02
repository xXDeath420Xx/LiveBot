import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } from 'discord.js';
import crypto from 'crypto';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import configCache from '../utils/configCache.js';
import { validateBirthday, computeAge } from './birthday-helpers.js';

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
        `SELECT user_id, guild_id FROM user_birthdays WHERE month = ? AND day = ? AND (last_announced IS NULL OR last_announced < CURDATE()) ${guildFilter}`,
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
        // No config = disabled by default — guilds must explicitly configure birthdays
        return configRows[0] || { enabled: false, announcement_channel_id: null, message_template: null, birthday_role_id: null };
      });

      if (!config.enabled) {
        logger.info(`[BirthdayManager] Birthdays disabled for guild ${guildId}`);
        return;
      }

      let channelId = config.announcement_channel_id;

      // If no announcement channel is configured, do NOT post anywhere
      if (!channelId) {
        logger.info(`[BirthdayManager] No announcement channel configured for guild ${guildId} — skipping`);
        return;
      }


      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        logger.warn(`[BirthdayManager] Invalid channel ${channelId} for guild ${guildId}`);
        return;
      }

      // Look up the (optional) birth year to show age on the card.
      let age = null;
      try {
        const [yrRows] = await pool.execute(
          'SELECT year FROM user_birthdays WHERE user_id = ? AND guild_id = ?',
          [userId, guildId]
        );
        age = computeAge(yrRows[0]?.year ?? null, new Date());
      } catch { /* age is optional — ignore lookup failure */ }

      // Create birthday embed
      const embed = new EmbedBuilder()
        .setTitle(`Happy Birthday ${member.displayName}!`)
        .setDescription(
          `Join us in wishing <@${userId}> a very happy birthday!` +
          (age !== null ? `\n🎂 Turning **${age}** today!` : '')
        )
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
          logger.info(`[BirthdayManager] Assigned birthday role to ${userId} in ${guildId}`);
        }
      }

      // Mark as announced today to prevent duplicates on restart
      await pool.execute('UPDATE user_birthdays SET last_announced = CURDATE() WHERE user_id = ? AND guild_id = ?', [userId, guildId]);

      logger.info(`[BirthdayManager] Announced birthday for ${member.user.tag} in ${guild.name}`);

      // Post the birthday card if one exists
      await this.postBirthdayCard(userId, guildId, channel, guildClient);
    } catch (error) {
      logger.error(`[BirthdayManager] Error announcing birthday: ${error.message}`);
    }
  }

  /**
   * Create birthday cards for upcoming birthdays (14 days out)
   */
  async createUpcomingCards(client) {
    try {
      const baseUrl = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/$/, '');

      // Check all birthdays within the next 14 days (not just exactly 14 days out)
      // This catches missed days from restarts, new bot installs, etc.
      const today = new Date();
      const datesToCheck = [];
      for (let d = 1; d <= 14; d++) {
        const check = new Date(today);
        check.setDate(check.getDate() + d);
        datesToCheck.push({ month: check.getMonth() + 1, day: check.getDate() });
      }

      // Build WHERE clause for all dates in the range
      const dateConditions = datesToCheck.map(() => '(ub.month = ? AND ub.day = ?)').join(' OR ');
      const dateParams = datesToCheck.flatMap(d => [d.month, d.day]);

      // Build guild filter
      let guildFilter = '';
      const params = [...dateParams];
      if (client.isDefaultBot) {
        guildFilter = `AND ub.guild_id COLLATE utf8mb4_unicode_ci NOT IN (SELECT guild_id COLLATE utf8mb4_unicode_ci FROM guild_bot_mapping)`;
      } else if (client.botId) {
        guildFilter = `AND ub.guild_id COLLATE utf8mb4_unicode_ci IN (SELECT guild_id COLLATE utf8mb4_unicode_ci FROM guild_bot_mapping WHERE bot_id = ?)`;
        params.push(client.botId);
      }

      const [upcoming] = await pool.execute(
        `SELECT ub.user_id, ub.guild_id, ub.month, ub.day FROM user_birthdays ub
         WHERE (${dateConditions}) ${guildFilter}`,
        params
      );

      for (const birthday of upcoming) {
        // Check if card already exists for this year
        const [existing] = await pool.execute(
          'SELECT id FROM birthday_cards WHERE guild_id = ? AND user_id = ? AND birthday_month = ? AND birthday_day = ? AND is_posted = 0',
          [birthday.guild_id, birthday.user_id, birthday.month, birthday.day]
        );

        if (existing.length > 0) continue; // Already created

        // Check if guild has birthday config enabled
        const config = await configCache.get('birthday_config', birthday.guild_id, async () => {
          const [rows] = await pool.execute('SELECT * FROM birthday_config WHERE guild_id = ?', [birthday.guild_id]);
          return rows[0] || { enabled: false, announcement_channel_id: null, card_channel_id: null, birthday_role_id: null, cards_enabled: 0 };
        });
        if (!config.enabled) continue;
        if (config.cards_enabled === 0) continue; // Cards explicitly disabled

        // Create the card
        const shareToken = crypto.randomBytes(16).toString('hex');
        await pool.execute(
          'INSERT INTO birthday_cards (guild_id, user_id, card_name, birthday_month, birthday_day, share_token, slug) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [birthday.guild_id, birthday.user_id, `Happy Birthday ${member.displayName}`, birthday.month, birthday.day, shareToken, `happy-birthday-${member.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 40)}-${shareToken.substring(0, 12)}`]
        );

        // Post "card is open" announcement
        const guildClient = global.botManager?.getClientForGuild(birthday.guild_id) || client;
        const guild = guildClient.guilds.cache.get(birthday.guild_id);
        if (!guild) continue;

        const member = await guild.members.fetch(birthday.user_id).catch(() => null);
        if (!member) continue;

        // Use card_channel_id for the "sign the card" post (hidden from birthday person)
        // Falls back to announcement_channel_id if no separate card channel is set
        let channelId = config.card_channel_id || config.announcement_channel_id;
        if (!channelId) continue; // No channel configured — don't guess

        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!channel) continue;

        // Hide the signing channel from the birthday person so the card is a surprise
        if (config.card_channel_id && channel.permissionOverwrites) {
          try {
            await channel.permissionOverwrites.edit(birthday.user_id, {
              ViewChannel: false
            }, { reason: `Birthday card surprise — hiding from ${member.displayName} until their birthday` });
            logger.info(`[BirthdayManager] Hidden card channel from ${member.user.tag} in ${guild.name}`);
          } catch (permErr) {
            logger.warn(`[BirthdayManager] Could not hide channel from birthday person: ${permErr.message}`);
          }
        }

        const cardUrl = `${baseUrl}/card/${shareToken}`;
        const embed = new EmbedBuilder()
          .setTitle(`🎂 ${member.displayName}'s Birthday is Coming Up!`)
          .setDescription(`**${member.displayName}**'s birthday is in 14 days!\n\nSign their digital birthday card before the big day:`)
          .setColor('#FF69B4')
          .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
          .setFooter({ text: `${guild.name} • Birthday Cards` })
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel('Sign the Card!')
            .setURL(cardUrl)
            .setStyle(ButtonStyle.Link)
            .setEmoji('✍️')
        );

        const signMsg = await channel.send({ embeds: [embed], components: [row] });

        // Save the signing message ID so we can delete it when the card is delivered
        await pool.execute(
          'UPDATE birthday_cards SET signing_message_id = ?, signing_channel_id = ? WHERE share_token = ?',
          [signMsg.id, channelId, shareToken]
        );

        logger.info(`[BirthdayManager] Created card for ${member.user.tag} in ${guild.name} (token: ${shareToken}, signMsg: ${signMsg.id})`);
      }
    } catch (error) {
      if (error.code !== 'ER_NO_SUCH_TABLE') {
        logger.error(`[BirthdayManager] Error creating upcoming cards: ${error.message}`);
      }
    }
  }

  /**
   * Post a birthday card on the birthday (if one exists)
   */
  async postBirthdayCard(userId, guildId, channel, guildClient) {
    try {
      const baseUrl = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/$/, '');

      const [cards] = await pool.execute(
        'SELECT * FROM birthday_cards WHERE guild_id = ? AND user_id = ? AND is_posted = 0 ORDER BY created_at DESC LIMIT 1',
        [guildId, userId]
      );

      if (cards.length === 0) return;
      const card = cards[0];

      const [signatures] = await pool.execute(
        'SELECT COUNT(*) as count FROM birthday_card_signatures WHERE card_id = ?',
        [card.id]
      );
      const sigCount = signatures[0]?.count || 0;

      const cardUrl = `${baseUrl}/card/${card.share_token}`;
      const embed = new EmbedBuilder()
        .setTitle('🎁 Your Birthday Card Has Arrived!')
        .setDescription(`**${sigCount}** people signed your birthday card! Open it to see all the messages:`)
        .setColor('#FFD700')
        .setFooter({ text: 'Happy Birthday!' })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel(`Open Card (${sigCount} signatures)`)
          .setURL(cardUrl)
          .setStyle(ButtonStyle.Link)
          .setEmoji('🎂')
      );

      const msg = await channel.send({ embeds: [embed], components: [row] });

      await pool.execute(
        'UPDATE birthday_cards SET is_posted = 1, posted_message_id = ? WHERE id = ?',
        [msg.id, card.id]
      );

      // DM the birthday person with their card link
      try {
        const recipient = await guildClient.users.fetch(userId).catch(() => null);
        if (recipient) {
          const dmEmbed = new EmbedBuilder()
            .setTitle('🎂 Happy Birthday!')
            .setDescription(`Your community made you a birthday card with **${sigCount}** signature${sigCount !== 1 ? 's' : ''}! Open it to see all the love:`)
            .setColor('#FF69B4')
            .setFooter({ text: 'From your friends' })
            .setTimestamp();
          const dmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('Open My Card').setURL(`${baseUrl}/card/${card.slug || card.share_token}/view`).setStyle(ButtonStyle.Link).setEmoji('🎁')
          );
          await recipient.send({ embeds: [dmEmbed], components: [dmRow] }).catch(() => {});
          logger.info(`[BirthdayManager] DM'd card link to ${recipient.tag}`, { guildId, userId });
        }
      } catch { /* DMs may be disabled */ }

      // Clean up the signing channel: delete the "Sign the Card!" embed and restore access
      try {
        const guild = guildClient.guilds.cache.get(guildId);

        // Delete the signing embed from the signing channel
        if (card.signing_channel_id && card.signing_message_id && guild) {
          const signingChannel = await guild.channels.fetch(card.signing_channel_id).catch(() => null);
          if (signingChannel) {
            const signMsg = await signingChannel.messages.fetch(card.signing_message_id).catch(() => null);
            if (signMsg) {
              await signMsg.delete().catch(() => {});
              logger.info(`[BirthdayManager] Deleted signing embed from channel ${card.signing_channel_id}`);
            }
          }
        }

        // Restore the birthday person's access to the signing channel
        const config = await configCache.get('birthday_config', guildId, async () => {
          const [rows] = await pool.execute('SELECT * FROM birthday_config WHERE guild_id = ?', [guildId]);
          return rows[0] || {};
        });

        const hideChannelId = card.signing_channel_id || config.card_channel_id;
        if (hideChannelId && guild) {
          const signingChannel = await guild.channels.fetch(hideChannelId).catch(() => null);
          if (signingChannel?.permissionOverwrites) {
            await signingChannel.permissionOverwrites.delete(userId,
              'Birthday card delivered — restoring channel access'
            ).catch(() => {});
            logger.info(`[BirthdayManager] Restored card channel access for user ${userId} in guild ${guildId}`);
          }
        }
      } catch (restoreErr) {
        logger.warn(`[BirthdayManager] Could not clean up signing channel: ${restoreErr.message}`);
      }

      logger.info(`[BirthdayManager] Posted birthday card for user ${userId} in guild ${guildId} (${sigCount} signatures)`);
    } catch (error) {
      if (error.code !== 'ER_NO_SUCH_TABLE') {
        logger.error(`[BirthdayManager] Error posting birthday card: ${error.message}`);
      }
    }
  }

  /**
   * Set a user's birthday
   */
  async setBirthday(userId, guildId, month, day, year = null) {
    const check = validateBirthday(month, day, year);
    if (!check.ok) {
      throw new Error(check.error);
    }

    try {
      await pool.execute(
        `INSERT INTO user_birthdays (user_id, guild_id, month, day, year)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE month = VALUES(month), day = VALUES(day), year = VALUES(year)`,
        [userId, guildId, month, day, year ?? null]
      );

      logger.info(`[BirthdayManager] Set birthday for user ${userId} in guild ${guildId}: ${month}/${day}${year ? '/' + year : ''}`);
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
        'SELECT month, day, year FROM user_birthdays WHERE user_id = ? AND guild_id = ?',
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
