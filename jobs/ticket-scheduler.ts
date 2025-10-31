import dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });
import { Queue, RepeatableJob } from 'bullmq';
import { redisOptions } from '../utils/cache';
import logger from '../utils/logger';

const ticketQueue: Queue = new Queue('ticket-jobs', { connection: redisOptions });

async function scheduleTicketChecks(): Promise<void> {
    // Remove any old repeatable jobs to ensure we only have one.
    const repeatableJobs: RepeatableJob[] = await ticketQueue.getRepeatableJobs();
    for (const job of repeatableJobs) {
        await ticketQueue.removeRepeatableByKey(job.key);
    }

    // Add the new repeatable job
    await ticketQueue.add('check-inactive-tickets', {}, {
        repeat: {
            every: 5 * 60 * 1000, // Every 5 minutes
        },
        removeOnComplete: true,
        removeOnFail: true,
    });
    logger.info('[TicketScheduler] Inactive ticket check job scheduled to run every 5 minutes.');
}

export { scheduleTicketChecks };