const { Worker } = require('bullmq');
const { redis } = require('../utils/cache');
const logger = require('../utils/logger');

logger.info('[Ticket Worker] Initializing...');

const processor = async job => {
    logger.info(`[TicketWorker] Processing job ${job.id} of type ${job.name}`);
    // Job processing logic will be re-added once the syntax error is resolved.
    await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate work
    logger.info(`[TicketWorker] Finished job ${job.id}`);
};

const workerOptions = {
    connection: redis
};

try {
    new Worker('ticket-jobs', processor, workerOptions);
    logger.info('[Ticket Worker] BullMQ Worker for tickets is active.');
} catch (error) {
    logger.error('[TicketWorker] Failed to instantiate worker.', { error });
    process.exit(1);
}
