const { Worker } = require('bullmq');
const path = require("path");
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { redisOptions } = require("../utils/cache");
const logger = require("../utils/logger");
const db = require("../utils/db");

// Export a function that takes the main client instance
module.exports = function startTicketWorker(client) {
    // The logger is initialized in the main index.js file. DO NOT re-initialize it here.

    logger.info('[Ticket Worker] Initializing BullMQ Worker.');

    const processor = async job => {
        try {
            logger.info(`[TicketWorker] Processing job ${job.id} of type ${job.name}`);
            // Future job processing logic goes here.
            await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate work
            logger.info(`[TicketWorker] Finished job ${job.id}`);
        } catch (error) {
            logger.error('[TicketWorker] Error processing job:', { error, jobId: job.id, jobName: job.name });
            // We throw the error so BullMQ can retry the job according to the retry strategy
            throw error;
        }
    };

    const workerOptions = {
        connection: redisOptions,
        concurrency: 5, // Process up to 5 jobs concurrently
        limiter: {
            max: 10, // Max 10 jobs
            duration: 1000, // per second
        },
    };

    try {
        const ticketWorker = new Worker('ticket-jobs', processor, workerOptions);

        ticketWorker.on('completed', job => {
            logger.info(`[TicketWorker] Job ${job.id} has completed.`);
        });

        ticketWorker.on('failed', (job, err) => {
            logger.error(`[TicketWorker] Job ${job?.id} has failed.`, { error: err });
        });

        logger.info('[Ticket Worker] BullMQ Worker for tickets is active.');

        // Graceful shutdown is handled by the main process.

        return ticketWorker;
    } catch (error) {
        logger.error('[TicketWorker] Failed to instantiate worker.', { error });
        process.exit(1);
    }
};