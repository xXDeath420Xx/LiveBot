import cron from 'node-cron';
import SteamWatcherManager from '../core/steam-watcher-manager.js';
import logger from '../utils/logger.js';

let scheduledTask = null;
const managers = new Map(); // Map of botId -> SteamWatcherManager
let isInitialized = false;

/**
 * Start the Steam Watch scheduler
 * Checks watchers every 5 minutes (fast polling for active games)
 * @param {Client} client - Discord client instance
 */
export function startSteamWatchScheduler(client) {
  // Prevent duplicate initialization - only initialize once
  if (isInitialized) {
    logger.debug('[SteamWatch] Scheduler already initialized, skipping duplicate call');
    return;
  }

  logger.info('[SteamWatch] Initializing Steam Watch scheduler...');
  isInitialized = true;

  // Initialize manager for default bot
  managers.set('default', new SteamWatcherManager(client));

  // Initialize managers for custom bots
  if (global.botManager && global.botManager.clients) {
    for (const [botId, botClient] of global.botManager.clients.entries()) {
      managers.set(botId, new SteamWatcherManager(botClient));
      logger.info(`[SteamWatch] Initialized manager for bot ${botId}`);
    }
  }

  // Schedule watcher checks every 5 minutes
  scheduledTask = cron.schedule('*/5 * * * *', async () => {
    try {
      logger.debug('[SteamWatch] Running scheduled watcher check...');

      // Use default bot's manager (watchers are shared across bots via database)
      const manager = managers.get('default');
      await manager.checkWatchers();

      logger.debug('[SteamWatch] Scheduled check complete');
    } catch (error) {
      logger.error('[SteamWatch] Error in scheduled check', {
        error: error.message,
        stack: error.stack
      });
    }
  });

  scheduledTask.start();
  logger.info('[SteamWatch] Scheduler started - checking every 5 minutes');

  // Run initial check after 30 seconds
  setTimeout(async () => {
    try {
      logger.info('[SteamWatch] Running initial watcher check...');
      const manager = managers.get('default');
      await manager.checkWatchers();
      logger.info('[SteamWatch] Initial check complete');
    } catch (error) {
      logger.error('[SteamWatch] Error in initial check', {
        error: error.message
      });
    }
  }, 30000);
}

/**
 * Stop the Steam Watch scheduler
 */
export function stopSteamWatchScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    logger.info('[SteamWatch] Scheduler stopped');
  }
  managers.clear();
  isInitialized = false;
}

/**
 * Trigger a manual check of all watchers
 */
export async function triggerManualSteamWatchCheck() {
  logger.info('[SteamWatch] Manual check triggered');
  const manager = managers.get('default');
  if (manager) {
    await manager.checkWatchers();
  } else {
    throw new Error('Steam Watch manager not initialized');
  }
}

/**
 * Get Steam Watch manager instance
 * @returns {SteamWatcherManager}
 */
export function getSteamWatchManager() {
  return managers.get('default');
}
