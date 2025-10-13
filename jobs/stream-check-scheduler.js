const { Queue } = require("bullmq");
const logger = require("../utils/logger");
const { redisOptions } = require("../utils/cache");

const TEAM_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const OLD_STREAM_CHECK_JOB_ID = "check-all-streams";
const TEAM_SYNC_JOB_ID = "sync-all-teams";

const systemQueue = new Queue("system-tasks", { connection: redisOptions });

async function setupSystemJobs() {
  logger.info("[Scheduler] Setting up system jobs and cleaning up old ones...");
  try {
    const repeatableJobs = await systemQueue.getRepeatableJobs();

    // Aggressively find and remove any old, conflicting stream check jobs.
    for (const job of repeatableJobs) {
        if (job.id === OLD_STREAM_CHECK_JOB_ID || job.name === 'check-streams') {
            await systemQueue.removeRepeatableByKey(job.key);
            logger.warn(`[Scheduler] Found and removed obsolete job '${job.name}' (ID: ${job.id}).`);
        }
    }

    // Ensure the team sync job is scheduled if it doesn't exist
    const teamSyncJob = repeatableJobs.find(job => job.id === TEAM_SYNC_JOB_ID);
    if (!teamSyncJob) {
        await systemQueue.add("sync-teams", {}, {
            jobId: TEAM_SYNC_JOB_ID,
            repeat: {
              every: TEAM_SYNC_INTERVAL_MS,
            },
            removeOnComplete: true,
            removeOnFail: 10,
          });
        logger.info(`[Scheduler] Repeatable job '${TEAM_SYNC_JOB_ID}' scheduled.`);
    }

  } catch (error) {
    logger.error("[Scheduler] Failed during system job setup:", { error: error.stack });
  }
}

module.exports = { setupSystemJobs };