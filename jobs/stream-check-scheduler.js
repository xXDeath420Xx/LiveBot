"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupSystemJobs = setupSystemJobs;
const bullmq_1 = require("bullmq");
const logger_1 = __importDefault(require("../utils/logger"));
const cache_1 = require("../utils/cache");
const TEAM_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const STREAM_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute - check streams frequently for accurate live status
const OLD_STREAM_CHECK_JOB_ID = 'check-all-streams';
const NEW_STREAM_CHECK_JOB_ID = 'check-streamers-recurring';
const TEAM_SYNC_JOB_ID = 'sync-all-teams';
const systemQueue = new bullmq_1.Queue('system-tasks', { connection: cache_1.redisOptions });
async function setupSystemJobs() {
    logger_1.default.info('[Scheduler] Setting up system jobs and cleaning up old ones...');
    try {
        const repeatableJobs = await systemQueue.getRepeatableJobs();
        // Aggressively find and remove any old, conflicting stream check jobs.
        for (const job of repeatableJobs) {
            if (job.id === OLD_STREAM_CHECK_JOB_ID || job.name === 'check-streams') {
                await systemQueue.removeRepeatableByKey(job.key);
                logger_1.default.warn(`[Scheduler] Found and removed obsolete job '${job.name}' (ID: ${job.id}).`);
            }
        }
        // Ensure the stream check job is scheduled
        const streamCheckJob = repeatableJobs.find((job) => job.id === NEW_STREAM_CHECK_JOB_ID);
        if (!streamCheckJob) {
            await systemQueue.add('check-streamers', {}, {
                jobId: NEW_STREAM_CHECK_JOB_ID,
                repeat: {
                    every: STREAM_CHECK_INTERVAL_MS,
                },
                removeOnComplete: true,
                removeOnFail: 10,
            });
            logger_1.default.info(`[Scheduler] Repeatable job '${NEW_STREAM_CHECK_JOB_ID}' scheduled (every ${STREAM_CHECK_INTERVAL_MS / 1000}s).`);
        }
        else {
            logger_1.default.info(`[Scheduler] Stream check job already scheduled.`);
        }
        // Ensure the team sync job is scheduled if it doesn't exist
        const teamSyncJob = repeatableJobs.find((job) => job.id === TEAM_SYNC_JOB_ID);
        if (!teamSyncJob) {
            await systemQueue.add('sync-teams', {}, {
                jobId: TEAM_SYNC_JOB_ID,
                repeat: {
                    every: TEAM_SYNC_INTERVAL_MS,
                },
                removeOnComplete: true,
                removeOnFail: 10,
            });
            logger_1.default.info(`[Scheduler] Repeatable job '${TEAM_SYNC_JOB_ID}' scheduled.`);
        }
        else {
            logger_1.default.info(`[Scheduler] Team sync job already scheduled.`);
        }
    }
    catch (error) {
        logger_1.default.error('[Scheduler] Failed during system job setup:', { error: error.stack });
    }
}
// Initialize scheduler on startup
setupSystemJobs().catch((error) => {
    logger_1.default.error('[Scheduler] Fatal error during initialization:', { error: error.stack });
    process.exit(1);
});
