import { Events, ActivityType } from 'discord.js';
import logger from '../utils/logger.js';
import { saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import pool from '../utils/db.js';
import { crossPollinateStreamer } from '../utils/streamer-cross-pollinate.js';

// Track recently auto-registered streamers to avoid spamming DB lookups
const recentlyChecked = new Map(); // `${guildId}:${userId}` -> timestamp
const CHECK_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

// Auto-track config cache per guild (5-min TTL)
const autoTrackConfigCache = new Map();
const CONFIG_CACHE_TTL = 5 * 60 * 1000;

/**
 * Get auto-track configs for a guild (cached).
 * @returns {Array} Config rows or empty array
 */
async function getAutoTrackConfigs(guildId) {
    const cached = autoTrackConfigCache.get(guildId);
    if (cached && Date.now() - cached.ts < CONFIG_CACHE_TTL) return cached.data;

    try {
        const [rows] = await pool.execute(
            'SELECT role_id, announcement_channel_id, live_role_id, delete_on_end, edit_on_end FROM guild_streamer_auto_track WHERE guild_id = ? AND enabled = 1',
            [guildId]
        );
        autoTrackConfigCache.set(guildId, { data: rows, ts: Date.now() });
        return rows;
    } catch (error) {
        logger.error('[AutoTrack] Error fetching config', { error: error.message, guildId });
        return [];
    }
}

/**
 * Invalidate config cache for a guild (called from commands/dashboard on save).
 */
export function invalidateAutoTrackConfig(guildId) {
    autoTrackConfigCache.delete(guildId);
}

/**
 * Scan a single guild for members currently streaming.
 * Called when auto-track is enabled/updated to catch already-live streamers.
 */
export async function scanGuildForActiveStreamers(client, guildId) {
    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return 0;

        let found = 0;
        for (const [, member] of guild.members.cache) {
            if (member.user.bot) continue;
            const streaming = member.presence?.activities?.find(
                a => a.type === ActivityType.Streaming && a.url?.includes('twitch.tv')
            );
            if (!streaming) continue;

            await autoRegisterStreamer(null, member.presence);
            found++;
        }

        if (found > 0) {
            logger.info(`[AutoTrack] On-enable scan for guild ${guildId} found ${found} streaming member(s)`, { category: 'streams' });
        }
        return found;
    } catch (error) {
        logger.error('[AutoTrack] Error in guild scan:', { error: error.message, guildId, category: 'streams' });
        return 0;
    }
}

/**
 * Scan all guilds with auto-track configs for members currently streaming.
 * Catches streamers whose transition was missed (e.g. during bot restart).
 * Call this after the bot is ready and presences are cached.
 */
export async function scanForActiveStreamers(client) {
    try {
        const [rows] = await pool.execute(
            'SELECT DISTINCT guild_id FROM guild_streamer_auto_track WHERE enabled = 1'
        );
        if (!rows.length) return;

        let found = 0;
        for (const { guild_id: guildId } of rows) {
            const guild = client.guilds.cache.get(guildId);
            if (!guild) continue;

            for (const [, member] of guild.members.cache) {
                if (member.user.bot) continue;
                const streaming = member.presence?.activities?.find(
                    a => a.type === ActivityType.Streaming && a.url?.includes('twitch.tv')
                );
                if (!streaming) continue;

                // Simulate a presence update with no old presence (fresh detection)
                const fakeOldPresence = null;
                await autoRegisterStreamer(fakeOldPresence, member.presence);
                found++;
            }
        }

        if (found > 0) {
            logger.info(`[AutoTrack] Startup scan found ${found} streaming member(s) to check`, { category: 'streams' });
        }
    } catch (error) {
        logger.error('[AutoTrack] Error in startup scan:', { error: error.message, category: 'streams' });
    }
}

export default {
    name: Events.PresenceUpdate,
    async execute(oldPresence, newPresence) {
        try {
            if (!newPresence?.guild) return;
            if (!newPresence.user || newPresence.user.bot) return;

            if (newPresence.client.isDefaultBot && await shouldIgnoreGuild(newPresence.guild.id)) return;

            // ── Auto-register Twitch streamers by role ────────────────────
            await autoRegisterStreamer(oldPresence, newPresence);

            // Only log significant changes to database (not to channel - too spammy)
            const oldStatus = oldPresence?.status || 'offline';
            const newStatus = newPresence.status || 'offline';

            // Only log online/offline transitions
            if ((oldStatus === 'offline' && newStatus !== 'offline') ||
                (oldStatus !== 'offline' && newStatus === 'offline')) {

                logger.debug(`[Presence] ${newPresence.user.tag}: ${oldStatus} → ${newStatus}`, {
                    guildId: newPresence.guild.id,
                    userId: newPresence.user.id,
                    category: 'presence'
                });

                await saveAuditLog(
                    newPresence.guild.id,
                    'PRESENCE_UPDATE',
                    newPresence.user.id,
                    null,
                    null,
                    null,
                    newStatus === 'offline' ? 'Went offline' : 'Came online',
                    null,
                    oldStatus,
                    newStatus,
                    { username: newPresence.user.tag }
                );
            }

            // Log custom status changes
            const oldCustom = oldPresence?.activities?.find(a => a.type === 4)?.state;
            const newCustom = newPresence.activities?.find(a => a.type === 4)?.state;

            if (oldCustom !== newCustom && (oldCustom || newCustom)) {
                logger.debug(`[Presence] ${newPresence.user.tag} status: "${oldCustom || 'none'}" → "${newCustom || 'none'}"`, {
                    guildId: newPresence.guild.id,
                    userId: newPresence.user.id,
                    category: 'presence'
                });
            }
        } catch (error) {
            logger.error('[Presence] Error logging presence update:', { error: error.message });
        }
    }
};

/**
 * Auto-register Twitch streamers when a member with a configured role starts streaming.
 * Acts as a fallback — skips members already tracked by self-promo, teams, or manual subs.
 */
async function autoRegisterStreamer(oldPresence, newPresence) {
    try {
        // Check if the user just started a Twitch streaming activity
        const allStreamingActivities = newPresence.activities?.filter(a => a.type === ActivityType.Streaming);
        const oldStreaming = oldPresence?.activities?.find(a => a.type === ActivityType.Streaming && a.url?.includes('twitch.tv'));
        const newStreaming = newPresence.activities?.find(a => a.type === ActivityType.Streaming && a.url?.includes('twitch.tv'));

        // Debug: log when we see any streaming activity (even non-Twitch)
        if (allStreamingActivities?.length > 0 && !newStreaming) {
            logger.info(`[AutoTrack] User ${newPresence.user.tag} has streaming activity but no twitch.tv URL`, {
                guildId: newPresence.guild.id,
                activities: allStreamingActivities.map(a => ({ name: a.name, url: a.url, type: a.type })),
                category: 'streams'
            });
        }

        // Only act when streaming starts (not already streaming before)
        if (!newStreaming || oldStreaming) return;

        const guildId = newPresence.guild.id;
        const userId = newPresence.user.id;
        const cacheKey = `${guildId}:${userId}`;

        // Cooldown check
        const lastCheck = recentlyChecked.get(cacheKey);
        if (lastCheck && Date.now() - lastCheck < CHECK_COOLDOWN_MS) return;
        recentlyChecked.set(cacheKey, Date.now());

        // Check if this guild has auto-track config (cached)
        const configs = await getAutoTrackConfigs(guildId);
        if (!configs.length) return;

        // Check if the member matches any config (NULL role_id = any member)
        const member = newPresence.member || await newPresence.guild.members.fetch(userId).catch(() => null);
        if (!member) return;

        const matchingConfig = configs.find(c => !c.role_id || member.roles.cache.has(c.role_id));
        if (!matchingConfig) return;

        // Extract Twitch username from URL (e.g., https://www.twitch.tv/username)
        const twitchUrl = newStreaming.url;
        const twitchUsername = twitchUrl.replace(/https?:\/\/(www\.)?twitch\.tv\//i, '').split(/[/?#]/)[0].toLowerCase();
        if (!twitchUsername || twitchUsername.length < 2) return;

        // ── Skip if already tracked (fallback deduplication) ──────────
        // Check by Discord user ID — skip if this user has ANY subscription in this guild
        const [subsByUser] = await pool.execute(
            `SELECT sub.subscription_id FROM subscriptions sub
             JOIN streamers s ON sub.streamer_id = s.streamer_id
             WHERE sub.guild_id = ? AND s.discord_user_id = ?`,
            [guildId, userId]
        );
        if (subsByUser.length > 0) {
            logger.debug(`[AutoTrack] Skipping ${userId} — already has subscription in guild ${guildId} (by user ID)`, { category: 'streams' });
            return;
        }

        // Check by Twitch username — skip if this Twitch account is already subscribed
        const [subsByUsername] = await pool.execute(
            `SELECT sub.subscription_id FROM subscriptions sub
             JOIN streamers s ON sub.streamer_id = s.streamer_id
             WHERE sub.guild_id = ? AND s.platform = 'twitch' AND LOWER(s.username) = ?`,
            [guildId, twitchUsername]
        );
        if (subsByUsername.length > 0) {
            logger.debug(`[AutoTrack] Skipping ${twitchUsername} — already subscribed in guild ${guildId} (by username)`, { category: 'streams' });
            return;
        }

        // Check if streamer record already exists (globally)
        const [existingStreamer] = await pool.execute(
            'SELECT streamer_id FROM streamers WHERE platform = ? AND LOWER(username) = ?',
            ['twitch', twitchUsername]
        );

        let streamerId;

        if (existingStreamer.length > 0) {
            streamerId = existingStreamer[0].streamer_id;

            // Update discord_user_id if not set
            await pool.execute(
                'UPDATE streamers SET discord_user_id = ? WHERE streamer_id = ? AND (discord_user_id IS NULL OR discord_user_id = ?)',
                [userId, streamerId, userId]
            );
        } else {
            // Validate with Twitch API before inserting
            let twitchApi;
            try {
                twitchApi = await import('../utils/platforms/twitch.js');
            } catch { return; }

            const twitchUser = await twitchApi.getTwitchUser(twitchUsername);
            if (!twitchUser) return;

            const [result] = await pool.execute(
                'INSERT INTO streamers (platform, platform_user_id, username, discord_user_id, guild_id) VALUES (?, ?, ?, ?, ?)',
                ['twitch', twitchUser.id, twitchUser.login || twitchUsername, userId, guildId]
            );
            streamerId = result.insertId;

            logger.info(`[AutoTrack] Auto-registered Twitch streamer: ${twitchUser.login} (${userId})`, {
                guildId, userId, twitchUsername: twitchUser.login, category: 'streams'
            });
        }

        // Create subscription for this guild
        await pool.execute(
            'INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, live_role_id, delete_on_end, edit_on_end) VALUES (?, ?, ?, ?, ?, ?)',
            [guildId, streamerId, matchingConfig.announcement_channel_id, matchingConfig.live_role_id || null,
             matchingConfig.delete_on_end ?? 1, matchingConfig.edit_on_end ?? 0]
        );

        logger.info(`[AutoTrack] Auto-subscribed guild ${guildId} to streamer ${twitchUsername} -> #${matchingConfig.announcement_channel_id}`, {
            guildId, streamerId, twitchUsername, category: 'streams'
        });

        // Cross-pollinate to other servers where this user is a member
        const crossAdded = await crossPollinateStreamer(streamerId, userId, guildId);
        if (crossAdded.length > 0) {
            logger.info(`[AutoTrack] Cross-pollinated streamer ${twitchUsername} to ${crossAdded.length} additional guild(s)`, {
                guildId, streamerId, twitchUsername, additionalGuilds: crossAdded.map(g => g.guildId), category: 'streams'
            });
        }
    } catch (error) {
        logger.error('[AutoTrack] Error in auto-register streamer:', { error: error.message, category: 'streams' });
    }
}
