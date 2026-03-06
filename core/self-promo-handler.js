/**
 * Self-Promo Channel Handler
 *
 * Config-driven auto-tracking for self-promo channels.
 * Per-guild settings stored in self_promo_config table.
 *
 * When a user posts a stream URL in the configured self-promo channel:
 *   - Parses the URL and validates with platform API
 *   - Already tracked → delete message, DM user (if dm_on_already_tracked)
 *   - Not tracked → create streamer+subscription, delete message, DM user (if dm_on_track)
 *   - Non-link messages → delete (if delete_invalid)
 */

import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { parseStreamUrl } from '../utils/stream-url-parser.js';
import * as twitchApi from '../utils/platforms/twitch.js';
import * as kickApi from '../utils/platforms/kick.js';

// Config cache per guild
const selfPromoConfigCache = new Map();
const CONFIG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Tracking cache: "guildId:userId:channelId" -> { result, expiresAt }
const trackingCache = new Map();
const TRACKING_CACHE_TTL = 5 * 60 * 1000;

/**
 * Get self-promo config for a guild (cached).
 * @returns {object|null} Config row or null if not configured/disabled
 */
export async function getSelfPromoConfig(guildId) {
    const cached = selfPromoConfigCache.get(guildId);
    if (cached && Date.now() - cached.ts < CONFIG_CACHE_TTL) return cached.data;

    try {
        const [rows] = await pool.execute(
            'SELECT * FROM self_promo_config WHERE guild_id = ? AND enabled = 1',
            [guildId]
        );
        const config = rows[0] || null;
        if (config && typeof config.allowed_platforms === 'string') {
            try { config.allowed_platforms = JSON.parse(config.allowed_platforms); } catch { config.allowed_platforms = []; }
        }
        selfPromoConfigCache.set(guildId, { data: config, ts: Date.now() });
        return config;
    } catch (error) {
        logger.error('[SelfPromo] Error fetching config', { error: error.message, guildId });
        return null;
    }
}

/**
 * Invalidate config cache for a guild (called from dashboard/commands on save).
 */
export function invalidateSelfPromoConfig(guildId) {
    selfPromoConfigCache.delete(guildId);
}

function getCacheKey(guildId, userId, channelId) {
    return `${guildId}:${userId}:${channelId}`;
}

function getCached(key) {
    const entry = trackingCache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
        trackingCache.delete(key);
        return undefined;
    }
    return entry.result;
}

function setCache(key, result) {
    trackingCache.set(key, { result, expiresAt: Date.now() + TRACKING_CACHE_TTL });
}

/**
 * Check if a user is tracked in a specific channel.
 * @returns {boolean}
 */
async function isTrackedInChannel(guildId, discordUserId, channelId) {
    const cacheKey = getCacheKey(guildId, discordUserId, channelId);
    const cached = getCached(cacheKey);
    if (cached !== undefined) return cached;

    try {
        const [rows] = await pool.execute(
            `SELECT sub.subscription_id FROM subscriptions sub
             JOIN streamers s ON sub.streamer_id = s.streamer_id
             WHERE sub.guild_id = ? AND s.discord_user_id = ? AND sub.announcement_channel_id = ?`,
            [guildId, discordUserId, channelId]
        );
        const result = rows.length > 0;
        setCache(cacheKey, result);
        return result;
    } catch (error) {
        logger.error('[SelfPromo] Error checking tracking status', { error: error.message, guildId, discordUserId, channelId });
        return false;
    }
}

/**
 * Validate a username with the platform API and return canonical data.
 * @returns {{ platformUserId: string, canonicalUsername: string } | null}
 */
async function validatePlatformUser(platform, username) {
    try {
        if (platform === 'twitch') {
            const user = await twitchApi.getTwitchUser(username);
            if (!user) return null;
            return { platformUserId: user.id, canonicalUsername: user.login };
        }

        if (platform === 'kick') {
            const user = await kickApi.getKickUser(username);
            if (!user) return null;
            return { platformUserId: String(user.user.id), canonicalUsername: user.user.username || username };
        }

        // YouTube, TikTok, Trovo, Facebook, Instagram - pass through
        return { platformUserId: username, canonicalUsername: username };
    } catch (error) {
        logger.error(`[SelfPromo] Error validating ${platform} user "${username}"`, { error: error.message });
        return null;
    }
}

/**
 * Create a streamer row and subscription for auto-tracking.
 * @param {string} guildId
 * @param {string} platform
 * @param {string} platformUserId
 * @param {string} canonicalUsername
 * @param {string} discordUserId
 * @param {string|null} channelId - announcement channel (null = falls through to team/guild default)
 * @param {number|null} teamSubscriptionId - team ID if the user is a team member
 * @returns {boolean} true if created successfully
 */
async function createStreamerAndSubscription(guildId, platform, platformUserId, canonicalUsername, discordUserId, channelId, teamSubscriptionId = null) {
    let connection;
    try {
        connection = await pool.getConnection();

        // Check if streamer already exists
        const [existing] = await connection.query(
            'SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?',
            [platform, platformUserId]
        );

        let streamerId;
        if (existing.length > 0) {
            streamerId = existing[0].streamer_id;
            // Link discord_user_id if not already set
            await connection.query(
                'UPDATE streamers SET discord_user_id = ? WHERE streamer_id = ? AND discord_user_id IS NULL',
                [discordUserId, streamerId]
            );
        } else {
            const [result] = await connection.query(
                'INSERT INTO streamers (platform, platform_user_id, username, discord_user_id) VALUES (?, ?, ?, ?)',
                [platform, platformUserId, canonicalUsername, discordUserId]
            );
            streamerId = result.insertId;
        }

        // Check if subscription already exists
        const [existingSub] = await connection.query(
            'SELECT subscription_id, team_subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
            [guildId, streamerId]
        );

        if (existingSub.length > 0) {
            // Already has a team subscription — nothing to change
            if (existingSub[0].team_subscription_id) {
                logger.info('[SelfPromo] Streamer already has team subscription, no changes needed', {
                    guildId, streamerId, teamSubscriptionId: existingSub[0].team_subscription_id
                });
                if (connection) connection.release();
                return false;
            }
            // Existing non-team subscription — update routing
            if (teamSubscriptionId) {
                // User is now on a team: clear channel override, set team ID
                await connection.query(
                    'UPDATE subscriptions SET announcement_channel_id = NULL, team_subscription_id = ? WHERE subscription_id = ?',
                    [teamSubscriptionId, existingSub[0].subscription_id]
                );
            } else {
                // Non-team: point to self-promo channel with delete_on_end + edit_on_end
                await connection.query(
                    'UPDATE subscriptions SET announcement_channel_id = ?, delete_on_end = 1, edit_on_end = 1 WHERE subscription_id = ?',
                    [channelId, existingSub[0].subscription_id]
                );
            }
        } else {
            // New subscription — self-promo subs get edit_on_end=1 by default
            await connection.query(
                `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, delete_on_end, edit_on_end, team_subscription_id)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [guildId, streamerId, channelId, teamSubscriptionId ? 0 : 1, teamSubscriptionId ? 0 : 1, teamSubscriptionId]
            );
        }

        // Invalidate tracking cache for this user
        trackingCache.delete(getCacheKey(guildId, discordUserId, channelId));

        const routing = teamSubscriptionId ? 'team channel' : 'self-promo channel';
        logger.info(`[SelfPromo] Created streamer + subscription → ${routing}`, {
            guildId, platform, canonicalUsername, discordUserId, channelId, teamSubscriptionId
        });

        return true;
    } catch (error) {
        logger.error('[SelfPromo] Error creating streamer/subscription', { error: error.message });
        return false;
    } finally {
        if (connection) connection.release();
    }
}

/**
 * Look up the team_subscription_id for a Discord user in this guild.
 * @returns {number|null}
 */
async function getTeamSubscriptionId(guildId, discordUserId) {
    try {
        const [rows] = await pool.execute(
            `SELECT sub.team_subscription_id FROM subscriptions sub
             JOIN streamers s ON sub.streamer_id = s.streamer_id
             WHERE sub.guild_id = ? AND s.discord_user_id = ? AND sub.team_subscription_id IS NOT NULL
             LIMIT 1`,
            [guildId, discordUserId]
        );
        return rows.length > 0 ? rows[0].team_subscription_id : null;
    } catch (error) {
        logger.error('[SelfPromo] Error looking up team subscription', { error: error.message });
        return null;
    }
}

/**
 * Check if a specific platform+username combo already has a subscription in this guild.
 * @returns {{ tracked: boolean, channelId: string|null }}
 */
async function isStreamerAlreadyTracked(guildId, platform, platformUserId) {
    try {
        const [rows] = await pool.execute(
            `SELECT COALESCE(sub.announcement_channel_id, ts.announcement_channel_id, gc.announcement_channel_id) AS channel_id
             FROM subscriptions sub
             JOIN streamers s ON sub.streamer_id = s.streamer_id
             LEFT JOIN twitch_teams ts ON sub.team_subscription_id = ts.id
             LEFT JOIN guild_config gc ON CAST(sub.guild_id AS CHAR) = CAST(gc.guild_id AS CHAR)
             WHERE sub.guild_id = ? AND s.platform = ? AND s.platform_user_id = ?`,
            [guildId, platform, platformUserId]
        );
        if (rows.length === 0) return { tracked: false, channelId: null };
        return { tracked: true, channelId: rows[0].channel_id || null };
    } catch (error) {
        logger.error('[SelfPromo] Error checking if streamer is tracked', { error: error.message });
        return { tracked: false, channelId: null };
    }
}

/**
 * Handle a message in a configured self-promo channel.
 * Config-driven: checks self_promo_config for the message's guild.
 *
 * @param {import('discord.js').Message} message
 * @returns {boolean} true if the message was handled (caller should return)
 */
export async function handleSelfPromoMessage(message) {
    if (!message.guild) return false;

    const guildId = message.guild.id;
    const config = await getSelfPromoConfig(guildId);

    // No config or not enabled — skip
    if (!config) return false;

    // Only handle messages in the configured self-promo channel
    if (message.channel.id !== config.channel_id) return false;

    const member = message.member;
    if (!member) return false;

    // Helper to delete the user's message
    const deleteMessage = () => message.delete().catch(err =>
        logger.error('[SelfPromo] Failed to delete message', { error: err.message, userId: member.id })
    );

    // Parse the URL from the message
    const parsed = parseStreamUrl(message.content);

    if (!parsed) {
        // No streaming URL found — delete if configured
        if (config.delete_invalid) {
            await deleteMessage();
        }
        return true;
    }

    // Check if platform is allowed
    const allowedPlatforms = config.allowed_platforms || [];
    if (allowedPlatforms.length > 0 && !allowedPlatforms.includes(parsed.platform)) {
        if (config.delete_invalid) {
            await deleteMessage();
        }
        return true;
    }

    // Auto-subscribe disabled — just delete the message
    if (!config.auto_subscribe) {
        if (config.delete_invalid) {
            await deleteMessage();
        }
        return true;
    }

    // Validate the username with the platform API
    const validated = await validatePlatformUser(parsed.platform, parsed.username);
    if (!validated) {
        await deleteMessage();
        return true;
    }

    // Check if this specific platform+user combo is already tracked
    const { tracked: alreadyTracked, channelId: trackedChannelId } = await isStreamerAlreadyTracked(guildId, parsed.platform, validated.platformUserId);
    if (alreadyTracked) {
        logger.info('[SelfPromo] Streamer already tracked, deleting manual post', {
            platform: parsed.platform, username: validated.canonicalUsername, userId: member.id, guildId
        });
        await deleteMessage();

        if (config.dm_on_already_tracked) {
            try {
                const channelMention = trackedChannelId ? `<#${trackedChannelId}>` : 'the announcement channel';
                await member.send(
                    `Your **${parsed.platform}** account **${validated.canonicalUsername}** is already being tracked! ` +
                    `The bot automatically posts go-live notifications for you in ${channelMention}. ` +
                    `No need to post again — it's all handled for you.`
                );
            } catch {
                logger.debug('[SelfPromo] Could not DM user about existing tracking', { userId: member.id });
            }
        }

        return true;
    }

    // Determine routing: team member → team channel, non-team → self-promo channel
    const teamId = await getTeamSubscriptionId(guildId, member.id);
    const isTeamMember = teamId !== null;

    // Team members: announcement_channel_id = NULL (falls through to team channel)
    // Non-team: announcement_channel_id = self-promo channel
    const announcementChannelId = isTeamMember ? null : config.channel_id;

    // Create the streamer + subscription
    const created = await createStreamerAndSubscription(
        guildId,
        parsed.platform,
        validated.platformUserId,
        validated.canonicalUsername,
        member.id,
        announcementChannelId,
        isTeamMember ? teamId : null
    );

    // Always delete in self-promo channel
    await deleteMessage();

    // DM the user if configured
    if (created && config.dm_on_track) {
        const channelMention = `<#${config.channel_id}>`;
        try {
            await member.send(
                `Your **${parsed.platform}** stream link has been received! ` +
                `You've been automatically added to our stream tracker in ${channelMention}. ` +
                `When you go live, the bot will post a notification for you automatically. ` +
                `No need to post manually anymore!`
            );
        } catch {
            logger.debug('[SelfPromo] Could not DM user about auto-tracking', { userId: member.id });
        }
    }

    return true;
}
