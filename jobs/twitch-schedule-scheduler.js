import cron from 'node-cron';
import logger from '../utils/logger.js';
import TwitchScheduleManager from '../core/twitch-schedule-manager.js';

let scheduledTask = null;
const scheduleManagers = new Map(); // Map of botId -> manager

/**
 * Start the Twitch schedule sync scheduler
 * Runs every 6 hours to sync Twitch schedules to Discord
 * Supports multi-bot system - creates managers for all bots
 * @param {Client} client - Discord client instance (default bot)
 */
export function startTwitchScheduleScheduler(client) {
  // Initialize manager for default bot (if not already exists)
  if (!scheduleManagers.has('default')) {
    scheduleManagers.set('default', new TwitchScheduleManager(client));
  }

  // Initialize managers for all custom bots
  if (global.botManager?.clients) {
    for (const [botId, botClient] of global.botManager.clients.entries()) {
      if (botId === 'default') continue;
      if (!scheduleManagers.has(botId)) {
        scheduleManagers.set(botId, new TwitchScheduleManager(botClient));
        logger.info(`[TwitchScheduleScheduler] Added schedule manager for custom bot ${botId}`);
      }
    }
  }

  // Only create the cron task once
  if (scheduledTask) {
    logger.info(`[TwitchScheduleScheduler] Scheduler already running, now managing ${scheduleManagers.size} bot(s)`);
    return;
  }

  // Schedule to run every 6 hours (at :00 of every 6th hour)
  scheduledTask = cron.schedule('0 */6 * * *', async () => {
    logger.info('[TwitchScheduleScheduler] Running Twitch schedule sync check');

    // Process schedules for all bots
    for (const [botId, manager] of scheduleManagers.entries()) {
      try {
        await manager.processAllSyncs();
      } catch (error) {
        logger.error(`[TwitchScheduleScheduler] Error in schedule sync (bot ${botId})`, {
          error: error.message,
          stack: error.stack,
          botId
        });
      }
    }

    logger.info('[TwitchScheduleScheduler] Completed Twitch schedule sync check');
  });

  logger.info(`[TwitchScheduleScheduler] Twitch schedule scheduler started for ${scheduleManagers.size} bot(s) (runs every 6 hours, multi-bot support enabled)`);

  // Run immediately on startup (after a 10 second delay to let bot fully initialize)
  setTimeout(async () => {
    logger.info('[TwitchScheduleScheduler] Running initial Twitch schedule sync');
    for (const [botId, manager] of scheduleManagers.entries()) {
      try {
        await manager.processAllSyncs();
      } catch (error) {
        logger.error(`[TwitchScheduleScheduler] Error in initial schedule sync (bot ${botId})`, {
          error: error.message,
          botId
        });
      }
    }
  }, 10000);
}

/**
 * Stop the Twitch schedule scheduler
 */
export function stopTwitchScheduleScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.info('[TwitchScheduleScheduler] Twitch schedule scheduler stopped');
  }
}

/**
 * Get the schedule manager for a specific guild
 * @param {string} guildId - The guild ID
 * @returns {TwitchScheduleManager|null}
 */
export function getTwitchScheduleManager(guildId) {
  if (!guildId) {
    return scheduleManagers.get('default');
  }

  // Check if guild has a custom bot assigned
  if (global.botManager) {
    const botId = global.botManager.guildBotMapping.get(guildId);
    if (botId) {
      const manager = scheduleManagers.get(botId);
      if (manager) {
        return manager;
      }
    }
  }

  // Fall back to default bot's manager
  return scheduleManagers.get('default');
}

export default {
  startTwitchScheduleScheduler,
  stopTwitchScheduleScheduler,
  getTwitchScheduleManager
};
