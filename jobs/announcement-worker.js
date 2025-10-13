BigInt.prototype.toJSON = function() { return this.toString(); };

const { Worker } = require("bullmq");
const path = require("path");
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const logger = require("../utils/logger");
const db = require("../utils/db");
const { redisOptions } = require("../utils/cache");
const { updateAnnouncement, getAndUpdateWebhook } = require("../utils/announcer");
const { processRole: handleRole } = require("../core/role-manager");

module.exports = function startAnnouncementWorker(client) {
    // The logger is initialized in the main index.js file. DO NOT re-initialize it here.
    logger.info('[Announcement Worker] Initializing BullMQ Worker.');

    async function cleanupOldAnnouncements(discordClient, subscriptionId, messageIdToKeep = null) {
        try {
            const [oldAnnouncements] = await db.execute(
                `SELECT announcement_id, message_id, channel_id FROM announcements WHERE subscription_id = ?`,
                [subscriptionId]
            );

            for (const oldAnn of oldAnnouncements) {
                if (oldAnn.message_id && oldAnn.message_id !== messageIdToKeep) {
                    const webhookClient = await getAndUpdateWebhook(discordClient, oldAnn.channel_id);
                    if (webhookClient) {
                        await webhookClient.deleteMessage(oldAnn.message_id).catch(e => {
                            if (e.code !== 10008) logger.warn(`[Worker] Failed to delete old message ${oldAnn.message_id}.`, { error: e });
                        });
                    }
                }
                if (oldAnn.message_id !== messageIdToKeep) {
                    await db.execute('DELETE FROM announcements WHERE announcement_id = ?', [oldAnn.announcement_id]);
                }
            }
        } catch (error) {
            logger.error(`[Worker] Error during cleanupOldAnnouncements for subscription ${subscriptionId}:`, { error });
        }
    }

    const announcementWorker = new Worker("announcement-queue", async job => {
        if (!client.isReady()) {
            logger.warn(`[Worker] Discord client not ready. Retrying job ${job.id}...`);
            throw new Error("Discord client not ready");
        }

        const { sub, liveData } = job.data;
        logger.info(`[Worker] Processing job ${job.id} for ${sub.username}.`, { guildId: sub.guild_id });

        try {
            const [[guildSettings]] = await db.execute('SELECT * FROM guilds WHERE guild_id = ?', [sub.guild_id]);
            const [[teamSettings]] = sub.team_subscription_id ? await db.execute('SELECT * FROM twitch_teams WHERE id = ?', [sub.team_subscription_id]) : [[null]];

            let targetChannelId = sub.announcement_channel_id;
            if (sub.team_subscription_id && teamSettings) {
                targetChannelId = teamSettings.announcement_channel_id;
            }

            if (!targetChannelId) {
                logger.warn(`[Worker] No announcement channel found for subscription ${sub.subscription_id}. Skipping.`, { guildId: sub.guild_id });
                return;
            }

            const [[channelSettings]] = await db.execute('SELECT * FROM channel_settings WHERE channel_id = ?', [targetChannelId]);

            const [existingAnnouncements] = await db.execute(
                `SELECT * FROM announcements WHERE subscription_id = ? AND channel_id = ? ORDER BY announcement_id DESC LIMIT 1`,
                [sub.subscription_id, targetChannelId]
            );
            let existingAnnouncementFromDb = existingAnnouncements[0] || null;

            await cleanupOldAnnouncements(client, sub.subscription_id, existingAnnouncementFromDb?.message_id);

            const sentMessage = await updateAnnouncement(client, sub, liveData, existingAnnouncementFromDb, guildSettings, channelSettings, teamSettings, targetChannelId);

            if (sentMessage && sentMessage.id && sentMessage.channel_id) {
                const query = existingAnnouncementFromDb
                    ? "UPDATE announcements SET message_id = ?, stream_game = ?, stream_title = ?, stream_thumbnail_url = ? WHERE announcement_id = ?"
                    : "INSERT INTO announcements (subscription_id, streamer_id, guild_id, message_id, channel_id, stream_game, stream_title, platform, stream_thumbnail_url, stream_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
                const params = existingAnnouncementFromDb
                    ? [sentMessage.id, liveData.game || null, liveData.title || null, liveData.thumbnailUrl || null, existingAnnouncementFromDb.announcement_id]
                    : [sub.subscription_id, sub.streamer_id, sub.guild_id, sentMessage.id, sentMessage.channel_id, liveData.game || null, liveData.title || null, liveData.platform, liveData.thumbnailUrl || null, liveData.url || null];

                await db.execute(query, params);

                const rolesToApply = [...new Set([guildSettings?.live_role_id, teamSettings?.live_role_id, sub.live_role_id].filter(Boolean))];
                if (rolesToApply.length > 0 && sub.discord_user_id) {
                    const guild = await client.guilds.fetch(sub.guild_id).catch(() => null);
                    if (guild) {
                        const member = await guild.members.fetch(sub.discord_user_id).catch(() => null);
                        if (member) await handleRole(member, rolesToApply, "add", sub.guild_id);
                    }
                }
            }
        } catch (error) {
            logger.error(`[Worker] Job ${job.id} failed for ${sub.username}:`, { error: error.message, stack: error.stack, guildId: sub.guild_id });
            throw error;
        }
    }, { connection: redisOptions, concurrency: 10 });

    announcementWorker.on("error", (err) => logger.error('[Announcement Worker] Worker error:', { error: err }));
    announcementWorker.on("completed", job => logger.info(`[Announcement Worker] Job ${job.id} has completed for ${job.data.sub.username}.`));
    announcementWorker.on("failed", (job, err) => logger.error(`[Announcement Worker] Job ${job?.id} for ${job?.data?.sub?.username} has failed.`, { error: err }));

    return announcementWorker;
};