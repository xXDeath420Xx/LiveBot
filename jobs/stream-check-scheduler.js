import cron from 'node-cron';
import logger from '../utils/logger.js';
import { checkStreamers } from '../core/stream-manager.js';

let schedulerTask = null;

/**
 * Start the stream check scheduler
 * Runs every 60 seconds to check if streamers are live
 * NOTE: This scheduler runs ONCE but checks ALL bots via botManager
 */
export function startStreamCheckScheduler(client) {
    if (schedulerTask) {
        logger.warn('[Stream Check Scheduler] Scheduler is already running', { category: 'streams' });
        return;
    }

    // Run every minute (every 60 seconds)
    schedulerTask = cron.schedule('* * * * *', async () => {
        logger.info('[Stream Check Scheduler] Running scheduled stream check', { category: 'streams' });
        try {
            // Check streams for default bot
            await checkStreamers(client);

            // Also check for all custom bots if botManager is available
            if (global.botManager && global.botManager.clients) {
                for (const [botId, botClient] of global.botManager.clients.entries()) {
                    // Skip default bot (already checked above)
                    if (botId === 'default') continue;

                    logger.info(`[Stream Check Scheduler] Checking streams for custom bot ${botId}`, { category: 'streams' });
                    try {
                        await checkStreamers(botClient);
                    } catch (error) {
                        logger.error(`[Stream Check Scheduler] Error checking custom bot ${botId}:`, { error, botId, category: 'streams' });
                    }
                }
            }
        } catch (error) {
            logger.error('[Stream Check Scheduler] Error during scheduled check:', { error, category: 'streams' });
        }
    });

    logger.info('[Stream Check Scheduler] Scheduler started (every 60 seconds)', { category: 'streams' });
}

/**
 * Stop the stream check scheduler
 */
export function stopStreamCheckScheduler() {
    if (schedulerTask) {
        schedulerTask.stop();
        schedulerTask = null;
        logger.info('[Stream Check Scheduler] Scheduler stopped', { category: 'streams' });
    } else {
        logger.warn('[Stream Check Scheduler] No scheduler running to stop', { category: 'streams' });
    }
}
