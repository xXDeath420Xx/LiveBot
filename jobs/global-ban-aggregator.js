import cron from 'node-cron';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

let scheduledTask = null;
let isInitialized = false;
let clientRef = null;

/**
 * Run the aggregation cycle:
 * 1. Process auto-aggregation (users crossing thresholds)
 * 2. Expire old entries past their expires_at date
 * 3. Clean up processed aggregate records older than 90 days
 */
async function runAggregation() {
    const startTime = Date.now();

    try {
        // 1. Process auto-aggregation
        const manager = clientRef?.globalBanManager;
        let created = 0;
        if (manager) {
            created = await manager.processAutoAggregate();
        }

        // 2. Expire entries past their expiration date
        let expired = 0;
        try {
            const [result] = await pool.execute(
                `UPDATE global_ban_entries SET active = 0 WHERE active = 1 AND expires_at IS NOT NULL AND expires_at < NOW()`
            );
            expired = result.affectedRows;
            if (expired > 0) {
                logger.info(`[GlobalBanAggregator] Expired ${expired} entries`);
                // Reload cache to remove expired entries
                if (manager) {
                    await manager.loadBanCache();
                }
            }
        } catch (error) {
            logger.error('[GlobalBanAggregator] Error expiring entries', { error: error.message });
        }

        // 3. Clean up old processed aggregate records (older than 90 days)
        let cleaned = 0;
        try {
            const [result] = await pool.execute(
                `DELETE FROM global_ban_auto_aggregate WHERE processed = 1 AND occurred_at < DATE_SUB(NOW(), INTERVAL 90 DAY)`
            );
            cleaned = result.affectedRows;
            if (cleaned > 0) {
                logger.info(`[GlobalBanAggregator] Cleaned up ${cleaned} old aggregate records`);
            }
        } catch (error) {
            logger.error('[GlobalBanAggregator] Error cleaning up old records', { error: error.message });
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        if (created > 0 || expired > 0 || cleaned > 0) {
            logger.info(`[GlobalBanAggregator] Cycle complete in ${elapsed}s: ${created} created, ${expired} expired, ${cleaned} cleaned`);
        }
    } catch (error) {
        logger.error('[GlobalBanAggregator] Aggregation cycle error', {
            error: error.message,
            stack: error.stack
        });
    }
}

/**
 * Start the global ban aggregator
 * Runs every 15 minutes, initial run 30 seconds after startup
 * @param {Client} client - Discord client instance
 */
export function startGlobalBanAggregator(client) {
    if (isInitialized) {
        logger.debug('[GlobalBanAggregator] Already initialized, skipping');
        return;
    }

    clientRef = client;
    isInitialized = true;
    logger.info('[GlobalBanAggregator] Initializing...');

    // Schedule every 15 minutes
    scheduledTask = cron.schedule('*/15 * * * *', async () => {
        try {
            await runAggregation();
        } catch (error) {
            logger.error('[GlobalBanAggregator] Scheduled run error', {
                error: error.message,
                stack: error.stack
            });
        }
    });

    scheduledTask.start();
    logger.info('[GlobalBanAggregator] Scheduler started — running every 15 minutes');

    // Initial run after 30 seconds
    setTimeout(async () => {
        try {
            logger.info('[GlobalBanAggregator] Running initial aggregation...');
            await runAggregation();
        } catch (error) {
            logger.error('[GlobalBanAggregator] Initial run error', { error: error.message });
        }
    }, 30000);
}

/**
 * Stop the global ban aggregator
 */
export function stopGlobalBanAggregator() {
    if (scheduledTask) {
        scheduledTask.stop();
        logger.info('[GlobalBanAggregator] Scheduler stopped');
    }
    clientRef = null;
    isInitialized = false;
}
