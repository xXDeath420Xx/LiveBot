// Monkey-patch BigInt to allow serialization
BigInt.prototype.toJSON = function() { return this.toString(); };

const {Worker} = require("bullmq");
const path = require("path");
require("dotenv-flow").config({path: path.resolve(__dirname, "..")}); // Corrected path
const {Client, GatewayIntentBits, Partials, Events} = require("discord.js");
const logger = require("../utils/logger");
const db = require("../utils/db");
const cache = require("../utils/cache");
const {updateAnnouncement} = require("../utils/announcer");
const {handleRole} = require("../core/role-manager"); // Import handleRole

// This is the worker's own Discord client instance.
const workerClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.User, Partials.GuildMember, Partials.Channel]
});

let worker;

// The worker will only start processing jobs once its own client is ready.
workerClient.once(Events.ClientReady, async () => {
  logger.info(`[Announcement Worker] Discord client is ready. Worker is active.`);

  worker = new Worker("announcements", async job => {
    const {sub, liveData, existing, guildSettings, teamSettings} = job.data;
    logger.info(`[Worker] Processing job ${job.id} for ${sub.username}`);
    try {
      const sentMessage = await updateAnnouncement(workerClient, sub, liveData, existing, guildSettings, teamSettings);

      if (sentMessage && sentMessage.id && sentMessage.channel_id) {
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

          // --- REFACTORED ROLE LOGIC ---
          // Determine the correct live role ID to apply. Team roles take precedence.
          const roleIdToApply = (sub.team_subscription_id && teamSettings?.live_role_id)
            ? teamSettings.live_role_id
            : guildSettings?.live_role_id;

          // Apply live role if a role is configured and the streamer has a Discord ID
          if (roleIdToApply && sub.discord_user_id) {
            try {
              const guild = await workerClient.guilds.fetch(sub.guild_id);
              const member = await guild.members.fetch(sub.discord_user_id).catch(e => {
                if (e.code === 10007) return null; // Ignore "Unknown Member" errors
                throw e;
              });

              if (member) {
                await handleRole(member, [roleIdToApply], "add", sub.guild_id);
                logger.info(`[Worker] Applied live role ${roleIdToApply} to ${member.user.tag} in guild ${sub.guild_id}.`);
              } else {
                logger.warn(`[Worker] Could not find member ${sub.discord_user_id} in guild ${sub.guild_id} to apply live role.`);
              }
            } catch (roleError) {
              logger.error(`[Worker] Failed to apply live role to ${sub.username} (${sub.discord_user_id}) in guild ${sub.guild_id}: ${roleError.message}`);
            }
          }
          // --- END REFACTORED ROLE LOGIC ---

        } else if (existing && sentMessage.id !== existing.message_id) {
          logger.info(`[Worker] UPDATED message ID for ${sub.username}`);
          await db.execute("UPDATE announcements SET message_id = ? WHERE announcement_id = ?", [sentMessage.id, existing.announcement_id]);
        }
      } else {
        logger.error(`[Worker] updateAnnouncement did not return a valid message object with ID and channel ID for job ${job.id} for ${sub.username}. Sent message:`, sentMessage);
      }
    } catch (error) {
      logger.error(`[Worker] Job ${job.id} failed for ${sub.username}:`, {error});
      throw error;
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

workerClient.login(process.env.DISCORD_TOKEN)
  .then(() => logger.info("[Announcement Worker] Logged in"));

async function shutdown(signal) {
  logger.warn(`[Announcement Worker] Received ${signal}. Shutting down...`);
  if (worker) {
    await worker.close();
  }
  await workerClient.destroy();
  await db.end();
  await cache.redis.quit();
  logger.info("[Announcement Worker] Shutdown complete.");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));