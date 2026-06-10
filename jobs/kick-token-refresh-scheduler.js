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
 * Refresh stored Kick display names from the live Kick API.
 *
 * Kick lets users rename freely, but the broadcaster id (channel_id /
 * platform_id) is stable. We store the name in tokes_platform_connections
 * (platform_name) and tokes_channels (channel_name); a rename leaves both stale
 * until the user next logs in. This heals it WITHOUT a login by querying the
 * Kick API with the bot's App Access Token (no user token required — so it
 * works even for accounts whose OAuth token has expired). Looks up by the
 * stable broadcaster id and writes only when the slug actually changed.
 */
async function refreshKickDisplayNames() {
    try {
        const bot = global.kickBot;
        if (!bot || typeof bot.kickApiRequest !== 'function') return;

        // Distinct Kick channels we know about (broadcaster id + current stored name).
        const [chans] = await pool.execute(
            "SELECT channel_id, channel_name FROM tokes_channels WHERE platform = 'kick'"
        );
        if (!chans.length) return;

        let renamed = 0;
        for (const c of chans) {
            try {
                const res = await bot.kickApiRequest(`/channels?broadcaster_user_id=${encodeURIComponent(c.channel_id)}`);
                const slug = res?.data?.[0]?.slug;
                if (!slug || slug === c.channel_name) continue; // unchanged or not found
                await pool.execute(
                    "UPDATE tokes_channels SET channel_name = ? WHERE platform = 'kick' AND channel_id = ?",
                    [slug, String(c.channel_id)]
                );
                await pool.execute(
                    "UPDATE tokes_platform_connections SET platform_name = ? WHERE platform = 'kick' AND platform_id = ?",
                    [slug, String(c.channel_id)]
                );
                renamed++;
                logger.info('[KickTokenRefresh] Updated renamed Kick channel', { from: c.channel_name, to: slug, broadcasterId: c.channel_id });
            } catch (err) {
                logger.warn('[KickTokenRefresh] Name lookup failed', { broadcasterId: c.channel_id, error: err.message });
            }
        }
        if (renamed) logger.info(`[KickTokenRefresh] Synced ${renamed} renamed Kick channel name(s)`);
    } catch (error) {
        logger.error('[KickTokenRefresh] Name-refresh cycle error', { error: error.message });
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
        await refreshKickDisplayNames();
    });
    logger.info('[KickTokenRefresh] Scheduler started (hourly at :15)');

    // Run shortly after startup so a freshly-booted bot heals stale tokens +
    // out-of-date display names fast.
    setTimeout(async () => {
        await refreshExpiringKickTokens();
        await refreshKickDisplayNames();
    }, 90 * 1000);
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
