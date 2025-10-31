import * as path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env') });
import logger from '../utils/logger';
import { checkStatroles } from '../core/statrole-manager';
import { updateStatdocks } from '../core/statdock-manager';
import { Client } from 'discord.js';

// Export a function that takes the main client instance
export = function startAnalyticsScheduler(client: Client): NodeJS.Timeout {
    // The logger is initialized in the main index.js file. DO NOT re-initialize it here.
    logger.info('[AnalyticsScheduler] Initializing scheduler.');

    // Schedule the jobs to run periodically
    async function runScheduledJobs(): Promise<void> {
        try {
            logger.info('[AnalyticsScheduler] Running scheduled analytics jobs...');
            await checkStatroles(client);
            await updateStatdocks(client);
            logger.info('[AnalyticsScheduler] Scheduled analytics jobs complete.');
        } catch (e) {
            logger.error('[AnalyticsScheduler] A critical error occurred during scheduled job execution:', { error: e });
        }
    }

    // Run immediately and then every 15 minutes
    void runScheduledJobs();
    const intervalId: NodeJS.Timeout = setInterval(runScheduledJobs, 15 * 60 * 1000);

    // Graceful shutdown is handled by the main process.

    return intervalId;
};