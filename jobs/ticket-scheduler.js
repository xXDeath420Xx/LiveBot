require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Queue } = require('bullmq');
const { redisOptions } = require('../utils/cache');
const logger = require('../utils/logger');

const ticketQueue = new Queue('ticket-jobs', { connection: redisOptions });

async function scheduleTicketChecks() {
    // Remove any old repeatable jobs to ensure we only have one.
    const repeatableJobs = await ticketQueue.getRepeatableJobs();
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
    await ticketQueue.close();
}

// We only want this to run from the main process, not workers.
if (process.env.IS_MAIN_PROCESS === 'true') {
    scheduleTicketChecks().catch(err => {
        logger.error('[TicketScheduler] Failed to schedule ticket jobs:', err);
    });
}