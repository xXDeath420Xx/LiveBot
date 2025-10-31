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
Object.defineProperty(exports, "__esModule", { value: true });
const bullmq_1 = require("bullmq");
const logger_1 = __importDefault(require("../utils/logger"));
const dotenvFlow = __importStar(require("dotenv-flow"));
dotenvFlow.config();
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const JOB_ID = 'sync-all-user-ids';
const systemQueue = new bullmq_1.Queue('system-tasks', {
    connection: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: Number(process.env.REDIS_PORT) || 6379,
    },
});
async function addUserSyncJob() {
    logger_1.default.info('[Scheduler] Setting up repeatable job for user ID syncs...');
    try {
        await systemQueue.add('sync-users', {}, {
            jobId: JOB_ID,
            repeat: {
                every: CHECK_INTERVAL_MS,
            },
            removeOnComplete: true,
            removeOnFail: 50,
        });
        logger_1.default.info(`[Scheduler] Repeatable job '${JOB_ID}' scheduled to run every ${CHECK_INTERVAL_MS / 1000 / 3600} hours.`);
    }
    catch (error) {
        logger_1.default.error('[Scheduler] Failed to add user sync job:', { error });
    }
}
(async () => {
    await addUserSyncJob();
    await systemQueue.close();
    logger_1.default.info('[Scheduler] User sync scheduler finished and disconnected.');
    process.exit(0);
})();
