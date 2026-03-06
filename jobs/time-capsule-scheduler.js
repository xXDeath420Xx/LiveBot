import cron from 'node-cron';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { EmbedBuilder } from 'discord.js';

let scheduledTask = null;

/**
 * Start the time capsule scheduler
 * Checks for time capsules that should be revealed and notifies users
 * @param {Client} client - Discord client instance
 */
export function startTimeCapsuleScheduler(client) {
  if (scheduledTask) {
    logger.info('[TimeCapsuleScheduler] Scheduler already running');
    return;
  }

  // Run every hour to check for time capsules ready to be revealed
  scheduledTask = cron.schedule('0 * * * *', async () => {
    logger.info('[TimeCapsuleScheduler] Checking for time capsules to reveal');

    try {
      // Get all time capsules that are ready to be revealed
      const [capsules] = await pool.execute(
        `SELECT * FROM time_capsules
         WHERE reveal_date <= NOW() AND revealed = 0`
      );

      if (capsules.length === 0) {
        logger.debug('[TimeCapsuleScheduler] No time capsules ready to reveal');
        return;
      }

      logger.info(`[TimeCapsuleScheduler] Found ${capsules.length} time capsule(s) to reveal`);

      for (const capsule of capsules) {
        try {
          const guild = client.guilds.cache.get(capsule.guild_id);
          if (!guild) {
            logger.warn(`[TimeCapsuleScheduler] Guild ${capsule.guild_id} not found`);
            continue;
          }

          const channel = guild.channels.cache.get(capsule.channel_id);
          if (!channel) {
            logger.warn(`[TimeCapsuleScheduler] Channel ${capsule.channel_id} not found`);
            continue;
          }

          const user = await client.users.fetch(capsule.user_id).catch(() => null);

          const embed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('⏰ Time Capsule Revealed!')
            .setDescription(capsule.message_content)
            .addFields([
              { name: 'Created by', value: user ? `<@${user.id}>` : 'Unknown User', inline: true },
              { name: 'Created on', value: `<t:${Math.floor(new Date(capsule.created_at).getTime() / 1000)}:D>`, inline: true }
            ])
            .setTimestamp();

          await channel.send({ embeds: [embed] });

          // Mark as revealed
          await pool.execute(
            'UPDATE time_capsules SET revealed = 1 WHERE id = ?',
            [capsule.id]
          );

          logger.info(`[TimeCapsuleScheduler] Revealed time capsule ${capsule.id} in guild ${capsule.guild_id}`);
        } catch (error) {
          logger.error(`[TimeCapsuleScheduler] Error revealing time capsule ${capsule.id}`, {
            error: error.message,
            stack: error.stack
          });
        }
      }

      logger.info('[TimeCapsuleScheduler] Completed time capsule check');
    } catch (error) {
      logger.error('[TimeCapsuleScheduler] Error checking time capsules', {
        error: error.message,
        stack: error.stack
      });
    }
  });

  logger.info('[TimeCapsuleScheduler] Scheduler started (runs hourly)');
  scheduledTask.start();
}

/**
 * Stop the time capsule scheduler
 */
export function stopTimeCapsuleScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.info('[TimeCapsuleScheduler] Scheduler stopped');
  }
}
