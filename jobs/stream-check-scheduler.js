const { Queue } = require("bullmq");
const logger = require("../utils/logger");
const { redisOptions } = require("../utils/cache");

const STREAM_CHECK_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const TEAM_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const STREAM_CHECK_JOB_ID = "check-all-streams";
const TEAM_SYNC_JOB_ID = "sync-all-teams";

const systemQueue = new Queue("system-tasks", { connection: redisOptions });

async function setupSystemJobs() {
  logger.info("[Scheduler] Setting up system jobs...");
  try {
    const repeatableJobs = await systemQueue.getRepeatableJobs();

    // Clear existing jobs to ensure we have the correct schedule
    for (const job of repeatableJobs) {
        if (job.id === STREAM_CHECK_JOB_ID || job.id === TEAM_SYNC_JOB_ID) {
            await systemQueue.removeRepeatableByKey(job.key);
        }
    }

    await systemQueue.add("check-streams", {}, {
      jobId: STREAM_CHECK_JOB_ID,
      repeat: {
        every: STREAM_CHECK_INTERVAL_MS,
      },
      removeOnComplete: true,
      removeOnFail: 50,
    });
    logger.info(`[Scheduler] Repeatable job '${STREAM_CHECK_JOB_ID}' scheduled.`);

    await systemQueue.add("sync-teams", {}, {
        jobId: TEAM_SYNC_JOB_ID,
        repeat: {
          every: TEAM_SYNC_INTERVAL_MS,
        },
        removeOnComplete: true,
        removeOnFail: 10,
      });
    logger.info(`[Scheduler] Repeatable job '${TEAM_SYNC_JOB_ID}' scheduled.`);

  } catch (error) {
    logger.error("[Scheduler] Failed to add system jobs:", { error: error.stack });
  }
}

module.exports = { setupSystemJobs };