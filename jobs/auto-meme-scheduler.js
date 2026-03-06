import cron from 'node-cron';
import logger from '../utils/logger.js';
import AutoMemeManager from '../core/auto-meme-manager.js';

let scheduledTask = null;
const managers = new Map(); // Map of botId -> manager

/**
 * Start the auto-meme scheduler
 * Posts memes based on per-guild configuration
 * @param {Client} client - Discord client instance (default bot)
 */
export function startAutoMemeScheduler(client) {
  // Initialize manager for default bot (if not already exists)
  if (!managers.has('default')) {
    managers.set('default', new AutoMemeManager(client));
  }

  // Initialize managers for all custom bots
  if (global.botManager?.clients) {
    for (const [botId, botClient] of global.botManager.clients.entries()) {
      if (botId === 'default') continue;
      if (!managers.has(botId)) {
        managers.set(botId, new AutoMemeManager(botClient));
        logger.info(`[AutoMemeScheduler] Added manager for custom bot ${botId}`);
      }
    }
  }

  // Only create the cron task once
  if (scheduledTask) {
    logger.info(`[AutoMemeScheduler] Scheduler already running, now managing ${managers.size} bot(s)`);
    return;
  }

  // Schedule meme posting every hour (checks which guilds are due)
  scheduledTask = cron.schedule('0 * * * *', async () => {
    logger.info('[AutoMemeScheduler] Running auto-meme check');

    // Process memes for all bots
    for (const [botId, manager] of managers.entries()) {
      try {
        await manager.postScheduledMemes();
      } catch (error) {
        logger.error(`[AutoMemeScheduler] Error posting memes (bot ${botId})`, {
          error: error.message,
          stack: error.stack,
          botId
        });
      }
    }

    logger.info('[AutoMemeScheduler] Completed auto-meme check');
  });

  logger.info('[AutoMemeScheduler] Scheduler started (runs every hour)');

  scheduledTask.start();
}

/**
 * Stop the auto-meme scheduler
 */
export function stopAutoMemeScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.info('[AutoMemeScheduler] Scheduler stopped');
  }
}

/**
 * Get manager instance for a specific bot
 */
export function getAutoMemeManager(botId = 'default') {
  return managers.get(botId);
}
