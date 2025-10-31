import * as path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env') });
import { Queue, RepeatableJob } from 'bullmq';
import { redisOptions } from '../utils/cache';
import logger from '../utils/logger';

const socialQueue: Queue = new Queue('social-feeds', { connection: redisOptions });

async function scheduleSocialFeedChecks(): Promise<void> {
    const repeatableJobs: RepeatableJob[] = await socialQueue.getRepeatableJobs();
    for (const job of repeatableJobs) {
        await socialQueue.removeRepeatableByKey(job.key);
    }

    await socialQueue.add('check-social-feeds', {}, {
        repeat: {
            every: 5 * 60 * 1000, // Every 5 minutes
        },
        removeOnComplete: true,
        removeOnFail: true,
    });
    logger.info('[SocialFeedScheduler] Social feed check job scheduled to run every 5 minutes.');
}

export { scheduleSocialFeedChecks };