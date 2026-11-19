import cron from 'node-cron';
import logger from '../utils/logger.js';
import { refreshAll } from '../core/fourtwenty-panel.js';

let task = null;
let initialTimer = null;

/**
 * Keep every 4:20 clock panel current. Runs at second 2 of every minute so a
 * city's 4:20 minute is picked up as it starts; refreshAll() only edits panels
 * whose content actually changed (a few times an hour).
 *
 * Clients are resolved per panel from global.botManager, so this one schedule
 * covers the main bot and every custom bot.
 */
// eslint-disable-next-line no-unused-vars
export function startFourTwentyPanelScheduler(client) {
    if (task) return;
    task = cron.schedule('2 * * * * *', () => { refreshAll(); });
    // First pass after custom bots have had time to log in and register.
    initialTimer = setTimeout(() => { refreshAll(); }, 60_000);
    logger.info('[420Panel] Scheduler started (checks every minute)');
}

export function stopFourTwentyPanelScheduler() {
    task?.stop();
    task = null;
    clearTimeout(initialTimer);
}
