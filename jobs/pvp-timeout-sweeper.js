// Auto-forfeits abandoned live PvP duels. The in-handler timeout is claim-based
// (the waiting player must come back and click to claim the win); this sweep covers
// the case where BOTH players walk away, so a match can't sit `active` forever.
// Every few minutes it forfeits the player currently on the clock for any match
// idle past the timeout — the opponent wins and ELO/wager settle via endMatch.
import cron from 'node-cron';
import RPGPvPManager from '../core/rpg-pvp-manager.js';
import logger from '../utils/logger.js';

const TIMEOUT_MINUTES = 10;
let task = null;

export function startPvpTimeoutSweeper() {
    if (task) return task;
    // every 3 minutes
    task = cron.schedule('*/3 * * * *', async () => {
        try {
            const ended = await RPGPvPManager.sweepStaleMatches(TIMEOUT_MINUTES);
            if (ended.length) {
                logger.info(`[pvp-sweeper] auto-forfeited ${ended.length} idle duel(s): ${ended.map(e => e.matchId).join(', ')}`);
            }
        } catch (err) {
            logger.warn('[pvp-sweeper] sweep failed', { error: err.message });
        }
    });
    logger.info('[Core] PvP timeout sweeper initialized');
    return task;
}

export function stopPvpTimeoutSweeper() {
    if (task) { task.stop(); task = null; }
}

export default startPvpTimeoutSweeper;
