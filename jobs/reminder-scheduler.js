import logger from '../utils/logger.js';

/**
 * Initialize the reminder scheduler
 * This runs every 30 seconds to check for due reminders
 * Supports multi-bot system - starts schedulers for all bots
 */
export function initReminderScheduler(client) {
    logger.info('[Reminder Scheduler] Initializing reminder schedulers for all bots');

    // Start scheduler for default bot
    if (client && client.reminderManager) {
        client.reminderManager.startScheduler(30);
        logger.info('[Reminder Scheduler] Started for default bot');
    } else {
        logger.warn('[Reminder Scheduler] Reminder manager not available for default bot');
    }

    // Start schedulers for all custom bots
    if (global.botManager?.clients) {
        for (const [botId, botClient] of global.botManager.clients.entries()) {
            if (botId === 'default') continue;

            if (botClient.reminderManager) {
                botClient.reminderManager.startScheduler(30);
                logger.info(`[Reminder Scheduler] Started for custom bot ${botId}`);
            } else {
                logger.warn(`[Reminder Scheduler] Reminder manager not available for custom bot ${botId}`);
            }
        }
    }

    logger.info('[Reminder Scheduler] All reminder schedulers initialized (multi-bot support enabled)');
}

export default initReminderScheduler;
