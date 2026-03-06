import cron from 'node-cron';
import logger from '../utils/logger.js';
import FreeGamesManager from '../core/free-games-manager.js';

let scheduledCheckTask = null;
let scheduledNotifyTask = null;
const managers = new Map(); // Map of botId -> manager

// Staggered platform checking - one platform every 15 minutes
// This spreads load and allows faster detection of new games
const PLATFORMS = ['epic', 'steam', 'gog', 'prime'];
let currentPlatformIndex = 0;

/**
 * Start the free games scheduler
 * Uses staggered checking: one platform every 15 minutes
 * All platforms checked within 1 hour, but spread out for efficiency
 * @param {Client} client - Discord client instance (default bot)
 */
export function startFreeGamesScheduler(client) {
  // Initialize manager for default bot (if not already exists)
  if (!managers.has('default')) {
    managers.set('default', new FreeGamesManager(client));
  }

  // Initialize managers for all custom bots
  if (global.botManager?.clients) {
    for (const [botId, botClient] of global.botManager.clients.entries()) {
      if (botId === 'default') continue;
      if (!managers.has(botId)) {
        managers.set(botId, new FreeGamesManager(botClient));
        logger.info(`[FreeGamesScheduler] Added manager for custom bot ${botId}`);
      }
    }
  }

  // Only create the cron tasks once
  if (scheduledCheckTask && scheduledNotifyTask) {
    logger.info(`[FreeGamesScheduler] Scheduler already running, now managing ${managers.size} bot(s)`);
    return;
  }

  // Staggered platform check - every 15 minutes, check ONE platform
  // This means all 4 platforms are checked within 1 hour, but spread out
  if (!scheduledCheckTask) {
    scheduledCheckTask = cron.schedule('*/15 * * * *', async () => {
      const platform = PLATFORMS[currentPlatformIndex];
      currentPlatformIndex = (currentPlatformIndex + 1) % PLATFORMS.length;

      logger.info(`[FreeGamesScheduler] Checking ${platform} for new games (staggered check ${currentPlatformIndex}/${PLATFORMS.length})`);

      const manager = managers.get('default');
      if (manager) {
        try {
          // Check single platform - fast and lightweight
          await manager.checkSinglePlatform(platform);
        } catch (error) {
          logger.error(`[FreeGamesScheduler] Error checking ${platform}`, {
            error: error.message
          });
        }
      }
    });

    logger.info('[FreeGamesScheduler] Staggered game checking started (one platform every 15 minutes)');
  }

  // Send notifications every 15 minutes (after platform check)
  if (!scheduledNotifyTask) {
    // Offset by 1 minute to run after platform check completes
    scheduledNotifyTask = cron.schedule('1,16,31,46 * * * *', async () => {
      logger.debug('[FreeGamesScheduler] Checking for notifications to send');

      const manager = managers.get('default');
      if (manager) {
        try {
          await manager.sendNotifications();
        } catch (error) {
          logger.error('[FreeGamesScheduler] Error sending notifications', {
            error: error.message
          });
        }
      }
    });

    logger.info('[FreeGamesScheduler] Notification scheduler started (runs every 15 minutes)');
  }

  // Run initial full check after 30 seconds (all platforms)
  setTimeout(async () => {
    logger.info('[FreeGamesScheduler] Running initial free games check (all platforms)');
    const manager = managers.get('default');
    if (manager) {
      try {
        await manager.checkForNewGames();
        await manager.sendNotifications();
      } catch (error) {
        logger.error('[FreeGamesScheduler] Error in initial check', {
          error: error.message
        });
      }
    }
  }, 30000);
}

/**
 * Stop the free games scheduler
 */
export function stopFreeGamesScheduler() {
  if (scheduledCheckTask) {
    scheduledCheckTask.stop();
    scheduledCheckTask = null;
  }

  if (scheduledNotifyTask) {
    scheduledNotifyTask.stop();
    scheduledNotifyTask = null;
  }

  logger.info('[FreeGamesScheduler] Free games scheduler stopped');
}

/**
 * Get the free games manager for a specific guild
 * @param {string} guildId - The guild ID
 * @returns {FreeGamesManager|null}
 */
export function getFreeGamesManager(guildId) {
  if (!guildId) {
    return managers.get('default');
  }

  // Check if guild has a custom bot assigned
  if (global.botManager) {
    const botId = global.botManager.guildBotMapping.get(guildId);
    if (botId) {
      const manager = managers.get(botId);
      if (manager) {
        return manager;
      }
    }
  }

  // Fall back to default bot's manager
  return managers.get('default');
}

/**
 * Manually trigger a check for new games
 * @returns {Promise<void>}
 */
export async function triggerManualCheck() {
  logger.info('[FreeGamesScheduler] Manual check triggered');
  const manager = managers.get('default');
  if (manager) {
    await manager.checkForNewGames();
    await manager.sendNotifications();
  }
}

export default {
  startFreeGamesScheduler,
  stopFreeGamesScheduler,
  getFreeGamesManager,
  triggerManualCheck
};
