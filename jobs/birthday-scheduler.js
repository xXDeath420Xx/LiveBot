import cron from 'node-cron';
import logger from '../utils/logger.js';

/**
 * Birthday Scheduler
 * Runs daily at midnight to check for birthdays and send announcements
 */

let birthdayCheckTask = null;

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

  // Schedule birthday checks daily at midnight EST (America/New_York)
  birthdayCheckTask = cron.schedule('0 0 * * *', async () => {
    logger.info('[BirthdayScheduler] Running daily birthday check for all bots');

    // Check for default bot
    const defaultClient = global.botManager?.getDefaultClient();
    if (defaultClient) {
      try {
        await birthdayManager.checkBirthdays(defaultClient);
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

  // Run an initial check on startup (optional, you can remove this if you don't want it)
  // This ensures that if the bot starts after midnight, it still checks for birthdays
  setTimeout(async () => {
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
