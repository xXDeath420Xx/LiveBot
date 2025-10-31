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
const logger_1 = __importDefault(require("../utils/logger"));
const cache_1 = require("../utils/cache");
const stream_checker_1 = require("../core/stream-checker");
const user_sync_1 = require("../core/user-sync");
const stats_manager_1 = require("../core/stats-manager");
const streamManager = __importStar(require("../core/stream-manager"));
module.exports = function startSystemWorker(client) {
    // The logger is initialized in the main index.js file. DO NOT re-initialize it here.
    logger_1.default.info(`[System Worker] Initializing BullMQ worker.`);
    const worker = new bullmq_1.Worker('system-tasks', async (job) => {
        logger_1.default.info(`[System Worker] Processing job '${job.name}' (ID: ${job.id}).`);
        try {
            switch (job.name) {
                case 'check-streamers':
                    await streamManager.checkStreamers(client);
                    break;
                case 'sync-teams':
                    await (0, stream_checker_1.checkTeams)(client);
                    break;
                case 'sync-users':
                    await (0, user_sync_1.syncDiscordUserIds)(client);
                    break;
                case 'collect-server-stats':
                    await (0, stats_manager_1.collectServerStats)(client);
                    break;
                default:
                    logger_1.default.warn(`[System Worker] Unknown job name: ${job.name}`);
            }
        }
        catch (error) {
            logger_1.default.error(`[System Worker] Job '${job.name}' failed:`, { error });
            throw error; // Re-throw to let BullMQ handle the failure
        }
    }, {
        connection: cache_1.redisOptions,
        concurrency: 1, // System tasks should probably run one at a time
    });
    worker.on('completed', (job) => {
        logger_1.default.info(`[System Worker] Job '${job.name}' (ID: ${job.id}) has completed.`);
    });
    worker.on('failed', (job, err) => {
        logger_1.default.error(`[System Worker] Job '${job?.name}' (ID: ${job?.id}) has failed.`, { error: err });
    });
    // Graceful shutdown is handled by the main process.
    return worker;
};
