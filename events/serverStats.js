/**
 * Server Stats Tracker
 * Tracks daily server statistics for analytics
 */

import pool from '../utils/db.js';
import logger from '../utils/logger.js';

// Track message counts per guild
const messageCountCache = new Map();
const activeUsersCache = new Map();

export default {
    name: 'ready',
    once: true,
    async execute(client) {
        // Save stats at midnight UTC
        scheduleDaily(() => saveAllStats(client), 0, 0);

        // Also set up message counter
        client.on('messageCreate', (message) => {
            if (!message.guild || message.author.bot) return;

            const guildId = message.guild.id;

            // Increment message count
            messageCountCache.set(guildId, (messageCountCache.get(guildId) || 0) + 1);

            // Track active users
            if (!activeUsersCache.has(guildId)) {
                activeUsersCache.set(guildId, new Set());
            }
            activeUsersCache.get(guildId).add(message.author.id);
        });

        logger.info('[ServerStats] Stats tracking initialized');
    }
};

function scheduleDaily(callback, hour, minute) {
    const now = new Date();
    let target = new Date(now);
    target.setUTCHours(hour, minute, 0, 0);

    // If we've passed the target time today, schedule for tomorrow
    if (target <= now) {
        target.setDate(target.getDate() + 1);
    }

    const msUntilTarget = target - now;

    setTimeout(() => {
        callback();
        // Then repeat every 24 hours
        setInterval(callback, 24 * 60 * 60 * 1000);
    }, msUntilTarget);
}

async function saveAllStats(client) {
    const today = new Date().toISOString().split('T')[0];

    for (const guild of client.guilds.cache.values()) {
        try {
            await saveGuildStats(guild, today);
        } catch (error) {
            logger.error(`[ServerStats] Failed to save stats for ${guild.name}:`, error);
        }
    }

    // Clear caches after saving
    messageCountCache.clear();
    activeUsersCache.clear();

    logger.info('[ServerStats] Daily stats saved for all guilds');
}

async function saveGuildStats(guild, date) {
    const guildId = guild.id;

    // Get current member count
    const memberCount = guild.memberCount;

    // Get message count from cache
    const messageCount = messageCountCache.get(guildId) || 0;

    // Get active users count
    const activeUsers = activeUsersCache.get(guildId)?.size || 0;

    // Calculate new members (members who joined today)
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const newMembers = guild.members.cache.filter(m =>
        m.joinedTimestamp && m.joinedTimestamp > oneDayAgo
    ).size;

    // Upsert stats
    await pool.execute(
        `INSERT INTO server_stats (guild_id, date, member_count, message_count, new_members, active_users)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
        member_count = VALUES(member_count),
        message_count = VALUES(message_count),
        new_members = VALUES(new_members),
        active_users = VALUES(active_users)`,
        [guildId, date, memberCount, messageCount, newMembers, activeUsers]
    );
}

// Export function for manual stats check
export async function getGuildStats(guildId, days = 7) {
    const [stats] = await pool.execute(
        `SELECT * FROM server_stats
        WHERE guild_id = ?
        ORDER BY date DESC
        LIMIT ?`,
        [guildId, days]
    );

    return stats;
}
