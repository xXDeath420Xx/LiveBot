import { Worker, Job, WorkerOptions } from 'bullmq';
import * as path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env') });
import { redisOptions } from '../utils/cache';
import logger from '../utils/logger';
import { Client } from 'discord.js';

interface TicketJobData {
    [key: string]: any;
}

// Export a function that takes the main client instance
export = function startTicketWorker(_client: Client): Worker {
    // The logger is initialized in the main index.js file. DO NOT re-initialize it here.

    logger.info('[Ticket Worker] Initializing BullMQ Worker.');

    const processor = async (job: Job<TicketJobData>): Promise<void> => {
        try {
            logger.info(`[TicketWorker] Processing job ${job.id} of type ${job.name}`);
            // Future job processing logic goes here.
            await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate work
            logger.info(`[TicketWorker] Finished job ${job.id}`);
        } catch (error) {
            logger.error('[TicketWorker] Error processing job:', { _error, jobId: job.id, jobName: job.name });
            // We throw the _error so BullMQ can retry the job according to the retry strategy
            throw _error;
        }
    };

    const workerOptions: WorkerOptions = {
        connection: redisOptions,
        concurrency: 5, // Process up to 5 jobs concurrently
        limiter: {
            max: 10, // Max 10 jobs
            duration: 1000, // per second
        },
    };

    try {
        const ticketWorker = new Worker<TicketJobData>('ticket-jobs', processor, workerOptions);

        ticketWorker.on('completed', (job: Job) => {
            logger.info(`[TicketWorker] Job ${job.id} has completed.`);
        });

        ticketWorker.on('failed', (job: Job | undefined, err: Error) => {
            logger.error(`[TicketWorker] Job ${job?.id} has failed.`, { error: err });
        });

        logger.info('[Ticket Worker] BullMQ Worker for tickets is active.');

        // Graceful shutdown is handled by the main process.

        return ticketWorker;
    } catch (error) {
        logger.error('[TicketWorker] Failed to instantiate worker.', { _error });
        process.exit(1);
    }
};