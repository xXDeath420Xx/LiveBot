const {Worker} = require("bullmq");
const path = require("path");
require("dotenv-flow").config({path: path.resolve(__dirname, "..")}); // Corrected path
const {Client, GatewayIntentBits, Partials, EmbedBuilder, Events} = require("discord.js");
const logger = require("../utils/logger");
const db = require("../utils/db");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel]
});

function formatDuration(seconds) {
  if (seconds < 60) {
    return `${Math.floor(seconds)} seconds`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

let worker;

client.once(Events.ClientReady, () => {
  logger.info(`[Summary Worker] Discord client is ready. Worker is active.`);

  worker = new Worker("stream-summary", async job => {
    const {announcementId} = job.data;
    logger.info(`[Summary Worker] Processing summary for announcement ID: ${announcementId}`);

    try {
      const [[session]] = await db.execute("SELECT * FROM stream_sessions WHERE announcement_id = ?", [announcementId]);
      if (!session || !session.end_time) {
        logger.warn(`[Summary Worker] No completed session found for announcement ID: ${announcementId}`);
        return;
      }

      const [[announcement]] = await db.execute("SELECT * FROM announcements WHERE announcement_id = ?", [announcementId]);
      if (!announcement) {
        logger.warn(`[Summary Worker] No announcement record found for ID: ${announcementId}`);
        return;
      }

      const channel = await client.channels.fetch(announcement.channel_id).catch(() => null);
      if (!channel) {
        logger.warn(`[Summary Worker] Could not fetch channel ${announcement.channel_id}. Message might be in a deleted channel.`);
        return;
      }

      const message = await channel.messages.fetch(announcement.message_id).catch((err) => {
        logger.error(`[Summary Worker] Failed to fetch message ${announcement.message_id} in channel ${announcement.channel_id}:`, {error: err.message});
        return null;
      });
      if (!message || !message.embeds[0]) {
        logger.warn(`[Summary Worker] Message ${announcement.message_id} not found or has no embed. Cannot post summary.`);
        return;
      }

      const durationSeconds = (new Date(session.end_time) - new Date(session.start_time)) / 1000;
      const summaryText = `Stream ended. Total duration: **${formatDuration(durationSeconds)}**.`;

      const originalEmbed = message.embeds[0];
      const summaryEmbed = new EmbedBuilder(originalEmbed)
        .setAuthor(null)
        .setTitle(`Summary of ${originalEmbed.author?.name || announcement.stream_title || "Stream"}`)
        .setDescription(summaryText)
        .setTimestamp(new Date(session.end_time));

      await message.edit({embeds: [summaryEmbed]});
      logger.info(`[Summary Worker] Successfully posted summary for announcement ID: ${announcementId}`);

    } catch (error) {
      logger.error(`[Summary Worker] Job ${job.id} failed:`, {error});
      throw error;
    }
  }, {
    connection: {
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: process.env.REDIS_PORT || 6379
    }
  });

  worker.on("completed", job => {
    logger.info(`[Summary Worker] Job ${job.id} has completed.`);
  });

  worker.on("failed", (job, err) => {
    logger.error(`[Summary Worker] Job ${job.id} has failed with error: ${err.message}`);
  });
});

client.login(process.env.DISCORD_TOKEN);

async function shutdown(signal) {
  logger.warn(`[Summary Worker] Received ${signal}. Shutting down...`);
  if (worker) {
    await worker.close();
  }
  await client.destroy();
  await db.end();
  logger.info("[Summary Worker] Shutdown complete.");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown('SIGTERM'));