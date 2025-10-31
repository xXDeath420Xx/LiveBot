import { Worker, Job } from 'bullmq';
import * as path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env') });
import { redisOptions } from '../utils/cache';
import logger from '../utils/logger';
import { checkRedditFeeds } from '../core/reddit-feed';
import twitterFeedModule from '../core/twitter-feed';
import { Client } from 'discord.js';

const { checkTwitterFeeds } = twitterFeedModule;

interface SocialFeedJobData {
    [key: string]: any;
}

// Export a function that takes the main client instance
export = function startSocialFeedWorker(client: Client): Worker {
    // The logger is initialized in the main index.js file. DO NOT re-initialize it here.

    logger.info('[Social Feed Worker] Initializing BullMQ Worker.');

    const socialFeedWorker = new Worker<SocialFeedJobData>('social-feeds', async (job: Job<SocialFeedJobData>) => {
        if (!client.isReady()) {
            logger.warn(`[SocialFeedWorker] Discord client not ready. Retrying job ${job.id}...`);
            throw new Error('Discord client not ready');
        }

        if (job.name === 'check-social-feeds') {
            logger.info('[SocialFeedWorker] Checking for new posts from Reddit and Twitter.');
            try {
                await checkRedditFeeds();
                await checkTwitterFeeds();
            } catch (error) {
                logger.error('[SocialFeedWorker] Error during social feed check:', { error });
                throw error;
            }
        }
    }, { connection: redisOptions });

    socialFeedWorker.on('completed', (job: Job) => logger.info(`[SocialFeedWorker] Job ${job.id} has completed.`));
    socialFeedWorker.on('failed', (job: Job | undefined, err: Error) => logger.error(`[SocialFeedWorker] Job ${job?.id} has failed.`, { error: err }));

    // Graceful shutdown is handled by the main process.

    return socialFeedWorker;
};
