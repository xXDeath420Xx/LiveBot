import cron from 'node-cron';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';

let refreshTask = null;

// Refresh any Kick connection whose access token expires within this window, so
// tokens never silently die between defender actions. Kick access tokens last
// ~1h, so a 1h scheduler with a 90-min look-ahead guarantees every token is
// renewed at least once per validity period.
const LOOKAHEAD_MS = 90 * 60 * 1000;

/**
 * Proactively refresh soon-to-expire Kick OAuth tokens.
 *
 * Today refresh is lazy — it only happens inside resolveChannel() when the
 * defender actually acts on a message. A channel that's enrolled but quiet (no
 * spam to act on) can let its token lapse, which is why the admin panel was
 * showing "token expired" badges. This job renews them on a fixed cadence,
 * independent of chat activity.
 *
 * Reuses the live KickBot.refreshAccessToken (same instance channel-tokens.js
 * uses) so token rotation + DB persistence stay in one place. Best-effort per
 * connection: one failure never aborts the batch.
 */
async function refreshExpiringKickTokens() {
    try {
        const bot = global.kickBot;
        if (!bot || typeof bot.refreshAccessToken !== 'function') {
            logger.warn('[KickTokenRefresh] KickBot not ready; skipping this cycle');
            return;
        }

        // Only connections that CAN be refreshed (have a refresh_token) and are
        // expiring within the look-ahead window (or already expired).
        const cutoff = new Date(Date.now() + LOOKAHEAD_MS)
            .toISOString().slice(0, 19).replace('T', ' ');
        const [rows] = await pool.execute(
            `SELECT id, refresh_token
             FROM tokes_platform_connections
             WHERE platform = 'kick'
               AND refresh_token IS NOT NULL
               AND expires_at IS NOT NULL
               AND expires_at < ?`,
            [cutoff]
        );

        if (!rows.length) {
            logger.debug('[KickTokenRefresh] No Kick tokens need refreshing this cycle');
            return;
        }

        let ok = 0, failed = 0;
        for (const row of rows) {
            try {
                const newToken = await bot.refreshAccessToken(row.id, row.refresh_token);
                if (newToken) ok++; else failed++;
            } catch (err) {
                failed++;
                logger.warn('[KickTokenRefresh] Refresh failed for connection', { connectionId: row.id, error: err.message });
            }
        }
        logger.info(`[KickTokenRefresh] Refreshed ${ok}/${rows.length} Kick tokens (${failed} failed)`);
    } catch (error) {
        logger.error('[KickTokenRefresh] Cycle error', { error: error.message });
    }
}

/**
 * Start the Kick token-refresh scheduler. Runs hourly at :15.
 */
export function startKickTokenRefreshScheduler() {
    if (refreshTask) {
        logger.warn('[KickTokenRefresh] Scheduler already running');
        return;
    }
    refreshTask = cron.schedule('15 * * * *', async () => {
        await refreshExpiringKickTokens();
    });
    logger.info('[KickTokenRefresh] Scheduler started (hourly at :15)');

    // Run shortly after startup so a freshly-booted bot heals stale tokens fast.
    setTimeout(() => { refreshExpiringKickTokens(); }, 90 * 1000);
}

/**
 * Stop the Kick token-refresh scheduler.
 */
export function stopKickTokenRefreshScheduler() {
    if (refreshTask) {
        refreshTask.stop();
        refreshTask = null;
        logger.info('[KickTokenRefresh] Scheduler stopped');
    }
}

export default { startKickTokenRefreshScheduler, stopKickTokenRefreshScheduler };
