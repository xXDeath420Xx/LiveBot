const path = require("path");
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const logger = require('../utils/logger');
const { checkStatroles } = require('../core/statrole-manager');
const { updateStatdocks } = require('../core/statdock-manager');

// Export a function that takes the main client instance
module.exports = function startAnalyticsScheduler(client) {
    // The logger is initialized in the main index.js file. DO NOT re-initialize it here.
    logger.info('[AnalyticsScheduler] Initializing scheduler.');

    // Schedule the jobs to run periodically
    async function runScheduledJobs() {
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
    runScheduledJobs();
    const intervalId = setInterval(runScheduledJobs, 15 * 60 * 1000);

    // Graceful shutdown is handled by the main process.

    return intervalId;
};