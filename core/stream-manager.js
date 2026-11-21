import pool from '../utils/db.js';
import * as twitchApi from '../utils/platforms/twitch.js';
import * as kickApi from '../utils/platforms/kick.js';
import * as youtubeApi from '../utils/platforms/youtube.js';
import * as tiktokApi from '../utils/platforms/tiktok.js';
import * as rumbleApi from '../utils/platforms/rumble.js';
import logger from '../utils/logger.js';
import { updateAnnouncement, deleteAnnouncement, editAnnouncementStreamEnded } from '../utils/announcer.js';
import { reportRoleAssignmentFailure } from './role-hierarchy-notifier.js';
import platformCache from '../utils/platformCache.js';
import { resolveRoutedChannel } from './live-channel-routing.js';
import { resolveStyle as resolveRenderStyle } from './stream-render-style.js';
import { recordObservation, closeStaleSessions } from './stream-session-recorder.js';
import { recordLiveRoleGrant, forgetLiveRoleGrant, cleanupLeftoverLiveRoles } from './live-role-grants.js';
import { attachGoLiveFilters, goLivePasses } from './stream-alert-filters.js';
import { dropBlockedSubscriptions } from './streamer-blocklist.js';


// Platform backoff tracking for rate limit handling
const platformBackoff = new Map();
const BACKOFF_INITIAL_MS = 60000; // 1 minute initial backoff
const BACKOFF_MAX_MS = 900000; // 15 minutes max backoff
const BACKOFF_RESET_AFTER_MS = 300000; // Reset backoff after 5 minutes of success

/**
 * Check if a platform is currently in backoff period
 * @param {string} platform - Platform name
 * @returns {boolean} True if platform should be skipped
 */
function isPlatformInBackoff(platform) {
    const state = platformBackoff.get(platform);
    if (!state) return false;

    const now = Date.now();
    if (now < state.backoffUntil) {
        logger.warn(`[Stream Manager] Skipping ${platform} - in backoff until ${new Date(state.backoffUntil).toISOString()}`, {
            category: 'streams',
            platform,
            remainingMs: state.backoffUntil - now
        });
        return true;
    }
    return false;
}

/**
 * Record a platform API failure and apply exponential backoff
 * @param {string} platform - Platform name
 * @param {Error} error - The error that occurred
 */
function recordPlatformFailure(platform, error) {
    const state = platformBackoff.get(platform) || {
        consecutiveFailures: 0,
        currentBackoffMs: BACKOFF_INITIAL_MS,
        backoffUntil: 0,
        lastSuccess: 0
    };

    state.consecutiveFailures++;
    state.currentBackoffMs = Math.min(state.currentBackoffMs * 2, BACKOFF_MAX_MS);
    state.backoffUntil = Date.now() + state.currentBackoffMs;

    platformBackoff.set(platform, state);

    logger.warn(`[Stream Manager] Platform ${platform} failure #${state.consecutiveFailures}, backoff for ${state.currentBackoffMs}ms`, {
        category: 'streams',
        platform,
        error: error.message,
        backoffMs: state.currentBackoffMs,
        backoffUntil: new Date(state.backoffUntil).toISOString()
    });
}

/**
 * Record a platform API success and reset backoff if needed
 * @param {string} platform - Platform name
 */
function recordPlatformSuccess(platform) {
    const state = platformBackoff.get(platform);
    if (!state) return;

    const now = Date.now();

    // Reset backoff after sustained success
    if (now - state.lastSuccess > BACKOFF_RESET_AFTER_MS) {
        state.consecutiveFailures = 0;
        state.currentBackoffMs = BACKOFF_INITIAL_MS;
    }

    state.lastSuccess = now;
    state.backoffUntil = 0;
    platformBackoff.set(platform, state);
}

// In-memory state tracking for live announcements
const liveAnnouncements = new Map();

// Re-announcement cooldown: after an announcement is cleaned up (edited/deleted),
// don't post a new one for the same streamer/guild/channel for this many minutes.
// Prevents duplicates from Twitch API hiccups causing false offline→online cycles.
const RE_ANNOUNCE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
const reAnnounceCooldowns = new Map(); // key: announcementKey → timestamp of cleanup

// Note: Cycle counting moved to stream-check-scheduler.js to count per-cron-cycle, not per-bot-call

// Grace period for offline detection (require N consecutive offline checks before deleting)
// Twitch/Kick APIs can flicker "offline" for 5+ minutes during hiccups.
// 6 checks × 1-min cron = 6 minutes before we believe a stream is truly offline.
const OFFLINE_GRACE_PERIOD = 6;

// Age-based failsafe for announcements that got stuck (cleanup failed, bot crashed, etc.)
// Only applies to announcements that have accumulated offline checks — NOT live streams.
const MAX_ANNOUNCEMENT_AGE_MINUTES = 30; // 30 minutes with offline checks = definitely offline

// Hard ceiling for a single streamer's live check. The YouTube module drives a
// headless browser (page.goto, 45s each, sometimes twice) and can occasionally
// hang past its own timeouts; without this guard one stuck check freezes the whole
// serial cycle and every streamer after it never gets checked. 90s comfortably
// covers a legitimate two-goto YouTube check while still bounding a true hang.
const PER_STREAMER_TIMEOUT_MS = 90_000;

// Platform API modules mapping
const platformModules = {
    twitch: twitchApi,
    kick: kickApi,
    youtube: youtubeApi,
    tiktok: tiktokApi,
    rumble: rumbleApi,
};

// Tracks platforms we've already warned about as unsupported. Without this,
// a bad row like platform='twitter' produces an ERROR every check cycle —
// 29 per hour in the wild — and drowns out real errors.
const _unsupportedPlatformsWarned = new Set();

// Load active announcements from database on startup
async function loadAnnouncementsFromDatabase() {
    let connection;
    try {
        connection = await pool.getConnection();
        const [rows] = await connection.query('SELECT * FROM live_announcements');

        for (const row of rows) {
            const key = `${row.guild_id}-${row.platform}-${row.username}-${row.channel_id}`;
            liveAnnouncements.set(key, {
                messageId: row.message_id,
                pingMessageId: row.ping_message_id || null,
                streamerId: row.streamer_id,
                platform: row.platform,
                username: row.username,
                discordUserId: row.discord_user_id,
                deleteOnEnd: row.delete_on_end || false,
                editOnEnd: row.edit_on_end || false,
                offlineCheckCount: row.offline_check_count || 0, // Load persisted counter from database
                createdAt: row.created_at, // Track creation time for age-based cleanup
                lastTitle: row.last_title ?? null, // What the embed currently shows — see shouldRefreshEmbed()
                lastGame: row.last_game ?? null,
                renderStyle: row.render_style ?? null // Which look it was drawn with — see needsRestyle()
            });
        }

        logger.info(`Loaded ${rows.length} active announcements from database`, { category: "streams" });
    } catch (error) {
        // If table doesn't exist yet, just log a warning
        if (error.code === 'ER_NO_SUCH_TABLE') {
            logger.warn('live_announcements table does not exist yet. Run migration to create it.', { category: "streams" });
        } else {
            logger.error('Failed to load announcements from database:', { error, category: "streams" });
        }
    } finally {
        if (connection) connection.release();
    }
}

// Clean up orphaned announcements (announcements with no matching subscription)
async function cleanupOrphanedAnnouncements(client) {
    let connection;
    try {
        connection = await pool.getConnection();

        // Find announcements that have no matching subscription
        const [orphaned] = await connection.query(`
            SELECT la.*
            FROM live_announcements la
            LEFT JOIN subscriptions s ON la.streamer_id = s.streamer_id AND la.guild_id = s.guild_id
            WHERE s.subscription_id IS NULL
        `);

        logger.info(`Found ${orphaned.length} orphaned announcements to clean up`, { category: "streams" });

        for (const announcement of orphaned) {
            try {
                // Delete the Discord message (use correct bot client for multi-bot guilds)
                const guildClient = (global.botManager ? global.botManager.getClientForGuild(announcement.guild_id) : null) || client;
                const deleteSuccess = await deleteAnnouncement(guildClient, announcement.channel_id, announcement.message_id);
                // Also delete ping message if it exists
                if (announcement.ping_message_id) {
                    deleteAnnouncement(guildClient, announcement.channel_id, announcement.ping_message_id).catch(() => {});
                }

                // Best-effort Discord delete — proceed with DB cleanup regardless
                // (subscription was removed, so the DB record must go either way)

                // Remove from in-memory tracking
                const key = `${announcement.guild_id}-${announcement.platform}-${announcement.username}-${announcement.channel_id}`;
                liveAnnouncements.delete(key);

                // Delete from database
                await connection.query(
                    'DELETE FROM live_announcements WHERE id = ?',
                    [announcement.id]
                );

                logger.info(`Cleaned up orphaned announcement for ${announcement.username} in guild ${announcement.guild_id}`, {
                    category: "streams",
                    streamerId: announcement.streamer_id,
                    messageId: announcement.message_id
                });
            } catch (error) {
                logger.error(`Failed to clean up orphaned announcement ${announcement.id}:`, {
                    error,
                    category: "streams"
                });
            }
        }

        logger.info(`Orphaned announcement cleanup complete. Removed ${orphaned.length} announcements.`, { category: "streams" });
    } catch (error) {
        if (error.code !== 'ER_NO_SUCH_TABLE') {
            logger.error('Failed to clean up orphaned announcements:', { error, category: "streams" });
        }
    } finally {
        if (connection) connection.release();
    }
}

// Clean up untracked Discord messages (messages in channel but not in database)
// When deep=true (startup), scans full channel history instead of just recent pages
async function cleanupUntrackedDiscordMessages(client, { deep = false } = {}) {
    let connection;
    try {
        connection = await pool.getConnection();

        // Get all announcement channels with guild_id (separate queries to avoid collation conflicts)
        const [gChannels] = await connection.query('SELECT DISTINCT announcement_channel_id, guild_id FROM guilds WHERE announcement_channel_id IS NOT NULL');
        const [gcChannels] = await connection.query('SELECT DISTINCT announcement_channel_id, guild_id FROM guild_config WHERE announcement_channel_id IS NOT NULL');
        const [tChannels] = await connection.query('SELECT DISTINCT announcement_channel_id, NULL AS guild_id FROM twitch_teams WHERE announcement_channel_id IS NOT NULL');
        const [sChannels] = await connection.query('SELECT DISTINCT announcement_channel_id, guild_id FROM subscriptions WHERE announcement_channel_id IS NOT NULL');
        // Include cross-network notification target channels (unified community channels)
        const [cnChannels] = await connection.query('SELECT DISTINCT target_channel_id AS announcement_channel_id, target_guild_id AS guild_id FROM cross_network_notifications WHERE enabled = 1').catch(() => [[]]);

        // Deduplicate in JS
        const channelSet = new Set();
        const channels = [];
        for (const row of [...gChannels, ...gcChannels, ...tChannels, ...sChannels, ...cnChannels]) {
            const key = `${row.guild_id}:${row.announcement_channel_id}`;
            if (!channelSet.has(key)) {
                channelSet.add(key);
                channels.push(row);
            }
        }

        // Build per-guild edit_on_end majority map (determines cleanup behavior)
        const [subSettings] = await connection.query(`
            SELECT guild_id,
                   SUM(edit_on_end = 1) AS edit_count,
                   COUNT(*) AS total
            FROM subscriptions
            GROUP BY guild_id
        `);
        const guildEditOnEnd = {};
        for (const row of subSettings) {
            guildEditOnEnd[row.guild_id] = Number(row.edit_count) > Number(row.total) / 2;
        }

        // Build set of all our bot user IDs for matching bot-direct messages
        const ourBotIds = new Set();
        if (client.user?.id) ourBotIds.add(client.user.id);
        if (global.botManager?.clients) {
            for (const [, botClient] of global.botManager.clients.entries()) {
                if (botClient.user?.id) ourBotIds.add(botClient.user.id);
            }
        }

        logger.info(`Checking ${channels.length} announcement channels for untracked messages (${deep ? 'deep scan' : 'normal'})`, { category: "streams" });

        let totalDeleted = 0;
        let totalEdited = 0;

        for (const { announcement_channel_id, guild_id } of channels) {
            try {
                // Use the correct bot client for this guild (custom bots can't be reached by the default client)
                const guildClient = (guild_id && global.botManager)
                    ? (global.botManager.getClientForGuild(guild_id) || client)
                    : client;

                const channel = await guildClient.channels.fetch(announcement_channel_id).catch(() => null);
                if (!channel || !channel.isTextBased()) continue;

                // Fetch messages: deep mode scans full history (startup), normal mode scans 3 pages
                const maxPages = deep ? 50 : 3; // deep: up to 5000 messages, normal: up to 300
                const allMessages = new Map();
                let lastId = null;
                for (let page = 0; page < maxPages; page++) {
                    const fetchOptions = { limit: 100 };
                    if (lastId) fetchOptions.before = lastId;
                    const batch = await channel.messages.fetch(fetchOptions);
                    if (batch.size === 0) break;
                    for (const [id, msg] of batch) allMessages.set(id, msg);
                    lastId = batch.last()?.id;
                    if (batch.size < 100) break; // No more messages in channel
                }

                for (const [messageId, message] of allMessages) {
                    // Match webhook messages OR bot-direct messages from any of our bots
                    const isOurWebhook = !!message.webhookId;
                    const isOurBot = message.author?.bot && ourBotIds.has(message.author.id);
                    if (!isOurWebhook && !isOurBot) continue;

                    const authorName = message.embeds?.[0]?.author?.name || '';

                    // Skip "was LIVE on" (stream-ended messages are intentional)
                    if (authorName.includes('was LIVE on')) continue;

                    // Only target LIVE announcement embeds ("is LIVE on")
                    // Skip non-stream messages (pinned info, welcome messages, etc.)
                    if (!authorName.includes('is LIVE on')) continue;

                    // Check if this message is tracked in either announcement system
                    const [tracked] = await connection.query(
                        'SELECT id FROM live_announcements WHERE message_id = ?',
                        [messageId]
                    );
                    const [crossTracked] = await connection.query(
                        'SELECT id FROM cross_network_messages WHERE message_id = ?',
                        [messageId]
                    ).catch(() => [[]]);

                    // If not tracked in either system, it's orphaned — handle per guild's edit_on_end setting
                    if (tracked.length === 0 && crossTracked.length === 0) {
                        try {
                            if (guildEditOnEnd[guild_id]) {
                                // edit_on_end guild: edit to "stream ended" instead of deleting
                                const match = authorName.match(/^(.+?) is LIVE on (\w+)/);
                                const username = match?.[1] || 'Unknown';
                                const platform = (match?.[2] || 'unknown').toLowerCase();

                                let vod = null;
                                if (platform === 'twitch') {
                                    try { vod = await twitchApi.getLatestVod(username); } catch { /* ignore */ }
                                }

                                const editSuccess = await editAnnouncementStreamEnded(
                                    guildClient, announcement_channel_id, messageId,
                                    username, platform, vod
                                );

                                if (editSuccess) {
                                    totalEdited++;
                                    logger.info(`Edited untracked orphan to stream-ended in channel ${announcement_channel_id}`, {
                                        category: "streams", messageId, username, platform,
                                        channelId: announcement_channel_id, guildId: guild_id
                                    });
                                } else {
                                    logger.warn(`Failed to edit untracked orphan ${messageId} — will retry next cycle`, {
                                        category: "streams", channelId: announcement_channel_id, guildId: guild_id
                                    });
                                }
                            } else {
                                await message.delete();
                                totalDeleted++;
                                logger.info(`Deleted untracked ${isOurWebhook ? 'webhook' : 'bot-direct'} message in channel ${announcement_channel_id}`, {
                                    category: "streams",
                                    messageId,
                                    channelId: announcement_channel_id,
                                    guildId: guild_id
                                });
                            }
                        } catch (cleanupError) {
                            logger.warn(`Failed to clean up untracked message ${messageId}:`, {
                                error: cleanupError.message,
                                category: "streams"
                            });
                        }
                    }
                }
            } catch (channelError) {
                logger.warn(`Failed to check channel ${announcement_channel_id}:`, {
                    error: channelError.message,
                    category: "streams"
                });
            }
        }

        logger.info(`Untracked message cleanup complete. Deleted ${totalDeleted}, edited ${totalEdited} untracked Discord messages.`, { category: "streams" });
    } catch (error) {
        logger.error('Failed to clean up untracked Discord messages:', { error, category: "streams" });
    } finally {
        if (connection) connection.release();
    }
}

// Clean up stale announcements based on age (failsafe for persistent announcements)
async function cleanupStaleAnnouncementsByAge(client) {
    let connection;
    try {
        connection = await pool.getConnection();

        // Clean up stuck PENDING slots (reserved but never posted — e.g. posting failed)
        // 5-minute timeout: if PENDING for 5+ minutes, the posting cycle clearly failed
        await connection.query(
            `DELETE FROM live_announcements WHERE message_id = 'PENDING' AND created_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)`
        );

        // Find announcements that have accumulated offline checks and are old enough
        // This catches announcements where the normal cleanup path failed (DB error, crash, etc.)
        // We do NOT force-remove by age alone — that kills genuinely long-running streams.
        const [staleAnnouncements] = await connection.query(`
            SELECT *
            FROM live_announcements
            WHERE message_id != 'PENDING'
              AND created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
              AND offline_check_count >= ?
        `, [MAX_ANNOUNCEMENT_AGE_MINUTES, OFFLINE_GRACE_PERIOD]);

        if (staleAnnouncements.length === 0) {
            logger.info('[Age-based Cleanup] No stale announcements found', { category: 'streams' });
            return;
        }

        logger.warn(`[Age-based Cleanup] Found ${staleAnnouncements.length} stuck announcements - forcing cleanup`, {
            category: 'streams',
            count: staleAnnouncements.length,
            threshold: `${MAX_ANNOUNCEMENT_AGE_MINUTES}min + ${OFFLINE_GRACE_PERIOD} offline checks`
        });

        let deletedCount = 0;
        for (const announcement of staleAnnouncements) {
            try {
                const ageMinutes = Math.floor((Date.now() - new Date(announcement.created_at).getTime()) / 1000 / 60);

                // Delete or edit the Discord message (use correct bot client for multi-bot guilds)
                const guildClient = global.botManager ? global.botManager.getClientForGuild(announcement.guild_id) : client;

                let cleanupSuccess = true;
                if (announcement.edit_on_end) {
                    // edit_on_end: edit to "stream ended" instead of deleting
                    let vod = null;
                    if (announcement.platform === 'twitch') {
                        vod = await twitchApi.getLatestVod(announcement.username);
                    }
                    cleanupSuccess = await editAnnouncementStreamEnded(
                        guildClient || client, announcement.channel_id, announcement.message_id,
                        announcement.username, announcement.platform, vod
                    );
                } else if (announcement.delete_on_end !== 0) {
                    cleanupSuccess = await deleteAnnouncement(guildClient || client, announcement.channel_id, announcement.message_id);
                }

                if (!cleanupSuccess) {
                    logger.warn(`[Age-based Cleanup] Failed to edit/delete for ${announcement.username} — skipping DB cleanup for retry`, {
                        category: 'streams', messageId: announcement.message_id, channelId: announcement.channel_id
                    });
                    continue;
                }

                // Delete ping message if it exists
                if (announcement.ping_message_id) {
                    deleteAnnouncement(guildClient || client, announcement.channel_id, announcement.ping_message_id).catch(() => {});
                }

                // Remove from in-memory tracking and set cooldown
                const key = `${announcement.guild_id}-${announcement.platform}-${announcement.username}-${announcement.channel_id}`;
                liveAnnouncements.delete(key);
                reAnnounceCooldowns.set(key, Date.now());

                // Delete from database
                await connection.query(
                    'DELETE FROM live_announcements WHERE id = ?',
                    [announcement.id]
                );

                deletedCount++;
                logger.warn(`[Age-based Cleanup] Deleted stale announcement for ${announcement.username} (age: ${ageMinutes} minutes, offline checks: ${announcement.offline_check_count || 0})`, {
                    category: 'streams',
                    streamer: announcement.username,
                    platform: announcement.platform,
                    guildId: announcement.guild_id,
                    ageMinutes,
                    offlineCheckCount: announcement.offline_check_count || 0,
                    messageId: announcement.message_id
                });
            } catch (error) {
                logger.error(`[Age-based Cleanup] Failed to delete stale announcement ${announcement.id}:`, {
                    error: error.message,
                    category: 'streams',
                    announcement
                });
            }
        }

        logger.warn(`[Age-based Cleanup] Complete. Deleted ${deletedCount}/${staleAnnouncements.length} stale announcements.`, {
            category: 'streams',
            deletedCount,
            totalStale: staleAnnouncements.length
        });
    } catch (error) {
        if (error.code !== 'ER_NO_SUCH_TABLE') {
            logger.error('[Age-based Cleanup] Failed to clean up stale announcements:', { error, category: 'streams' });
        }
    } finally {
        if (connection) connection.release();
    }
}

// Reserve announcement slot in database to prevent race conditions
async function reserveAnnouncementSlot(guildId, platform, username, channelId, streamerId, discordUserId, deleteOnEnd = true, editOnEnd = false, activeChannelIds = [channelId]) {
    let connection;
    try {
        connection = await pool.getConnection();

        // Clean up stale records for this streamer in a channel it no longer announces to
        // (subscription channel changed). A streamer can legitimately announce in SEVERAL
        // channels of one guild (e.g. two Twitch teams), so every channel targeted this
        // cycle is live, not stale — otherwise each post deletes the other, every cycle.
        const keep = [...new Set([channelId, ...activeChannelIds])];
        const [staleRows] = await connection.query(
            `SELECT id, channel_id, message_id, delete_on_end FROM live_announcements
             WHERE guild_id = ? AND platform = ? AND username = ? AND channel_id NOT IN (?)`,
            [guildId, platform, username, keep]
        );
        if (staleRows.length > 0) {
            for (const stale of staleRows) {
                // Try to delete the old Discord message if delete_on_end is enabled
                if (stale.delete_on_end && stale.message_id !== 'PENDING') {
                    try {
                        const guildClient = global.botManager ? global.botManager.getClientForGuild(guildId) : client;
                        if (guildClient) {
                            const oldChannel = await guildClient.channels.fetch(stale.channel_id).catch(() => null);
                            if (oldChannel) {
                                await oldChannel.messages.delete(stale.message_id).catch(() => {});
                            }
                        }
                    } catch (e) {
                        // Best-effort cleanup of old Discord message
                    }
                }
                // Remove stale DB record and in-memory cache entry
                await connection.query('DELETE FROM live_announcements WHERE id = ?', [stale.id]);
                const staleKey = `${guildId}-${platform}-${username}-${stale.channel_id}`;
                liveAnnouncements.delete(staleKey);
                logger.warn(`[reserveAnnouncementSlot] Cleaned up stale announcement for ${username} in old channel ${stale.channel_id} (subscription moved to ${channelId})`, {
                    category: "streams", guildId, oldChannel: stale.channel_id, newChannel: channelId
                });
            }
        }

        // Try to insert a placeholder row with a temporary message_id
        // If another instance already created it, this will fail due to UNIQUE constraint
        const result = await connection.query(
            `INSERT INTO live_announcements (guild_id, platform, username, channel_id, message_id, streamer_id, discord_user_id, stream_started_at, offline_check_count, delete_on_end, edit_on_end)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
            [guildId, platform, username, channelId, 'PENDING', streamerId, discordUserId, new Date(), deleteOnEnd ? 1 : 0, editOnEnd ? 1 : 0]
        );

        // If we get here, we successfully reserved the slot
        logger.info(`[reserveAnnouncementSlot] Reserved slot for ${username} on ${platform}`, {
            category: "streams",
            guildId,
            channelId
        });
        return true;
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            // Another instance already reserved this slot
            logger.info(`[reserveAnnouncementSlot] Slot already reserved for ${username} on ${platform}`, {
                category: "streams",
                guildId,
                channelId
            });
            return false;
        } else if (error.code !== 'ER_NO_SUCH_TABLE') {
            logger.error('[reserveAnnouncementSlot] Failed to reserve slot:', {
                error: error.message,
                code: error.code,
                guildId,
                platform,
                username,
                category: "streams"
            });
            return false;
        }
        return false;
    } finally {
        if (connection) connection.release();
    }
}

// Save announcement to database
async function saveAnnouncementToDatabase(guildId, platform, username, channelId, messageId, streamerId, discordUserId, streamStartedAt = null, deleteOnEnd = true, editOnEnd = false, pingMessageId = null) {
    let connection;
    try {
        // Convert ISO datetime to MySQL format if needed
        let mysqlDatetime = null;
        if (streamStartedAt) {
            try {
                const date = new Date(streamStartedAt);
                if (!isNaN(date.getTime())) {
                    mysqlDatetime = date.toISOString().slice(0, 19).replace('T', ' ');
                }
            } catch (e) {
                logger.warn('Failed to parse stream_started_at:', { streamStartedAt, error: e.message });
            }
        }

        connection = await pool.getConnection();
        await connection.query(
            `INSERT INTO live_announcements (guild_id, platform, username, channel_id, message_id, streamer_id, discord_user_id, stream_started_at, offline_check_count, delete_on_end, edit_on_end, ping_message_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
             ON DUPLICATE KEY UPDATE message_id = VALUES(message_id), stream_started_at = VALUES(stream_started_at), offline_check_count = 0, delete_on_end = VALUES(delete_on_end), edit_on_end = VALUES(edit_on_end), ping_message_id = COALESCE(VALUES(ping_message_id), ping_message_id), updated_at = CURRENT_TIMESTAMP`,
            [guildId, platform, username, channelId, messageId, streamerId, discordUserId, mysqlDatetime, deleteOnEnd ? 1 : 0, editOnEnd ? 1 : 0, pingMessageId]
        );
    } catch (error) {
        if (error.code !== 'ER_NO_SUCH_TABLE') {
            logger.error('Failed to save announcement to database:', { error, guildId, platform, username, category: "streams" });
        }
    } finally {
        if (connection) connection.release();
    }
}

/**
 * Does the live embed actually need rewriting?
 *
 * The embed shows title, game and the streamer's avatar — nothing that ticks on its own.
 * Going offline is handled separately (delete/edit-on-end), so only a title or category
 * change is worth an edit. A null lastTitle means the row predates change tracking, so
 * refresh once to record a baseline.
 */
function embedContentChanged(announcementData, streamData) {
    if (!announcementData || announcementData.lastTitle == null) return true;
    const title = streamData.title || null;
    const game = streamData.game_name || null;
    return announcementData.lastTitle !== title || announcementData.lastGame !== game;
}

/**
 * The announcement is drawn in a different style than the one now configured.
 *
 * This is a correctness gap, not a routine refresh, so it bypasses the every-Nth-cycle embed
 * gate: one cycle takes minutes (every bot is checked serially), so waiting for cycle N would
 * leave announcements looking wrong for half an hour after someone changed the setting. It
 * self-limits — once redrawn, the stored style matches and this stops firing.
 */
function styleMismatched(announcementData, resolvedStyle) {
    return !!announcementData && announcementData.renderStyle !== resolvedStyle;
}

/**
 * A platform preview is a live frame, so freezing it at go-live defeats the point of choosing
 * it. Unlike a style mismatch this IS routine, so it stays behind the embed-update gate.
 */
function previewNeedsRefresh(resolvedStyle) {
    return resolvedStyle === 'twitch';
}

// Remember what the embed now shows, so the next pass can tell whether anything moved
async function updateAnnouncementContentState(guildId, platform, username, channelId, title, game, renderStyle = null) {
    try {
        await pool.execute(
            'UPDATE live_announcements SET last_title = ?, last_game = ?, render_style = ? WHERE guild_id = ? AND platform = ? AND username = ? AND channel_id = ?',
            [title ?? null, game ?? null, renderStyle, guildId, platform, username, channelId]
        );
    } catch (error) {
        if (error.code !== 'ER_NO_SUCH_TABLE') {
            logger.warn(`[Stream Manager] Failed to persist embed content state for ${username}: ${error.message}`, { category: 'streams' });
        }
    }
}

// Update offline check count in database
async function updateOfflineCheckCount(guildId, platform, username, channelId, count) {
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.query(
            'UPDATE live_announcements SET offline_check_count = ? WHERE guild_id = ? AND platform = ? AND username = ? AND channel_id = ?',
            [count, guildId, platform, username, channelId]
        );
    } catch (error) {
        if (error.code !== 'ER_NO_SUCH_TABLE') {
            logger.error('Failed to update offline check count in database:', { error, guildId, platform, username, count, category: "streams" });
        }
    } finally {
        if (connection) connection.release();
    }
}

// Delete announcement from database
async function deleteAnnouncementFromDatabase(guildId, platform, username, channelId) {
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.query(
            'DELETE FROM live_announcements WHERE guild_id = ? AND platform = ? AND username = ? AND channel_id = ?',
            [guildId, platform, username, channelId]
        );
    } catch (error) {
        if (error.code !== 'ER_NO_SUCH_TABLE') {
            logger.error('Failed to delete announcement from database:', { error, guildId, platform, username, category: "streams" });
        }
    } finally {
        if (connection) connection.release();
    }
}

// Clear all announcements from both memory and database
async function clearAllAnnouncements() {
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.query('DELETE FROM live_announcements');
        liveAnnouncements.clear();
        logger.info('Cleared all announcement state from memory and database', { category: "streams" });
    } catch (error) {
        if (error.code !== 'ER_NO_SUCH_TABLE') {
            logger.error('Failed to clear announcements from database:', { error, category: "streams" });
        }
        // Still clear memory even if database fails
        liveAnnouncements.clear();
    } finally {
        if (connection) connection.release();
    }
}

/**
 * Perform once-per-cycle setup tasks (load DB state, run cleanups).
 * Called by the scheduler ONCE before any bot's checkStreamers calls.
 */
async function performCycleSetup(client, cycleOptions = {}) {
    const { isFirstPass, shouldRunStaleCleanup, shouldRunUntrackedCleanup, shouldRunOrphanCleanup, currentPass } = cycleOptions;

    // Only load announcements from database on first pass to preserve in-memory counters
    if (isFirstPass) {
        await loadAnnouncementsFromDatabase();
        await cleanupOrphanedAnnouncements(client);
        // Roles left on members whose subscription went away mid-stream (core/live-role-grants.js)
        await cleanupLeftoverLiveRoles(client);
        // Deep scan on startup: scan full channel history to clear backlog of orphaned messages
        await cleanupUntrackedDiscordMessages(client, { deep: true });
        // Run age-based cleanup on startup to catch any stuck announcements immediately
        await cleanupStaleAnnouncementsByAge(client);
    }

    // Run periodic cleanup tasks
    if (shouldRunStaleCleanup) {
        logger.info(`[Stream Manager] Running periodic age-based cleanup (cycle #${currentPass})`, { category: "streams" });
        await cleanupStaleAnnouncementsByAge(client);
    }

    // Stream history: close sessions nobody has seen live for hours (bot was down, streamer
    // untracked mid-stream). Cheap single UPDATE on the open_key index.
    if (isFirstPass || shouldRunStaleCleanup) {
        await closeStaleSessions();
    }

    if (shouldRunOrphanCleanup) {
        logger.info(`[Stream Manager] Running periodic orphaned announcement cleanup (cycle #${currentPass})`, { category: "streams" });
        await cleanupOrphanedAnnouncements(client);
        await cleanupLeftoverLiveRoles(client);
    }

    if (shouldRunUntrackedCleanup) {
        logger.info(`[Stream Manager] Running untracked message cleanup (cycle #${currentPass})`, { category: "streams" });
        await cleanupUntrackedDiscordMessages(client);
    }

}

/**
 * Main stream checking function.
 * cycleOptions is provided by the scheduler and shared across all bot calls in a cycle.
 */
async function checkStreamers(client, cycleOptions = {}) {
    const { shouldUpdateEmbeds = false, currentPass = 0, onlyStreamerIds = null, forceLiveIds = null } = cycleOptions;
    // When onlyStreamerIds is a Set, this is an EventSub-triggered targeted check for one (or a few)
    // streamers who just went live — process ONLY them, skipping the full 500-streamer sweep.
    const scoped = onlyStreamerIds instanceof Set ? onlyStreamerIds : null;
    // Streamers EventSub confirmed as live: trust that over Helix's laggy isLive check.
    const forceLive = forceLiveIds instanceof Set ? forceLiveIds : null;

    if (shouldUpdateEmbeds) {
        logger.info(`[Stream Manager] Cycle #${currentPass}: Will update embeds for live streamers`, { category: "streams" });
    } else {
        logger.debug(`[Stream Manager] Cycle #${currentPass}: Normal check`, { category: "streams" });
    }

    let connection;
    try {
        connection = await pool.getConnection();

        // Build guild filter based on bot assignment to prevent race conditions
        // between default bot and custom bots processing the same subscriptions
        let guildFilter = '';
        const queryParams = [];
        const botIdentifier = client.botId || client.user?.id || 'unknown';
        logger.debug(`[Stream Manager] Bot check - botId: ${botIdentifier}, isDefaultBot: ${client.isDefaultBot}`, { category: "streams" });

        if (client.isDefaultBot) {
            // Default bot handles guilds NOT assigned to any custom bot
            guildFilter = `WHERE sub.guild_id NOT IN (SELECT guild_id FROM guild_bot_mapping)`;
        } else if (client.botId) {
            // Custom bot only handles its assigned guilds (parameterized to prevent SQL injection)
            guildFilter = `WHERE sub.guild_id IN (SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?)`;
            queryParams.push(client.botId);
        }

        logger.debug(`[Stream Manager] Using guild filter: ${guildFilter || 'NONE (all guilds)'}`, { category: "streams" });

        /*
         * `paused` has to be honoured HERE, and until now it was not.
         *
         * Two systems set subscriptions.paused — the monthly leveling reset (everyone below level
         * 3) and, as of streamer-departure, members who have left the server. Neither did anything,
         * because this query never looked at the column: a paused subscription was announced
         * exactly like an active one, through both the poll cycle and the EventSub push (which
         * funnels into checkStreamerNow -> checkStreamers -> this query).
         *
         * Written as an appended predicate rather than baked into `guildFilter` because that string
         * is empty when neither bot branch matches, and a bare `AND` would be a syntax error.
         */
        const pausedFilter = guildFilter ? 'AND sub.paused = 0' : 'WHERE sub.paused = 0';

        // Load subscriptions, teams, and guild settings
        const [subscriptions] = await connection.query(
            `SELECT sub.subscription_id, sub.guild_id,
                    COALESCE(sub.announcement_channel_id, gc.announcement_channel_id) AS sub_channel_id,
                    sub.announcement_channel_id AS explicit_channel_id,
                    sub.live_role_id AS sub_role_id, sub.override_nickname, sub.override_avatar_url, sub.post_as_streamer,
                    sub.team_subscription_id, sub.delete_on_end, sub.edit_on_end, sub.custom_message, sub.ping_role_id,
                    s.streamer_id, s.discord_user_id, s.username, s.platform, s.profile_image_url, s.platform_user_id
             FROM subscriptions sub
             JOIN streamers s ON sub.streamer_id = s.streamer_id
             LEFT JOIN guild_config gc ON sub.guild_id COLLATE utf8mb4_unicode_ci = gc.guild_id COLLATE utf8mb4_unicode_ci
             ${guildFilter} ${pausedFilter}`,
            queryParams
        );

        // Per-subscription go-live filters (category / title keywords), read separately so a database
        // without those columns still announces as before. See core/stream-alert-filters.js.
        await attachGoLiveFilters(connection, subscriptions);

        // Each server's "never announce these streamers" list (core/streamer-blocklist.js). A blocked
        // streamer's subscriptions in that server are left out of this run, so no go-live post of any kind
        // (alerts, shoutout channel, auto-tracked members, teams) is made for them there.
        const { dropped: blockedSubs } = await dropBlockedSubscriptions(subscriptions);
        if (blockedSubs.length) {
            const drop = new Set(blockedSubs);
            for (let i = subscriptions.length - 1; i >= 0; i--) if (drop.has(subscriptions[i])) subscriptions.splice(i, 1);
            logger.debug(`[Stream Manager] ${blockedSubs.length} subscription(s) skipped: on the server's blocked streamers list`, { category: "streams" });
        }

        const [teams] = await connection.query(
            'SELECT id, announcement_channel_id AS team_channel_id, live_role_id AS team_role_id, webhook_name AS team_webhook_name, webhook_avatar_url AS team_webhook_avatar FROM twitch_teams'
        );

        const [guildSettings] = await connection.query(`
            SELECT
                g.guild_id,
                g.announcement_channel_id AS guild_channel_id,
                g.live_role_id AS guild_role_id,
                g.use_webhook_persona,
                g.stream_ignored_roles,
                g.announcement_message
            FROM guilds g
        `);

        logger.debug(`[Stream Manager] Loaded ${subscriptions.length} subscriptions, ${teams.length} teams, ${guildSettings.length} guilds`, { category: "streams" });

        const teamsMap = new Map(teams.map(t => [t.id, t]));
        const guildsMap = new Map(guildSettings.map(g => {
            g.ignored_roles_set = new Set(
                g.stream_ignored_roles ? JSON.parse(g.stream_ignored_roles) : []
            );
            return [g.guild_id, g];
        }));

        // Group subscriptions by unique streamer
        const streamersToCheck = new Map();
        for (const sub of subscriptions) {
            const key = `${sub.platform}-${sub.username}`;
            if (!streamersToCheck.has(key)) {
                streamersToCheck.set(key, {
                    streamerInfo: {
                        streamer_id: sub.streamer_id,
                        discord_user_id: sub.discord_user_id,
                        username: sub.username,
                        platform: sub.platform,
                        profile_image_url: sub.profile_image_url,
                    },
                    subscriptions: []
                });
            }
            streamersToCheck.get(key).subscriptions.push(sub);
        }

        // Targeted (EventSub-triggered) run: keep only the streamer(s) that just went live.
        if (scoped) {
            for (const [key, { streamerInfo }] of streamersToCheck) {
                if (!scoped.has(String(streamerInfo.streamer_id))) streamersToCheck.delete(key);
            }
            logger.debug(`[Stream Manager] Targeted check for ${streamersToCheck.size} streamer(s) [${[...scoped].join(',')}]`, { category: "streams" });
        }

        logger.debug(`[Stream Manager] Checking ${streamersToCheck.size} unique streamers now...`, { category: "streams" });

        // Track role operations to batch them
        const roleOperationsByGuild = new Map();

        let processedCount = 0;
        for (const { streamerInfo, subscriptions: subs } of streamersToCheck.values()) {
            processedCount++;
            logger.debug(`[Stream Manager] Processing streamer ${processedCount}/${streamersToCheck.size}: ${streamerInfo.username} (${streamerInfo.platform})`, {
                category: "streams",
                progress: `${processedCount}/${streamersToCheck.size}`,
                streamer: streamerInfo.username,
                platform: streamerInfo.platform
            });
            // Per-streamer wall-clock guard. A single hanging check (e.g. a headless
            // YouTube page.goto that never resolves) must NOT stall the whole cycle and
            // starve every streamer after it in the list. Abandon it and move on.
            try {
                const eventsubLive = !!forceLive && forceLive.has(String(streamerInfo.streamer_id));
                await Promise.race([
                    processUniqueStreamer(client, streamerInfo, subs, guildsMap, teamsMap, roleOperationsByGuild, shouldUpdateEmbeds, eventsubLive),
                    new Promise((_, reject) => setTimeout(
                        () => reject(new Error('per-streamer timeout')),
                        PER_STREAMER_TIMEOUT_MS
                    )),
                ]);
            } catch (err) {
                logger.warn(`[Stream Manager] Skipped ${streamerInfo.username} (${streamerInfo.platform}) after ${PER_STREAMER_TIMEOUT_MS}ms: ${err.message}`, {
                    category: "streams",
                    streamer: streamerInfo.username,
                    platform: streamerInfo.platform,
                });
            }
            logger.debug(`[Stream Manager] Completed processing streamer ${processedCount}/${streamersToCheck.size}: ${streamerInfo.username}`, {
                category: "streams",
                progress: `${processedCount}/${streamersToCheck.size}`
            });
        }

        logger.debug(`[Stream Manager] Finished checking all ${processedCount} streamers`, { category: "streams" });

        // Apply role changes
        logger.debug(`[Stream Manager] Role operations map size: ${roleOperationsByGuild.size}`, { category: "streams" });
        for (const [guildId, userRoleMap] of roleOperationsByGuild.entries()) {
            logger.debug(`[Stream Manager] Processing role changes for guild ${guildId}, users: ${userRoleMap.size}`, { category: "streams", guildId });
            for (const [discordUserId, roleMap] of userRoleMap.entries()) {
                for (const [roleId, { shouldHaveRole, member, streamerName }] of roleMap.entries()) {
                    try {
                        const guild = member.guild;
                        const liveRole = await guild.roles.fetch(roleId).catch(() => null);
                        if (!liveRole) {
                            logger.warn(`[Role Check] Could not fetch role ${roleId} in guild ${guildId}`, { category: "streams" });
                            continue;
                        }

                        const hasRole = member.roles.cache.has(roleId);

                        // Debug logging to understand why roles aren't being assigned
                        (shouldHaveRole === hasRole ? logger.debug : logger.info)(`[Role Check] User: ${member.user.tag}, Role: ${liveRole.name} (${roleId}), shouldHaveRole: ${shouldHaveRole}, hasRole: ${hasRole}, streamer: ${streamerName}`, {
                            category: "streams",
                            guildId: guild.id,
                            discordUserId
                        });

                        // The .catch() used to swallow the rejection and let the "Added/Removed
                        // live role" line log unconditionally underneath it — so a guild where
                        // every write was denied still produced a log full of successes.
                        // Branch on the outcome instead, and tell the owner: a 50013 here means
                        // their streamers silently never get their live role, and the only
                        // people who can fix it are in that server.
                        if (shouldHaveRole && !hasRole) {
                            try {
                                await member.roles.add(liveRole);
                                logger.info(`Added live role '${liveRole.name}' to ${member.user.tag}`, { guildId: guild.id, userId: member.id, streamer: streamerName, category: "streams" });
                                // Ledger of roles the bot gave, so one left behind can be taken back
                                // (core/live-role-grants.js). A role staff gave is never recorded.
                                recordLiveRoleGrant(guild.id, member.id, liveRole.id).catch(err =>
                                    logger.warn(`[LiveRoles] could not record grant: ${err.message}`, { category: "streams" }));
                            } catch (e) {
                                logger.error(`Failed to add role:`, { error: e, guildId: guild.id, memberId: member.id, roleId: liveRole.id, category: "streams" });
                                await reportRoleAssignmentFailure({ guild, role: liveRole, error: e, action: 'add' });
                            }
                        } else if (!shouldHaveRole && hasRole) {
                            try {
                                await member.roles.remove(liveRole);
                                logger.info(`Removed live role '${liveRole.name}' from ${member.user.tag}`, { guildId: guild.id, userId: member.id, category: "streams" });
                                forgetLiveRoleGrant(guild.id, member.id, liveRole.id).catch(() => {});
                            } catch (e) {
                                logger.error(`Failed to remove role:`, { error: e, guildId: guild.id, memberId: member.id, roleId: liveRole.id, category: "streams" });
                                await reportRoleAssignmentFailure({ guild, role: liveRole, error: e, action: 'remove' });
                            }
                        }
                    } catch (error) {
                        logger.error(`Error applying role changes for user ${discordUserId}:`, { error, guildId, category: "streams" });
                    }
                }
            }
        }

    } catch (error) {
        logger.error("Failed to run stream checker process:", { error, category: "streams" });
    } finally {
        if (connection) connection.release();
    }
}

/**
 * Poll Helix stream details a few times, waiting for it to catch up to an EventSub go-live.
 * Bypasses platformCache (which may hold a stale null). Bounded so it never approaches the
 * 90s per-streamer guard: 6 tries, 3s apart ≈ 15s worst case, and it returns the instant details
 * appear. Returns null if Helix still hasn't caught up — the caller then skips this pass and the
 * next poll cycle (or the offline/online reconcile) will announce.
 */
async function fetchDetailsWithRetry(api, streamer, tries = 6, gapMs = 3000) {
    for (let i = 0; i < tries; i++) {
        await new Promise(r => setTimeout(r, gapMs));
        try {
            const data = await api.getStreamDetails(streamer.username);
            if (data) {
                logger.info(`[processUniqueStreamer] Helix details caught up for ${streamer.username} after ${(i + 1) * gapMs / 1000}s`, { category: "streams" });
                return data;
            }
        } catch { /* transient — keep trying */ }
    }
    return null;
}

/**
 * Announce ONE streamer immediately, across every bot that serves their guilds.
 *
 * Called by the Twitch EventSub webhook the instant a `stream.online` arrives — instead of waiting
 * for the minute cron to walk the whole list and reach this streamer. It reuses the exact same
 * checkStreamers pipeline (announcer, multi-guild fan-out, dedup, slot reservation, live roles),
 * just scoped to the one streamer_id, and runs it for the default bot plus every custom bot the way
 * the scheduler does — so whichever bot owns the streamer's guild is the one that posts.
 *
 * @param {string|number} streamerId  streamers.streamer_id
 * @param {{forceLive?: boolean}} [options]  forceLive: EventSub confirmed this streamer is ONLINE,
 *   so trust it over Helix's laggy isLive check (used for stream.online; false for stream.offline).
 */
async function checkStreamerNow(streamerId, { forceLive = false } = {}) {
    const id = String(streamerId);
    const opts = {
        onlyStreamerIds: new Set([id]),
        forceLiveIds: forceLive ? new Set([id]) : null,
        currentPass: 'eventsub',
    };
    // botManager.clients holds every bot INCLUDING the default one (keyed 'default'), so iterating
    // it covers whichever bot owns the streamer's guild. checkStreamers already filters each bot to
    // only its own guilds, so bots that don't serve this streamer's guild do nothing.
    const clients = global.botManager?.clients
        ? [...global.botManager.clients.values()]
        : [];
    if (!clients.length) {
        logger.warn(`[Stream Manager] EventSub check for ${streamerId}: no bot clients available`, { category: 'streams' });
        return;
    }
    for (const client of clients) {
        try {
            await checkStreamers(client, opts);
        } catch (error) {
            logger.error(`[Stream Manager] EventSub targeted check failed for streamer ${streamerId}`, {
                error: error.message, botId: client.botId || 'default', category: 'streams',
            });
        }
    }
}

/**
 * Process a unique streamer across all their subscriptions
 */
async function processUniqueStreamer(
    client,
    streamer,
    subscriptions,
    guildsMap,
    teamsMap,
    roleOperationsByGuild,
    shouldUpdateEmbeds = false,
    eventsubLive = false
) {
    logger.debug(`[processUniqueStreamer] ENTRY: Processing ${streamer.username} on ${streamer.platform}`, {
        category: "streams",
        streamer: streamer.username,
        platform: streamer.platform,
        subscriptionCount: subscriptions.length
    });

    // Check if platform is in backoff due to rate limiting or errors
    if (isPlatformInBackoff(streamer.platform)) {
        logger.debug(`[processUniqueStreamer] Skipping ${streamer.username} - platform ${streamer.platform} in backoff`, {
            category: "streams"
        });
        return;
    }

    const api = platformModules[streamer.platform];
    if (!api) {
        // De-spam: log this ONCE per platform per process. A bad platform row
        // (e.g. 'twitter' — not a stream platform) would otherwise re-trigger
        // this error every cycle for the life of the process.
        if (!_unsupportedPlatformsWarned.has(streamer.platform)) {
            _unsupportedPlatformsWarned.add(streamer.platform);
            logger.warn(`[processUniqueStreamer] Skipping streamers on "${streamer.platform}": no live checker for that platform (Instagram is not supported). Logged once per session.`, {
                category: "streams",
                platform: streamer.platform,
                availablePlatforms: Object.keys(platformModules)
            });
        }
        return;
    }

    try {
        // OPTIMIZATION: Check if streamer has any active announcements
        const hasActiveAnnouncements = Array.from(liveAnnouncements.keys()).some(key =>
            key.includes(`-${streamer.platform}-${streamer.username}-`)
        );

        // NOTE: We no longer skip streamers without active announcements
        // This was causing new streams to be missed until the 5th pass
        // All streamers are now checked every pass to ensure timely announcements

        logger.debug(`[processUniqueStreamer] Calling api.isStreamerLive for ${streamer.username}...`, {
            category: "streams",
            hasActiveAnnouncements,
            shouldUpdateEmbeds
        });
        // EventSub is authoritative and FASTER than Helix here. Twitch's stream.online fires the
        // moment the broadcast starts, but Helix GET /streams (what isStreamerLive polls) lags
        // 10-60s behind — and our 30s cache can hold a stale "offline" from a poll that ran just
        // before go-live. Re-gating the announcement on that laggy/cached signal is exactly why a
        // stream could be live for a minute+ with no post. So when EventSub already told us the
        // streamer is online, TRUST it: drop the stale cache and skip the Helix isLive gate.
        let isLive;
        if (eventsubLive) {
            platformCache.invalidate(streamer.platform, streamer.username);
            isLive = true;
            logger.info(`[processUniqueStreamer] ${streamer.username} confirmed live via EventSub — skipping Helix isLive gate`, { category: "streams" });
        } else {
            // Use platform cache to reduce API calls (30s TTL)
            isLive = await platformCache.get(
                streamer.platform,
                'isLive',
                streamer.username,
                () => api.isStreamerLive(streamer.username)
            );
        }

        // Record success for platform backoff tracking
        recordPlatformSuccess(streamer.platform);
        logger.debug(`[processUniqueStreamer] isStreamerLive returned: ${isLive} for ${streamer.username}`, {
            category: "streams",
            isLive,
            streamer: streamer.username,
            platform: streamer.platform
        });

        let streamData = null;
        if (isLive) {
            logger.debug(`[processUniqueStreamer] Streamer ${streamer.username} is LIVE, fetching details...`, { category: "streams" });
            // Use platform cache for stream details (30s TTL)
            streamData = await platformCache.get(
                streamer.platform,
                'getDetails',
                streamer.username,
                () => api.getStreamDetails(streamer.username)
            );
            // Helix stream DETAILS lag behind stream.online just like isLive does (same endpoint),
            // so an EventSub-triggered announce often finds details still empty for the first few
            // seconds. Retry briefly (bypassing the cache, which may hold a stale null) so the embed
            // gets the real title/game/thumbnail instead of "Untitled Stream / N/A".
            if (!streamData && eventsubLive) {
                streamData = await fetchDetailsWithRetry(api, streamer);
            }
            logger.debug(`[processUniqueStreamer] getStreamDetails returned for ${streamer.username}:`, {
                category: "streams",
                hasData: !!streamData,
                title: streamData?.title,
                viewers: streamData?.viewer_count
            });
            if (!streamData) {
                logger.warn(`[Stream Manager] Streamer ${streamer.username} on ${streamer.platform} reported live but getStreamDetails returned null. Skipping announcement.`, { category: "streams" });
            }
        } else {
            logger.debug(`[processUniqueStreamer] Streamer ${streamer.username} is NOT live`, { category: "streams" });
        }

        // Stream history (stream_uptime): one row per broadcast per channel, opened on a live
        // sighting and closed after a sustained offline. Never throws; see stream-session-recorder.js.
        await recordObservation(streamer, isLive, streamData);

        const guildOperations = new Map();

        // Guilds where this streamer has a subscription hand-routed to a specific channel.
        // There, a second subscription that would only fall back to its TEAM's channel (a
        // streamer on two Twitch teams) still counts for tracking + live roles, but does not
        // post again — the guild already chose where this streamer is announced.
        const explicitlyRoutedGuilds = new Set(
            subscriptions.filter(s => s.explicit_channel_id).map(s => s.guild_id)
        );

        logger.debug(`[processUniqueStreamer] Processing ${subscriptions.length} subscriptions for ${streamer.username}`, {
            category: "streams",
            subscriptionCount: subscriptions.length
        });

        for (const sub of subscriptions) {
            const guildDefault = guildsMap.get(sub.guild_id);
            logger.debug(`[processUniqueStreamer] Processing subscription for guild ${sub.guild_id}`, {
                category: "streams",
                hasGuildDefault: !!guildDefault,
                subChannelId: sub.sub_channel_id,
                guildId: sub.guild_id
            });

            // Only skip if no guild default AND no custom channel configured
            if (!guildDefault && !sub.sub_channel_id) {
                logger.warn(`[processUniqueStreamer] No guild default or custom channel for ${sub.guild_id}, skipping`, {
                    category: "streams"
                });
                continue;
            }

            if (!guildOperations.has(sub.guild_id)) {
                const guild = await client.guilds.fetch(sub.guild_id).catch(() => null);
                if (!guild) continue;

                let member = null;
                if (streamer.discord_user_id) {
                    member = await guild.members.fetch(streamer.discord_user_id).catch(() => null);
                }

                guildOperations.set(sub.guild_id, {
                    guild,
                    member,
                    guildDefault,
                    roleIds: new Set(),
                    channelAnnouncements: new Map()
                });
            }

            const guildOp = guildOperations.get(sub.guild_id);

            // If streamer has Discord link but is not a member, skip ONLY the role operations (not announcements)
            // Announcements should still be posted — the streamer doesn't need to be in the guild for that

            // Check if streamer has an ignored role (opt-out)
            if (guildOp.member && guildDefault?.ignored_roles_set?.size > 0) {
                const hasIgnoredRole = guildOp.member.roles.cache.some(r => guildDefault.ignored_roles_set.has(r.id));
                if (hasIgnoredRole) {
                    logger.info(`[processUniqueStreamer] Skipping ${streamer.username} in guild ${sub.guild_id} — member has ignored role`, {
                        category: "streams", streamer: streamer.username, guild_id: sub.guild_id
                    });
                    continue;
                }
            }

            const team = sub.team_subscription_id ? teamsMap.get(sub.team_subscription_id) : null;

            const finalRoleId = sub.sub_role_id || team?.team_role_id || guildDefault.guild_role_id;
            let finalChannelId = sub.sub_channel_id || team?.team_channel_id || guildDefault.guild_channel_id;

            // Role-based routing ladder (subscribers > team > normal). Evaluated fresh on
            // every check against the member's live roles, so a lapsed sub falls back to
            // the normal channel on its own — nothing is baked into the subscription row.
            if (guildOp.member) {
                const routed = await resolveRoutedChannel({
                    guild: guildOp.guild,
                    member: guildOp.member,
                    currentChannelId: finalChannelId || null
                });
                if (routed) {
                    logger.info(`[processUniqueStreamer] ${streamer.username} matched live routing rule "${routed.rule.label || routed.rule.ruleId}" — announcing in ${routed.channelId} instead of ${finalChannelId || '(no channel)'}`, {
                        category: "streams",
                        guildId: sub.guild_id,
                        streamer: streamer.username,
                        fromChannel: finalChannelId || null,
                        toChannel: routed.channelId,
                        ruleId: routed.rule.ruleId
                    });
                    finalChannelId = routed.channelId;
                }
            }

            if (!sub.explicit_channel_id && sub.team_subscription_id && explicitlyRoutedGuilds.has(sub.guild_id)) {
                logger.info(`[processUniqueStreamer] ${streamer.username} is hand-routed elsewhere in ${sub.guild_id} — team subscription ${sub.subscription_id} applies roles only, no second announcement`, {
                    category: "streams", guildId: sub.guild_id, skippedChannel: finalChannelId || null
                });
                finalChannelId = null;
            }

            logger.debug(`[processUniqueStreamer] Subscription channel resolution for ${streamer.username}`, {
                category: "streams",
                finalChannelId,
                finalRoleId,
                subChannelId: sub.sub_channel_id,
                teamChannelId: team?.team_channel_id,
                guildChannelId: guildDefault.guild_channel_id
            });

            if (finalRoleId) {
                guildOp.roleIds.add(finalRoleId);
            }

            if (finalChannelId) {
                if (!guildOp.channelAnnouncements.has(finalChannelId)) {
                    const webhookConfig = {
                        username: sub.override_nickname || team?.team_webhook_name || guildDefault?.guild_webhook_name || (guildOp.member ? guildOp.member.user.username : streamer.username),
                        avatarURL: sub.override_avatar_url || (guildOp.member ? guildOp.member.user.displayAvatarURL() : null) || streamer.profile_image_url || team?.team_webhook_avatar || guildDefault?.guild_webhook_avatar
                    };

                    guildOp.channelAnnouncements.set(finalChannelId, {
                        deleteOnEnd: sub.delete_on_end !== 0,
                        editOnEnd: sub.edit_on_end !== 0,
                        webhookConfig,
                        subscription: sub,
                        team: team
                    });
                }
            }
        }

        logger.debug(`[processUniqueStreamer] Starting guild operations for ${streamer.username}`, {
            category: "streams",
            guildCount: guildOperations.size,
            streamer: streamer.username
        });

        // Process each guild
        for (const [guildId, guildOp] of guildOperations.entries()) {
            const { guild, member, roleIds, channelAnnouncements } = guildOp;

            logger.debug(`[processUniqueStreamer] Processing guild ${guildId} for ${streamer.username}`, {
                category: "streams",
                guildId,
                channelAnnouncementCount: channelAnnouncements.size,
                roleIdCount: roleIds.size,
                hasMember: !!member
            });

            // Track role operations
            if (member && roleIds.size > 0 && streamer.discord_user_id) {
                logger.debug(`[Stream Manager] Tracking role operations for ${streamer.username} in guild ${guildId}`, {
                    category: "streams",
                    discord_user_id: streamer.discord_user_id,
                    roleIdsCount: roleIds.size,
                    isLive,
                    hasStreamData: !!streamData
                });
                for (const roleId of roleIds) {
                    if (!roleOperationsByGuild.has(guildId)) {
                        roleOperationsByGuild.set(guildId, new Map());
                    }
                    if (!roleOperationsByGuild.get(guildId).has(streamer.discord_user_id)) {
                        roleOperationsByGuild.get(guildId).set(streamer.discord_user_id, new Map());
                    }

                    const userRoleMap = roleOperationsByGuild.get(guildId).get(streamer.discord_user_id);

                    if (isLive && streamData) {
                        // User is live on this platform - set role to true
                        userRoleMap.set(roleId, {
                            shouldHaveRole: true,
                            member,
                            streamerName: streamer.username
                        });
                    } else {
                        // User is offline on this platform - only set to false if not already true from another platform
                        const existingRole = userRoleMap.get(roleId);
                        if (!existingRole || existingRole.shouldHaveRole !== true) {
                            userRoleMap.set(roleId, {
                                shouldHaveRole: false,
                                member,
                                streamerName: streamer.username
                            });
                        }
                    }
                }
            }

            // Handle announcements
            for (const [channelId, { deleteOnEnd, editOnEnd, webhookConfig, subscription, team }] of channelAnnouncements.entries()) {
                const announcementKey = `${guild.id}-${streamer.platform}-${streamer.username}-${channelId}`;
                let announcementData = liveAnnouncements.get(announcementKey);

                // PENDING means another cycle reserved the slot but hasn't posted yet — skip
                if (announcementData?.messageId === 'PENDING') {
                    logger.info(`[processUniqueStreamer] In-memory announcement is PENDING for ${streamer.username} in channel ${channelId} — skipping`, {
                        category: "streams", guildId: guild.id
                    });
                    continue;
                }

                // If not in memory, check database (for multi-bot instances)
                if (!announcementData) {
                    try {
                        const [dbAnnouncements] = await pool.execute(
                            `SELECT message_id, streamer_id, platform, username, discord_user_id, delete_on_end, edit_on_end, offline_check_count, ping_message_id
                             FROM live_announcements
                             WHERE guild_id = ? AND platform = ? AND username = ? AND channel_id = ?`,
                            [guild.id, streamer.platform, streamer.username, channelId]
                        );
                        if (dbAnnouncements.length > 0) {
                            const dbAnn = dbAnnouncements[0];
                            // PENDING means another cycle reserved but hasn't posted yet — skip this streamer
                            if (dbAnn.message_id === 'PENDING') {
                                logger.info(`[processUniqueStreamer] DB announcement slot is PENDING for ${streamer.username} in channel ${channelId} — skipping (another cycle will post)`, {
                                    category: "streams", guildId: guild.id
                                });
                                continue;
                            }
                            announcementData = {
                                messageId: dbAnn.message_id,
                                pingMessageId: dbAnn.ping_message_id || null,
                                streamerId: dbAnn.streamer_id,
                                platform: dbAnn.platform,
                                username: dbAnn.username,
                                discordUserId: dbAnn.discord_user_id,
                                deleteOnEnd: dbAnn.delete_on_end,
                                editOnEnd: dbAnn.edit_on_end,
                                offlineCheckCount: dbAnn.offline_check_count
                            };
                            // Populate in-memory cache
                            liveAnnouncements.set(announcementKey, announcementData);
                        }
                    } catch (error) {
                        if (error.code !== 'ER_NO_SUCH_TABLE') {
                            logger.error(`[processUniqueStreamer] Failed to check database for existing announcement:`, {
                                error: error.message,
                                category: "streams"
                            });
                        }
                    }
                }

                logger.debug(`[processUniqueStreamer] Processing channel ${channelId} for ${streamer.username}`, {
                    category: "streams",
                    channelId,
                    isLive,
                    hasStreamData: !!streamData,
                    hasAnnouncementData: !!announcementData,
                    announcementKey
                });

                if (isLive && streamData) {
                    // Even on an update pass, an unchanged stream needs no edit. The embed no longer
                    // carries a live preview frame — just title, game and the streamer's avatar — so
                    // rewriting it every 5 minutes only burned Discord edits and made messages jump
                    // in clients. Refresh when the streamer actually changes something.
                    // …unless the look itself has to change. A style switch has to reach every
                    // currently-live announcement instead of waiting for a retitle, and a platform
                    // preview is a live frame that should keep moving.
                    const resolvedRenderStyle = (await resolveRenderStyle({
                        guildId: guild.id,
                        channelId,
                        streamerId: streamer.streamer_id,
                    })).style;

                    const restyleNeeded = styleMismatched(announcementData, resolvedRenderStyle);

                    if (announcementData && shouldUpdateEmbeds
                        && !embedContentChanged(announcementData, streamData)
                        && !restyleNeeded
                        && !previewNeedsRefresh(resolvedRenderStyle)) {
                        liveAnnouncements.set(announcementKey, announcementData);
                        continue;
                    }

                    // Skip editing existing announcements on non-update passes to reduce API calls /
                    // flickering — but never skip an announcement drawn in the wrong style. A full
                    // cycle takes minutes and the embed gate is every 5th cycle, so honouring the
                    // gate here would leave a changed setting unapplied for half an hour.
                    if (announcementData && !shouldUpdateEmbeds && !restyleNeeded) {
                        // Reset offline counter in memory AND database (prevents age-based cleanup
                        // from seeing stale DB counter after API blips)
                        if (announcementData.offlineCheckCount > 0) {
                            announcementData.offlineCheckCount = 0;
                            await updateOfflineCheckCount(guild.id, streamer.platform, streamer.username, channelId, 0);
                        }
                        liveAnnouncements.set(announcementKey, announcementData);
                        continue;
                    }

                    logger.info(`[processUniqueStreamer] Streamer is LIVE - creating/updating announcement for ${streamer.username}`, {
                        category: "streams",
                        hasAnnouncementData: !!announcementData,
                        channel: channelId,
                        guild: guild.id
                    });

                    try {
                        // Build platform URL
                        const platformUrls = {
                            twitch: `https://twitch.tv/${streamer.username}`,
                            kick: `https://kick.com/${streamer.username}`,
                            youtube: `https://youtube.com/channel/${streamer.username}`,
                            tiktok: `https://tiktok.com/@${streamer.username}`,
                            facebook: `https://facebook.com/gaming/${streamer.username}`,
                            instagram: `https://instagram.com/${streamer.username}`,
                        };

                        const platformUrl = platformUrls[streamer.platform] || `https://${streamer.platform}.com/${streamer.username}`;

                        const subContext = {
                            streamer_id: streamer.streamer_id,
                            username: streamer.username,
                            guild_id: guild.id,
                            profile_image_url: streamer.profile_image_url,
                            custom_message: subscription.custom_message,
                            ping_role_id: subscription.ping_role_id,
                            override_nickname: subscription.override_nickname,
                            override_avatar_url: subscription.override_avatar_url,
                            post_as_streamer: subscription.post_as_streamer ?? null,
                            discord_user_id: streamer.discord_user_id
                        };

                        const liveData = {
                            game: streamData.game_name || null,
                            title: streamData.title || null,
                            thumbnailUrl: streamData.thumbnail_url || null,
                            platform: streamer.platform,
                            url: streamData.url || platformUrl,
                            username: streamer.username,
                            profileImageUrl: streamer.profile_image_url || null,
                            // Rendered onto the announcement card
                            viewerCount: streamData.viewer_count ?? null,
                            startedAt: streamData.started_at || null
                        };

                        // Debug: Log liveData for Kick
                        if (streamer.platform === 'kick') {
                            logger.info(`[Stream Manager] LiveData for ${streamer.username}:`, {
                                liveData: liveData,
                                streamData_thumbnail_url: streamData.thumbnail_url,
                                category: 'streams'
                            });
                        }

                        const guildSettings = guildOp.guildDefault;
                        const existingAnnouncement = announcementData ? { message_id: announcementData.messageId, ping_message_id: announcementData.pingMessageId || null } : null;

                        // If no existing announcement, check re-announcement cooldown first
                        // Prevents duplicates when Twitch API briefly flickers "offline" then back to "live"
                        if (!existingAnnouncement) {
                            // The subscription's category / title filter decides whether a NEW post is
                            // made. Re-checked every cycle, so a stream that switches into a matching
                            // category or title is announced then. Existing posts are not affected.
                            const filterCheck = goLivePasses(subscription, streamData);
                            if (!filterCheck.ok) {
                                logger.debug(`[processUniqueStreamer] ${streamer.username} not announced in ${channelId}: ${filterCheck.reason}`, {
                                    category: "streams", guildId: guild.id, subscriptionId: subscription.subscription_id
                                });
                                continue;
                            }
                            const cooldownExpiry = reAnnounceCooldowns.get(announcementKey);
                            if (cooldownExpiry && (Date.now() - cooldownExpiry) < RE_ANNOUNCE_COOLDOWN_MS) {
                                const remainingMs = RE_ANNOUNCE_COOLDOWN_MS - (Date.now() - cooldownExpiry);
                                logger.info(`[processUniqueStreamer] Re-announcement cooldown active for ${streamer.username} — skipping (${Math.ceil(remainingMs / 1000)}s remaining)`, {
                                    category: "streams",
                                    channelId,
                                    guildId: guild.id
                                });
                                continue;
                            }
                            // Clear expired cooldown
                            if (cooldownExpiry) reAnnounceCooldowns.delete(announcementKey);

                            const reserved = await reserveAnnouncementSlot(
                                guild.id,
                                streamer.platform,
                                streamer.username,
                                channelId,
                                streamer.streamer_id,
                                streamer.discord_user_id,
                                deleteOnEnd,
                                editOnEnd,
                                [...channelAnnouncements.keys()]
                            );

                            if (!reserved) {
                                // Another instance already reserved/created this announcement
                                logger.info(`[processUniqueStreamer] Announcement slot already reserved for ${streamer.username}`, {
                                    category: "streams",
                                    channelId
                                });
                                continue;
                            }
                        }

                        // Get the correct bot client for this guild (supports multi-bot system)
                        const guildClient = global.botManager ? global.botManager.getClientForGuild(guild.id) : client;

                        // If creating a NEW announcement (not editing existing), check if there's
                        // already an orphaned "is LIVE on" message for this streamer in the channel.
                        // This prevents duplicate LIVE messages when stream flickers offline/online.
                        if (!existingAnnouncement) {
                            try {
                                const announceCh = await guildClient.channels.fetch(channelId).catch(() => null);
                                if (announceCh?.isTextBased()) {
                                    const recentMsgs = await announceCh.messages.fetch({ limit: 50 });
                                    for (const [oldMsgId, oldMsg] of recentMsgs) {
                                        const oldAuthor = oldMsg.embeds?.[0]?.author?.name || '';
                                        // Match this exact streamer's orphaned LIVE embed
                                        if (oldAuthor.includes(`${streamer.username} is LIVE on`) || oldAuthor.includes(`${streamer.username.charAt(0).toUpperCase() + streamer.username.slice(1)} is LIVE on`)) {
                                            // Don't touch tracked messages
                                            if (liveAnnouncements.has(announcementKey) || liveAnnouncements.get(announcementKey)?.messageId === oldMsgId) continue;

                                            // Check DB too
                                            const [trackedRow] = await pool.execute('SELECT id FROM live_announcements WHERE message_id = ?', [oldMsgId]);
                                            if (trackedRow.length > 0) continue;

                                            // Orphaned — clean it up
                                            if (editOnEnd) {
                                                let vod = null;
                                                if (streamer.platform === 'twitch') {
                                                    try { vod = await twitchApi.getLatestVod(streamer.username); } catch { /* ignore */ }
                                                }
                                                await editAnnouncementStreamEnded(guildClient, channelId, oldMsgId, streamer.username, streamer.platform, vod);
                                            } else if (deleteOnEnd) {
                                                await deleteAnnouncement(guildClient, channelId, oldMsgId);
                                            }

                                            logger.info(`[processUniqueStreamer] Cleaned up orphaned LIVE message before creating new announcement`, {
                                                category: "streams", oldMessageId: oldMsgId, username: streamer.username, guildId: guild.id
                                            });
                                        }
                                    }
                                }
                            } catch (cleanupErr) {
                                // Non-fatal — orphan cleanup is best-effort
                                logger.warn(`[processUniqueStreamer] Failed pre-announcement orphan cleanup for ${streamer.username}: ${cleanupErr.message}`, {
                                    category: "streams"
                                });
                            }
                        }

                        const message = await updateAnnouncement(
                            guildClient,
                            subContext,
                            liveData,
                            existingAnnouncement,
                            guildSettings,
                            null, // channelSettings
                            team, // teamSettings
                            channelId
                        );

                        if (message && message.id) {
                            // Save to memory and database (reset offline counter since stream is live)
                            liveAnnouncements.set(announcementKey, {
                                messageId: message.id,
                                pingMessageId: message.pingMessageId || null,
                                streamerId: streamer.streamer_id,
                                platform: streamer.platform,
                                username: streamer.username,
                                discordUserId: streamer.discord_user_id,
                                deleteOnEnd: deleteOnEnd,
                                editOnEnd: editOnEnd,
                                offlineCheckCount: 0, // Reset counter since stream is live
                                lastTitle: streamData.title || null,
                                lastGame: streamData.game_name || null,
                                renderStyle: resolvedRenderStyle
                            });

                            await saveAnnouncementToDatabase(
                                guild.id,
                                streamer.platform,
                                streamer.username,
                                channelId,
                                message.id,
                                streamer.streamer_id,
                                streamer.discord_user_id,
                                streamData.started_at || new Date(),
                                deleteOnEnd,
                                editOnEnd,
                                message.pingMessageId || null
                            );

                            // "Last notified" on the dashboard's streamer list: only a new post counts,
                            // not an edit of the one already up. Tolerates the column not existing yet.
                            if (!existingAnnouncement || existingAnnouncement.message_id !== message.id) {
                                pool.execute('UPDATE subscriptions SET last_announced_at = NOW() WHERE subscription_id = ?', [subscription.subscription_id])
                                    .catch((e) => { if (e.code !== 'ER_BAD_FIELD_ERROR') logger.warn(`[processUniqueStreamer] Could not record last_announced_at: ${e.message}`, { category: 'streams' }); });
                            }

                            await updateAnnouncementContentState(
                                guild.id, streamer.platform, streamer.username, channelId,
                                streamData.title || null, streamData.game_name || null,
                                resolvedRenderStyle
                            );

                            logger.info(`[processUniqueStreamer] Announcement created/updated for ${streamer.username}`, {
                                category: "streams",
                                messageId: message.id
                            });

                        }
                    } catch (error) {
                        logger.error(`[processUniqueStreamer] Failed to create announcement for ${streamer.username}:`, {
                            error: error.message,
                            stack: error.stack,
                            guildId: guild.id,
                            channelId,
                            category: "streams"
                        });
                    }
                } else {
                    // Stream is OFFLINE - handle cleanup with grace period
                    if (announcementData) {
                        const shouldDelete = announcementData.deleteOnEnd !== undefined ? announcementData.deleteOnEnd : deleteOnEnd;

                        // Increment offline check counter
                        const currentCount = (announcementData.offlineCheckCount || 0) + 1;
                        announcementData.offlineCheckCount = currentCount;

                        // Update in-memory counter
                        liveAnnouncements.set(announcementKey, announcementData);

                        // Persist offline counter to database
                        await updateOfflineCheckCount(guild.id, streamer.platform, streamer.username, channelId, currentCount);

                        logger.info(`[processUniqueStreamer] Streamer is OFFLINE (check ${currentCount}/${OFFLINE_GRACE_PERIOD}) for ${streamer.username}`, {
                            category: "streams",
                            hasAnnouncementData: !!announcementData,
                            channel: channelId,
                            guild: guild.id,
                            deleteOnEnd: shouldDelete,
                            offlineCheckCount: currentCount
                        });

                        try {
                            // Only delete after consecutive offline checks reach threshold
                            if (currentCount >= OFFLINE_GRACE_PERIOD) {
                                // Check edit_on_end flag (per-subscription, stored on announcement)
                                const shouldEdit = announcementData.editOnEnd !== undefined ? announcementData.editOnEnd : editOnEnd;

                                if (shouldEdit) {
                                    // Edit announcement to "stream ended" — works regardless of deleteOnEnd
                                    const guildClient = global.botManager ? global.botManager.getClientForGuild(guild.id) : client;

                                    // Fetch VOD for Twitch streamers
                                    let vod = null;
                                    if (streamer.platform === 'twitch') {
                                        vod = await twitchApi.getLatestVod(streamer.username);
                                    }

                                    const editSuccess = await editAnnouncementStreamEnded(
                                        guildClient, channelId, announcementData.messageId,
                                        streamer.username, streamer.platform, vod
                                    );

                                    if (editSuccess) {
                                        // Delete the separate ping message if it exists
                                        if (announcementData.pingMessageId) {
                                            deleteAnnouncement(guildClient, channelId, announcementData.pingMessageId).catch(() => {});
                                        }
                                        liveAnnouncements.delete(announcementKey);
                                        reAnnounceCooldowns.set(announcementKey, Date.now());
                                        await deleteAnnouncementFromDatabase(guild.id, streamer.platform, streamer.username, channelId);

                                        logger.info(`[processUniqueStreamer] Edited announcement to stream-ended for ${streamer.username} (edit_on_end)`, {
                                            category: "streams",
                                            hasVod: !!vod,
                                            offlineCheckCount: currentCount,
                                            guildId: guild.id
                                        });
                                    } else {
                                        logger.warn(`[processUniqueStreamer] Failed to edit stream-ended for ${streamer.username} — keeping tracking record for retry`, {
                                            category: "streams",
                                            messageId: announcementData.messageId,
                                            channelId,
                                            guildId: guild.id
                                        });
                                    }
                                } else if (shouldDelete) {
                                    // Get the correct bot client for this guild (supports multi-bot system)
                                    const guildClient = global.botManager ? global.botManager.getClientForGuild(guild.id) : client;

                                    // Delete Discord message — only remove tracking if Discord delete succeeded
                                    const deleteSuccess = await deleteAnnouncement(guildClient, channelId, announcementData.messageId);
                                    if (deleteSuccess) {
                                        // Delete the separate ping message if it exists
                                        if (announcementData.pingMessageId) {
                                            deleteAnnouncement(guildClient, channelId, announcementData.pingMessageId).catch(() => {});
                                        }
                                        liveAnnouncements.delete(announcementKey);
                                        reAnnounceCooldowns.set(announcementKey, Date.now());
                                        await deleteAnnouncementFromDatabase(guild.id, streamer.platform, streamer.username, channelId);

                                        logger.info(`[processUniqueStreamer] Deleted announcement for ${streamer.username} after ${currentCount} offline checks`, {
                                            category: "streams",
                                            deleted: true,
                                            offlineCheckCount: currentCount
                                        });
                                    } else {
                                        // Discord delete failed — keep tracking so age-based cleanup can retry
                                        logger.warn(`[processUniqueStreamer] Failed to delete Discord message for ${streamer.username} — keeping tracking record for retry`, {
                                            category: "streams",
                                            messageId: announcementData.messageId,
                                            channelId,
                                            guildId: guild.id,
                                            offlineCheckCount: currentCount
                                        });
                                    }
                                } else {
                                    // Keep Discord message but remove from live tracking
                                    // The message stays in the channel (deleteOnEnd=false) but we
                                    // stop counting this streamer as "live" in the dashboard
                                    // Delete the separate ping message since stream is over
                                    if (announcementData.pingMessageId) {
                                        const guildClient2 = global.botManager ? global.botManager.getClientForGuild(guild.id) : client;
                                        deleteAnnouncement(guildClient2, channelId, announcementData.pingMessageId).catch(() => {});
                                    }
                                    liveAnnouncements.delete(announcementKey);
                                    reAnnounceCooldowns.set(announcementKey, Date.now());
                                    await deleteAnnouncementFromDatabase(guild.id, streamer.platform, streamer.username, channelId);

                                    logger.info(`[processUniqueStreamer] Removed live tracking for ${streamer.username} (deleteOnEnd=false, Discord message kept)`, {
                                        category: "streams",
                                        deleted: false,
                                        dbRecordRemoved: true,
                                        messageId: announcementData.messageId,
                                        offlineCheckCount: currentCount
                                    });
                                }
                            } else {
                                logger.info(`[processUniqueStreamer] Grace period active for ${streamer.username} - waiting for ${OFFLINE_GRACE_PERIOD - currentCount} more offline check(s)`, {
                                    category: "streams",
                                    offlineCheckCount: currentCount,
                                    remainingChecks: OFFLINE_GRACE_PERIOD - currentCount
                                });
                            }
                        } catch (error) {
                            logger.error(`[processUniqueStreamer] Failed to cleanup announcement for ${streamer.username}:`, {
                                error: error.message,
                                stack: error.stack,
                                guildId: guild.id,
                                channelId,
                                category: "streams"
                            });
                        }
                    }
                }
            }
        }

    } catch (error) {
        // Record platform failure for backoff tracking
        // Only trigger backoff for rate limit or API errors, not for individual streamer issues
        if (error.status === 429 || error.message?.includes('rate limit') || error.message?.includes('Too Many Requests')) {
            recordPlatformFailure(streamer.platform, error);
        }

        logger.error(`Error processing unique streamer ${streamer.username} on ${streamer.platform}:`, {
            error: error.message || error,
            stack: error.stack,
            category: "streams"
        });
    }
}

function getLiveAnnouncements() {
    return liveAnnouncements;
}


/**
 * Force a Twitch live-check for every tracked streamer in a guild. Used by the
 * `/stream livecheck` admin command and the dashboard "Rescan live" button.
 *
 * Returns a summary: how many streamers were in scope, how many showed up live,
 * and how many were newly announced (vs. already in live_announcements for this guild).
 */
async function rescanGuildStreamers(guildId, { forceLive = true } = {}) {
    const connection = await pool.getConnection();
    let subs;
    try {
        [subs] = await connection.query(
            `SELECT DISTINCT s.streamer_id, s.username, s.platform
             FROM subscriptions sub
             JOIN streamers s ON s.streamer_id = sub.streamer_id
             WHERE sub.guild_id = ? AND sub.paused = 0 AND sub.departed_at IS NULL`,
            [guildId]);
    } finally { connection.release(); }

    if (!subs.length) {
        return { scope: 0, scanned: 0, announced: 0, errors: 0, streamers: [] };
    }

    // Capture pre-scan announcement ids so we can tell what the rescan newly added
    const [preRows] = await pool.query(
        'SELECT streamer_id FROM live_announcements WHERE guild_id = ?', [guildId]);
    const preAnnounced = new Set(preRows.map(r => String(r.streamer_id)));

    const ids = new Set(subs.map(s => String(s.streamer_id)));
    const forceSet = forceLive ? new Set(ids) : null;
    const allClients = global.botManager?.clients ? [...global.botManager.clients.values()] : [];
    // Only the client that owns this guild loads its subscriptions (see the guild filter in
    // checkStreamers): the mapped custom bot, else the default bot. Running every client made a
    // rescan take minutes, because each one re-checked these streamers for its own guilds too.
    const [[mapping]] = await pool.query(
        'SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ? LIMIT 1', [guildId]);
    const owner = mapping
        ? allClients.find(c => !c.isDefaultBot && String(c.botId) === String(mapping.bot_id))
        : allClients.find(c => c.isDefaultBot);
    const clients = owner ? [owner] : allClients;
    let errors = 0;
    for (const client of clients) {
        try { await checkStreamers(client, { onlyStreamerIds: ids, forceLiveIds: forceSet, currentPass: 'rescan' }); }
        catch (e) { errors++; logger.warn(`[Stream Manager] rescanGuildStreamers error for ${guildId}: ${e.message}`); }
    }

    // Measure what the rescan surfaced
    const [postRows] = await pool.query(
        'SELECT streamer_id, username, channel_id FROM live_announcements WHERE guild_id = ?', [guildId]);
    const nowLive = postRows.filter(r => !preAnnounced.has(String(r.streamer_id)));

    return {
        scope: subs.length,
        scanned: subs.length,
        announced: nowLive.length,
        errors,
        newlyLive: nowLive.map(r => ({ streamerId: String(r.streamer_id), username: r.username, channelId: r.channel_id })),
    };
}

export {
    performCycleSetup,
    checkStreamers,
    checkStreamerNow,
    rescanGuildStreamers,
    getLiveAnnouncements,
    clearAllAnnouncements,
    updateOfflineCheckCount,
    deleteAnnouncementFromDatabase,
    saveAnnouncementToDatabase,
    embedContentChanged,
    updateAnnouncementContentState
};
