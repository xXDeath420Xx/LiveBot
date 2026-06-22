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
import { safeJsonArray } from '../utils/safeJson.js';
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

function normalizeIdentity(value) {
    return (value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hasCommonSubstring(a, b, minLen = 5) {
    if (a.length < minLen || b.length < minLen) return false;
    for (let i = 0; i + minLen <= a.length; i++) {
        if (b.includes(a.slice(i, i + minLen))) return true;
    }
    return false;
}

// Soft ownership gate so users can't auto-track OTHER people's channels:
// the platform username must look like the poster's Discord identity.
// False negatives (real owners with unrelated Discord names) are handled by
// a mod linking them manually via the dashboard.
export function looksLikeOwnedChannel(member, platformUsername) {
    const target = normalizeIdentity(platformUsername);
    if (target.length < 4) return false;

    const candidates = [
        member.user?.username,
        member.user?.globalName,
        member.nickname,
        member.displayName,
    ].map(normalizeIdentity).filter(c => c.length >= 4);

    for (const cand of candidates) {
        if (cand === target) return true;
        if (cand.includes(target) || target.includes(cand)) return true;
        if (hasCommonSubstring(cand, target, 5)) return true;
    }
    return false;
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
export async function validatePlatformUser(platform, username) {
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

        if (platform === 'instagram') {
            // Instagram is no longer a supported go-live platform — Meta's Graph API
            // cannot detect Lives, so a subscription would never announce. Reject the
            // link instead of creating a phantom subscription.
            logger.info(`[SelfPromo] Ignoring Instagram link @${username} — platform not supported`);
            return null;
        }

        // YouTube, TikTok, Trovo, Facebook - pass through
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
export async function createStreamerAndSubscription(guildId, platform, platformUserId, canonicalUsername, discordUserId, channelId, teamSubscriptionId = null) {
    let connection;
    try {
        connection = await pool.getConnection();

        // Check if streamer already exists — match either canonical key
        // (platform_user_id) OR canonical username, since legacy setup scripts
        // wrote rows with placeholder platform_user_id values like
        // "<username>_id" which collide on the unique_platform_username index
        // when the API-resolved numeric id is later inserted.
        const [existing] = await connection.query(
            'SELECT streamer_id, platform_user_id FROM streamers WHERE platform = ? AND (platform_user_id = ? OR username = ?)',
            [platform, platformUserId, canonicalUsername]
        );

        let streamerId;
        if (existing.length > 0) {
            streamerId = existing[0].streamer_id;
            // Self-heal: if the existing row has a placeholder platform_user_id
            // that differs from the canonical numeric id we just resolved, fix it.
            if (existing[0].platform_user_id !== platformUserId) {
                await connection.query(
                    'UPDATE streamers SET platform_user_id = ? WHERE streamer_id = ?',
                    [platformUserId, streamerId]
                );
                logger.info('[SelfPromo] healed placeholder platform_user_id', {
                    streamerId, platform, canonicalUsername,
                    old: existing[0].platform_user_id, new: platformUserId
                });
            }
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
export async function getTeamSubscriptionId(guildId, discordUserId) {
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
export async function isStreamerAlreadyTracked(guildId, platform, platformUserId) {
    try {
        const [rows] = await pool.execute(
            `SELECT COALESCE(sub.announcement_channel_id, ts.announcement_channel_id, gc.announcement_channel_id) AS channel_id
             FROM subscriptions sub
             JOIN streamers s ON sub.streamer_id = s.streamer_id
             LEFT JOIN twitch_teams ts ON sub.team_subscription_id = ts.id
             LEFT JOIN guild_config gc ON sub.guild_id COLLATE utf8mb4_unicode_ci = gc.guild_id COLLATE utf8mb4_unicode_ci
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
 * Check whether a user is allowed to post/create threads in the self-promo
 * announcement channel. When the announce gate is disabled or the target
 * channel isn't the configured announcement channel, returns {allowed:true}.
 *
 * @param {import('discord.js').Guild} guild
 * @param {string} userId
 * @param {string} channelId - the channel the user tried to post in / created a thread under
 * @returns {Promise<{allowed:boolean, reasons?:string[], deleteUnauthorized?:boolean}>}
 */
export async function checkAnnounceChannelGate(guild, userId, channelId) {
    if (!guild || !userId || !channelId) return { allowed: true };

    const config = await getSelfPromoConfig(guild.id);
    if (!config || !config.announce_gate_enabled) return { allowed: true };
    if (!config.announcement_channel_id || config.announcement_channel_id !== channelId) {
        return { allowed: true };
    }

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return { allowed: true };

    // Manage Channels bypass — admins can always post
    try {
        if (member.permissions?.has?.('ManageChannels')) return { allowed: true };
    } catch { /* ignore permission-object glitches */ }

    const requiredRoleIds = safeJsonArray(config.announce_required_role_ids, 'announce_required_role_ids');
    const hasRequiredRole = requiredRoleIds.length === 0
        || member.roles.cache.some(r => requiredRoleIds.includes(r.id));

    const minLevel = Number(config.announce_min_level) || 0;
    let userLevel = 0;
    if (minLevel > 0) {
        const lm = guild.client?.levelingManager;
        if (lm?.getUserRank) {
            const rank = await lm.getUserRank(guild.id, userId).catch(() => null);
            userLevel = Number(rank?.level) || 0;
        }
    }
    const meetsLevel = minLevel <= 0 || userLevel >= minLevel;

    if (hasRequiredRole && meetsLevel) return { allowed: true };

    const reasons = [];
    if (!meetsLevel) {
        reasons.push(`Level **${minLevel}+** required (you are level ${userLevel})`);
    }
    if (!hasRequiredRole) {
        const mentions = requiredRoleIds.map(id => `<@&${id}>`).join(', ');
        reasons.push(`One of these roles is required: ${mentions}`);
    }
    return {
        allowed: false,
        reasons,
        deleteUnauthorized: config.announce_delete_unauthorized !== 0,
    };
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

    // From here on, every exit logs — the handler is now committed to this message.
    logger.info('[SelfPromo] entered handler for configured channel', {
        guildId, channelId: message.channel.id, userId: message.author?.id, contentPreview: message.content.slice(0, 120)
    });

    const member = message.member;
    if (!member) {
        logger.info('[SelfPromo] skipped: no member on message', { guildId, userId: message.author?.id });
        return false;
    }

    // Role whitelist bypass — members wearing any whitelisted role can post
    // freely without URL validation or deletion. See migration 086.
    const whitelistedRoles = safeJsonArray(config.whitelisted_role_ids, 'self_promo whitelisted_role_ids');
    if (whitelistedRoles.length > 0 && member.roles.cache.some(r => whitelistedRoles.includes(r.id))) {
        logger.info('[SelfPromo] skipped: member has whitelisted role', { guildId, userId: member.id });
        return false;
    }

    // Helper to delete the user's message
    const deleteMessage = () => message.delete().catch(err =>
        logger.error('[SelfPromo] Failed to delete message', { error: err.message, userId: member.id })
    );

    // Parse the URL from the message
    const parsed = parseStreamUrl(message.content);

    if (!parsed) {
        logger.info('[SelfPromo] skipped: no streamer URL parsed', {
            guildId, userId: member.id, deleteInvalid: !!config.delete_invalid,
            contentPreview: message.content.slice(0, 120)
        });
        // No streaming URL found — delete if configured
        if (config.delete_invalid) {
            await deleteMessage();
        }
        return true;
    }

    logger.info('[SelfPromo] URL parsed', {
        guildId, userId: member.id, platform: parsed.platform, username: parsed.username
    });

    // Check if platform is allowed
    const allowedPlatforms = config.allowed_platforms || [];
    if (allowedPlatforms.length > 0 && !allowedPlatforms.includes(parsed.platform)) {
        logger.info('[SelfPromo] skipped: platform not in allowlist', {
            guildId, userId: member.id, platform: parsed.platform, allowed: allowedPlatforms
        });
        if (config.delete_invalid) {
            await deleteMessage();
        }
        return true;
    }

    // Auto-subscribe disabled — just delete the message
    if (!config.auto_subscribe) {
        logger.info('[SelfPromo] skipped: auto_subscribe disabled', { guildId, userId: member.id });
        if (config.delete_invalid) {
            await deleteMessage();
        }
        return true;
    }

    // Validate the username with the platform API
    const validated = await validatePlatformUser(parsed.platform, parsed.username);
    if (!validated) {
        logger.info('[SelfPromo] skipped: platform validation failed', {
            guildId, userId: member.id, platform: parsed.platform, username: parsed.username
        });
        await deleteMessage();
        return true;
    }

    logger.info('[SelfPromo] platform validation OK', {
        guildId, userId: member.id, platform: parsed.platform,
        canonicalUsername: validated.canonicalUsername, platformUserId: validated.platformUserId
    });

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

    // Ownership gate — self-promo is for the user's OWN channel only.
    if (!looksLikeOwnedChannel(member, validated.canonicalUsername)) {
        logger.info('[SelfPromo] rejected: channel does not look owned by poster', {
            guildId, userId: member.id, platform: parsed.platform,
            postedChannel: validated.canonicalUsername,
            discordUsername: member.user?.username,
            discordDisplayName: member.displayName
        });
        await deleteMessage();
        try {
            await member.send(
                `The **${parsed.platform}** link you posted (\`${validated.canonicalUsername}\`) ` +
                `doesn't look like your own channel — this channel is for **self**-promotion only, ` +
                `please don't post other people's stream links here. ` +
                `If \`${validated.canonicalUsername}\` actually IS yours, ask a moderator to link it ` +
                `manually (your Discord name doesn't match the channel name closely enough for the ` +
                `bot to verify automatically).`
            );
        } catch {
            logger.debug('[SelfPromo] Could not DM rejection notice', { userId: member.id });
        }
        return true;
    }

    // Determine routing: team member → team channel, non-team → self-promo channel
    const teamId = await getTeamSubscriptionId(guildId, member.id);
    const isTeamMember = teamId !== null;

    // Team members: announcement_channel_id = NULL (falls through to team channel)
    // Non-team: same_channel=1 → signup channel; otherwise the configured
    //          announcement channel (fallback to signup channel if unset).
    const useSeparateAnnounceChannel = !config.same_channel && config.announcement_channel_id;
    const resolvedAnnounceChannelId = useSeparateAnnounceChannel
        ? config.announcement_channel_id
        : config.channel_id;
    const announcementChannelId = isTeamMember ? null : resolvedAnnounceChannelId;

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

    logger.info('[SelfPromo] createStreamerAndSubscription returned', {
        guildId, userId: member.id, platform: parsed.platform,
        canonicalUsername: validated.canonicalUsername, created, isTeamMember,
        announcementChannelId
    });

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
