import cron from 'node-cron';
import logger from '../utils/logger.js';

let scheduledTask = null;
let clockTask = null;
let initialUpdateScheduled = false;

/**
 * Yield every loaded bot client (main + custom) by reading global.botManager
 * fresh on each invocation. This avoids the init-order dependency that
 * previously broke clocks when one custom bot hung during command deployment
 * and blocked Promise.allSettled — leaving the explicit `clients` Set with
 * only the main bot. Same pattern used by stream-check-scheduler.
 */
function* iterateAllBotClients() {
    if (!global.botManager || !global.botManager.clients) return;
    for (const [, botClient] of global.botManager.clients.entries()) {
        yield botClient;
    }
}

/**
 * Start the stat display scheduler. Idempotent — only the first call wires
 * up the cron jobs; subsequent calls (from the custom-bot init loop) are
 * no-ops because the cron handlers discover bot clients dynamically.
 *
 * The `client` parameter is accepted for backwards compatibility but is no
 * longer used to populate a clients Set.
 */
// eslint-disable-next-line no-unused-vars
export function startStatDisplayScheduler(client) {
    if (scheduledTask) return;

    scheduledTask = cron.schedule('*/10 * * * *', async () => {
        try {
            for (const c of iterateAllBotClients()) {
                if (c.statDisplayManager) {
                    await c.statDisplayManager.updateAll();
                }
            }
        } catch (error) {
            logger.error('[StatDisplayScheduler] Error updating stat displays', {
                error: error.message,
                stack: error.stack
            });
        }
    });

    scheduledTask.start();
    logger.info('[StatDisplayScheduler] Started (stats every 10 minutes)');

    // Discord allows 2 renames per 10 min per channel, so 5 min is the fastest safe interval
    clockTask = cron.schedule('*/5 * * * *', async () => {
        try {
            for (const c of iterateAllBotClients()) {
                if (c.statDisplayManager) {
                    await c.statDisplayManager.updateClocks();
                }
            }
        } catch (error) {
            logger.error('[StatDisplayScheduler] Error updating clocks', { error: error.message });
        }
    });
    clockTask.start();
    logger.info('[StatDisplayScheduler] Clock cycle started (every 5 minutes)');

    if (!initialUpdateScheduled) {
        initialUpdateScheduled = true;
        // 60s gives slow custom bots time to register in global.botManager.clients
        setTimeout(async () => {
            const all = [...iterateAllBotClients()];
            logger.info(`[StatDisplayScheduler] Running initial update for ${all.length} client(s)`);
            for (const c of all) {
                if (c.statDisplayManager) {
                    await c.statDisplayManager.updateAll().catch(err => {
                        logger.error('[StatDisplayScheduler] Error on initial update', { error: err.message });
                    });
                }
            }
        }, 60000);
    }
}

export function stopStatDisplayScheduler() {
    if (scheduledTask) {
        scheduledTask.stop();
        scheduledTask = null;
    }
    if (clockTask) {
        clockTask.stop();
        clockTask = null;
    }
    initialUpdateScheduled = false;
    logger.info('[StatDisplayScheduler] Stopped');
}
