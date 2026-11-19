import cron from 'node-cron';
import logger from '../utils/logger.js';
import ScheduledAnnouncementsManager from '../core/scheduled-announcements-manager.js';

let scheduledTask = null;
const announcementsManagers = new Map(); // Map of botId -> manager

/**
 * Start the announcement scheduler
 * Runs every minute to check for due announcements
 * Supports multi-bot system - creates managers for all bots
 * @param {Client} client - Discord client instance (default bot)
 */
export function startAnnouncementScheduler(client) {
  if (scheduledTask) {
    logger.warn('[AnnouncementScheduler] Scheduler is already running');
    return;
  }

  // Initialize manager for default bot
  announcementsManagers.set('default', new ScheduledAnnouncementsManager(client));

  // Initialize managers for all custom bots
  if (global.botManager?.clients) {
    for (const [botId, botClient] of global.botManager.clients.entries()) {
      if (botId === 'default') continue;
      announcementsManagers.set(botId, new ScheduledAnnouncementsManager(botClient));
    }
  }

  // Schedule to run every minute. One pass covers every bot: the manager sends each due row with
  // the client that serves its guild (core/scheduled-announcements-manager.js), so running a pass
  // per bot would only make them race for the same rows. Custom bots that load after this point
  // are covered the same way.
  scheduledTask = cron.schedule('* * * * *', async () => {
    try {
      await announcementsManagers.get('default').checkDueAnnouncements();
    } catch (error) {
      logger.error('[AnnouncementScheduler] Error in scheduled announcement check', {
        error: error.message,
        stack: error.stack
      });
    }
  });

  logger.info(`[AnnouncementScheduler] Announcement scheduler started for ${announcementsManagers.size} bots (runs every minute, multi-bot support enabled)`);
}

/**
 * Stop the announcement scheduler
 */
export function stopAnnouncementScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.info('[AnnouncementScheduler] Announcement scheduler stopped');
  }
}

/**
 * Get the announcements manager instance for a specific guild
 * @param {string} guildId - The guild ID to get the manager for
 * @returns {ScheduledAnnouncementsManager|null}
 */
export function getAnnouncementsManager(guildId) {
  // If no guild ID provided, return default manager (for backwards compatibility)
  if (!guildId) {
    return announcementsManagers.get('default');
  }

  // Check if guild has a custom bot assigned
  if (global.botManager) {
    const botId = global.botManager.guildBotMapping.get(guildId);
    if (botId) {
      const manager = announcementsManagers.get(botId);
      if (manager) {
        return manager;
      }
    }
  }

  // Fall back to default bot's manager
  return announcementsManagers.get('default');
}

export default {
  startAnnouncementScheduler,
  stopAnnouncementScheduler,
  getAnnouncementsManager
};
