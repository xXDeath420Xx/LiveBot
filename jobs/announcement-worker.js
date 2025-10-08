BigInt.prototype.toJSON = function() { return this.toString(); };

const { Worker } = require("bullmq");
const path = require("path");
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Client, GatewayIntentBits, Partials, Events, EmbedBuilder } = require("discord.js");
const logger = require("../utils/logger");
const db = require("../utils/db");
const { redis, redisOptions } = require("../utils/cache"); // Import redisOptions as well
const { updateAnnouncement, getOrCreateWebhook } = require("../utils/announcer");
const { processRole: handleRole } = require("../core/role-manager");

const workerClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.User, Partials.GuildMember, Partials.Channel]
});

// Initialize the logger for this worker process
logger.init(workerClient, db);

// New helper function to clean up old announcements for a specific streamer/platform/channel
async function cleanupOldAnnouncements(client, streamerId, platform, channelId, messageIdToKeep = null) {
    logger.info(`[Worker] Initiating cleanup for streamer ${streamerId} on platform ${platform} in channel ${channelId}. Message to keep: ${messageIdToKeep || 'none'}`);
    try {
        const [oldAnnouncements] = await db.execute(
            `SELECT announcement_id, message_id FROM announcements WHERE streamer_id = ? AND platform = ? AND channel_id = ?`,
            [streamerId, platform, channelId]
        );

        if (oldAnnouncements.length > 0) {
            const webhookClient = await getOrCreateWebhook(client, channelId, null);
            if (!webhookClient) {
                logger.error(`[Worker] Failed to get webhook for channel ${channelId} during cleanup. Cannot delete old messages.`);
                // Continue with DB cleanup even if webhook fails
            }

            for (const oldAnn of oldAnnouncements) {
                if (oldAnn.message_id && oldAnn.message_id !== messageIdToKeep) {
                    if (webhookClient) {
                        try {
                            await webhookClient.deleteMessage(oldAnn.message_id);
                            logger.info(`[Worker] Successfully deleted old Discord message ${oldAnn.message_id} during cleanup.`);
                        } catch (e) {
                            if (e.code === 10008) { // Unknown Message
                                logger.warn(`[Worker] Old Discord message ${oldAnn.message_id} was already deleted. Skipping Discord delete.`);
                            } else {
                                logger.error(`[Worker] Failed to delete old Discord message ${oldAnn.message_id} during cleanup:`, e);
                            }
                        }
                    } else {
                        logger.warn(`[Worker] Skipping Discord message delete for ${oldAnn.message_id} as webhook client is unavailable.`);
                    }
                }
                // Always delete the DB record if it's not the one we intend to keep (if any)
                if (oldAnn.message_id !== messageIdToKeep) {
                    await db.execute('DELETE FROM announcements WHERE announcement_id = ?', [oldAnn.announcement_id]);
                    logger.info(`[Worker] Deleted old announcement DB record ${oldAnn.announcement_id} during cleanup.`);
                }
            }
        }
    } catch (error) {
        logger.error(`[Worker] Error during cleanupOldAnnouncements for streamer ${streamerId}:`, error);
    }
}

// New function for global announcement cleanup at startup
async function globalAnnouncementCleanupAtStartup(client) {
    logger.info('[Worker] Starting global announcement cleanup at startup...');
    try {
        // Find all unique streamer/platform/channel combinations that have multiple announcements
        const [duplicateCombinations] = await db.execute(`
            SELECT streamer_id, platform, channel_id
            FROM announcements
            GROUP BY streamer_id, platform, channel_id
            HAVING COUNT(*) > 1
        `);

        for (const combo of duplicateCombinations) {
            const { streamer_id, platform, channel_id } = combo;
            // Get all announcements for this combination, ordered by newest first
            const [announcementsForCombo] = await db.execute(`
                SELECT announcement_id, message_id
                FROM announcements
                WHERE streamer_id = ? AND platform = ? AND channel_id = ?
                ORDER BY announcement_id DESC
            `, [streamer_id, platform, channel_id]);

            // Keep the newest one (first in the sorted list)
            const messageIdToKeep = announcementsForCombo[0].message_id;

            // Delete all older ones
            for (let i = 1; i < announcementsForCombo.length; i++) {
                const oldAnn = announcementsForCombo[i];
                logger.info(`[Worker] Cleaning up old duplicate announcement ${oldAnn.announcement_id} for streamer ${streamer_id} on platform ${platform} in channel ${channel_id}.`);
                const webhookClient = await getOrCreateWebhook(client, channel_id, null);
                if (webhookClient && oldAnn.message_id) {
                    try {
                        await webhookClient.deleteMessage(oldAnn.message_id);
                        logger.info(`[Worker] Successfully deleted old Discord message ${oldAnn.message_id} during global cleanup.`);
                    } catch (e) {
                        if (e.code === 10008) { // Unknown Message
                            logger.warn(`[Worker] Old Discord message ${oldAnn.message_id} was already deleted during global cleanup. Skipping Discord delete.`);
                        } else {
                            logger.error(`[Worker] Failed to delete old Discord message ${oldAnn.message_id} during global cleanup:`, e);
                        }
                    }
                } else {
                    logger.warn(`[Worker] Skipping Discord message delete for ${oldAnn.message_id} as webhook client is unavailable or message_id is null.`);
                }
                await db.execute('DELETE FROM announcements WHERE announcement_id = ?', [oldAnn.announcement_id]);
                logger.info(`[Worker] Deleted old announcement DB record ${oldAnn.announcement_id} during global cleanup.`);
            }
        }
    } catch (error) {
        logger.error('[Worker] Error during global announcement cleanup:', error);
    }
    logger.info('[Worker] Global announcement cleanup finished.');
}

// New function for global live role cleanup at startup
async function globalLiveRoleCleanupAtStartup(client) {
    logger.info('[Worker] Starting global live role cleanup at startup...');
    try {
        // 1. Get all discord_user_ids that are currently live (have an active announcement)
        const [activeStreamerDiscordIds] = await db.execute(`
            SELECT DISTINCT s.discord_user_id
            FROM announcements a
            JOIN streamers s ON a.streamer_id = s.streamer_id
            WHERE s.discord_user_id IS NOT NULL
        `);
        const currentlyLiveDiscordIds = new Set(activeStreamerDiscordIds.map(row => row.discord_user_id));

        // 2. Get all guilds and their configured live roles
        const [guildsWithLiveRoles] = await db.execute(`
            SELECT guild_id, live_role_id FROM guilds WHERE live_role_id IS NOT NULL
        `);
        const [teamsWithLiveRoles] = await db.execute(`
            SELECT guild_id, live_role_id FROM twitch_teams WHERE live_role_id IS NOT NULL
        `);

        const guildLiveRolesMap = new Map(); // guild_id -> Set<role_id>
        guildsWithLiveRoles.forEach(g => {
            if (!guildLiveRolesMap.has(g.guild_id)) guildLiveRolesMap.set(g.guild_id, new Set());
            guildLiveRolesMap.get(g.guild_id).add(g.live_role_id);
        });
        teamsWithLiveRoles.forEach(t => {
            if (!guildLiveRolesMap.has(t.guild_id)) guildLiveRolesMap.set(t.guild_id, new Set());
            guildLiveRolesMap.get(t.guild_id).add(t.live_role_id);
        });

        // 3. Iterate through all guilds the bot is in and check members
        for (const [guildId, liveRoleIds] of guildLiveRolesMap.entries()) {
            try {
                const guild = await client.guilds.fetch(guildId).catch(() => null);
                if (!guild) {
                    logger.warn(`[Worker] Guild ${guildId} not found during live role cleanup. Skipping.`);
                    continue;
                }

                // Fetch all members to check their roles. This can be a heavy operation for large guilds.
                const members = await guild.members.fetch().catch(e => {
                    logger.error(`[Worker] Failed to fetch members for guild ${guildId} during live role cleanup:`, e);
                    return new Map();
                });

                for (const member of members.values()) {
                    if (member.user.bot) continue; // Skip bots

                    let rolesRemoved = [];
                    for (const liveRoleId of liveRoleIds) {
                        if (member.roles.cache.has(liveRoleId)) {
                            // This member has a live role
                            if (!currentlyLiveDiscordIds.has(member.id)) {
                                // Member has a live role but is not currently streaming via bot announcements
                                await handleRole(member, [liveRoleId], "remove", guildId);
                                rolesRemoved.push(guild.roles.cache.get(liveRoleId)?.name || liveRoleId);
                            }
                        }
                    }
                    if (rolesRemoved.length > 0) {
                        logger.info(`[Worker] Removed inactive live roles (${rolesRemoved.join(', ')}) from ${member.user.tag} in guild ${guild.name}.`);
                    }
                }
            } catch (guildError) {
                logger.error(`[Worker] Error processing guild ${guildId} for live role cleanup:`, guildError);
            }
        }
    } catch (error) {
        logger.error('[Worker] Error during global live role cleanup:', error);
    }
    logger.info('[Worker] Global live role cleanup finished.');
}

const worker = new Worker("announcement-queue", async job => {
    if (!workerClient.isReady()) {
        logger.warn(`[Worker] Discord client not ready when processing job ${job.id}. Retrying...`);
        throw new Error("Discord client not ready");
    }

    const { sub, liveData } = job.data;
    logger.info(`[Worker] Processing job ${job.id} for ${sub.username}.`);

    try {
        const [[guildSettings]] = await db.execute('SELECT announcement_channel_id, members_announcement_channel_id, subscribers_announcement_channel_id, live_role_id, privacy_level FROM guilds WHERE guild_id = ?', [sub.guild_id]);
        const [[teamSettings]] = sub.team_subscription_id ? await db.execute('SELECT announcement_channel_id, members_announcement_channel_id, subscribers_announcement_channel_id, live_role_id, privacy_level FROM twitch_teams WHERE id = ?', [sub.team_subscription_id]) : [[]];
        const [[userPreference]] = sub.discord_user_id ? await db.execute('SELECT privacy_level FROM user_preferences WHERE discord_user_id = ?', [sub.discord_user_id]) : [[]];
        const [[channelSettings]] = sub.announcement_channel_id ? await db.execute('SELECT privacy_level FROM channel_settings WHERE channel_id = ?', [sub.announcement_channel_id]) : [[]];

        const effectivePrivacyLevel = sub.privacy_level || userPreference?.privacy_level || channelSettings?.privacy_level || teamSettings?.privacy_level || guildSettings?.privacy_level || 'public';

        let targetChannelId = null;
        switch (effectivePrivacyLevel) {
            case 'members':
                targetChannelId = teamSettings?.members_announcement_channel_id || guildSettings?.members_announcement_channel_id;
                break;
            case 'subscribers':
                targetChannelId = teamSettings?.subscribers_announcement_channel_id || guildSettings?.subscribers_announcement_channel_id;
                break;
            default:
                targetChannelId = sub.announcement_channel_id || teamSettings?.announcement_channel_id || guildSettings?.announcement_channel_id;
                break;
        }

        if (!targetChannelId) {
            logger.warn(`[Worker] No announcement channel configured for privacy level '${effectivePrivacyLevel}' for subscription ${sub.subscription_id}. Skipping job ${job.id}.`);
            return;
        }

        // Fetch the most recent announcement for this specific streamer, platform, and target channel
        const [existingAnnouncements] = await db.execute(
            `SELECT a.*, ss.start_time FROM announcements a LEFT JOIN stream_sessions ss ON a.announcement_id = ss.announcement_id WHERE a.streamer_id = ? AND a.platform = ? AND a.channel_id = ? ORDER BY a.announcement_id DESC LIMIT 1`,
            [sub.streamer_id, liveData.platform, targetChannelId]
        );
        let existingAnnouncementFromDb = existingAnnouncements[0] || null;

        // Cooldown check
        if (existingAnnouncementFromDb && existingAnnouncementFromDb.message_id) {
            const lastAnnouncementTime = new Date(existingAnnouncementFromDb.start_time).getTime();
            const currentTime = Date.now();
            const COOLDOWN_PERIOD_MS = 5 * 60 * 1000; // 5 minutes

            if (currentTime - lastAnnouncementTime < COOLDOWN_PERIOD_MS) {
                logger.info(`[Worker] Skipping job ${job.id} for ${sub.username} (${liveData.platform}) in channel ${targetChannelId} due to cooldown. Announcement was made recently.`);
                return; // Skip processing this job to prevent spam
            }
        }

        // --- Cleanup Phase ---
        // Before attempting to send/update, ensure only one relevant announcement exists.
        // We pass the message_id of the announcement we *might* want to update, so it's not deleted.
        await cleanupOldAnnouncements(workerClient, sub.streamer_id, liveData.platform, targetChannelId, existingAnnouncementFromDb?.message_id);

        // After cleanup, re-fetch existingAnnouncementFromDb in case it was deleted by cleanup (e.g., if messageIdToKeep was null)
        // or if the original existingAnnouncementFromDb was not the one we wanted to keep (e.g. if it was a duplicate)
        const [recheckedAnnouncements] = await db.execute(
            `SELECT a.*, ss.start_time FROM announcements a LEFT JOIN stream_sessions ss ON a.announcement_id = ss.announcement_id WHERE a.streamer_id = ? AND a.platform = ? AND a.channel_id = ? ORDER BY a.announcement_id DESC LIMIT 1`,
            [sub.streamer_id, liveData.platform, targetChannelId]
        );
        existingAnnouncementFromDb = recheckedAnnouncements[0] || null;


        logger.debug(`[Worker] Before updateAnnouncement for ${sub.username} (Sub ID: ${sub.subscription_id}): existingAnnouncementFromDb = ${existingAnnouncementFromDb ? JSON.stringify(existingAnnouncementFromDb) : 'null'}`);

        let sentMessage = await updateAnnouncement(workerClient, sub, liveData, existingAnnouncementFromDb, guildSettings, channelSettings, teamSettings, targetChannelId);

        logger.debug(`[Worker] After first updateAnnouncement for ${sub.username} (Sub ID: ${sub.subscription_id}): sentMessage = ${sentMessage ? JSON.stringify(sentMessage) : 'null'}`);

        if (sentMessage?.deleted) {
            logger.info(`[Worker] Detected deleted message for ${sub.username} (Sub ID: ${sub.subscription_id}). Attempting re-creation.`);
            // The cleanupOldAnnouncements should have already removed the DB record for the deleted message.
            // Now, try to send a new message since the old one was deleted.
            // No need for another cleanup here, as the previous one should have cleared everything except the one we were trying to keep (if any).
            // Since it was deleted, we now send a brand new message.
            const newSentMessageAfterDeletion = await updateAnnouncement(workerClient, sub, liveData, null, guildSettings, channelSettings, teamSettings, targetChannelId); // Pass null for existingAnnouncement
            
            if (newSentMessageAfterDeletion && newSentMessageAfterDeletion.id && newSentMessageAfterDeletion.channel_id) {
                sentMessage = newSentMessageAfterDeletion;
                logger.info(`[Worker] Successfully re-created announcement for ${sub.username} (Sub ID: ${sub.subscription_id}).`);
            } else {
                logger.error(`[Worker] Failed to re-create announcement for ${sub.username} after original was deleted. Job ${job.id} will not update DB.`);
                return;
            }
        }

        if (sentMessage && sentMessage.id && sentMessage.channel_id) {
            logger.debug(`[Worker] Processing successful message/edit for ${sub.username}. existingAnnouncementFromDb is now: ${existingAnnouncementFromDb ? JSON.stringify(existingAnnouncementFromDb) : 'null'}`);
            if (!existingAnnouncements || existingAnnouncements.length === 0 || existingAnnouncements[0].message_id !== sentMessage.id) { // If it's a new message or message ID changed
                logger.info(`[Worker] Inserting new announcement record for ${sub.username} (Sub ID: ${sub.subscription_id}).`);
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
                    logger.info(`[Worker] Inserted new stream session for announcement ${newAnnouncementId}.`);
                }
            } else {
                logger.info(`[Worker] Updating existing announcement record ${existingAnnouncements[0].announcement_id} for ${sub.username}.`);
                await db.execute(
                    "UPDATE announcements SET message_id = ?, channel_id = ?, stream_game = ?, stream_title = ?, platform = ?, stream_thumbnail_url = ?, stream_url = ? WHERE announcement_id = ?",
                    [sentMessage.id, sentMessage.channel_id, liveData.game || null, liveData.title || null, liveData.platform, liveData.thumbnailUrl || null, liveData.url || null, existingAnnouncements[0].announcement_id]
                );
                // Also update the stream_sessions start_time if it's an update to an existing announcement
                await db.execute(
                    "UPDATE stream_sessions SET start_time = NOW(), game_name = ? WHERE announcement_id = ?",
                    [liveData.game || null, existingAnnouncements[0].announcement_id]
                );
            }

            const rolesToApply = [];
            if (guildSettings?.live_role_id) rolesToApply.push(guildSettings.live_role_id);
            if (teamSettings?.live_role_id) rolesToApply.push(teamSettings.live_role_id);
            const uniqueRolesToApply = [...new Set(rolesToApply)];

            const discordUserId = sub.discord_user_id || (await db.execute('SELECT discord_user_id FROM streamers WHERE streamer_id = ?', [sub.streamer_id]))[0][0]?.discord_user_id;

            if (uniqueRolesToApply.length > 0 && discordUserId) {
                try {
                    const guild = await workerClient.guilds.fetch(sub.guild_id);
                    const member = await guild.members.fetch(discordUserId).catch(() => null);
                    if (member) {
                        await handleRole(member, uniqueRolesToApply, "add", sub.guild_id);
                    }
                } catch (roleError) {
                    logger.error(`[Worker] Failed to apply live roles to ${sub.username} (${discordUserId}) in guild ${sub.guild_id}: ${roleError.message}`);
                }
            }
        } else if (sentMessage === null) {
            logger.warn(`[Worker] updateAnnouncement returned null for job ${job.id} for ${sub.username}. No action taken.`);
        } else {
            logger.error(`[Worker] updateAnnouncement did not return a valid message object (missing id or channel_id) for job ${job.id} for ${sub.username}. No action taken.`);
        }
    } catch (error) {
        logger.error(`[Worker] Job ${job.id} failed for ${sub.username}:`, { error: error.stack });
        throw error;
    }
}, {
    connection: redisOptions, // Use redisOptions here
    limiter: { max: 10, duration: 1000 }
});

worker.on("error", err => logger.error(`[Announcement Worker] Unhandled worker error: ${err.message}`, { error: err }));
workerClient.once(Events.ClientReady, async () => {
    logger.info(`[Announcement Worker] Discord client is ready. Worker is active.`);
    // Perform aggressive cleanup at startup
    await globalAnnouncementCleanupAtStartup(workerClient);
    await globalLiveRoleCleanupAtStartup(workerClient);
});
worker.on("completed", job => logger.info(`[Announcement Worker] Job ${job.id} has completed for ${job.data.sub.username}.`));
worker.on("failed", (job, err) => logger.error(`[Announcement Worker] Job ${job.id} has failed for ${job.data.sub.username} with error: ${err.message}`));

workerClient.login(process.env.DISCORD_TOKEN)
    .then(() => logger.info("[Announcement Worker] Logged in"))
    .catch(err => {
        logger.error("[Announcement Worker] Failed to log in.", { error: err });
        process.exit(1);
    });

async function shutdown(signal) {
    logger.warn(`[Reminder Worker] Received ${signal}. Shutting down...`);
    if (worker) await worker.close();
    await workerClient.destroy();
    await db.end();
    await redis.quit();
    logger.info("[Reminder Worker] Shutdown complete.");
    process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));