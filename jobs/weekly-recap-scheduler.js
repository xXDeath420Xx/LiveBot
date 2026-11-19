/**
 * Weekly Recap scheduler.
 *
 * Fires every hour on the hour — the manager decides which guilds are "due" based on the
 * configured day_of_week + hour and whether we've already posted this week. 60-min cadence
 * is coarse enough that an hour-after-scheduled first post is fine, and avoids the complexity
 * of per-guild cron entries.
 *
 * Imported + started from index.js alongside the other schedulers.
 */
import cron from 'node-cron';
import logger from '../utils/logger.js';
import { runRecapCycle } from '../core/weekly-recap-manager.js';

let task = null;
let running = false;

export function startWeeklyRecapScheduler() {
    if (task) { logger.warn('[Weekly Recap] already running'); return; }
    task = cron.schedule('5 * * * *', async () => {
        if (running) return;
        running = true;
        try { await runRecapCycle(); }
        catch (e) { logger.error('[Weekly Recap] cycle error', { err: e.message }); }
        finally { running = false; }
    });
    logger.info('[Weekly Recap] Started (hourly check at :05)');
}

export function stopWeeklyRecapScheduler() {
    if (task) { task.stop(); task = null; }
    running = false;
    logger.info('[Weekly Recap] Stopped');
}
