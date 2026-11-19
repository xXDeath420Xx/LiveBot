import cron from 'node-cron';
import logger from '../utils/logger.js';
import { checkStreamers, performCycleSetup } from '../core/stream-manager.js';
import platformCache from '../utils/platformCache.js';

let schedulerTask = null;
let cycleRunning = false;

// Cycle counter — tracks cron cycles (not individual bot calls).
//
// These intervals are in CYCLES, not minutes. The cron fires every minute, but a cycle checks
// every bot's streamers (CHECK_CONCURRENCY bots at a time; one after another it took 6–16
// minutes), and ticks arriving mid-cycle are skipped without incrementing. So "every 5th cycle"
// is several times 5 minutes of uninterrupted uptime — and because this counter is module state, every restart
// sends it back to zero. Anything that must not wait that long has to bypass these flags
// (see styleMismatched() in core/stream-manager.js).
let cycleCount = 0;
// How many bots check their streamers at once (see the cycle body). 1 = the old one-after-another order.
const CHECK_CONCURRENCY = Math.max(1, Number(process.env.STREAM_CHECK_CONCURRENCY) || 4);
const EMBED_UPDATE_INTERVAL = 5;    // Refresh embeds every 5th completed cycle
const STALE_CLEANUP_INTERVAL = 3;   // Run stale cleanup every 3rd completed cycle
const UNTRACKED_CLEANUP_INTERVAL = 30; // Run untracked cleanup every 30th completed cycle
const ORPHAN_CLEANUP_INTERVAL = 10;    // Run orphaned announcement cleanup every 10th completed cycle

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
            // Expected: a cycle walks every bot's streamers and takes several minutes (see cycleCount above)
            logger.debug('[Stream Check Scheduler] Previous cycle still running, skipping this tick', { category: 'streams' });
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

            // The default bot, then every custom bot, CHECK_CONCURRENCY at a time. Each bot only handles its
            // own guilds (guild_bot_mapping), so two bots never touch the same announcement or role, and each
            // has its own Discord rate limits; platformCache shares in-flight API lookups for a streamer that
            // several bots track. One after another this took a median 10 minutes (885 streamer checks).
            const bots = [['default', client]];
            if (global.botManager && global.botManager.clients) {
                for (const [botId, botClient] of global.botManager.clients.entries()) {
                    if (botId !== 'default') bots.push([botId, botClient]);
                }
            }
            let next = 0;
            const worker = async () => {
                while (next < bots.length) {
                    const [botId, botClient] = bots[next++];
                    if (botId !== 'default') {
                        logger.info(`[Stream Check Scheduler] Checking streams for custom bot ${botId}`, { category: 'streams' });
                    }
                    try {
                        await checkStreamers(botClient, cycleOptions);
                    } catch (error) {
                        logger.error(`[Stream Check Scheduler] Error checking ${botId === 'default' ? 'the default bot' : `custom bot ${botId}`}:`, { error, botId, category: 'streams' });
                    }
                }
            };
            const started = Date.now();
            await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, bots.length) }, worker));
            logger.info(`[Stream Check Scheduler] Cycle #${cycleCount} checked ${bots.length} bots in ${Math.round((Date.now() - started) / 1000)}s`, { category: 'streams' });
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
