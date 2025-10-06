const { Worker } = require("bullmq");
const path = require("path");
require("dotenv-flow").config({ path: path.resolve(__dirname, "..") });
const { Client, GatewayIntentBits, Partials, Events } = require("discord.js");
const logger = require("../utils/logger");
const db = require("../utils/db");
const cache = require("../utils/cache");
const { checkStreams, checkTeams } = require("../core/stream-checker");
const { syncDiscordUserIds } = require("../core/user-sync");
const { collectServerStats } = require("../core/stats-manager");

// This worker has its own client to perform its tasks independently.
const workerClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel],
});

let worker;

workerClient.once(Events.ClientReady, async (c) => {
  logger.info(`[System Worker] Discord client is ready as ${c.user.tag}. Worker is active.`);

  worker = new Worker("system-tasks", async (job) => {
    logger.info(`[System Worker] Processing job '${job.name}' (ID: ${job.id}).`);
    try {
      switch (job.name) {
        case "check-streams":
          await checkStreams(workerClient);
          break;
        case "sync-teams":
          await checkTeams(workerClient);
          break;
        case "sync-users":
          await syncDiscordUserIds(workerClient);
          break;
        case "collect-server-stats":
          await collectServerStats();
          break;
        default:
          logger.warn(`[System Worker] Unknown job name: ${job.name}`);
      }
    } catch (error) {
      logger.error(`[System Worker] Job '${job.name}' failed:`, { error });
      throw error; // Re-throw to let BullMQ handle the failure
    }
  }, {
    connection: {
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: process.env.REDIS_PORT || 6379,
    },
    // High concurrency to allow different system tasks to run in parallel if needed
    concurrency: 5, 
  });

  worker.on("completed", (job) => {
    logger.info(`[System Worker] Job '${job.name}' (ID: ${job.id}) has completed.`);
  });

  worker.on("failed", (job, err) => {
    logger.error(`[System Worker] Job '${job.name}' (ID: ${job.id}) has failed with error: ${err.message}`);
  });
});

workerClient.login(process.env.DISCORD_TOKEN)
  .then(() => logger.info("[System Worker] Logging in..."));

async function shutdown(signal) {
  logger.warn(`[System Worker] Received ${signal}. Shutting down...`);
  if (worker) {
    await worker.close();
  }
  await workerClient.destroy();
  await db.end();
  await cache.redis.quit();
  logger.info("[System Worker] Shutdown complete.");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));