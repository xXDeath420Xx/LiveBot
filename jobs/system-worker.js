const { Worker } = require("bullmq");
const path = require("path");
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const logger = require("../utils/logger");
const db = require("../utils/db");
const { redisOptions } = require("../utils/cache");
const { checkStreams, checkTeams } = require("../core/stream-checker");
const { syncDiscordUserIds } = require("../core/user-sync");
const { collectServerStats } = require("../core/stats-manager");

// Export a function that takes the main client instance
module.exports = function startSystemWorker(client) {
  // The logger is initialized in the main index.js file. DO NOT re-initialize it here.

  logger.info(`[System Worker] Initializing BullMQ worker.`);

  const worker = new Worker("system-tasks", async (job) => {
    logger.info(`[System Worker] Processing job '${job.name}' (ID: ${job.id}).`);
    try {
      switch (job.name) {
        case "check-streams":
          await checkStreams(client);
          break;
        case "sync-teams":
          await checkTeams(client);
          break;
        case "sync-users":
          await syncDiscordUserIds(client);
          break;
        case "collect-server-stats":
          await collectServerStats(client);
          break;
        default:
          logger.warn(`[System Worker] Unknown job name: ${job.name}`);
      }
    } catch (error) {
      logger.error(`[System Worker] Job '${job.name}' failed:`, { error });
      throw error; // Re-throw to let BullMQ handle the failure
    }
  }, {
    connection: redisOptions,
    concurrency: 1, // System tasks should probably run one at a time
  });

  worker.on("completed", (job) => {
    logger.info(`[System Worker] Job '${job.name}' (ID: ${job.id}) has completed.`);
  });

  worker.on("failed", (job, err) => {
    logger.error(`[System Worker] Job '${job.name}' (ID: ${job.id}) has failed.`, { error: err });
  });

  // Graceful shutdown is handled by the main process.

  return worker;
};