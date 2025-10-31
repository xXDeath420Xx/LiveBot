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
const db_1 = __importDefault(require("../utils/db"));
const dotenvFlow = __importStar(require("dotenv-flow"));
dotenvFlow.config();
const VOD_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const vodQueue = new bullmq_1.Queue('vod-uploads', {
    connection: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: Number(process.env.REDIS_PORT) || 6379,
    },
});
async function scheduleVODChecks() {
    logger_1.default.info('[VOD Scheduler] Setting up repeatable jobs for VOD checks...');
    try {
        // Find all unique streamers who have VOD notifications enabled for either platform in at least one subscription
        const [streamersToTrack] = await db_1.default.execute(`
        SELECT s.streamer_id, s.platform, s.platform_user_id, s.username
        FROM streamers s
        JOIN subscriptions sub ON s.streamer_id = sub.streamer_id
        WHERE s.platform IN ('youtube', 'tiktok') AND (sub.youtube_vod_notifications = 1 OR sub.tiktok_vod_notifications = 1)
        GROUP BY s.streamer_id
    `);
        // Clear out old repeatable jobs that may no longer be valid
        const repeatableJobs = await vodQueue.getRepeatableJobs();
        const activeJobIds = new Set(streamersToTrack.map((s) => `vod-check-${s.streamer_id}`));
        for (const job of repeatableJobs) {
            if (job.id && !activeJobIds.has(job.id)) {
                await vodQueue.removeRepeatableByKey(job.key);
            }
        }
        // Add new repeatable jobs
        for (const streamer of streamersToTrack) {
            const jobId = `vod-check-${streamer.streamer_id}`;
            await vodQueue.add('check-vod', { streamer }, {
                jobId: jobId,
                repeat: { every: VOD_CHECK_INTERVAL_MS },
                removeOnComplete: true,
                removeOnFail: 50,
            });
        }
        logger_1.default.info(`[VOD Scheduler] Sync complete. Tracking VODs for ${streamersToTrack.length} streamers.`);
    }
    catch (error) {
        logger_1.default.error('[VOD Scheduler] Failed to schedule VOD check jobs:', { error });
    }
}
(async () => {
    await scheduleVODChecks();
    await vodQueue.close();
    logger_1.default.info('[VOD Scheduler] VOD check scheduler finished and disconnected.');
    process.exit(0);
})();
