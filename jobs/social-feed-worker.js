const { Worker } = require('bullmq');
const path = require("path");
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { redisOptions } = require('../utils/cache');
const logger = require('../utils/logger');
const { checkRedditFeeds } = require('../core/reddit-feed');
const { checkTwitterFeeds } = require('../core/twitter-feed');

// Export a function that takes the main client instance
module.exports = function startSocialFeedWorker(client) {
    // The logger is initialized in the main index.js file. DO NOT re-initialize it here.

    logger.info('[Social Feed Worker] Initializing BullMQ Worker.');

    const socialFeedWorker = new Worker('social-feeds', async job => {
        if (!client.isReady()) {
            logger.warn(`[SocialFeedWorker] Discord client not ready. Retrying job ${job.id}...`);
            throw new Error("Discord client not ready");
        }

        if (job.name === 'check-social-feeds') {
            logger.info('[SocialFeedWorker] Checking for new posts from Reddit and Twitter.');
            try {
                await checkRedditFeeds(client);
                await checkTwitterFeeds(client);
            } catch (error) {
                logger.error('[SocialFeedWorker] Error during social feed check:', { error });
                throw error;
            }
        }
    }, { connection: redisOptions });

    socialFeedWorker.on("completed", job => logger.info(`[SocialFeedWorker] Job ${job.id} has completed.`));
    socialFeedWorker.on("failed", (job, err) => logger.error(`[SocialFeedWorker] Job ${job.id} has failed.`, { error: err }));

    // Graceful shutdown is handled by the main process.

    return socialFeedWorker;
};