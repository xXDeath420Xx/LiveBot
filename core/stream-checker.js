const logger = require("../utils/logger");
const db = require("../utils/db");
const cache = require("../utils/cache");
const apiChecks = require("../utils/api_checks.js");
const { announcementQueue } = require("../jobs/announcement-queue");
const { summaryQueue } = require("../jobs/summary-queue");
const initCycleTLS = require("cycletls");
const { syncTwitchTeam } = require("./team-sync");

let isChecking = false;
let isCheckingTeams = false;
let cycleTLS = null;

async function fetchAndCache(key, fetcher, ttl) {
    let data = await cache.get(key);
    if (data) return data;
    data = await fetcher();
    if (data) await cache.set(key, data, ttl);
    return data;
}

async function checkStreams(client) {
    if (isChecking) return;
    isChecking = true;
    logger.info(`[Check] ---> Starting stream check @ ${new Date().toLocaleTimeString()}`);
    try {
        const [subscriptions] = await db.execute("SELECT sub.*, s.*, s.discord_user_id AS streamer_discord_user_id FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id");
        const [announcementsInDb] = await db.execute(`
            SELECT a1.* FROM announcements a1
                                 JOIN (SELECT subscription_id, MAX(announcement_id) as max_announcement_id FROM announcements GROUP BY subscription_id) a2
                                      ON a1.subscription_id = a2.subscription_id AND a1.announcement_id = a2.max_announcement_id
        `);
        const announcementsMap = new Map(announcementsInDb.map(a => [a.subscription_id, a]));

        const guildSettingsList = await fetchAndCache("db:guilds", () => db.execute("SELECT * FROM guilds").then(res => res[0]), 300);
        const guildSettingsMap = new Map(guildSettingsList.map(g => [g.guild_id, g]));

        if (!cycleTLS) {
            logger.info("[CycleTLS] Shared instance not found for stream check, initializing...");
            cycleTLS = await initCycleTLS({ timeout: 60000 });
        }

        const liveStatusMap = new Map();
        const uniqueStreamers = [...new Map(subscriptions.map(item => [item.streamer_id, item])).values()];

        for (const streamer of uniqueStreamers) {
            try {
                const cacheKey = `api:${streamer.platform}:${streamer.username}`;
                const fetchedLiveData = await fetchAndCache(cacheKey, async () => {
                    if (streamer.platform === "twitch") return apiChecks.checkTwitch(streamer);
                    if (streamer.platform === "kick" && cycleTLS) return apiChecks.checkKick(cycleTLS, streamer.username);
                    if (streamer.platform === "youtube") return apiChecks.checkYouTube(streamer.platform_user_id);
                    return { isLive: false, profileImageUrl: null };
                }, 75);

                if (fetchedLiveData?.profileImageUrl && fetchedLiveData.profileImageUrl !== streamer.profile_image_url) {
                    logger.info(`[Avatar] New avatar found for ${streamer.username} on ${streamer.platform}. URL: ${fetchedLiveData.profileImageUrl}`);
                    if (streamer.platform === 'twitch') {
                        logger.info(`[Avatar] ${streamer.username} is a Twitch streamer. Updating as source of truth.`);
                        // If it's a Twitch avatar, it's the source of truth. Update it.
                        await db.execute("UPDATE streamers SET profile_image_url = ? WHERE streamer_id = ?", [fetchedLiveData.profileImageUrl, streamer.streamer_id]);
                        // If a discord_user_id is present, propagate this avatar to all their linked accounts.
                        if (streamer.discord_user_id) {
                            logger.info(`[Avatar] Propagating Twitch avatar for ${streamer.username} to all linked accounts (Discord ID: ${streamer.discord_user_id}).`);
                            await db.execute("UPDATE streamers SET profile_image_url = ? WHERE discord_user_id = ?", [fetchedLiveData.profileImageUrl, streamer.discord_user_id]);
                        }
                    } else {
                        // For non-Twitch platforms, only update the avatar if it's currently NULL.
                        // This prevents overwriting a valid (potentially Twitch) avatar with a Kick/YouTube one.
                        logger.info(`[Avatar] ${streamer.username} is not a Twitch streamer. Updating only if current avatar is NULL.`);
                        await db.execute("UPDATE streamers SET profile_image_url = ? WHERE streamer_id = ? AND profile_image_url IS NULL", [fetchedLiveData.profileImageUrl, streamer.streamer_id]);
                    }
                }

                if (fetchedLiveData?.isLive) {
                    liveStatusMap.set(streamer.streamer_id, fetchedLiveData);
                }
            } catch (e) {
                logger.error(`[API Check Error] for ${streamer.username} (${streamer.platform}): ${e.message}`);
            }
        }

        const desiredAnnouncementKeys = new Set();
        for (const sub of subscriptions) {
            const liveData = liveStatusMap.get(sub.streamer_id);
            if (!liveData) continue;

            const guildSettings = guildSettingsMap.get(sub.guild_id);
            const targetChannelId = sub.announcement_channel_id || guildSettings?.announcement_channel_id;
            if (!targetChannelId) continue;

            desiredAnnouncementKeys.add(sub.subscription_id);
            const existing = announcementsMap.get(sub.subscription_id);
            await announcementQueue.add(`announcement-${sub.subscription_id}`, { sub, liveData, existing, guildSettings }, { jobId: `announcement-${sub.subscription_id}`, removeOnComplete: true, removeOnFail: 50 });
        }

        for (const [subscription_id, existing] of announcementsMap.entries()) {
            if (!desiredAnnouncementKeys.has(subscription_id)) {
                await db.execute("UPDATE stream_sessions SET end_time = NOW() WHERE announcement_id = ? AND end_time IS NULL", [existing.announcement_id]);
                const guildSettings = guildSettingsMap.get(existing.guild_id);
                if (guildSettings?.enable_stream_summaries) {
                    await summaryQueue.add(`summary-${existing.announcement_id}`, { announcementId: existing.announcement_id });
                } else {
                    const channel = await client.channels.fetch(existing.channel_id).catch(() => null);
                    if (channel) await channel.messages.delete(existing.message_id).catch(() => {});
                }
                await db.execute("DELETE FROM announcements WHERE announcement_id = ?", [existing.announcement_id]);
            }
        }

    } catch (e) {
        logger.error("[checkStreams] CRITICAL ERROR:", { error: e });
        if (e && e.message && String(e.message).toLowerCase().includes('cycletls')) {
            logger.warn("[CycleTLS] Nullifying CycleTLS instance due to stream check error.");
            if (cycleTLS) {
                await cycleTLS.exit().catch(() => {});
            }
            cycleTLS = null;
        }
    } finally {
        isChecking = false;
        logger.info("[Check] ---> Finished stream check");
    }
}

async function checkTeams(client) {
    if (isCheckingTeams) return;
    isCheckingTeams = true;
    logger.info(`[Team Sync] ---> Starting hourly team sync @ ${new Date().toLocaleTimeString()}`);
    try {
        if (!cycleTLS) {
            logger.info("[CycleTLS] Shared instance not found for team sync, initializing...");
            cycleTLS = await initCycleTLS({ timeout: 60000 });
        }
        const [teamSubscriptions] = await db.execute("SELECT id FROM twitch_teams");
        if (teamSubscriptions.length === 0) {
            logger.info("[Team Sync] No teams are subscribed for syncing.");
        } else {
            logger.info(`[Team Sync] Found ${teamSubscriptions.length} teams to sync.`);
            for (const sub of teamSubscriptions) {
                await syncTwitchTeam(sub.id, db, apiChecks, logger, cycleTLS, client); // Pass client here
            }
        }
    } catch (error) {
        logger.error("[Team Sync] CRITICAL ERROR during hourly sync:", { error: error });
        if (error && error.message && String(error.message).toLowerCase().includes('cycletls')) {
            logger.warn("[CycleTLS] Nullifying CycleTLS instance due to team sync error.");
            if (cycleTLS) {
                await cycleTLS.exit().catch(() => {});
            }
            cycleTLS = null;
        }
    } finally {
        isCheckingTeams = false;
        logger.info("[Team Sync] ---> Finished hourly team sync.");
    }
}

module.exports = { checkStreams, checkTeams };