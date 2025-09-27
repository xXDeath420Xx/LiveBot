const { Queue } = require("bullmq");
const logger = require("../utils/logger");
require("dotenv-flow").config();

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const JOB_ID = "sync-all-user-ids";

const systemQueue = new Queue("system-tasks", {
  connection: {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: process.env.REDIS_PORT || 6379,
  },
});

async function addUserSyncJob() {
  logger.info("[Scheduler] Setting up repeatable job for user ID syncs...");
  try {
    await systemQueue.add("sync-users", {}, {
      jobId: JOB_ID,
      repeat: {
        every: CHECK_INTERVAL_MS,
      },
      removeOnComplete: true,
      removeOnFail: 50,
    });
    logger.info(`[Scheduler] Repeatable job '${JOB_ID}' scheduled to run every ${CHECK_INTERVAL_MS / 1000 / 3600} hours.`);
  } catch (error) {
    logger.error("[Scheduler] Failed to add user sync job:", { error });
  }
}

(async () => {
  await addUserSyncJob();
  await systemQueue.close();
  logger.info("[Scheduler] User sync scheduler finished and disconnected.");
  process.exit(0);
})();