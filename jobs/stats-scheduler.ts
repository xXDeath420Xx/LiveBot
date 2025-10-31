import { Queue } from 'bullmq';
import { redisOptions } from '../utils/cache';

const systemQueue: Queue = new Queue('system-tasks', { connection: redisOptions });

async function scheduleStatsCollection(): Promise<void> {
    try {
        // Remove any old scheduled job to avoid duplicates
        const repeatableJobs = await systemQueue.getRepeatableJobs();
        const existingJob = repeatableJobs.find((job) => job.name === 'collect-server-stats');
        if (existingJob) {
            await systemQueue.removeRepeatableByKey(existingJob.key);
        }

        // Add the new job, scheduled to run once a day (24 hours = 86400000 milliseconds)
        await systemQueue.add('collect-server-stats', {}, {
            repeat: {
                every: 24 * 60 * 60 * 1000, // Every 24 hours
            },
            jobId: 'collect-server-stats',
            removeOnComplete: true,
            removeOnFail: 50
        });
        console.log('[StatsScheduler] Daily server stats collection job scheduled.');
    } finally {
        await systemQueue.close();
    }
}

scheduleStatsCollection().catch(console.error);