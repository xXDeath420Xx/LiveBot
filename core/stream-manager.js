import pool from '../utils/db.js';
import * as twitchApi from '../utils/platforms/twitch.js';
import * as kickApi from '../utils/platforms/kick.js';
import * as facebookApi from '../utils/platforms/facebook.js';
import * as instagramApi from '../utils/platforms/instagram.js';
import * as youtubeApi from '../utils/platforms/youtube.js';
import * as tiktokApi from '../utils/platforms/tiktok.js';
import * as trovoApi from '../utils/platforms/trovo-api.js';
import logger from '../utils/logger.js';
import { updateAnnouncement, deleteAnnouncement, editAnnouncementStreamEnded } from '../utils/announcer.js';
import platformCache from '../utils/platformCache.js';
import { createMutex, withMutex } from '../utils/mutex.js';

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

// Counter to track stream check passes for embed updates
let streamCheckPassCounter = 0;
const passCounterMutex = createMutex(5000); // Mutex with 5s timeout to prevent deadlocks
const EMBED_UPDATE_INTERVAL = 5; // Update embeds every 5th pass
const STALE_CLEANUP_INTERVAL = 12; // Run stale cleanup every 12th pass
const UNTRACKED_CLEANUP_INTERVAL = 30; // Run untracked message cleanup every 30th pass

// Grace period for offline detection (require N consecutive offline checks before deleting)
const OFFLINE_GRACE_PERIOD = 4; // Require 4 consecutive offline checks before deleting announcement (prevents API flakiness spam)

// Age-based failsafe (force delete announcements older than this many hours)
// This is a FAILSAFE only for truly stuck announcements, not for regular cleanup
// Regular cleanup happens via offline detection with grace period
const MAX_ANNOUNCEMENT_AGE_MINUTES = 360; // 6 hours - only delete if announcement is stuck for this long

// Platform API modules mapping
const platformModules = {
    twitch: twitchApi,
    kick: kickApi,
    facebook: facebookApi,
    instagram: instagramApi,
    youtube: youtubeApi,
    tiktok: tiktokApi,
    trovo: trovoApi,
};

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
                streamerId: row.streamer_id,
                platform: row.platform,
                username: row.username,
                discordUserId: row.discord_user_id,
                deleteOnEnd: row.delete_on_end || false,
                editOnEnd: row.edit_on_end || false,
                offlineCheckCount: row.offline_check_count || 0, // Load persisted counter from database
                createdAt: row.created_at // Track creation time for age-based cleanup
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
                // Delete the Discord message
                await deleteAnnouncement(client, announcement.channel_id, announcement.message_id);

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
async function cleanupUntrackedDiscordMessages(client) {
    let connection;
    try {
        connection = await pool.getConnection();

        // Get all announcement channels from guilds
        const [channels] = await connection.query(`
            SELECT DISTINCT announcement_channel_id
            FROM guilds
            WHERE announcement_channel_id IS NOT NULL
            UNION
            SELECT DISTINCT announcement_channel_id
            FROM twitch_teams
            WHERE announcement_channel_id IS NOT NULL
        `);

        logger.info(`Checking ${channels.length} announcement channels for untracked messages`, { category: "streams" });

        let totalDeleted = 0;

        for (const { announcement_channel_id } of channels) {
            try {
                const channel = await client.channels.fetch(announcement_channel_id);
                if (!channel || !channel.isTextBased()) continue;

                // Fetch recent messages (last 100)
                const messages = await channel.messages.fetch({ limit: 100 });

                for (const [messageId, message] of messages) {
                    // Skip non-webhook messages and messages from wrong bot
                    if (!message.webhookId) continue;

                    // Check if this message is tracked in database
                    const [tracked] = await connection.query(
                        'SELECT id FROM live_announcements WHERE message_id = ?',
                        [messageId]
                    );

                    // If not tracked and is a webhook message, it's orphaned
                    if (tracked.length === 0) {
                        try {
                            await message.delete();
                            totalDeleted++;
                            logger.info(`Deleted untracked Discord message in channel ${announcement_channel_id}`, {
                                category: "streams",
                                messageId,
                                channelId: announcement_channel_id
                            });
                        } catch (deleteError) {
                            logger.warn(`Failed to delete untracked message ${messageId}:`, {
                                error: deleteError.message,
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

        logger.info(`Untracked message cleanup complete. Deleted ${totalDeleted} untracked Discord messages.`, { category: "streams" });
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

        // Find announcements that are old AND have been detected as offline
        // This ensures we only delete announcements that SHOULD have been cleaned up but weren't
        // We do NOT delete announcements for streamers who are still live, even if they've been streaming for hours
        const [staleAnnouncements] = await connection.query(`
            SELECT *
            FROM live_announcements
            WHERE created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
            AND offline_check_count >= ?
        `, [MAX_ANNOUNCEMENT_AGE_MINUTES, OFFLINE_GRACE_PERIOD]);

        if (staleAnnouncements.length === 0) {
            logger.info('[Age-based Cleanup] No stale announcements found', { category: 'streams' });
            return;
        }

        logger.warn(`[Age-based Cleanup] Found ${staleAnnouncements.length} stuck announcements (older than ${MAX_ANNOUNCEMENT_AGE_MINUTES} minutes AND offline_check_count >= ${OFFLINE_GRACE_PERIOD}) - forcing cleanup`, {
            category: 'streams',
            count: staleAnnouncements.length
        });

        let deletedCount = 0;
        for (const announcement of staleAnnouncements) {
            try {
                const ageMinutes = Math.floor((Date.now() - new Date(announcement.created_at).getTime()) / 1000 / 60);

                // Delete or edit the Discord message (use correct bot client for multi-bot guilds)
                const guildClient = global.botManager ? global.botManager.getClientForGuild(announcement.guild_id) : client;

                if (announcement.delete_on_end !== 0) {
                    if (announcement.edit_on_end) {
                        // edit_on_end: edit to "stream ended" instead of deleting
                        let vod = null;
                        if (announcement.platform === 'twitch') {
                            vod = await twitchApi.getLatestVod(announcement.username);
                        }
                        await editAnnouncementStreamEnded(
                            guildClient || client, announcement.channel_id, announcement.message_id,
                            announcement.username, announcement.platform, vod
                        );
                    } else {
                        await deleteAnnouncement(guildClient || client, announcement.channel_id, announcement.message_id);
                    }
                }

                // Remove from in-memory tracking
                const key = `${announcement.guild_id}-${announcement.platform}-${announcement.username}-${announcement.channel_id}`;
                liveAnnouncements.delete(key);

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
async function reserveAnnouncementSlot(guildId, platform, username, channelId, streamerId, discordUserId, deleteOnEnd = true, editOnEnd = false) {
    let connection;
    try {
        connection = await pool.getConnection();

        // Clean up stale records for this streamer in a DIFFERENT channel (subscription channel changed)
        const [staleRows] = await connection.query(
            `SELECT id, channel_id, message_id, delete_on_end FROM live_announcements
             WHERE guild_id = ? AND platform = ? AND username = ? AND channel_id != ?`,
            [guildId, platform, username, channelId]
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
async function saveAnnouncementToDatabase(guildId, platform, username, channelId, messageId, streamerId, discordUserId, streamStartedAt = null, deleteOnEnd = true, editOnEnd = false) {
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
            `INSERT INTO live_announcements (guild_id, platform, username, channel_id, message_id, streamer_id, discord_user_id, stream_started_at, offline_check_count, delete_on_end, edit_on_end)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
             ON DUPLICATE KEY UPDATE message_id = VALUES(message_id), stream_started_at = VALUES(stream_started_at), offline_check_count = 0, delete_on_end = VALUES(delete_on_end), edit_on_end = VALUES(edit_on_end), updated_at = CURRENT_TIMESTAMP`,
            [guildId, platform, username, channelId, messageId, streamerId, discordUserId, mysqlDatetime, deleteOnEnd ? 1 : 0, editOnEnd ? 1 : 0]
        );
    } catch (error) {
        if (error.code !== 'ER_NO_SUCH_TABLE') {
            logger.error('Failed to save announcement to database:', { error, guildId, platform, username, category: "streams" });
        }
    } finally {
        if (connection) connection.release();
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
 * Main stream checking function
 */
async function checkStreamers(client) {
    // Use mutex to safely read/modify pass counter (prevents race conditions with concurrent bot instances)
    const { isFirstPass, shouldUpdateEmbeds, shouldRunStaleCleanup, shouldRunUntrackedCleanup, currentPass } =
        await passCounterMutex.runExclusive(() => {
            const isFirst = streamCheckPassCounter === 0;

            // Increment counter
            streamCheckPassCounter++;
            const current = streamCheckPassCounter;

            // Calculate what actions to take
            const updateEmbeds = current >= EMBED_UPDATE_INTERVAL;
            const staleCleanup = current % STALE_CLEANUP_INTERVAL === 0;
            const untrackedCleanup = current % UNTRACKED_CLEANUP_INTERVAL === 0;

            // Reset counter if needed
            if (updateEmbeds) {
                streamCheckPassCounter = 0;
            }

            return {
                isFirstPass: isFirst,
                shouldUpdateEmbeds: updateEmbeds,
                shouldRunStaleCleanup: staleCleanup,
                shouldRunUntrackedCleanup: untrackedCleanup,
                currentPass: current
            };
        });

    // Only load announcements from database on first pass to preserve in-memory counters
    if (isFirstPass) {
        await loadAnnouncementsFromDatabase();
        await cleanupOrphanedAnnouncements(client);
        await cleanupUntrackedDiscordMessages(client);
        // Note: Age-based cleanup runs periodically, not on first pass, to avoid deleting legitimate long streams
    }

    if (shouldUpdateEmbeds) {
        logger.info(`[Stream Manager] Pass #${currentPass}: Will update embeds for live streamers`, { category: "streams" });
    } else {
        logger.info(`[Stream Manager] Pass #${currentPass}/${EMBED_UPDATE_INTERVAL}`, { category: "streams" });
    }

    // Run periodic cleanup tasks
    if (shouldRunStaleCleanup) {
        logger.info(`[Stream Manager] Running periodic age-based cleanup (pass #${currentPass})`, { category: "streams" });
        await cleanupStaleAnnouncementsByAge(client);
    }

    if (shouldRunUntrackedCleanup) {
        logger.info(`[Stream Manager] Running untracked message cleanup (pass #${currentPass})`, { category: "streams" });
        await cleanupUntrackedDiscordMessages(client);
    }

    let connection;
    try {
        connection = await pool.getConnection();

        // Build guild filter based on bot assignment to prevent race conditions
        // between default bot and custom bots processing the same subscriptions
        let guildFilter = '';
        const queryParams = [];
        const botIdentifier = client.botId || client.user?.id || 'unknown';
        logger.info(`[Stream Manager] Bot check - botId: ${botIdentifier}, isDefaultBot: ${client.isDefaultBot}`, { category: "streams" });

        if (client.isDefaultBot) {
            // Default bot handles guilds NOT assigned to any custom bot
            guildFilter = `WHERE sub.guild_id NOT IN (SELECT guild_id FROM guild_bot_mapping)`;
        } else if (client.botId) {
            // Custom bot only handles its assigned guilds (parameterized to prevent SQL injection)
            guildFilter = `WHERE sub.guild_id IN (SELECT guild_id FROM guild_bot_mapping WHERE bot_id = ?)`;
            queryParams.push(client.botId);
        }

        logger.info(`[Stream Manager] Using guild filter: ${guildFilter || 'NONE (all guilds)'}`, { category: "streams" });

        // Load subscriptions, teams, and guild settings
        const [subscriptions] = await connection.query(
            `SELECT sub.subscription_id, sub.guild_id,
                    COALESCE(sub.announcement_channel_id, gc.announcement_channel_id) AS sub_channel_id,
                    sub.live_role_id AS sub_role_id, sub.override_nickname, sub.override_avatar_url,
                    sub.team_subscription_id, sub.delete_on_end, sub.edit_on_end, sub.custom_message,
                    s.streamer_id, s.discord_user_id, s.username, s.platform, s.profile_image_url
             FROM subscriptions sub
             JOIN streamers s ON sub.streamer_id = s.streamer_id
             LEFT JOIN guild_config gc ON CAST(sub.guild_id AS CHAR) = CAST(gc.guild_id AS CHAR)
             ${guildFilter}`,
            queryParams
        );

        const [teams] = await connection.query(
            'SELECT id, announcement_channel_id AS team_channel_id, live_role_id AS team_role_id, webhook_name AS team_webhook_name, webhook_avatar_url AS team_webhook_avatar FROM twitch_teams'
        );

        const [guildSettings] = await connection.query(`
            SELECT
                g.guild_id,
                g.announcement_channel_id AS guild_channel_id,
                g.live_role_id AS guild_role_id,
                g.use_webhook_persona
            FROM guilds g
        `);

        logger.info(`[Stream Manager] Loaded ${subscriptions.length} subscriptions, ${teams.length} teams, ${guildSettings.length} guilds`, { category: "streams" });

        const teamsMap = new Map(teams.map(t => [t.id, t]));
        const guildsMap = new Map(guildSettings.map(g => [g.guild_id, g]));

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

        logger.info(`[Stream Manager] Checking ${streamersToCheck.size} unique streamers now...`, { category: "streams" });

        // Track role operations to batch them
        const roleOperationsByGuild = new Map();

        let processedCount = 0;
        for (const { streamerInfo, subscriptions: subs } of streamersToCheck.values()) {
            processedCount++;
            logger.info(`[Stream Manager] Processing streamer ${processedCount}/${streamersToCheck.size}: ${streamerInfo.username} (${streamerInfo.platform})`, {
                category: "streams",
                progress: `${processedCount}/${streamersToCheck.size}`,
                streamer: streamerInfo.username,
                platform: streamerInfo.platform
            });
            await processUniqueStreamer(client, streamerInfo, subs, guildsMap, teamsMap, roleOperationsByGuild, shouldUpdateEmbeds);
            logger.info(`[Stream Manager] Completed processing streamer ${processedCount}/${streamersToCheck.size}: ${streamerInfo.username}`, {
                category: "streams",
                progress: `${processedCount}/${streamersToCheck.size}`
            });
        }

        logger.info(`[Stream Manager] Finished checking all ${processedCount} streamers`, { category: "streams" });

        // Apply role changes
        logger.info(`[Stream Manager] Role operations map size: ${roleOperationsByGuild.size}`, { category: "streams" });
        for (const [guildId, userRoleMap] of roleOperationsByGuild.entries()) {
            logger.info(`[Stream Manager] Processing role changes for guild ${guildId}, users: ${userRoleMap.size}`, { category: "streams", guildId });
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
                        logger.info(`[Role Check] User: ${member.user.tag}, Role: ${liveRole.name} (${roleId}), shouldHaveRole: ${shouldHaveRole}, hasRole: ${hasRole}, streamer: ${streamerName}`, {
                            category: "streams",
                            guildId: guild.id,
                            discordUserId
                        });

                        if (shouldHaveRole && !hasRole) {
                            await member.roles.add(liveRole).catch(e =>
                                logger.error(`Failed to add role:`, { error: e, guildId: guild.id, memberId: member.id, roleId: liveRole.id, category: "streams" })
                            );
                            logger.info(`Added live role '${liveRole.name}' to ${member.user.tag}`, { guildId: guild.id, userId: member.id, streamer: streamerName, category: "streams" });
                        } else if (!shouldHaveRole && hasRole) {
                            await member.roles.remove(liveRole).catch(e =>
                                logger.error(`Failed to remove role:`, { error: e, guildId: guild.id, memberId: member.id, roleId: liveRole.id, category: "streams" })
                            );
                            logger.info(`Removed live role '${liveRole.name}' from ${member.user.tag}`, { guildId: guild.id, userId: member.id, category: "streams" });
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
 * Process a unique streamer across all their subscriptions
 */
async function processUniqueStreamer(
    client,
    streamer,
    subscriptions,
    guildsMap,
    teamsMap,
    roleOperationsByGuild,
    shouldUpdateEmbeds = false
) {
    logger.info(`[processUniqueStreamer] ENTRY: Processing ${streamer.username} on ${streamer.platform}`, {
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
        logger.error(`[processUniqueStreamer] No API module found for platform: ${streamer.platform}`, {
            category: "streams",
            platform: streamer.platform,
            availablePlatforms: Object.keys(platformModules)
        });
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

        logger.info(`[processUniqueStreamer] Calling api.isStreamerLive for ${streamer.username}...`, {
            category: "streams",
            hasActiveAnnouncements,
            shouldUpdateEmbeds
        });
        // Use platform cache to reduce API calls (30s TTL)
        const isLive = await platformCache.get(
            streamer.platform,
            'isLive',
            streamer.username,
            () => api.isStreamerLive(streamer.username)
        );

        // Record success for platform backoff tracking
        recordPlatformSuccess(streamer.platform);
        logger.info(`[processUniqueStreamer] isStreamerLive returned: ${isLive} for ${streamer.username}`, {
            category: "streams",
            isLive,
            streamer: streamer.username,
            platform: streamer.platform
        });

        let streamData = null;
        if (isLive) {
            logger.info(`[processUniqueStreamer] Streamer ${streamer.username} is LIVE, fetching details...`, { category: "streams" });
            // Use platform cache for stream details (30s TTL)
            streamData = await platformCache.get(
                streamer.platform,
                'getDetails',
                streamer.username,
                () => api.getStreamDetails(streamer.username)
            );
            logger.info(`[processUniqueStreamer] getStreamDetails returned for ${streamer.username}:`, {
                category: "streams",
                hasData: !!streamData,
                title: streamData?.title,
                viewers: streamData?.viewer_count
            });
            if (!streamData) {
                logger.warn(`[Stream Manager] Streamer ${streamer.username} on ${streamer.platform} reported live but getStreamDetails returned null. Skipping announcement.`, { category: "streams" });
            }
        } else {
            logger.info(`[processUniqueStreamer] Streamer ${streamer.username} is NOT live`, { category: "streams" });
        }

        const guildOperations = new Map();

        logger.info(`[processUniqueStreamer] Processing ${subscriptions.length} subscriptions for ${streamer.username}`, {
            category: "streams",
            subscriptionCount: subscriptions.length
        });

        for (const sub of subscriptions) {
            const guildDefault = guildsMap.get(sub.guild_id);
            logger.info(`[processUniqueStreamer] Processing subscription for guild ${sub.guild_id}`, {
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

            // Skip if streamer has Discord link but is not a member of this guild
            if (streamer.discord_user_id && !guildOp.member) {
                logger.warn(`[processUniqueStreamer] Skipping announcement - streamer ${streamer.username} has Discord link but is not a member of guild ${sub.guild_id}`, {
                    category: "streams",
                    streamer: streamer.username,
                    discord_user_id: streamer.discord_user_id,
                    guild_id: sub.guild_id
                });
                continue;
            }

            const team = sub.team_subscription_id ? teamsMap.get(sub.team_subscription_id) : null;

            const finalRoleId = sub.sub_role_id || team?.team_role_id || guildDefault.guild_role_id;
            const finalChannelId = sub.sub_channel_id || team?.team_channel_id || guildDefault.guild_channel_id;

            logger.info(`[processUniqueStreamer] Subscription channel resolution for ${streamer.username}`, {
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

        logger.info(`[processUniqueStreamer] Starting guild operations for ${streamer.username}`, {
            category: "streams",
            guildCount: guildOperations.size,
            streamer: streamer.username
        });

        // Process each guild
        for (const [guildId, guildOp] of guildOperations.entries()) {
            const { guild, member, roleIds, channelAnnouncements } = guildOp;

            logger.info(`[processUniqueStreamer] Processing guild ${guildId} for ${streamer.username}`, {
                category: "streams",
                guildId,
                channelAnnouncementCount: channelAnnouncements.size,
                roleIdCount: roleIds.size,
                hasMember: !!member
            });

            // Track role operations
            if (member && roleIds.size > 0 && streamer.discord_user_id) {
                logger.info(`[Stream Manager] Tracking role operations for ${streamer.username} in guild ${guildId}`, {
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

                // If not in memory, check database (for multi-bot instances)
                if (!announcementData) {
                    try {
                        const [dbAnnouncements] = await pool.execute(
                            `SELECT message_id, streamer_id, platform, username, discord_user_id, delete_on_end, edit_on_end, offline_check_count
                             FROM live_announcements
                             WHERE guild_id = ? AND platform = ? AND username = ? AND channel_id = ?`,
                            [guild.id, streamer.platform, streamer.username, channelId]
                        );
                        if (dbAnnouncements.length > 0) {
                            const dbAnn = dbAnnouncements[0];
                            announcementData = {
                                messageId: dbAnn.message_id,
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

                logger.info(`[processUniqueStreamer] Processing channel ${channelId} for ${streamer.username}`, {
                    category: "streams",
                    channelId,
                    isLive,
                    hasStreamData: !!streamData,
                    hasAnnouncementData: !!announcementData,
                    announcementKey
                });

                if (isLive && streamData) {
                    // Skip editing existing announcements on non-update passes to reduce API calls / flickering
                    if (announcementData && !shouldUpdateEmbeds) {
                        announcementData.offlineCheckCount = 0;
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
                            trovo: `https://trovo.live/s/${streamer.username}`,
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
                            override_nickname: subscription.override_nickname,
                            override_avatar_url: subscription.override_avatar_url,
                            discord_user_id: streamer.discord_user_id
                        };

                        const liveData = {
                            game: streamData.game_name || null,
                            title: streamData.title || null,
                            thumbnailUrl: streamData.thumbnail_url || null,
                            platform: streamer.platform,
                            url: streamData.url || platformUrl,
                            username: streamer.username,
                            profileImageUrl: streamer.profile_image_url || null
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
                        const existingAnnouncement = announcementData ? { message_id: announcementData.messageId } : null;

                        // If no existing announcement, reserve the slot in database FIRST to prevent race conditions
                        if (!existingAnnouncement) {
                            const reserved = await reserveAnnouncementSlot(
                                guild.id,
                                streamer.platform,
                                streamer.username,
                                channelId,
                                streamer.streamer_id,
                                streamer.discord_user_id,
                                deleteOnEnd,
                                editOnEnd
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
                                streamerId: streamer.streamer_id,
                                platform: streamer.platform,
                                username: streamer.username,
                                discordUserId: streamer.discord_user_id,
                                deleteOnEnd: deleteOnEnd,
                                editOnEnd: editOnEnd,
                                offlineCheckCount: 0 // Reset counter since stream is live
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
                                editOnEnd
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

                                if (shouldDelete && shouldEdit) {
                                    // Edit announcement to "stream ended" instead of deleting
                                    const guildClient = global.botManager ? global.botManager.getClientForGuild(guild.id) : client;

                                    // Fetch VOD for Twitch streamers
                                    let vod = null;
                                    if (streamer.platform === 'twitch') {
                                        vod = await twitchApi.getLatestVod(streamer.username);
                                    }

                                    await editAnnouncementStreamEnded(
                                        guildClient, channelId, announcementData.messageId,
                                        streamer.username, streamer.platform, vod
                                    );

                                    liveAnnouncements.delete(announcementKey);
                                    await deleteAnnouncementFromDatabase(guild.id, streamer.platform, streamer.username, channelId);

                                    logger.info(`[processUniqueStreamer] Edited announcement to stream-ended for ${streamer.username} (edit_on_end)`, {
                                        category: "streams",
                                        hasVod: !!vod,
                                        offlineCheckCount: currentCount,
                                        guildId: guild.id
                                    });
                                } else if (shouldDelete) {
                                    // Get the correct bot client for this guild (supports multi-bot system)
                                    const guildClient = global.botManager ? global.botManager.getClientForGuild(guild.id) : client;

                                    // Delete Discord message and remove from tracking
                                    await deleteAnnouncement(guildClient, channelId, announcementData.messageId);
                                    liveAnnouncements.delete(announcementKey);
                                    await deleteAnnouncementFromDatabase(guild.id, streamer.platform, streamer.username, channelId);

                                    logger.info(`[processUniqueStreamer] Deleted announcement for ${streamer.username} after ${currentCount} offline checks`, {
                                        category: "streams",
                                        deleted: true,
                                        offlineCheckCount: currentCount
                                    });
                                } else {
                                    // Keep Discord message but remove from live tracking
                                    // The message stays in the channel (deleteOnEnd=false) but we
                                    // stop counting this streamer as "live" in the dashboard
                                    liveAnnouncements.delete(announcementKey);
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

export {
    checkStreamers,
    getLiveAnnouncements,
    clearAllAnnouncements
};
