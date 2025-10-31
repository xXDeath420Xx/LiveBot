"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const bullmq_1 = require("bullmq");
const path = __importStar(require("path"));
const dotenv = __importStar(require("dotenv"));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
const cache_1 = require("../utils/cache");
const logger_1 = __importDefault(require("../utils/logger"));
module.exports = function startTicketWorker(client) {
    // The logger is initialized in the main index.js file. DO NOT re-initialize it here.
    logger_1.default.info('[Ticket Worker] Initializing BullMQ Worker.');
    const processor = async (job) => {
        try {
            logger_1.default.info(`[TicketWorker] Processing job ${job.id} of type ${job.name}`);
            // Future job processing logic goes here.
            await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate work
            logger_1.default.info(`[TicketWorker] Finished job ${job.id}`);
        }
        catch (error) {
            logger_1.default.error('[TicketWorker] Error processing job:', { error, jobId: job.id, jobName: job.name });
            // We throw the error so BullMQ can retry the job according to the retry strategy
            throw error;
        }
    };
    const workerOptions = {
        connection: cache_1.redisOptions,
        concurrency: 5, // Process up to 5 jobs concurrently
        limiter: {
            max: 10, // Max 10 jobs
            duration: 1000, // per second
        },
    };
    try {
        const ticketWorker = new bullmq_1.Worker('ticket-jobs', processor, workerOptions);
        ticketWorker.on('completed', (job) => {
            logger_1.default.info(`[TicketWorker] Job ${job.id} has completed.`);
        });
        ticketWorker.on('failed', (job, err) => {
            logger_1.default.error(`[TicketWorker] Job ${job?.id} has failed.`, { error: err });
        });
        logger_1.default.info('[Ticket Worker] BullMQ Worker for tickets is active.');
        // Graceful shutdown is handled by the main process.
        return ticketWorker;
    }
    catch (error) {
        logger_1.default.error('[TicketWorker] Failed to instantiate worker.', { error });
        process.exit(1);
    }
};
