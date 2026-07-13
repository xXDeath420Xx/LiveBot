import cron from 'node-cron';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';

/**
 * Birthday Scheduler
 * Runs daily at midnight to check for birthdays and send announcements
 */

let birthdayCheckTask = null;

/**
 * Remove birthday roles from members whose birthday was yesterday or earlier.
 * Runs hourly and on startup to catch roles that survived bot restarts.
 */
async function cleanupExpiredBirthdayRoles() {
  try {
    // Find all guilds with birthday roles configured
    const [configs] = await pool.execute(
      'SELECT guild_id, birthday_role_id FROM birthday_config WHERE birthday_role_id IS NOT NULL AND enabled = 1'
    );
    if (configs.length === 0) return;

    for (const config of configs) {
      // Find members who were announced but their birthday is NOT today
      const [expired] = await pool.execute(
        `SELECT ub.user_id FROM user_birthdays ub
         WHERE ub.guild_id = ? AND ub.last_announced IS NOT NULL
         AND ub.last_announced < CURDATE()`,
        [config.guild_id]
      );
      if (expired.length === 0) continue;

      const botClient = global.botManager?.getClientForGuild(config.guild_id) || global.botManager?.getDefaultClient();
      if (!botClient) continue;

      const guild = botClient.guilds.cache.get(config.guild_id);
      if (!guild) continue;

      const role = guild.roles.cache.get(config.birthday_role_id);
      if (!role) continue;

      for (const row of expired) {
        try {
          const member = await guild.members.fetch(row.user_id).catch(() => null);
          if (member && member.roles.cache.has(role.id)) {
            await member.roles.remove(role, 'Birthday ended');
            logger.info(`[BirthdayScheduler] Removed expired birthday role from ${member.user.username} in ${guild.name}`);
          }
        } catch { /* member left or role hierarchy issue */ }
      }
    }
  } catch (err) {
    logger.error('[BirthdayScheduler] Error cleaning up birthday roles:', { error: err.message });
  }
}

/**
 * Start the birthday check scheduler
 * Supports multi-bot system - runs checks for both default and custom bots
 */
export function startBirthdayScheduler(birthdayManager) {
  if (!birthdayManager) {
    logger.warn('[BirthdayScheduler] Birthday manager not provided, scheduler not started');
    return;
  }

  if (birthdayCheckTask) {
    logger.warn('[BirthdayScheduler] Birthday scheduler already running');
    return;
  }

  // Clean up expired birthday roles — runs every hour
  cron.schedule('0 * * * *', async () => {
    await cleanupExpiredBirthdayRoles();
  });

  // Schedule birthday checks daily at midnight EST (America/New_York)
  birthdayCheckTask = cron.schedule('0 0 * * *', async () => {
    logger.info('[BirthdayScheduler] Running daily birthday check for all bots');

    // Check for default bot
    const defaultClient = global.botManager?.getDefaultClient();
    if (defaultClient) {
      try {
        await birthdayManager.checkBirthdays(defaultClient);
        await birthdayManager.createUpcomingCards(defaultClient);
      } catch (error) {
        logger.error('[BirthdayScheduler] Error during birthday check (default bot)', {
          error: error.message,
          stack: error.stack
        });
      }
    }

    // Check for all custom bots
    if (global.botManager?.clients) {
      for (const [botId, botClient] of global.botManager.clients.entries()) {
        if (botId === 'default') continue;

        try {
          logger.info(`[BirthdayScheduler] Checking birthdays for custom bot ${botId}`);
          await birthdayManager.checkBirthdays(botClient);
          await birthdayManager.createUpcomingCards(botClient);
        } catch (error) {
          logger.error(`[BirthdayScheduler] Error during birthday check (bot ${botId})`, {
            error: error.message,
            stack: error.stack,
            botId
          });
        }
      }
    }
  }, {
    timezone: 'America/New_York'
  });

  logger.info('[BirthdayScheduler] Birthday scheduler started (runs daily at 00:00 EST, multi-bot support enabled)');

  // Run an initial check on startup
  setTimeout(async () => {
    // Clean up any expired birthday roles first (survives restarts)
    await cleanupExpiredBirthdayRoles();

    logger.info('[BirthdayScheduler] Running initial birthday check for all bots');

    const defaultClient = global.botManager?.getDefaultClient();
    if (defaultClient) {
      try {
        await birthdayManager.checkBirthdays(defaultClient);
      } catch (error) {
        logger.error('[BirthdayScheduler] Error during initial birthday check (default bot)', {
          error: error.message,
          stack: error.stack
        });
      }
    }

    if (global.botManager?.clients) {
      for (const [botId, botClient] of global.botManager.clients.entries()) {
        if (botId === 'default') continue;
        try {
          await birthdayManager.checkBirthdays(botClient);
        } catch (error) {
          logger.error(`[BirthdayScheduler] Error during initial birthday check (bot ${botId})`, {
            error: error.message,
            stack: error.stack,
            botId
          });
        }
      }
    }
    // Check for standalone cards with deliver_at that need delivery
    try {
      const [pendingDeliveries] = await pool.execute(
        'SELECT * FROM birthday_cards WHERE deliver_at IS NOT NULL AND deliver_at <= NOW() AND is_posted = 0'
      );
      for (const card of pendingDeliveries) {
        try {
          // Mark as delivered
          await pool.execute('UPDATE birthday_cards SET is_posted = 1 WHERE id = ?', [card.id]);

          // If guild-linked, post to the announcement channel
          if (card.guild_id) {
            const botClient = global.botManager?.getClientForGuild(card.guild_id) || global.botManager?.getDefaultClient();
            if (botClient) {
              const config = await pool.execute('SELECT announcement_channel_id FROM birthday_config WHERE guild_id = ?', [card.guild_id]).then(r => r[0][0]).catch(() => null);
              if (config?.announcement_channel_id) {
                const channel = await botClient.channels.fetch(config.announcement_channel_id).catch(() => null);
                if (channel) {
                  await birthdayManager.postBirthdayCard(card.user_id, card.guild_id, channel, botClient);
                }
              }
            }
          }

          // DM the creator if standalone
          if (!card.guild_id && card.creator_user_id) {
            const defaultClient = global.botManager?.getDefaultClient();
            if (defaultClient) {
              const baseUrl = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/$/, '');
              const user = await defaultClient.users.fetch(card.creator_user_id).catch(() => null);
              if (user) {
                const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
                const [sigCount] = await pool.execute('SELECT COUNT(*) as c FROM birthday_card_signatures WHERE card_id = ?', [card.id]);
                const embed = new EmbedBuilder()
                  .setTitle('📬 Your card has been delivered!')
                  .setDescription(`"${card.card_name}" now has **${sigCount[0].c}** signatures and is ready to share.`)
                  .setColor('#a78bfa')
                  .setTimestamp();
                const row = new ActionRowBuilder().addComponents(
                  new ButtonBuilder().setLabel('View Card').setURL(`${baseUrl}/card/${card.slug || card.share_token}/view`).setStyle(ButtonStyle.Link)
                );
                await user.send({ embeds: [embed], components: [row] }).catch(() => {});
              }
            }
          }

          logger.info(`[BirthdayScheduler] Delivered scheduled card ${card.id} (${card.card_name})`);
        } catch (e) {
          logger.error(`[BirthdayScheduler] Failed to deliver card ${card.id}: ${e.message}`);
        }
      }
      if (pendingDeliveries.length) logger.info(`[BirthdayScheduler] Delivered ${pendingDeliveries.length} scheduled card(s)`);
    } catch (e) {
      logger.error('[BirthdayScheduler] Error checking scheduled deliveries: ' + e.message);
    }

  }, 5000); // Wait 5 seconds after startup

  return birthdayCheckTask;
}

/**
 * Stop the birthday check scheduler
 */
export function stopBirthdayScheduler() {
  if (birthdayCheckTask) {
    birthdayCheckTask.stop();
    birthdayCheckTask = null;
    logger.info('[BirthdayScheduler] Birthday scheduler stopped');
  }
}

export default { startBirthdayScheduler, stopBirthdayScheduler };
