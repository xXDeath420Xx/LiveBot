import cron from 'node-cron';
import logger from '../utils/logger.js';
import { getLiveAnnouncements, updateOfflineCheckCount, deleteAnnouncementFromDatabase, saveAnnouncementToDatabase, embedContentChanged, updateAnnouncementContentState } from '../core/stream-manager.js';
import { updateAnnouncement, deleteAnnouncement, editAnnouncementStreamEnded, describeAnnouncementEdit } from '../utils/announcer.js';
import { resolveStyle as resolveRenderStyle } from '../core/stream-render-style.js';
import pool from '../utils/db.js';
import platformCache from '../utils/platformCache.js';

// Platform API modules
import * as twitchApi from '../utils/platforms/twitch.js';
import * as kickApi from '../utils/platforms/kick.js';
import * as youtubeApi from '../utils/platforms/youtube.js';
import * as tiktokApi from '../utils/platforms/tiktok.js';

const platformModules = {
    twitch: twitchApi,
    kick: kickApi,
    youtube: youtubeApi,
    tiktok: tiktokApi,
};

let schedulerTask = null;
// One pass at a time. Without this, a pass that hangs on one announcement keeps running while
// cron starts the next one every 5 minutes, and each stuck pass used to pin a DB connection:
// on 2026-11-10 that leaked one connection per pass from 23:25 until the 30-connection pool
// was gone at 01:18, and the dashboard and every DB-backed job failed with "Queue limit reached".
let passRunning = false;
let passStartedAt = 0;
// A single announcement may not hold up the pass longer than this. The work it was doing is
// not cancelled, but the pass moves on and the log names the stage it was stuck in.
const ENTRY_TIMEOUT_MS = 60_000;
// A post that keeps timing out is logged once, with the reason, then counted until it updates again
// (H-311: 374 identical ERROR lines in one night for 8 posts in one channel).
const timedOut = new Map(); // announcement key -> { count, firstAt, stage }

function withTimeout(promise, ms, onTimeout) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(onTimeout())), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

/**
 * Start the announcement updater scheduler
 * Runs every 5 minutes to update existing stream announcements with current viewer counts
 * Supports multi-bot system - updates announcements for all bots
 */
export function startAnnouncementUpdater(client) {
    if (schedulerTask) {
        logger.warn('[Announcement Updater] Scheduler is already running', { category: 'streams' });
        return;
    }

    // Run every 5 minutes — iterate the shared announcement Map ONCE with proper client resolution
    // (iterating per-bot caused double-processing since all bots share the same Map)
    schedulerTask = cron.schedule('*/5 * * * *', async () => {
        if (passRunning) {
            logger.warn('[Announcement Updater] Previous pass still running — skipping this one', {
                category: 'streams', runningForSec: Math.round((Date.now() - passStartedAt) / 1000)
            });
            return;
        }
        passRunning = true;
        passStartedAt = Date.now();
        logger.info('[Announcement Updater] Running scheduled announcement update', { category: 'streams' });

        try {
            await updateLiveAnnouncements(client);
        } catch (error) {
            logger.error('[Announcement Updater] Error during scheduled update:', { error, category: 'streams' });
        } finally {
            passRunning = false;
        }
    });

    logger.info('[Announcement Updater] Scheduler started (every 5 minutes, multi-bot support enabled)', { category: 'streams' });
}

/**
 * Stop the announcement updater scheduler
 */
export function stopAnnouncementUpdater() {
    if (schedulerTask) {
        schedulerTask.stop();
        schedulerTask = null;
        logger.info('[Announcement Updater] Scheduler stopped', { category: 'streams' });
    } else {
        logger.warn('[Announcement Updater] No scheduler running to stop', { category: 'streams' });
    }
}

/**
 * Update all live announcements with current stream data
 */
async function updateLiveAnnouncements(client) {
    const liveAnnouncements = getLiveAnnouncements();

    if (liveAnnouncements.size === 0) {
        logger.info('[Announcement Updater] No live announcements to update', { category: 'streams' });
        return;
    }

    logger.debug(`[Announcement Updater] Updating ${liveAnnouncements.size} live announcements`, { category: 'streams' });

    // Posts that ended while timing out leave nothing to recover.
    for (const key of timedOut.keys()) if (!liveAnnouncements.has(key)) timedOut.delete(key);

    try {
        for (const [key, announcement] of liveAnnouncements.entries()) {
            const stage = { at: 'start', client: null, channelId: null };
            try {
              await withTimeout((async () => {
                const api = platformModules[announcement.platform];
                if (!api) {
                    logger.warn(`[Announcement Updater] No API module for platform: ${announcement.platform}`, {
                        category: 'streams'
                    });
                    return;
                }

                // Extract guild_id and channel_id from the key: "guildId-platform-username-channelId"
                const keyParts = key.split('-');
                const guildId = keyParts[0];
                const channelId = keyParts[keyParts.length - 1];

                // Check if still live using the shared platform cache
                // (same cache the stream-check-scheduler uses — prevents conflicting API results)
                stage.at = 'isLive';
                const isLive = await platformCache.get(
                    announcement.platform,
                    'isLive',
                    announcement.username,
                    () => api.isStreamerLive(announcement.username)
                );

                if (!isLive) {
                    // Stream appears offline — DO NOT handle cleanup here.
                    // The stream-check-scheduler is the single authority for offline detection
                    // and announcement cleanup. If we also do it here, the two systems race
                    // and cause false "stream ended" → new post duplicates.
                    logger.info(`[Announcement Updater] ${announcement.username} appears offline — skipping embed update (stream checker handles cleanup)`, {
                        category: 'streams', guildId
                    });
                    return;
                }

                stage.at = 'getStreamDetails';
                const streamData = await api.getStreamDetails(announcement.username);
                if (!streamData) {
                    logger.warn(`[Announcement Updater] Could not get stream details for ${announcement.username}`, {
                        category: 'streams'
                    });
                    return;
                }

                // Nothing in the embed changes on its own, so an unchanged title/category means
                // there is nothing to rewrite. Going offline is handled above, not here.
                //
                // Two exceptions, both about the look rather than the content: the announcement is
                // drawn in a style that is no longer the configured one, or it is a platform
                // preview, whose whole point is that the frame keeps moving.
                stage.at = 'resolveRenderStyle';
                const renderStyle = (await resolveRenderStyle({
                    guildId,
                    channelId,
                    streamerId: announcement.streamerId,
                })).style;
                const restyleNeeded = announcement.renderStyle !== renderStyle;

                if (!embedContentChanged(announcement, streamData) && !restyleNeeded && renderStyle !== 'twitch') return;

                // Get subscription and guild settings
                stage.at = 'subscriptionQuery';
                const [subscriptions] = await pool.query(
                    `SELECT sub.*, s.profile_image_url, s.discord_user_id
                     FROM subscriptions sub
                     JOIN streamers s ON sub.streamer_id = s.streamer_id
                     WHERE sub.guild_id = ? AND s.streamer_id = ?`,
                    [guildId, announcement.streamerId]
                );

                if (subscriptions.length === 0) return;

                const subscription = subscriptions[0];

                const [guildSettings] = await pool.query(
                    'SELECT * FROM guilds WHERE guild_id = ?',
                    [guildId]
                );

                if (guildSettings.length === 0) return;

                // Build platform URL
                const platformUrls = {
                    twitch: `https://twitch.tv/${announcement.username}`,
                    kick: `https://kick.com/${announcement.username}`,
                    youtube: `https://youtube.com/channel/${announcement.username}`,
                    tiktok: `https://tiktok.com/@${announcement.username}`,
                    facebook: `https://facebook.com/gaming/${announcement.username}`,
                };

                const platformUrl = platformUrls[announcement.platform] || `https://${announcement.platform}.com/${announcement.username}`;

                const subContext = {
                    streamer_id: announcement.streamerId,
                    username: announcement.username,
                    guild_id: guildId,
                    profile_image_url: subscription.profile_image_url,
                    custom_message: subscription.custom_message,
                    override_nickname: subscription.override_nickname,
                    override_avatar_url: subscription.override_avatar_url,
                    post_as_streamer: subscription.post_as_streamer ?? null,
                    discord_user_id: subscription.discord_user_id
                };

                const liveData = {
                    game: streamData.game_name || null,
                    title: streamData.title || null,
                    thumbnailUrl: streamData.thumbnail_url || null,
                    platform: announcement.platform,
                    url: platformUrl,
                    username: announcement.username,
                    profileImageUrl: subscription.profile_image_url || null,
                    viewerCount: streamData.viewer_count || 0,
                    startedAt: streamData.started_at || null
                };

                const existingAnnouncement = { message_id: announcement.messageId };

                // Get the correct bot client for this guild (supports multi-bot system)
                const guildClient = global.botManager ? global.botManager.getClientForGuild(guildId) : client;
                stage.client = guildClient;
                stage.channelId = channelId;

                // Update the announcement
                stage.at = 'updateAnnouncement(discord)';
                const updated = await updateAnnouncement(
                    guildClient,
                    subContext,
                    liveData,
                    existingAnnouncement,
                    guildSettings[0],
                    null,
                    null,
                    channelId
                );

                // null: the edit was held back (edit already running in this channel, rate limit,
                // edit budget, viewers-only change too soon) or failed. Keep the old state so the
                // next pass tries again; recording it here would hide a title change for good.
                if (!updated) return;

                // If the tracked message was gone, updateAnnouncement posts a NEW one and
                // returns it with a different id. We MUST persist that new id back to the
                // shared in-memory Map AND the DB — otherwise the next cycle keeps editing the
                // stale (deleted) id, 10008s, and reposts a fresh message every 5 minutes forever.
                if (updated?.id && updated.id !== announcement.messageId) {
                    announcement.messageId = updated.id; // mutate the shared Map value in place
                    if (updated.pingMessageId !== undefined && updated.pingMessageId !== null) {
                        announcement.pingMessageId = updated.pingMessageId;
                    }
                    stage.at = 'saveAnnouncement';
                    await saveAnnouncementToDatabase(
                        guildId,
                        announcement.platform,
                        announcement.username,
                        channelId,
                        updated.id,
                        announcement.streamerId,
                        subscription.discord_user_id,
                        null,
                        subscription.delete_on_end ?? 1,
                        subscription.edit_on_end ?? 0,
                        announcement.pingMessageId ?? null
                    );
                    logger.warn(`[Announcement Updater] Re-tracked ${announcement.username} to new message ${updated.id} after resend (old message was gone)`, {
                        category: 'streams', guildId, channelId
                    });
                }

                // Record what the embed now shows, in the shared Map and the DB, so the next
                // pass can tell nothing moved and skip the edit entirely.
                announcement.lastTitle = streamData.title || null;
                announcement.lastGame = streamData.game_name || null;
                // The style has to be persisted here too. Omitting it does not merely skip the
                // column — updateAnnouncementContentState writes render_style unconditionally, so
                // leaving it out NULLs whatever stream-manager recorded, and every pass then sees
                // a style mismatch and edits the message again forever.
                announcement.renderStyle = renderStyle;
                stage.at = 'contentState';
                await updateAnnouncementContentState(
                    guildId, announcement.platform, announcement.username, channelId,
                    announcement.lastTitle, announcement.lastGame, renderStyle
                );

                logger.debug(`[Announcement Updater] ${updated.unchanged ? 'Nothing to change for' : 'Updated announcement for'} ${announcement.username}`, {
                    category: 'streams',
                    viewers: streamData.viewer_count
                });
                const recovered = timedOut.get(key);
                if (recovered) {
                    timedOut.delete(key);
                    logger.info(`[Announcement Updater] ${announcement.username} is updating again after ${recovered.count} timed-out pass(es) since ${new Date(recovered.firstAt).toISOString()}`, {
                        category: 'streams', guildId, channelId
                    });
                }
              })(), ENTRY_TIMEOUT_MS, () => `timed out after ${ENTRY_TIMEOUT_MS / 1000}s at stage "${stage.at}" (key ${key})`);
            } catch (error) {
                if (String(error.message).startsWith('timed out after')) {
                    const seen = timedOut.get(key);
                    if (seen) {
                        seen.count++;
                        logger.debug(`[Announcement Updater] ${announcement.username} timed out again (${seen.count}x, ${stage.at})`, { category: 'streams' });
                    } else {
                        timedOut.set(key, { count: 1, firstAt: Date.now(), stage: stage.at });
                        let why = `stuck at ${stage.at}`;
                        if (stage.at === 'updateAnnouncement(discord)' && stage.client) {
                            why = `Discord did not answer the edit: ${describeAnnouncementEdit(stage.client, stage.channelId, announcement.messageId)}`;
                        } else if (stage.at === 'getStreamDetails' || stage.at === 'isLive') {
                            why = `the ${announcement.platform} API did not answer`;
                        }
                        logger.warn(`[Announcement Updater] ${announcement.username}'s live post did not update within ${ENTRY_TIMEOUT_MS / 1000}s: ${why}. Further timeouts for this post are counted, not logged, until it updates again`, {
                            category: 'streams', key, stage: stage.at
                        });
                    }
                } else {
                    logger.error(`[Announcement Updater] Error updating announcement for ${announcement.username}:`, {
                        error: error.message,
                        category: 'streams'
                    });
                }
            }
        }

    } catch (error) {
        logger.error('[Announcement Updater] Error during announcement update process:', {
            error,
            category: 'streams'
        });
    }
}
