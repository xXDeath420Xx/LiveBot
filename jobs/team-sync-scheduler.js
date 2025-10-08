const { Queue } = require("bullmq");
const logger = require("../utils/logger");
const path = require("path");
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { redisOptions } = require("../utils/cache");

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const JOB_ID = "sync-all-teams";

const systemQueue = new Queue("system-tasks", { connection: redisOptions });

async function addTeamSyncJob() {
  logger.info("[Scheduler] Setting up repeatable job for team syncs...");
  try {
    await systemQueue.add("sync-teams", {}, {
      jobId: JOB_ID,
      repeat: {
        every: CHECK_INTERVAL_MS,
      },
      removeOnComplete: true,
      removeOnFail: 50,
    });
    logger.info(`[Scheduler] Repeatable job '${JOB_ID}' scheduled to run every ${CHECK_INTERVAL_MS / 1000 / 60} minutes.`);
  } catch (error) {
    logger.error("[Scheduler] Failed to add team sync job:", { error });
  }
}

(async () => {
  await addTeamSyncJob();
  await systemQueue.close();
  logger.info("[Scheduler] Team sync scheduler finished and disconnected.");
  process.exit(0);
})();