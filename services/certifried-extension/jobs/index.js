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
import { seasonTick, refreshSeasonColumns } from '../game/season-system.js';
import { isFrozen } from '../freeze.js';
import { isGreenhouseLive } from '../../cfx/integrations/cutover.js';

const jobs = [];
let seasonStartupTimer = null;

/**
 * Start all background jobs
 */
export async function startJobs() {
    // Replaced by Greenhouse Tycoon (GREENHOUSE_LIVE=1, phase 5): never start, whatever CFX_FROZEN says.
    if (isGreenhouseLive()) {
        logger.info('[Jobs] Greenhouse Tycoon is live (GREENHOUSE_LIVE=1): no old game jobs started');
        return;
    }
    // CertiFried Tycoon is frozen until v2 replaces it (CFX_FROZEN, H-636). None of the jobs below run:
    // market prices, growth, quest resets, bonus sync, cleanup, workers (idle cycle), raids, research,
    // turf wars, shop rotation, tournaments, season rollover (and its start-up run).
    if (isFrozen()) {
        logger.info('[Jobs] CertiFried Tycoon is frozen (CFX_FROZEN): no game jobs started');
        return;
    }
    logger.debug('[Jobs] Starting background jobs...');

    // Season counters are written only once their columns exist (see game/season-system.js)
    await refreshSeasonColumns();

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
                logger.debug('[Jobs] Resolved turf wars', { count: resolved });
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

    // Season rollover - every 5 minutes, plus once shortly after start so an overdue
    // season (e.g. after downtime) closes without waiting (H-408)
    const runSeasonTick = async () => {
        try {
            await seasonTick();
        } catch (error) {
            logger.error('[Jobs] Season tick failed', { error: error.message });
        }
    };
    jobs.push(new CronJob('*/5 * * * *', runSeasonTick, null, true, 'UTC'));
    seasonStartupTimer = setTimeout(runSeasonTick, 30_000);
    seasonStartupTimer.unref?.();

    logger.info('[Jobs] Started', { count: jobs.length });
}

/**
 * Stop all background jobs
 */
export async function stopJobs() {
    logger.debug('[Jobs] Stopping background jobs...');
    if (seasonStartupTimer) clearTimeout(seasonStartupTimer);

    for (const job of jobs) {
        job.stop();
    }

    jobs.length = 0;
    logger.debug('[Jobs] Stopped');
}

export default { startJobs, stopJobs };
