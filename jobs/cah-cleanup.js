/**
 * Daily cleanup of finished/abandoned CAH games + frequent stuck-game watchdog.
 *
 * Daily purge (04:00 UTC): drops GAME_END/ABANDONED rows older than 30 days.
 * Schema cascades deletes via FK so dropping a cah_games row clears its
 * players, submissions, and deck-joins automatically.
 *
 * Watchdog (every 5 min): finds non-LOBBY games that haven't been updated in
 * STUCK_MINUTES and force-abandons them. A healthy in-flight game updates
 * `updated_at` on every state transition + every submission (see _persist),
 * so an idle window that wide means the engine's not driving it forward —
 * usually a crash recovery from a prior version, or a desync we couldn't
 * resolve. Better to clear it than leave players staring at a frozen lobby.
 */
import cron from 'node-cron';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { adminForceEndGame } from '../core/cah-manager.js';

const RETENTION_DAYS = 30;
const STUCK_MINUTES = 15;        // non-LOBBY game idle this long → abandon
const LOBBY_IDLE_HOURS = 4;      // LOBBY game idle this long → also abandon
let purgeTask = null;
let watchdogTask = null;

async function runCleanup() {
    try {
        const [result] = await pool.execute(
            `DELETE FROM cah_games
             WHERE state IN ('GAME_END','ABANDONED')
             AND (ended_at IS NULL OR ended_at < (NOW() - INTERVAL ? DAY))`,
            [RETENTION_DAYS]
        );
        if (result.affectedRows > 0) {
            logger.info(`[cah-cleanup] purged ${result.affectedRows} games older than ${RETENTION_DAYS} days`);
        }
    } catch (err) {
        logger.error(`[cah-cleanup] failed: ${err.message}`);
    }
}

async function runStuckWatchdog() {
    try {
        // Two queries: non-LOBBY stuck (tight threshold) and LOBBY stuck (loose threshold).
        const [stuckActive] = await pool.execute(
            `SELECT id, state, updated_at FROM cah_games
             WHERE state NOT IN ('GAME_END','ABANDONED','LOBBY')
             AND updated_at < (NOW() - INTERVAL ? MINUTE)`,
            [STUCK_MINUTES]
        );
        const [stuckLobby] = await pool.execute(
            `SELECT id, state, updated_at FROM cah_games
             WHERE state = 'LOBBY'
             AND updated_at < (NOW() - INTERVAL ? HOUR)`,
            [LOBBY_IDLE_HOURS]
        );
        const toAbandon = [...stuckActive, ...stuckLobby];
        if (toAbandon.length === 0) return;
        let ok = 0, fail = 0;
        for (const row of toAbandon) {
            try {
                const r = await adminForceEndGame(row.id, 'watchdog_stuck');
                if (r.ok) {
                    ok++;
                    logger.warn(`[cah-cleanup] watchdog abandoned stuck game ${row.id} (state=${row.state}, last update ${row.updated_at}, via ${r.mode})`);
                } else {
                    fail++;
                }
            } catch (err) {
                fail++;
                logger.error(`[cah-cleanup] watchdog failed to abandon ${row.id}: ${err.message}`);
            }
        }
        logger.info(`[cah-cleanup] watchdog: ${ok} abandoned (${stuckActive.length} active, ${stuckLobby.length} lobby), ${fail} failed`);
    } catch (err) {
        logger.error(`[cah-cleanup] watchdog query failed: ${err.message}`);
    }
}

export function startCahCleanup() {
    if (purgeTask && watchdogTask) return { purgeTask, watchdogTask };
    // Daily at 04:00 UTC — purge terminal games past retention
    if (!purgeTask) {
        purgeTask = cron.schedule('0 4 * * *', runCleanup, { timezone: 'UTC' });
        logger.info(`[cah-cleanup] purge job scheduled daily at 04:00 UTC (${RETENTION_DAYS}d retention)`);
    }
    // Every 5 minutes — find and abandon stuck games
    if (!watchdogTask) {
        watchdogTask = cron.schedule('*/5 * * * *', runStuckWatchdog, { timezone: 'UTC' });
        logger.info(`[cah-cleanup] stuck-game watchdog scheduled every 5min (${STUCK_MINUTES}min active threshold, ${LOBBY_IDLE_HOURS}h lobby threshold)`);
    }
    return { purgeTask, watchdogTask };
}

export function stopCahCleanup() {
    if (purgeTask) { purgeTask.stop(); purgeTask = null; }
    if (watchdogTask) { watchdogTask.stop(); watchdogTask = null; }
}

export { runCleanup, runStuckWatchdog };
