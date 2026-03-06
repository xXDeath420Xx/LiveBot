import cron from 'node-cron';
import logger from '../utils/logger.js';

/**
 * Start the giveaway scheduler
 * Checks every 15 seconds for giveaways that need to end
 * Supports multi-bot system - runs checks for all bots
 */
export function startGiveawayScheduler(giveawayManager) {
  // Run every 15 seconds using setInterval
  const interval = setInterval(async () => {
    // Check for default bot
    const defaultClient = global.botManager?.getDefaultClient();
    if (defaultClient && defaultClient.giveawayManager) {
      try {
        await defaultClient.giveawayManager.checkGiveaways(defaultClient);
      } catch (error) {
        logger.error('[GiveawayScheduler] Error in scheduled giveaway check (default bot)', {
          error: error.message,
          stack: error.stack
        });
      }
    }

    // Check for all custom bots
    if (global.botManager?.clients) {
      for (const [botId, botClient] of global.botManager.clients.entries()) {
        if (botId === 'default') continue;

        if (botClient.giveawayManager) {
          try {
            await botClient.giveawayManager.checkGiveaways(botClient);
          } catch (error) {
            logger.error(`[GiveawayScheduler] Error in scheduled giveaway check (bot ${botId})`, {
              error: error.message,
              stack: error.stack,
              botId
            });
          }
        }
      }
    }
  }, 15 * 1000); // Check every 15 seconds

  logger.info('[GiveawayScheduler] Giveaway scheduler started (runs every 15 seconds, multi-bot support enabled)');

  return interval;
}

export default startGiveawayScheduler;
