const {Worker} = require("bullmq");
const path = require("path");
require("dotenv-flow").config({path: path.resolve(__dirname, "..")}); // Corrected path
const {Client, GatewayIntentBits, Partials, Events} = require("discord.js");
const logger = require("../utils/logger");
const db = require("../utils/db");
const cache = require("../utils/cache"); // ADDED: Import the cache module
const {updateAnnouncement} = require("../utils/announcer");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.User, Partials.GuildMember, Partials.Channel]
});

let worker;

client.once(Events.ClientReady, async () => {
  logger.info(`[Announcement Worker] Discord client is ready. Worker is active.`);

  worker = new Worker("announcements", async job => {
    const {sub, liveData, existing, guildSettings, channelSettings, teamSettings} = job.data;
    logger.info(`[Worker] Processing job ${job.id} for ${sub.username}`);
    try {
      const sentMessage = await updateAnnouncement(client, sub, liveData, existing, guildSettings, channelSettings, teamSettings);

      // Corrected check for sentMessage and its properties
      if (sentMessage && sentMessage.id && sentMessage.channel_id) { // Check for top-level channel_id
        if (!existing) {
          logger.info(`[Worker] CREATED new announcement for ${sub.username}`);
          const [announcementResult] = await db.execute("INSERT INTO announcements (subscription_id, streamer_id, guild_id, message_id, channel_id, stream_game, stream_title, platform, stream_thumbnail_url) VALUES (?,?,?,?,?,?,?,?,?)", [sub.subscription_id, sub.streamer_id, sub.guild_id, sentMessage.id, sentMessage.channel_id, liveData.game || null, liveData.title || null, liveData.platform, liveData.thumbnailUrl || null]);

          const newAnnouncementId = announcementResult.insertId;
          if (newAnnouncementId) {
            await db.execute(
              "INSERT INTO stream_sessions (announcement_id, streamer_id, guild_id, start_time, game_name) VALUES (?, ?, ?, NOW(), ?)",
              [newAnnouncementId, sub.streamer_id, sub.guild_id, liveData.game || null]
            );
            logger.info(`[Stats] Started tracking new stream session for announcement ID: ${newAnnouncementId}`);
          }

        } else if (existing && sentMessage.id !== existing.message_id) {
          logger.info(`[Worker] UPDATED message ID for ${sub.username}`);
          await db.execute("UPDATE announcements SET message_id = ? WHERE announcement_id = ?", [sentMessage.id, existing.announcement_id]);
        }
      } else {
        logger.error(`[Worker] updateAnnouncement did not return a valid message object with ID and channel ID for job ${job.id} for ${sub.username}. Sent message:`, sentMessage);
        // If the message is critical, you might want to throw an error here to trigger retry logic
        // throw new Error('Invalid message object returned from updateAnnouncement');
      }
    } catch (error) {
      logger.error(`[Worker] Job ${job.id} failed for ${sub.username}:`, {error});
      throw error; // Throw error to let BullMQ handle retry logic
    }
  }, {
    connection: {
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: process.env.REDIS_PORT || 6379
    },
    limiter: {
      max: 10,
      duration: 1000
    }
  });

  worker.on("completed", job => {
    logger.info(`[Announcement Worker] Job ${job.id} has completed for ${job.data.sub.username}.`);
  });

  worker.on("failed", (job, err) => {
    logger.error(`[Announcement Worker] Job ${job.id} has failed for ${job.data.sub.username} with error: ${err.message}`);
  });
});

client.login(process.env.DISCORD_TOKEN)
  .then(() => logger.info("[Announcement Worker] Logged in"));

async function shutdown(signal) {
  logger.warn(`[Announcement Worker] Received ${signal}. Shutting down...`);
  if (worker) {
    await worker.close();
  } // Close worker if it was initialized
  await client.destroy();
  await db.end();
  await cache.redis.quit();
  logger.info("[Announcement Worker] Shutdown complete.");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown('SIGTERM'));