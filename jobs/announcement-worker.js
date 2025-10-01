// B:/Code/LiveBot/jobs/announcement-worker.js - Updated on 2025-10-01 - Unique Identifier: WORKER-FINAL-002
BigInt.prototype.toJSON = function() { return this.toString(); };

const { Worker } = require("bullmq");
const path = require("path");
require("dotenv-flow").config({ path: path.resolve(__dirname, "..") });
const { Client, GatewayIntentBits, Partials, Events } = require("discord.js");
const logger = require("../utils/logger");
const db = require("../utils/db");
const { redis } = require("../utils/cache");
const { updateAnnouncement } = require("../utils/announcer");
const { handleRole } = require("../core/role-manager");

const workerClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.User, Partials.GuildMember, Partials.Channel]
});

const worker = new Worker("announcement-queue", async job => {
    console.log(`[Worker] >>> ENTERING JOB PROCESSING for job ${job.id}`);

    if (!workerClient.isReady()) {
        logger.warn(`[Worker] Discord client not ready when processing job ${job.id}. Retrying...`);
        throw new Error("Discord client not ready");
    }

    const { sub, liveData } = job.data;
    logger.info(`[Worker] Processing job ${job.id} for ${sub.username}.`);

    try {
        const [guildSettingsArr] = await db.execute('SELECT * FROM guilds WHERE guild_id = ?', [sub.guild_id]);
        const guildSettings = guildSettingsArr[0];

        let teamSettings = null;
        if (sub.team_subscription_id) {
            const [teamSettingsArr] = await db.execute('SELECT * FROM twitch_teams WHERE id = ?', [sub.team_subscription_id]);
            teamSettings = teamSettingsArr[0];
        }

        const targetChannelId = sub.announcement_channel_id || teamSettings?.announcement_channel_id || guildSettings?.announcement_channel_id;

        if (!targetChannelId) {
            logger.warn(`[Worker] No announcement channel resolved for subscription ${sub.subscription_id} (${sub.username}). Skipping job ${job.id}.`);
            return;
        }

        const [channelTeamSettingsArr] = await db.execute('SELECT * FROM twitch_teams WHERE announcement_channel_id = ?', [targetChannelId]);
        if (channelTeamSettingsArr.length > 0) {
            teamSettings = channelTeamSettingsArr[0];
            logger.info(`[Worker] Target channel ${targetChannelId} is a team channel. Using settings for team ID ${teamSettings.id}.`);
        }

        const [existingAnnouncementsForStreamerInChannel] = await db.execute(
            `SELECT * FROM announcements WHERE streamer_id = ? AND platform = ? AND channel_id = ?`,
            [sub.streamer_id, liveData.platform, targetChannelId]
        );
        const existingAnnouncementFromDb = existingAnnouncementsForStreamerInChannel[0] || null;

        logger.debug(`[Worker] DB lookup for streamer ${sub.streamer_id} (${liveData.platform}) in channel ${targetChannelId} found existing: ${!!existingAnnouncementFromDb}`);

        const sentMessage = await updateAnnouncement(workerClient, sub, liveData, existingAnnouncementFromDb, guildSettings, null, teamSettings);

        if (sentMessage && sentMessage.id && sentMessage.channel_id) {
            if (!existingAnnouncementFromDb) {
                logger.info(`[Worker] CREATED new announcement for ${sub.username} in channel ${targetChannelId}. Message ID: ${sentMessage.id}`);
                const [announcementResult] = await db.execute(
                    "INSERT INTO announcements (subscription_id, streamer_id, guild_id, message_id, channel_id, stream_game, stream_title, platform, stream_thumbnail_url, stream_url) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    [sub.subscription_id, sub.streamer_id, sub.guild_id, sentMessage.id, sentMessage.channel_id, liveData.game || null, liveData.title || null, liveData.platform, liveData.thumbnailUrl || null, liveData.url || null]
                );
                const newAnnouncementId = announcementResult.insertId;
                if (newAnnouncementId) {
                    await db.execute(
                        "INSERT INTO stream_sessions (announcement_id, streamer_id, guild_id, start_time, game_name) VALUES (?, ?, ?, NOW(), ?)",
                        [newAnnouncementId, sub.streamer_id, sub.guild_id, liveData.game || null]
                    );
                    logger.info(`[Stats] Started tracking new stream session for announcement ID: ${newAnnouncementId}`);
                }
            } else {
                logger.info(`[Worker] Updating existing announcement for ${sub.username} in channel ${targetChannelId}. Announcement ID: ${existingAnnouncementFromDb.announcement_id}`);
                await db.execute(
                    "UPDATE announcements SET subscription_id = ?, message_id = ?, channel_id = ?, stream_game = ?, stream_title = ?, platform = ?, stream_thumbnail_url = ?, stream_url = ? WHERE announcement_id = ?",
                    [sub.subscription_id, sentMessage.id, sentMessage.channel_id, liveData.game || null, liveData.title || null, liveData.platform, liveData.thumbnailUrl || null, liveData.url || null, existingAnnouncementFromDb.announcement_id]
                );
            }

            const rolesToApply = [];
            if (guildSettings?.live_role_id) {
                rolesToApply.push(guildSettings.live_role_id);
            }
            if (teamSettings?.live_role_id) { // Use the final teamSettings
                rolesToApply.push(teamSettings.live_role_id);
            }
            const uniqueRolesToApply = [...new Set(rolesToApply)];

            const discordUserId = sub.discord_user_id || (await db.execute('SELECT discord_user_id FROM streamers WHERE streamer_id = ?', [sub.streamer_id]))[0][0]?.discord_user_id;

            if (uniqueRolesToApply.length > 0 && discordUserId) {
                try {
                    const guild = await workerClient.guilds.fetch(sub.guild_id);
                    const member = await guild.members.fetch(discordUserId).catch(() => null);
                    if (member) {
                        await handleRole(member, uniqueRolesToApply, "add", sub.guild_id);
                        logger.info(`[Worker] Applied live roles ${uniqueRolesToApply.join(', ')} to ${member.user.tag} in guild ${sub.guild_id}.`);
                    } else {
                        logger.warn(`[Worker] Could not find member ${discordUserId} in guild ${sub.guild_id} to apply live roles.`);
                    }
                } catch (roleError) {
                    logger.error(`[Worker] Failed to apply live roles to ${sub.username} (${discordUserId}) in guild ${sub.guild_id}: ${roleError.message}`);
                }
            }
        } else {
            logger.error(`[Worker] updateAnnouncement did not return a valid message object for job ${job.id} for ${sub.username}.`);
        }
    } catch (error) {
        console.error(`[Worker] Job ${job.id} failed for ${sub.username}:`, { error: error.stack });
        throw error;
    }
}, {
    connection: redis,
    limiter: { max: 10, duration: 1000 }
});

logger.info("[Announcement Worker] BullMQ Worker instantiated and listening for jobs.");

worker.on("error", err => logger.error(`[Announcement Worker] Unhandled worker error: ${err.message}`, { error: err }));
workerClient.once(Events.ClientReady, () => logger.info(`[Announcement Worker] Discord client is ready. Worker is active.`));
worker.on("completed", job => logger.info(`[Announcement Worker] Job ${job.id} has completed for ${job.data.sub.username}.`));
worker.on("failed", (job, err) => logger.error(`[Announcement Worker] Job ${job.id} has failed for ${job.data.sub.username} with error: ${err.message}`));

workerClient.login(process.env.DISCORD_TOKEN).then(() => logger.info("[Announcement Worker] Logged in"));

async function shutdown(signal) {
    logger.warn(`[Announcement Worker] Received ${signal}. Shutting down...`);
    if (worker) await worker.close();
    await workerClient.destroy();
    await db.end();
    await redis.quit();
    logger.info("[Announcement Worker] Shutdown complete.");
    process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
