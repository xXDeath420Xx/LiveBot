import cron from 'node-cron';
import BuyMeACoffeeManager from '../core/buymeacoffee-manager.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const LOG_TAG = '[BMC]';
const DEFAULT_CRON = '*/5 * * * *';

let scheduledTask = null;
let manager = null;
let isInitialized = false;
let isRunning = false; // re-entrancy guard

function resolveCron() {
    const fromEnv = process.env.BMC_POLLER_CRON;
    if (fromEnv && cron.validate(fromEnv)) return fromEnv;
    if (fromEnv) {
        logger.warn(`${LOG_TAG} Invalid BMC_POLLER_CRON "${fromEnv}", falling back to ${DEFAULT_CRON}`);
    }
    return DEFAULT_CRON;
}

async function runCycle() {
    if (isRunning) {
        logger.debug(`${LOG_TAG} Previous cycle still running, skipping this tick`);
        return;
    }
    isRunning = true;
    try {
        // Distinct linked users who have at least one enabled announce target
        const [rows] = await pool.execute(
            `SELECT DISTINCT a.user_id
             FROM bmc_announce a
             JOIN bmc_user_links l ON l.user_id = a.user_id
             WHERE a.enabled = 1`
        );
        if (rows.length === 0) return;

        let totalAnnounced = 0;
        for (const row of rows) {
            const count = await manager.pollUser(row.user_id);
            totalAnnounced += count;
        }

        if (totalAnnounced > 0) {
            logger.info(`${LOG_TAG} Announced ${totalAnnounced} new item(s) across ${rows.length} linked user(s)`);
        }
    } catch (error) {
        logger.error(`${LOG_TAG} Poll cycle failed`, { error: error.message, stack: error.stack });
    } finally {
        isRunning = false;
    }
}

/**
 * Start the Buy Me a Coffee poller (every 5 minutes by default).
 * @param {Client} client - Discord client instance
 */
export function startBuyMeACoffeeScheduler(client) {
    if (isInitialized) {
        logger.debug(`${LOG_TAG} Scheduler already initialized, skipping duplicate call`);
        return;
    }
    isInitialized = true;
    manager = new BuyMeACoffeeManager(client);

    const expression = resolveCron();
    scheduledTask = cron.schedule(expression, runCycle);
    scheduledTask.start();
    logger.info(`${LOG_TAG} Scheduler started (cron: ${expression})`);
}

/**
 * Stop the Buy Me a Coffee poller.
 */
export function stopBuyMeACoffeeScheduler() {
    if (scheduledTask) {
        scheduledTask.stop();
        scheduledTask = null;
        logger.info(`${LOG_TAG} Scheduler stopped`);
    }
    manager = null;
    isInitialized = false;
    isRunning = false;
}

/**
 * Trigger a manual poll for a single user.
 * @param {string} userId
 * @returns {Promise<number>} count announced
 */
export async function triggerBuyMeACoffeePoll(userId) {
    if (!manager) {
        throw new Error('Buy Me a Coffee manager not initialized');
    }
    return manager.pollUser(userId);
}
