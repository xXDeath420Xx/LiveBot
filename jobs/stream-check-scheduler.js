import cron from 'node-cron';
import logger from '../utils/logger.js';
import { checkStreamers, performCycleSetup } from '../core/stream-manager.js';
import platformCache from '../utils/platformCache.js';

let schedulerTask = null;
let cycleRunning = false;

// Cycle counter — tracks cron cycles (not individual bot calls)
let cycleCount = 0;
const EMBED_UPDATE_INTERVAL = 5;    // Update embeds every 5th cycle (5 minutes)
const STALE_CLEANUP_INTERVAL = 3;   // Run stale cleanup every 3rd cycle (3 minutes)
const UNTRACKED_CLEANUP_INTERVAL = 30; // Run untracked cleanup every 30th cycle (30 minutes)
const ORPHAN_CLEANUP_INTERVAL = 10;    // Run orphaned announcement cleanup every 10th cycle (10 minutes)

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
        if (cycleRunning) {
            logger.warn('[Stream Check Scheduler] Previous cycle still running, skipping this tick', { category: 'streams' });
            return;
        }
        cycleRunning = true;
        try {
            logger.info('[Stream Check Scheduler] Running scheduled stream check', { category: 'streams' });

            // Increment cycle counter (tracks cron invocations, not bot calls)
            cycleCount++;

            // Compute per-cycle flags ONCE
            const isFirstPass = cycleCount === 1; // Only on first cycle after startup
            const shouldUpdateEmbeds = cycleCount % EMBED_UPDATE_INTERVAL === 0;
            const shouldRunStaleCleanup = cycleCount % STALE_CLEANUP_INTERVAL === 0;
            const shouldRunUntrackedCleanup = cycleCount % UNTRACKED_CLEANUP_INTERVAL === 0;
            const shouldRunOrphanCleanup = cycleCount % ORPHAN_CLEANUP_INTERVAL === 0;

            const cycleOptions = {
                isFirstPass,
                shouldUpdateEmbeds,
                shouldRunStaleCleanup,
                shouldRunUntrackedCleanup,
                shouldRunOrphanCleanup,
                currentPass: cycleCount
            };

            logger.info(`[Stream Check Scheduler] Cycle #${cycleCount}: embeds=${shouldUpdateEmbeds}, stale=${shouldRunStaleCleanup}, untracked=${shouldRunUntrackedCleanup}, orphan=${shouldRunOrphanCleanup}`, { category: 'streams' });

            // Run setup tasks ONCE per cycle (load DB, cleanups) using the default bot client
            await performCycleSetup(client, cycleOptions);

            // Check streams for default bot
            await checkStreamers(client, cycleOptions);

            // Also check for all custom bots if botManager is available
            if (global.botManager && global.botManager.clients) {
                for (const [botId, botClient] of global.botManager.clients.entries()) {
                    // Skip default bot (already checked above)
                    if (botId === 'default') continue;

                    logger.info(`[Stream Check Scheduler] Checking streams for custom bot ${botId}`, { category: 'streams' });
                    try {
                        await checkStreamers(botClient, cycleOptions);
                    } catch (error) {
                        logger.error(`[Stream Check Scheduler] Error checking custom bot ${botId}:`, { error, botId, category: 'streams' });
                    }
                }
            }
        } catch (error) {
            logger.error('[Stream Check Scheduler] Error during scheduled check:', { error, category: 'streams' });
        } finally {
            cycleRunning = false;
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
