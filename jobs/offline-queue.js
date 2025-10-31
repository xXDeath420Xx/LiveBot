"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.offlineQueue = void 0;
const bullmq_1 = require("bullmq");
const cache_1 = require("../utils/cache");
const logger_1 = __importDefault(require("../utils/logger"));
exports.offlineQueue = new bullmq_1.Queue('offline-queue', {
    connection: cache_1.redisOptions,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 2000
        },
        removeOnComplete: {
            age: 3600, // Keep completed jobs for 1 hour
            count: 1000
        },
        removeOnFail: {
            age: 86400 // Keep failed jobs for 24 hours
        }
    }
});
exports.offlineQueue.on('error', (err) => {
    logger_1.default.error('[Offline Queue] Queue error:', { error: err, category: 'streams' });
});
logger_1.default.info('[Offline Queue] Initialized offline queue');
