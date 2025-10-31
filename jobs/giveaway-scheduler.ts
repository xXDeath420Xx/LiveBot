import { Queue } from 'bullmq';
import { redisOptions } from '../utils/cache';

const systemQueue = new Queue('system-tasks', { connection: redisOptions });

/**
 * Schedule giveaway check jobs to run every 15 seconds
 */
async function scheduleGiveawayChecks(): Promise<void> {
    try {
        // Remove existing repeatable job with proper key
        const repeatableJobs = await systemQueue.getRepeatableJobs();
        const existingJob = repeatableJobs.find((job) => job.name === 'check-giveaways');
        if (existingJob) {
            await systemQueue.removeRepeatableByKey(existingJob.key);
        }

        await systemQueue.add('check-giveaways', {}, {
            repeat: { every: 15 * 1000 }, // Every 15 seconds
            jobId: 'check-giveaways'
        });
        console.log('[GiveawayScheduler] Giveaway check job scheduled to run every 15 seconds.');
    } finally {
        await systemQueue.close();
    }
}

scheduleGiveawayChecks().catch(console.error);
