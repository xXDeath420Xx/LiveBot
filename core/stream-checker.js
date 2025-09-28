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
        const [subscriptions, announcementsInDb, guildSettingsList, teamSettingsList] = await Promise.all([
            db.execute("SELECT sub.*, s.*, s.discord_user_id AS streamer_discord_user_id FROM subscriptions sub JOIN streamers s ON sub.streamer_id = s.streamer_id").then(res => res[0]),
            db.execute(`
                SELECT a1.* FROM announcements a1
                JOIN (SELECT subscription_id, MAX(announcement_id) as max_announcement_id FROM announcements GROUP BY subscription_id) a2
                ON a1.subscription_id = a2.subscription_id AND a1.announcement_id = a2.max_announcement_id
            `).then(res => res[0]),
            fetchAndCache("db:guilds", () => db.execute("SELECT * FROM guilds").then(res => res[0]), 300),
            fetchAndCache("db:twitch_teams", () => db.execute("SELECT * FROM twitch_teams").then(res => res[0]), 300),
        ]);

        const announcementsMap = new Map(announcementsInDb.map(a => [a.subscription_id, a]));
        const guildSettingsMap = new Map(guildSettingsList.map(g => [g.guild_id, g]));
        const teamSettingsMap = new Map(teamSettingsList.map(t => [t.id, t]));

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
                    if (streamer.platform === "facebook") return apiChecks.checkFacebook(streamer.username);
                    if (streamer.platform === "instagram") return apiChecks.checkInstagram(streamer.username);
                    return { isLive: false, profileImageUrl: null };
                }, 75);

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
            const teamSettings = sub.team_subscription_id ? teamSettingsMap.get(sub.team_subscription_id) : null;

            if (liveData.platform === 'youtube') {
                const visibilitySetting = sub.youtube_visibility_level || guildSettings?.youtube_visibility_level || 'public';
                if (visibilitySetting === 'public' && liveData.visibility === 'members-only') {
                    logger.info(`[Check] Skipping members-only YouTube stream for ${sub.username} in guild ${sub.guild_id} as per settings.`);
                    continue;
                }
            }

            const targetChannelId = sub.announcement_channel_id || teamSettings?.announcement_channel_id || guildSettings?.announcement_channel_id;
            if (!targetChannelId) continue;

            desiredAnnouncementKeys.add(sub.subscription_id);
            const existing = announcementsMap.get(sub.subscription_id);
            await announcementQueue.add(`announcement-${sub.subscription_id}`, { sub, liveData, existing, guildSettings, teamSettings }, { jobId: `announcement-${sub.subscription_id}`, removeOnComplete: true, removeOnFail: 50 });
        }

        // --- BATCH OFFLINE PROCESSING ---
        const endedAnnouncements = [];
        for (const [subscription_id, existing] of announcementsMap.entries()) {
            if (!desiredAnnouncementKeys.has(subscription_id)) {
                endedAnnouncements.push(existing);
            }
        }

        if (endedAnnouncements.length > 0) {
            const endedAnnouncementIds = endedAnnouncements.map(a => a.announcement_id);
            logger.info(`[Check] Found ${endedAnnouncementIds.length} streams that have ended. Processing cleanup.`);

            // Batch update stream sessions
            await db.execute(`UPDATE stream_sessions SET end_time = NOW() WHERE announcement_id IN (?) AND end_time IS NULL`, [endedAnnouncementIds]);

            // Handle summaries or message deletions in parallel
            const cleanupPromises = endedAnnouncements.map(existing => {
                const guildSettings = guildSettingsMap.get(existing.guild_id);
                if (guildSettings?.enable_stream_summaries) {
                    return summaryQueue.add(`summary-${existing.announcement_id}`, { announcementId: existing.announcement_id });
                } else {
                    return client.channels.fetch(existing.channel_id)
                        .then(channel => {
                            if (channel) {
                                return channel.messages.delete(existing.message_id).catch(err => {
                                    if (err.code !== 10008) { // Ignore "Unknown Message" errors
                                        logger.warn(`[Check] Could not delete announcement message ${existing.message_id}: ${err.message}`);
                                    }
                                });
                            }
                        })
                        .catch(() => { /* Ignore channel fetch errors */ });
                }
            });
            await Promise.all(cleanupPromises);

            // Batch delete announcements from the DB
            await db.execute(`DELETE FROM announcements WHERE announcement_id IN (?)`, [endedAnnouncementIds]);
            logger.info(`[Check] Cleaned up ${endedAnnouncementIds.length} ended stream announcements from the database.`);
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
            logger.info(`[Team Sync] Found ${teamSubscriptions.length} teams to sync. Running in parallel...`);
            const syncPromises = teamSubscriptions.map(sub => syncTwitchTeam(sub.id, db, apiChecks, logger, cycleTLS));
            await Promise.all(syncPromises);
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