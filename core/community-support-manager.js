import logger from '../utils/logger.js';
import pool from '../utils/db.js';

// In-memory config cache per guild
const configCache = new Map();
const CONFIG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get community support config for a guild (cached)
 */
export async function getConfig(guildId) {
    const cached = configCache.get(guildId);
    if (cached && Date.now() - cached.ts < CONFIG_CACHE_TTL) return cached.data;

    const [rows] = await pool.execute(
        'SELECT * FROM community_support_config WHERE guild_id = ? AND enabled = 1',
        [guildId]
    );

    const config = rows[0] || null;
    configCache.set(guildId, { data: config, ts: Date.now() });
    return config;
}

/**
 * Invalidate config cache for a guild
 */
export function invalidateConfig(guildId) {
    configCache.delete(guildId);
}

/**
 * Generate candidate Twitch usernames from a raw name string.
 * Strips common suffixes (ttv, tv) and cleans non-Twitch characters.
 * @param {string} rawName
 * @returns {string[]} Array of unique valid Twitch username candidates (lowercase)
 */
export function generateCandidateUsernames(rawName) {
    if (!rawName || typeof rawName !== 'string') return [];

    const candidates = [];
    const seen = new Set();
    const base = rawName.toLowerCase().trim();

    // Clean non-Twitch characters (Twitch allows a-z, 0-9, _)
    const cleaned = base.replace(/[^a-z0-9_]/g, '').replace(/^_+|_+$/g, '');
    if (cleaned.length >= 4 && cleaned.length <= 25 && !seen.has(cleaned)) {
        candidates.push(cleaned); // Exact cleaned name is highest priority
        seen.add(cleaned);
    }

    // Only strip explicit TTV-style suffixes: _ttv, .ttv, ttv (NOT plain "tv")
    // This prevents "miketv" -> "mike" which is a different person
    const ttvPattern = /[_.]?ttv$/i;
    const stripped = cleaned.replace(ttvPattern, '').replace(/^_+|_+$/g, '');
    if (stripped !== cleaned && stripped.length >= 4 && stripped.length <= 25 && /^[a-z0-9_]+$/.test(stripped) && !seen.has(stripped)) {
        candidates.push(stripped);
        seen.add(stripped);
    }

    return candidates; // Ordered: exact first, then variant
}

/**
 * Find the best Twitch account match from multiple name sources.
 * Batch-checks all candidates via getTwitchUsers, prefers affiliate/partner.
 * Optionally caches the result in community_twitch_links.
 * @param {string[]} nameSources - Array of raw name strings (username, displayName, globalName)
 * @param {string} guildId
 * @param {string|null} discordUserId - If provided, caches the Discord→Twitch link
 * @returns {Promise<{ isAffiliate: boolean, twitchId: string, canonicalUsername: string }|null>}
 */
export async function findBestTwitchMatch(nameSources, guildId, discordUserId = null) {
    // Generate candidates per source, maintaining priority order.
    // nameSources is ordered by priority: [username, nickname, globalName]
    // Within each source, generateCandidateUsernames returns [exact, stripped_variant]
    // We try candidates in strict priority order — first valid Twitch match wins.
    // This prevents a nickname-derived candidate from overriding the actual username match.
    const orderedCandidates = [];
    const seen = new Set();
    for (const source of nameSources) {
        if (!source) continue;
        for (const candidate of generateCandidateUsernames(source)) {
            if (!seen.has(candidate)) {
                orderedCandidates.push(candidate);
                seen.add(candidate);
            }
        }
    }

    if (orderedCandidates.length === 0) return null;

    try {
        // Batch API call for efficiency — get all Twitch users in one request
        const { getTwitchUsers } = await import('../utils/platforms/twitch-api.js');
        const users = await getTwitchUsers(orderedCandidates);

        if (!users || users.length === 0) return null;

        // Build lookup map: lowercase login → Twitch user data
        const userMap = new Map();
        for (const user of users) {
            userMap.set(user.login.toLowerCase(), user);
        }

        // Walk candidates in priority order — first match wins (accuracy over affiliate status)
        let bestMatch = null;
        for (const candidate of orderedCandidates) {
            const user = userMap.get(candidate);
            if (user) {
                const isAffiliate = user.broadcaster_type === 'affiliate' || user.broadcaster_type === 'partner';
                bestMatch = { isAffiliate, twitchId: user.id, canonicalUsername: user.login };
                break; // First match in priority order is the most accurate
            }
        }

        if (!bestMatch) return null;

        // Cache the result in community_twitch_links
        const cacheDiscordId = discordUserId || 'api_lookup';
        await pool.execute(
            `INSERT INTO community_twitch_links (guild_id, discord_user_id, twitch_username, twitch_user_id, is_affiliate, last_checked)
             VALUES (?, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE is_affiliate = ?, twitch_username = ?, twitch_user_id = ?, last_checked = NOW()`,
            [guildId, cacheDiscordId, bestMatch.canonicalUsername, bestMatch.twitchId, bestMatch.isAffiliate ? 1 : 0,
             bestMatch.isAffiliate ? 1 : 0, bestMatch.canonicalUsername, bestMatch.twitchId]
        );

        logger.info(`[CommunitySupport] findBestTwitchMatch: candidates=[${orderedCandidates.join(',')}] → ${bestMatch.canonicalUsername} (affiliate=${bestMatch.isAffiliate})`);
        return bestMatch;
    } catch (error) {
        logger.warn(`[CommunitySupport] findBestTwitchMatch failed for candidates [${orderedCandidates.join(',')}]:`, {
            error: error.message
        });
        return null;
    }
}

/**
 * Extract Twitch usernames from a message.
 * Handles: twitch.tv/username, @username, plain usernames, URLs
 * @returns {{ username: string, fromUrl: boolean }[]}
 */
export function extractTwitchUsernames(content) {
    const results = [];
    const seen = new Set();

    // Match twitch.tv/username links (most reliable signal)
    const twitchLinkRegex = /(?:https?:\/\/)?(?:www\.)?twitch\.tv\/([a-zA-Z0-9_]{4,25})/gi;
    let match;
    while ((match = twitchLinkRegex.exec(content)) !== null) {
        const name = match[1].toLowerCase();
        if (!seen.has(name)) {
            seen.add(name);
            results.push({ username: name, fromUrl: true });
        }
    }

    // If we found links, return those
    if (results.length > 0) return results;

    // Only extract @-prefixed usernames (explicit intent to reference someone)
    // This avoids false positives from casual conversation words
    const atMentionRegex = /(?:^|\s)@([a-zA-Z0-9_]{4,25})(?:\s|$|[.,!?])/g;
    while ((match = atMentionRegex.exec(content)) !== null) {
        const name = match[1].toLowerCase();
        // Skip common words that might follow @
        if (!['everyone', 'here', 'channel'].includes(name) && !seen.has(name)) {
            seen.add(name);
            results.push({ username: name, fromUrl: false });
        }
    }

    return results;
}

/**
 * Check if a Twitch user is an affiliate or partner.
 * Uses cache from community_twitch_links, falls back to Twitch API.
 * @returns {{ isAffiliate: boolean, twitchId: string|null, canonicalUsername: string }}
 */
export async function checkAffiliateStatus(guildId, twitchUsername) {
    const cleanName = twitchUsername.toLowerCase();

    // Check DB cache first (refreshes every 24 hours)
    const [cached] = await pool.execute(
        `SELECT is_affiliate, twitch_user_id, last_checked FROM community_twitch_links
         WHERE guild_id = ? AND twitch_username = ?`,
        [guildId, cleanName]
    );

    if (cached.length > 0) {
        const age = Date.now() - new Date(cached[0].last_checked).getTime();
        if (age < 24 * 60 * 60 * 1000) { // Less than 24 hours old
            return { isAffiliate: !!cached[0].is_affiliate, twitchId: cached[0].twitch_user_id || null, canonicalUsername: cleanName };
        }
    }

    // Call Twitch API
    try {
        const { getTwitchUser } = await import('../utils/platforms/twitch-api.js');
        const user = await getTwitchUser(cleanName);

        if (!user) {
            // getTwitchUser returns null for both "not found" AND API errors.
            // If we have a stale cache entry, trust it over assuming non-affiliate.
            if (cached.length > 0) {
                logger.info(`[CommunitySupport] Twitch API returned null for ${cleanName}, using stale cache: affiliate=${cached[0].is_affiliate}`);
                return { isAffiliate: !!cached[0].is_affiliate, twitchId: cached[0].twitch_user_id || null, canonicalUsername: cleanName };
            }
            logger.debug(`[CommunitySupport] Twitch user not found (no cache): ${cleanName}`);
            return { isAffiliate: false, twitchId: null, canonicalUsername: cleanName };
        }

        const isAffiliate = user.broadcaster_type === 'affiliate' || user.broadcaster_type === 'partner';
        const twitchId = user.id;
        const canonicalUsername = user.login;

        // Update cache
        await pool.execute(
            `INSERT INTO community_twitch_links (guild_id, discord_user_id, twitch_username, twitch_user_id, is_affiliate, last_checked)
             VALUES (?, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE is_affiliate = ?, twitch_username = ?, twitch_user_id = ?, last_checked = NOW()`,
            [guildId, 'api_lookup', canonicalUsername, twitchId, isAffiliate ? 1 : 0, isAffiliate ? 1 : 0, canonicalUsername, twitchId]
        );

        // Also update the real discord user's cache row if it exists (PK is guild_id + discord_user_id)
        if (cached.length > 0 && cached[0].twitch_user_id !== twitchId) {
            await pool.execute(
                `UPDATE community_twitch_links SET is_affiliate = ?, twitch_user_id = ?, last_checked = NOW()
                 WHERE guild_id = ? AND twitch_username = ?`,
                [isAffiliate ? 1 : 0, twitchId, guildId, cleanName]
            );
        }

        return { isAffiliate, twitchId, canonicalUsername };
    } catch (error) {
        logger.warn(`[CommunitySupport] Failed to check affiliate status for ${cleanName}:`, {
            error: error.message
        });
        // If API fails but we have a stale cache entry, use it instead of defaulting to false
        if (cached.length > 0) {
            logger.info(`[CommunitySupport] Using stale cache for ${cleanName}: affiliate=${cached[0].is_affiliate}`);
            return { isAffiliate: !!cached[0].is_affiliate, twitchId: cached[0].twitch_user_id || null, canonicalUsername: cleanName };
        }
        return { isAffiliate: false, twitchId: null, canonicalUsername: cleanName };
    }
}

/**
 * Try to resolve a Discord user to their Twitch username and ID.
 * Checks: community_twitch_links, streamers table, streamer_discord_links
 * @returns {{ username: string, twitchId: string|null }|null}
 */
export async function resolveTwitchUsername(guildId, discordUserId) {
    // Check verified sources FIRST (streamers table has confirmed Discord↔Twitch links)
    // These are more reliable than the auto-resolved cache

    // Check streamers table (verified via streamer subscriptions)
    const [streamers] = await pool.execute(
        `SELECT s.username, s.platform_user_id FROM streamers s
         JOIN subscriptions sub ON s.streamer_id = sub.streamer_id
         WHERE sub.guild_id = ? AND s.discord_user_id = ? AND s.platform = 'twitch'
         LIMIT 1`,
        [guildId, discordUserId]
    );
    if (streamers.length > 0) return { username: streamers[0].username, twitchId: streamers[0].platform_user_id || null };

    // Check streamer_discord_links (verified links across all guilds)
    const [discordLinks] = await pool.execute(
        `SELECT s.username, s.platform_user_id FROM streamer_discord_links sdl
         JOIN streamers s ON sdl.streamer_id = s.streamer_id
         WHERE sdl.discord_user_id = ? AND s.platform = 'twitch'
         LIMIT 1`,
        [discordUserId]
    );
    if (discordLinks.length > 0) return { username: discordLinks[0].username, twitchId: discordLinks[0].platform_user_id || null };

    // Fall back to auto-resolved cache (less reliable, expires after 7 days)
    const [links] = await pool.execute(
        'SELECT twitch_username, twitch_user_id, last_checked FROM community_twitch_links WHERE guild_id = ? AND discord_user_id = ?',
        [guildId, discordUserId]
    );
    if (links.length > 0) {
        const age = Date.now() - new Date(links[0].last_checked).getTime();
        if (age < 7 * 24 * 60 * 60 * 1000) {
            return { username: links[0].twitch_username, twitchId: links[0].twitch_user_id || null };
        }
        // Stale — delete so it gets re-resolved via findBestTwitchMatch
        await pool.execute(
            'DELETE FROM community_twitch_links WHERE guild_id = ? AND discord_user_id = ?',
            [guildId, discordUserId]
        );
        logger.info(`[CommunitySupport] Expired stale twitch link cache for discord user ${discordUserId}`);
    }

    return null;
}

/**
 * Record a support/raid entry and award points
 */
export async function recordEntry(guildId, userId, entryType, targetUsername, isAffiliate, messageId, channelId, config, targetTwitchId = null) {
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // Prevent duplicate entries for the same message + target
    const [existing] = await pool.execute(
        'SELECT id FROM community_support_entries WHERE guild_id = ? AND message_id = ? AND target_username = ? LIMIT 1',
        [guildId, messageId, targetUsername]
    );
    if (existing.length > 0) {
        logger.debug(`[CommunitySupport] Skipping duplicate: ${userId} -> ${targetUsername} (message ${messageId})`);
        return 0;
    }

    let points;
    if (entryType === 'raid') {
        points = isAffiliate ? config.raid_affiliate_points : config.raid_non_affiliate_points;
    } else {
        points = config.support_points;
    }

    await pool.execute(
        `INSERT INTO community_support_entries
         (guild_id, user_id, entry_type, target_username, target_twitch_id, target_is_affiliate, points_awarded, message_id, channel_id, month_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [guildId, userId, entryType, targetUsername, targetTwitchId, isAffiliate ? 1 : 0, points, messageId, channelId, monthKey]
    );

    logger.info(`[CommunitySupport] Recorded ${entryType}: ${userId} -> ${targetUsername} (${isAffiliate ? 'affiliate' : 'non-affiliate'}, ${points}pts)`);
    return points;
}

/**
 * Get leaderboard for current or specified month
 */
export async function getLeaderboard(guildId, monthKey = null, limit = 10) {
    if (!monthKey) {
        const now = new Date();
        monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    const [rows] = await pool.execute(
        `SELECT user_id, SUM(points_awarded) as total_points,
                COUNT(*) as total_entries,
                SUM(CASE WHEN entry_type = 'raid' THEN 1 ELSE 0 END) as raid_count,
                SUM(CASE WHEN entry_type = 'support' THEN 1 ELSE 0 END) as support_count
         FROM community_support_entries
         WHERE guild_id = ? AND month_key = ?
         GROUP BY user_id
         ORDER BY total_points DESC
         LIMIT ?`,
        [guildId, monthKey, limit]
    );

    return rows;
}

/**
 * Get a user's stats for the current month
 */
export async function getUserStats(guildId, userId, monthKey = null) {
    if (!monthKey) {
        const now = new Date();
        monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    const [rows] = await pool.execute(
        `SELECT SUM(points_awarded) as total_points,
                COUNT(*) as total_entries,
                SUM(CASE WHEN entry_type = 'raid' THEN 1 ELSE 0 END) as raid_count,
                SUM(CASE WHEN entry_type = 'support' THEN 1 ELSE 0 END) as support_count
         FROM community_support_entries
         WHERE guild_id = ? AND user_id = ? AND month_key = ?`,
        [guildId, userId, monthKey]
    );

    return rows[0] || { total_points: 0, total_entries: 0, raid_count: 0, support_count: 0 };
}

/**
 * Monthly rotation: tally top 10 and add to shoutout system
 */
export async function performMonthlyRotation(guildId, client) {
    const now = new Date();
    // Get LAST month's key (we rotate at start of new month)
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const monthKey = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;

    // Check if rotation already done for this month
    const [existing] = await pool.execute(
        'SELECT id FROM community_support_shoutouts WHERE guild_id = ? AND month_key = ?',
        [guildId, monthKey]
    );

    if (existing.length > 0) {
        logger.debug(`[CommunitySupport] Monthly rotation already done for ${monthKey}`);
        return null;
    }

    const config = await getConfig(guildId);
    if (!config) return null;

    // Get top 10 from last month
    const leaderboard = await getLeaderboard(guildId, monthKey, 10);

    if (leaderboard.length === 0) {
        logger.info(`[CommunitySupport] No entries for ${monthKey}, skipping rotation`);
        return null;
    }

    // Active until end of current month
    const activeUntil = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const activeUntilStr = activeUntil.toISOString().slice(0, 10);

    const shoutoutEntries = [];

    for (let i = 0; i < leaderboard.length; i++) {
        const entry = leaderboard[i];
        const resolved = await resolveTwitchUsername(guildId, entry.user_id);
        const twitchUsername = resolved ? resolved.username : null;

        let streamerId = null;

        // If we have a Twitch username, ensure they're in the streaming system
        if (twitchUsername && config.shoutout_channel_id) {
            streamerId = await ensureStreamerSubscription(
                guildId, entry.user_id, twitchUsername, config.shoutout_channel_id
            );
        }

        await pool.execute(
            `INSERT INTO community_support_shoutouts
             (guild_id, user_id, twitch_username, total_points, rank_position, month_key, active_until, streamer_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [guildId, entry.user_id, twitchUsername, entry.total_points, i + 1, monthKey, activeUntilStr, streamerId]
        );

        shoutoutEntries.push({
            userId: entry.user_id,
            twitchUsername,
            totalPoints: entry.total_points,
            rank: i + 1
        });
    }

    logger.info(`[CommunitySupport] Monthly rotation complete for ${monthKey}: ${shoutoutEntries.length} users`);
    return shoutoutEntries;
}

/**
 * Ensure a user is subscribed as a streamer in the shoutout channel
 */
async function ensureStreamerSubscription(guildId, discordUserId, twitchUsername, channelId) {
    try {
        const { getTwitchUser } = await import('../utils/platforms/twitch-api.js');
        const twitchUser = await getTwitchUser(twitchUsername);
        if (!twitchUser) return null;

        // Check if streamer already exists
        const [existing] = await pool.execute(
            'SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?',
            ['twitch', twitchUser.id]
        );

        let streamerId;
        if (existing.length > 0) {
            streamerId = existing[0].streamer_id;
            // Update discord_user_id and profile image if not already set
            await pool.execute(
                `UPDATE streamers SET discord_user_id = COALESCE(NULLIF(discord_user_id, ''), ?),
                 profile_image_url = COALESCE(profile_image_url, ?)
                 WHERE streamer_id = ?`,
                [discordUserId, twitchUser.profile_image_url || null, streamerId]
            );
        } else {
            const [result] = await pool.execute(
                `INSERT INTO streamers (platform, platform_user_id, username, discord_user_id, profile_image_url)
                 VALUES ('twitch', ?, ?, ?, ?)`,
                [twitchUser.id, twitchUser.login, discordUserId, twitchUser.profile_image_url || null]
            );
            streamerId = result.insertId;
        }

        // Check if subscription exists for this guild
        const [existingSub] = await pool.execute(
            'SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
            [guildId, streamerId]
        );

        if (existingSub.length === 0) {
            await pool.execute(
                `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, delete_on_end)
                 VALUES (?, ?, ?, 1)`,
                [guildId, streamerId, channelId]
            );
            logger.info(`[CommunitySupport] Added streamer subscription: ${twitchUsername} -> channel ${channelId}`);
        }

        return streamerId;
    } catch (error) {
        logger.warn(`[CommunitySupport] Failed to ensure streamer subscription for ${twitchUsername}:`, {
            error: error.message
        });
        return null;
    }
}

/**
 * Remove expired shoutout subscriptions (called monthly)
 */
export async function cleanupExpiredShoutouts(guildId) {
    const today = new Date().toISOString().slice(0, 10);

    const [expired] = await pool.execute(
        `SELECT streamer_id FROM community_support_shoutouts
         WHERE guild_id = ? AND active_until < ? AND streamer_id IS NOT NULL`,
        [guildId, today]
    );

    for (const entry of expired) {
        // Only remove if they're not in the current rotation
        const [current] = await pool.execute(
            `SELECT id FROM community_support_shoutouts
             WHERE guild_id = ? AND streamer_id = ? AND active_until >= ?`,
            [guildId, entry.streamer_id, today]
        );

        if (current.length === 0) {
            // Never remove permanent subscriptions (owner/family/close friends)
            const [permCheck] = await pool.execute(
                'SELECT permanent FROM subscriptions WHERE guild_id = ? AND streamer_id = ? AND permanent = 1',
                [guildId, entry.streamer_id]
            );
            if (permCheck.length > 0) {
                logger.info(`[CommunitySupport] Skipping permanent subscription: streamer ${entry.streamer_id}`);
                continue;
            }

            await pool.execute(
                'DELETE FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
                [guildId, entry.streamer_id]
            );
            logger.info(`[CommunitySupport] Removed expired shoutout subscription: streamer ${entry.streamer_id}`);
        }
    }
}

export default {
    getConfig, invalidateConfig, extractTwitchUsernames,
    checkAffiliateStatus, resolveTwitchUsername, recordEntry,
    getLeaderboard, getUserStats, performMonthlyRotation, cleanupExpiredShoutouts,
    generateCandidateUsernames, findBestTwitchMatch
};
