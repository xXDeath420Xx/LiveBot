/**
 * Background Jobs Manager
 * Manages scheduled tasks for the game
 */

import { CronJob } from 'cron';
import logger from '../../../utils/logger.js';
import { marketTick } from './market-tick.js';
import { growthTick } from './growth-tick.js';
import { questReset } from './quest-reset.js';
import { bonusSync } from './bonus-sync.js';
import { cleanup } from './cleanup.js';
import { workersTick } from './workers-tick.js';
import { raidTick } from './raid-tick.js';
import { researchTick } from './research-tick.js';
import { resolveEndedWars } from '../routes/territories.js';
import { rotateShopDeals } from './shop-rotation.js';
import { tournamentTick } from './tournament-tick.js';

const jobs = [];

/**
 * Start all background jobs
 */
export async function startJobs() {
    logger.info('[Jobs] Starting background jobs...');

    // Market price tick - every 5 minutes
    jobs.push(new CronJob('*/5 * * * *', async () => {
        try {
            await marketTick();
        } catch (error) {
            logger.error('[Jobs] Market tick failed', { error: error.message });
        }
    }, null, true, 'UTC'));

    // Growth tick - every 10 seconds (plant status updates + notifications)
    jobs.push(new CronJob('*/10 * * * * *', async () => {
        try {
            await growthTick();
        } catch (error) {
            logger.error('[Jobs] Growth tick failed', { error: error.message });
        }
    }, null, true, 'UTC'));

    // Quest reset - daily at midnight UTC
    jobs.push(new CronJob('0 0 * * *', async () => {
        try {
            await questReset('daily');
        } catch (error) {
            logger.error('[Jobs] Daily quest reset failed', { error: error.message });
        }
    }, null, true, 'UTC'));

    // Weekly quest reset - Monday at midnight UTC
    jobs.push(new CronJob('0 0 * * 1', async () => {
        try {
            await questReset('weekly');
        } catch (error) {
            logger.error('[Jobs] Weekly quest reset failed', { error: error.message });
        }
    }, null, true, 'UTC'));

    // Bot bonus sync - every 15 minutes
    jobs.push(new CronJob('*/15 * * * *', async () => {
        try {
            await bonusSync();
        } catch (error) {
            logger.error('[Jobs] Bonus sync failed', { error: error.message });
        }
    }, null, true, 'UTC'));

    // Cleanup - every hour
    jobs.push(new CronJob('0 * * * *', async () => {
        try {
            await cleanup();
        } catch (error) {
            logger.error('[Jobs] Cleanup failed', { error: error.message });
        }
    }, null, true, 'UTC'));

    // Idle Tycoon tick - every 10 seconds (full idle cycle for all players)
    jobs.push(new CronJob('*/10 * * * * *', async () => {
        try {
            await workersTick();
        } catch (error) {
            logger.error('[Jobs] Workers tick failed', { error: error.message });
        }
    }, null, true, 'UTC'));

    // Raid tick - every 15 minutes (checks eligible players for DEA raids)
    jobs.push(new CronJob('*/15 * * * *', async () => {
        try {
            await raidTick();
        } catch (error) {
            logger.error('[Jobs] Raid tick failed', { error: error.message });
        }
    }, null, true, 'UTC'));

    // Research tick - every 10 seconds (auto-completes finished research and training)
    jobs.push(new CronJob('*/10 * * * * *', async () => {
        try {
            await researchTick();
        } catch (error) {
            logger.error('[Jobs] Research tick failed', { error: error.message });
        }
    }, null, true, 'UTC'));

    // Territory war resolution - every 5 minutes
    jobs.push(new CronJob('*/5 * * * *', async () => {
        try {
            const resolved = await resolveEndedWars();
            if (resolved > 0) {
                logger.info('[Jobs] Resolved turf wars', { count: resolved });
            }
        } catch (error) {
            logger.error('[Jobs] Territory war resolution failed', { error: error.message });
        }
    }, null, true, 'UTC'));

    // Shop deal rotation - every hour (creates new deals when old ones expire)
    jobs.push(new CronJob('0 * * * *', async () => {
        try {
            await rotateShopDeals();
        } catch (error) {
            logger.error('[Jobs] Shop rotation failed', { error: error.message });
        }
    }, null, true, 'UTC'));

    // Tournament lifecycle - every 5 minutes (activates/completes tournaments, auto-creates new ones)
    jobs.push(new CronJob('*/5 * * * *', async () => {
        try {
            await tournamentTick();
        } catch (error) {
            logger.error('[Jobs] Tournament tick failed', { error: error.message });
        }
    }, null, true, 'UTC'));

    logger.info('[Jobs] Started', { count: jobs.length });
}

/**
 * Stop all background jobs
 */
export async function stopJobs() {
    logger.info('[Jobs] Stopping background jobs...');

    for (const job of jobs) {
        job.stop();
    }

    jobs.length = 0;
    logger.info('[Jobs] Stopped');
}

export default { startJobs, stopJobs };
