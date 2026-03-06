import cron from 'node-cron';
import logger from '../utils/logger.js';

/**
 * Start the poll scheduler
 * Checks every minute for polls that need to end
 * Supports multi-bot system - runs checks for all bots
 */
export function startPollScheduler(pollsManager) {
  // Run every minute
  const task = cron.schedule('* * * * *', async () => {
    // Check for default bot
    const defaultClient = global.botManager?.getDefaultClient();
    if (defaultClient && defaultClient.pollsManager) {
      try {
        await defaultClient.pollsManager.checkExpiredPolls(defaultClient);
      } catch (error) {
        logger.error('[PollScheduler] Error in scheduled poll check (default bot)', {
          error: error.message,
          stack: error.stack
        });
      }
    }

    // Check for all custom bots
    if (global.botManager?.clients) {
      for (const [botId, botClient] of global.botManager.clients.entries()) {
        if (botId === 'default') continue;

        if (botClient.pollsManager) {
          try {
            await botClient.pollsManager.checkExpiredPolls(botClient);
          } catch (error) {
            logger.error(`[PollScheduler] Error in scheduled poll check (bot ${botId})`, {
              error: error.message,
              stack: error.stack,
              botId
            });
          }
        }
      }
    }
  });

  logger.info('[PollScheduler] Poll scheduler started (runs every minute, multi-bot support enabled)');

  return task;
}

export default startPollScheduler;
