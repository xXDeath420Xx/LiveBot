const { Queue } = require("bullmq");
const logger = require("../utils/logger");
require("dotenv-flow").config();

const CHECK_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const JOB_ID = "check-all-streams";

const systemQueue = new Queue("system-tasks", {
  connection: {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: process.env.REDIS_PORT || 6379,
  },
});

async function addStreamCheckJob() {
  logger.info("[Scheduler] Setting up repeatable job for stream checks...");
  try {
    await systemQueue.add("check-streams", {}, {
      jobId: JOB_ID,
      repeat: {
        every: CHECK_INTERVAL_MS,
      },
      removeOnComplete: true,
      removeOnFail: 50,
    });
    logger.info(`[Scheduler] Repeatable job '${JOB_ID}' scheduled to run every ${CHECK_INTERVAL_MS / 1000} seconds.`);
  } catch (error) {
    logger.error("[Scheduler] Failed to add stream check job:", { error });
  }
}

(async () => {
  await addStreamCheckJob();
  await systemQueue.close();
  logger.info("[Scheduler] Stream check scheduler finished and disconnected.");
  process.exit(0);
})();