import cron from 'node-cron';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { BIRTHDAY_ROLE_HOURS } from '../core/birthday-helpers.js';

/**
 * Birthday Scheduler
 * Runs daily at midnight to check for birthdays and send announcements
 */

let birthdayCheckTask = null;

/**
 * Members whose birthday role is due back: given BIRTHDAY_ROLE_HOURS ago or more
 * (user_birthdays.birthday_role_given_at). Rows announced before that column existed have no time
 * and keep the old rule: due once the announcement date is over.
 */
export const EXPIRED_ROLE_SQL = `SELECT ub.user_id, ub.birthday_role_given_at FROM user_birthdays ub
   WHERE ub.guild_id = ?
     AND (ub.birthday_role_given_at <= NOW() - INTERVAL ${BIRTHDAY_ROLE_HOURS} HOUR
          OR (ub.birthday_role_given_at IS NULL AND ub.last_announced IS NOT NULL AND ub.last_announced < CURDATE()))`;

/**
 * Remove birthday roles that have been held for BIRTHDAY_ROLE_HOURS.
 * Runs every 15 minutes and on startup to catch roles that survived bot restarts.
 */
export async function cleanupExpiredBirthdayRoles() {
  try {
    // Find all guilds with birthday roles configured
    const [configs] = await pool.execute(
      // Every server with a birthday role, enabled or not: turning birthdays off on the day must still take the
      // role back from whoever got it that day (H-678).
      'SELECT guild_id, birthday_role_id FROM birthday_config WHERE birthday_role_id IS NOT NULL'
    );
    if (configs.length === 0) return;

    for (const config of configs) {
      const [expired] = await pool.execute(EXPIRED_ROLE_SQL, [config.guild_id]);
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
          // Taken back (or nothing to take): stop checking this row until the next birthday.
          if (row.birthday_role_given_at) {
            await pool.execute(
              'UPDATE user_birthdays SET birthday_role_given_at = NULL WHERE guild_id = ? AND user_id = ?',
              [config.guild_id, row.user_id]
            );
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

  // Take back birthday roles held for 24 hours, and deliver cards whose delivery date has passed
  cron.schedule('*/15 * * * *', async () => {
    await cleanupExpiredBirthdayRoles();
    await deliverScheduledCards().catch(err => logger.error('[BirthdayScheduler] Scheduled card delivery failed: ' + err.message));
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
    // Cards whose delivery date has passed (the 15-minute job above checks too).
    await deliverScheduledCards().catch(err => logger.error('[BirthdayScheduler] Scheduled card delivery failed: ' + err.message));

  }, 5000); // Wait 5 seconds after startup

  return birthdayCheckTask;
}

/**
 * Cards made on the website with a delivery date (cards-create "Delivery date") that has passed.
 * A card connected to a Discord server is posted in its signing channel (else the server's birthday
 * announcement or card channel), mentioning the recipient when one was picked. A card that is not
 * connected is sent to its creator as a DM, when they were logged in when they made it. Each card is
 * claimed (is_posted = 1) before it is sent, so two runs never send it twice and a failed send is not
 * retried forever.
 *
 * Before 2026-11-19 this ran only at startup, and a connected card was marked delivered before
 * birthdayManager.postBirthdayCard looked for an undelivered card, so it was never posted.
 *
 * @returns {Promise<number>} cards sent
 */
export async function deliverScheduledCards({ db = pool, botManager = global.botManager, log = logger, baseUrl = process.env.DASHBOARD_URL } = {}) {
  const base = String(baseUrl || 'https://certifriedmultitool.com').replace(/\/$/, '');
  const [cards] = await db.execute(
    'SELECT * FROM birthday_cards WHERE deliver_at IS NOT NULL AND deliver_at <= NOW() AND is_posted = 0'
  );
  if (!cards.length) return 0;
  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
  let sent = 0;
  for (const card of cards) {
    const [claim] = await db.execute('UPDATE birthday_cards SET is_posted = 1 WHERE id = ? AND is_posted = 0', [card.id]);
    if (!claim?.affectedRows) continue;
    try {
      const [[sig]] = await db.execute('SELECT COUNT(*) AS c FROM birthday_card_signatures WHERE card_id = ?', [card.id]);
      const signed = Number(sig?.c) || 0;
      const title = String(card.card_name || `A card for ${card.recipient_name || 'you'}`).slice(0, 256);
      const url = `${base}/card/${encodeURIComponent(card.slug || card.share_token)}`;
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Open the card').setURL(url).setStyle(ButtonStyle.Link)
      );
      const signedLine = `${signed} ${signed === 1 ? 'person' : 'people'} signed it.`;

      if (card.guild_id) {
        const client = botManager?.getClientForGuild?.(card.guild_id) || botManager?.getDefaultClient?.();
        const [[cfg]] = await db.execute(
          'SELECT announcement_channel_id, card_channel_id FROM birthday_config WHERE guild_id = ?', [card.guild_id]
        );
        const channelId = card.signing_channel_id || cfg?.announcement_channel_id || cfg?.card_channel_id || null;
        const channel = client && channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
        if (!channel) {
          log.warn(`[BirthdayScheduler] Scheduled card ${card.id}: no channel to post it in (guild ${card.guild_id})`);
          continue;
        }
        const embed = new EmbedBuilder().setTitle(title).setDescription(signedLine).setColor(0xa78bfa).setTimestamp();
        const mention = card.user_id ? String(card.user_id) : null;
        await channel.send({
          content: mention ? `<@${mention}>` : undefined,
          embeds: [embed],
          components: [row],
          allowedMentions: { users: mention ? [mention] : [] }
        });
      } else if (card.creator_user_id) {
        const client = botManager?.getDefaultClient?.();
        const user = client ? await client.users.fetch(String(card.creator_user_id)).catch(() => null) : null;
        if (!user) {
          log.warn(`[BirthdayScheduler] Scheduled card ${card.id}: could not reach its creator`);
          continue;
        }
        const embed = new EmbedBuilder()
          .setTitle('Your card is ready to send')
          .setDescription(`"${title}": ${signedLine} Send the link to ${card.recipient_name || 'them'}.`)
          .setColor(0xa78bfa)
          .setTimestamp();
        const dm = await user.send({ embeds: [embed], components: [row] }).catch(() => null);
        if (!dm) {
          log.warn(`[BirthdayScheduler] Scheduled card ${card.id}: the creator's DMs are closed`);
          continue;
        }
      } else {
        // Made while logged out and never connected to a server: nobody to send it to.
        continue;
      }
      sent++;
      log.info(`[BirthdayScheduler] Delivered scheduled card ${card.id}`);
    } catch (err) {
      log.error(`[BirthdayScheduler] Failed to deliver card ${card.id}: ${err.message}`);
    }
  }
  return sent;
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
