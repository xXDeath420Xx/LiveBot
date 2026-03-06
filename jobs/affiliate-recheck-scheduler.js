import cron from 'node-cron';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';

let recheckTask = null;

/**
 * Re-check affiliate status for all known non-affiliate raid targets.
 * Updates the community_twitch_links cache so future entries use the correct status.
 * Does NOT retroactively change any existing entries or points.
 */
async function recheckAffiliateStatuses() {
    try {
        logger.info('[AffiliateRecheck] Starting affiliate status re-check');

        // Get all distinct non-affiliate targets across all guilds (raids AND support)
        const [targets] = await pool.execute(
            `SELECT DISTINCT e.guild_id, e.target_username, e.target_twitch_id
             FROM community_support_entries e
             WHERE e.target_username NOT IN (
                   SELECT ctl.twitch_username FROM community_twitch_links ctl
                   WHERE ctl.guild_id = e.guild_id AND ctl.is_affiliate = 1
               )
             ORDER BY e.guild_id`
        );

        if (targets.length === 0) {
            logger.info('[AffiliateRecheck] No non-affiliate targets to re-check');
            return;
        }

        const { getTwitchUser } = await import('../utils/platforms/twitch-api.js');
        let checked = 0;
        let promoted = 0;

        for (const { guild_id, target_username, target_twitch_id } of targets) {
            try {
                // Prefer ID-based lookup (survives username changes)
                const user = await getTwitchUser(target_twitch_id || target_username);
                if (!user) continue;

                checked++;
                const isAffiliate = user.broadcaster_type === 'affiliate' || user.broadcaster_type === 'partner';
                const canonicalUsername = user.login;
                const twitchId = user.id;

                // Update cache with current username and ID
                await pool.execute(
                    `INSERT INTO community_twitch_links (guild_id, discord_user_id, twitch_username, twitch_user_id, is_affiliate, last_checked)
                     VALUES (?, 'api_lookup', ?, ?, ?, NOW())
                     ON DUPLICATE KEY UPDATE is_affiliate = ?, twitch_username = ?, twitch_user_id = ?, last_checked = NOW()`,
                    [guild_id, canonicalUsername, twitchId, isAffiliate ? 1 : 0, isAffiliate ? 1 : 0, canonicalUsername, twitchId]
                );

                // Backfill: update entries with twitch ID and refresh username to canonical
                if (twitchId) {
                    await pool.execute(
                        `UPDATE community_support_entries
                         SET target_twitch_id = ?, target_username = ?
                         WHERE guild_id = ? AND target_username = ? AND (target_twitch_id IS NULL OR target_username != ?)`,
                        [twitchId, canonicalUsername, guild_id, target_username, canonicalUsername]
                    );
                }

                if (isAffiliate) {
                    promoted++;
                    logger.info(`[AffiliateRecheck] ${canonicalUsername} is now ${user.broadcaster_type} (guild ${guild_id}). Future entries will use affiliate points.`);
                }
            } catch (error) {
                logger.warn(`[AffiliateRecheck] Failed to check ${target_twitch_id || target_username}:`, { error: error.message });
            }
        }

        logger.info(`[AffiliateRecheck] Complete. Checked ${checked}/${targets.length} targets, ${promoted} newly promoted to affiliate/partner.`);
    } catch (error) {
        logger.error('[AffiliateRecheck] Error during re-check:', { error: error.message });
    }
}

/**
 * Start the affiliate re-check scheduler.
 * Runs every 6 hours to catch streamers who recently became affiliate.
 */
export function startAffiliateRecheckScheduler() {
    if (recheckTask) {
        logger.warn('[AffiliateRecheck] Scheduler already running');
        return;
    }

    // Run at minute 30 past every 6th hour (00:30, 06:30, 12:30, 18:30 UTC)
    recheckTask = cron.schedule('30 */6 * * *', async () => {
        await recheckAffiliateStatuses();
    });

    logger.info('[AffiliateRecheck] Scheduler started (every 6 hours at :30)');

    // Run 2 minutes after startup
    setTimeout(async () => {
        await recheckAffiliateStatuses();
    }, 120000);
}

/**
 * Stop the affiliate re-check scheduler
 */
export function stopAffiliateRecheckScheduler() {
    if (recheckTask) {
        recheckTask.stop();
        recheckTask = null;
        logger.info('[AffiliateRecheck] Scheduler stopped');
    }
}

export default { startAffiliateRecheckScheduler, stopAffiliateRecheckScheduler };
