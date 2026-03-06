/**
 * Cross-pollinate streamers across all servers.
 *
 * When a streamer is registered in any server, check all other servers
 * (across all bot instances) where that Discord user is a member.
 * If the other server has stream announcements configured (announcement_channel_id
 * in the guilds table), auto-create a subscription for that server using
 * the server's default announcement channel.
 */

import pool from './db.js';
import logger from './logger.js';

/**
 * Cross-pollinate a streamer to all guilds they're a member of.
 *
 * @param {number|string} streamerId - The streamer's DB ID
 * @param {string} discordUserId - The streamer's Discord user ID
 * @param {string} originGuildId - The guild that originally registered the streamer (skip this one)
 * @returns {Array} List of guilds that were auto-subscribed
 */
export async function crossPollinateStreamer(streamerId, discordUserId, originGuildId) {
    if (!discordUserId) return [];

    const added = [];

    try {
        // Collect all guild IDs where this user is a member (across all bot instances)
        // botManager.clients includes both the default bot ('default' key) and all custom bots
        const memberGuildIds = new Set();
        const botManager = global.botManager;

        if (botManager?.clients) {
            for (const [, botClient] of botManager.clients) {
                if (!botClient.isReady() || !botClient.guilds?.cache) continue;
                for (const [guildId, guild] of botClient.guilds.cache) {
                    if (guildId === originGuildId) continue;
                    if (guild.members.cache.has(discordUserId)) {
                        memberGuildIds.add(guildId);
                    }
                }
            }
        }

        if (memberGuildIds.size === 0) return [];

        // Check which of these guilds have stream announcements configured
        const placeholders = Array.from(memberGuildIds).map(() => '?').join(',');
        const [guildsWithAnnouncements] = await pool.execute(
            `SELECT guild_id, announcement_channel_id FROM guilds
             WHERE guild_id IN (${placeholders})
             AND announcement_channel_id IS NOT NULL
             AND announcement_channel_id != ''`,
            Array.from(memberGuildIds)
        );

        if (guildsWithAnnouncements.length === 0) return [];

        // Create subscriptions where they don't exist
        for (const guildConfig of guildsWithAnnouncements) {
            const [existingSub] = await pool.execute(
                'SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
                [guildConfig.guild_id, streamerId]
            );

            if (existingSub.length === 0) {
                await pool.execute(
                    'INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)',
                    [guildConfig.guild_id, streamerId, guildConfig.announcement_channel_id]
                );

                added.push({
                    guildId: guildConfig.guild_id,
                    channelId: guildConfig.announcement_channel_id
                });

                logger.info(`[CrossPollinate] Auto-subscribed streamer ${streamerId} to guild ${guildConfig.guild_id} -> ${guildConfig.announcement_channel_id}`, {
                    streamerId, guildId: guildConfig.guild_id, category: 'streams'
                });
            }
        }
    } catch (error) {
        logger.error('[CrossPollinate] Error cross-pollinating streamer:', {
            error: error.message, streamerId, discordUserId, category: 'streams'
        });
    }

    return added;
}

/**
 * Backfill: cross-pollinate ALL existing streamers that have a discord_user_id.
 * Runs within the bot context so it can check guild membership via bot clients.
 *
 * @returns {{ total: number, created: number, details: Array }}
 */
export async function backfillCrossPollinate() {
    const [streamers] = await pool.execute(
        'SELECT streamer_id, username, discord_user_id FROM streamers WHERE discord_user_id IS NOT NULL'
    );

    logger.info(`[CrossPollinate:Backfill] Starting backfill for ${streamers.length} streamers`, { category: 'streams' });

    let created = 0;
    const details = [];

    for (const { streamer_id, username, discord_user_id } of streamers) {
        // Pass null as originGuildId so no guild is skipped
        const added = await crossPollinateStreamer(streamer_id, discord_user_id, null);
        if (added.length > 0) {
            created += added.length;
            details.push({ username, streamer_id, guildsAdded: added });
        }
    }

    logger.info(`[CrossPollinate:Backfill] Complete: ${created} new subscriptions across ${details.length} streamers`, { category: 'streams' });

    return { total: streamers.length, created, details };
}

/**
 * Cross-pollinate all existing tracked streamers INTO a specific guild.
 * Called when a guild enables stream notifications (sets an announcement channel).
 *
 * Uses REST API guild.members.fetch() for accurate membership checks.
 * Runs asynchronously — fire-and-forget from the caller.
 *
 * @param {string} guildId - The guild that just enabled notifications
 * @param {string} channelId - The guild's default announcement channel
 * @returns {{ checked: number, created: number, details: Array }}
 */
export async function crossPollinateGuild(guildId, channelId) {
    if (!guildId || !channelId) return { checked: 0, created: 0, details: [] };

    const botManager = global.botManager;
    if (!botManager?.clients) {
        logger.warn('[CrossPollinate:Guild] No bot manager available, skipping', { category: 'streams' });
        return { checked: 0, created: 0, details: [] };
    }

    // Find the bot client that serves this guild
    let guild = null;
    for (const [, botClient] of botManager.clients) {
        if (!botClient.isReady()) continue;
        const g = botClient.guilds.cache.get(guildId);
        if (g) { guild = g; break; }
    }

    if (!guild) {
        logger.warn(`[CrossPollinate:Guild] Guild ${guildId} not found in any bot client`, { category: 'streams' });
        return { checked: 0, created: 0, details: [] };
    }

    try {
        // Get all streamers with a discord_user_id
        const [streamers] = await pool.execute(
            'SELECT streamer_id, username, platform, discord_user_id FROM streamers WHERE discord_user_id IS NOT NULL'
        );

        if (streamers.length === 0) return { checked: 0, created: 0, details: [] };

        // Deduplicate by discord_user_id to minimize API calls
        const uniqueUsers = new Map();
        for (const s of streamers) {
            if (!uniqueUsers.has(s.discord_user_id)) {
                uniqueUsers.set(s.discord_user_id, []);
            }
            uniqueUsers.get(s.discord_user_id).push(s);
        }

        logger.info(`[CrossPollinate:Guild] Checking ${uniqueUsers.size} unique Discord users for guild ${guildId}`, { category: 'streams' });

        let checked = 0;
        let created = 0;
        const details = [];

        for (const [discordUserId, userStreamers] of uniqueUsers) {
            checked++;

            // REST API membership check
            const isMember = await guild.members.fetch(discordUserId).then(() => true).catch(() => false);
            if (!isMember) continue;

            // Create subscriptions for each of this user's streamer entries
            for (const streamer of userStreamers) {
                const [existing] = await pool.execute(
                    'SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
                    [guildId, streamer.streamer_id]
                );

                if (existing.length === 0) {
                    await pool.execute(
                        'INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id) VALUES (?, ?, ?)',
                        [guildId, streamer.streamer_id, channelId]
                    );

                    created++;
                    details.push({ username: streamer.username, platform: streamer.platform, streamer_id: streamer.streamer_id });

                    logger.info(`[CrossPollinate:Guild] Auto-subscribed ${streamer.username} (${streamer.platform}) to guild ${guildId}`, {
                        category: 'streams', streamerId: streamer.streamer_id
                    });
                }
            }
        }

        logger.info(`[CrossPollinate:Guild] Complete for guild ${guildId}: checked ${checked} users, created ${created} subscriptions`, {
            category: 'streams', guildId, checked, created
        });

        return { checked, created, details };
    } catch (error) {
        logger.error('[CrossPollinate:Guild] Error:', {
            error: error.message, guildId, category: 'streams'
        });
        return { checked: 0, created: 0, details: [] };
    }
}
