import cron from 'node-cron';
import logger from '../utils/logger.js';
import { checkTeams } from '../core/stream-checker.js';

let schedulerTask = null;
let isSyncing = false;

/**
 * Sync all teams across all bots (default + custom)
 * Can be called manually or by the scheduler
 * @returns {Promise<{success: boolean, message: string, results: Array}>}
 */
export async function syncAllTeams() {
    if (isSyncing) {
        logger.warn('[Team Sync] Sync already in progress, skipping', { category: 'team-sync' });
        return { success: false, message: 'Team sync already in progress', results: [] };
    }

    isSyncing = true;
    const results = [];
    const startTime = Date.now();

    try {
        logger.info('[Team Sync] Starting global team sync across all bots', { category: 'team-sync' });

        // Collect all unique bots
        const botsToSync = new Map();

        // Add default bot
        const defaultClient = global.botManager?.getDefaultClient();
        if (defaultClient) {
            botsToSync.set('default', defaultClient);
        }

        // Add all custom bots
        if (global.botManager?.clients) {
            for (const [botId, botClient] of global.botManager.clients.entries()) {
                if (botId !== 'default' && !botsToSync.has(botId)) {
                    botsToSync.set(botId, botClient);
                }
            }
        }

        logger.info(`[Team Sync] Syncing teams for ${botsToSync.size} bot(s)`, { category: 'team-sync' });

        // Sync each bot
        for (const [botId, botClient] of botsToSync.entries()) {
            try {
                logger.info(`[Team Sync] Starting sync for bot ${botId}`, { category: 'team-sync' });
                await checkTeams(botClient);
                results.push({ botId, success: true });
                logger.info(`[Team Sync] Completed sync for bot ${botId}`, { category: 'team-sync' });
            } catch (error) {
                logger.error(`[Team Sync] Error syncing bot ${botId}:`, { error: error.message, category: 'team-sync' });
                results.push({ botId, success: false, error: error.message });
            }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        const successCount = results.filter(r => r.success).length;
        logger.info(`[Team Sync] Global sync complete: ${successCount}/${botsToSync.size} bots synced in ${duration}s`, { category: 'team-sync' });

        return {
            success: true,
            message: `Synced ${successCount}/${botsToSync.size} bots in ${duration}s`,
            results
        };
    } catch (error) {
        logger.error('[Team Sync] Critical error during global sync:', { error: error.message, category: 'team-sync' });
        return { success: false, message: error.message, results };
    } finally {
        isSyncing = false;
    }
}

/**
 * Start the team sync scheduler
 * Runs every hour to sync Twitch team members
 * Supports multi-bot system - syncs teams for all bots
 */
export function startTeamSyncScheduler(client) {
    if (schedulerTask) {
        logger.warn('[Team Sync Scheduler] Scheduler is already running', { category: 'team-sync' });
        return;
    }

    // Run every hour (at minute 0)
    schedulerTask = cron.schedule('0 * * * *', async () => {
        logger.info('[Team Sync Scheduler] Running scheduled team sync for all bots', { category: 'team-sync' });
        await syncAllTeams();
    });

    logger.info('[Team Sync Scheduler] Scheduler started (every hour at :00, multi-bot support enabled)', { category: 'team-sync' });

    // Run initial sync after 2 minutes to let all bots initialize
    setTimeout(async () => {
        logger.info('[Team Sync Scheduler] Running initial team sync', { category: 'team-sync' });
        await syncAllTeams();
    }, 120000);
}

/**
 * Stop the team sync scheduler
 */
export function stopTeamSyncScheduler() {
    if (schedulerTask) {
        schedulerTask.stop();
        schedulerTask = null;
        logger.info('[Team Sync Scheduler] Scheduler stopped', { category: 'team-sync' });
    } else {
        logger.warn('[Team Sync Scheduler] No scheduler running to stop', { category: 'team-sync' });
    }
}
