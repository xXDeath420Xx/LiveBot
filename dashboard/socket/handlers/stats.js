/**
 * Stats Socket Handler
 * Handles real-time statistics updates
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

// Cache for stats to avoid hammering the database
const statsCache = new Map();
const CACHE_TTL = 30000; // 30 seconds

export function statsHandler(io, socket) {
    /**
     * Request current stats for a guild
     */
    socket.on('stats:get', async (data) => {
        try {
            const { guildId } = data;
            if (!guildId) return;

            // Check cache
            const cached = statsCache.get(guildId);
            if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
                socket.emit('stats:data', cached.data);
                return;
            }

            // Fetch fresh stats
            const stats = await fetchGuildStats(guildId);

            // Cache the result
            statsCache.set(guildId, {
                data: stats,
                timestamp: Date.now()
            });

            socket.emit('stats:data', stats);

        } catch (error) {
            logger.error('[Socket Stats] Error:', error);
        }
    });

    /**
     * Subscribe to real-time stats updates
     */
    socket.on('stats:subscribe', (guildId) => {
        if (!guildId) return;
        socket.statsSubscription = guildId;

        // Send initial stats
        socket.emit('stats:subscribed', { guildId });
    });

    /**
     * Unsubscribe from stats updates
     */
    socket.on('stats:unsubscribe', () => {
        socket.statsSubscription = null;
    });
}

/**
 * Fetch guild statistics from database
 */
async function fetchGuildStats(guildId) {
    const stats = {
        guildId,
        timestamp: Date.now(),
        messages: { total: 0, today: 0 },
        members: { joins: 0, leaves: 0 },
        moderation: { total: 0, today: 0 },
        activity: []
    };

    try {
        // Message stats (last 30 days)
        const [messageStats] = await pool.execute(`
            SELECT
                SUM(count) as total,
                SUM(CASE WHEN log_date = CURDATE() THEN count ELSE 0 END) as today
            FROM activity_logs
            WHERE guild_id = ? AND type = 'message'
            AND log_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        `, [guildId]);

        if (messageStats[0]) {
            stats.messages.total = messageStats[0].total || 0;
            stats.messages.today = messageStats[0].today || 0;
        }

        // Member stats (last 30 days)
        const [memberStats] = await pool.execute(`
            SELECT event_type, COUNT(*) as count
            FROM member_logs
            WHERE guild_id = ?
            AND timestamp >= DATE_SUB(NOW(), INTERVAL 30 DAY)
            GROUP BY event_type
        `, [guildId]);

        memberStats.forEach(stat => {
            if (stat.event_type === 'JOIN') stats.members.joins = stat.count;
            if (stat.event_type === 'LEAVE') stats.members.leaves = stat.count;
        });

        // Moderation stats
        const [modStats] = await pool.execute(`
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN DATE(timestamp) = CURDATE() THEN 1 ELSE 0 END) as today
            FROM infractions
            WHERE guild_id = ?
            AND timestamp >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        `, [guildId]);

        if (modStats[0]) {
            stats.moderation.total = modStats[0].total || 0;
            stats.moderation.today = modStats[0].today || 0;
        }

        // Daily activity for chart (last 7 days)
        const [dailyActivity] = await pool.execute(`
            SELECT
                log_date as date,
                SUM(count) as messages
            FROM activity_logs
            WHERE guild_id = ? AND type = 'message'
            AND log_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
            GROUP BY log_date
            ORDER BY log_date ASC
        `, [guildId]);

        stats.activity = dailyActivity.map(row => ({
            date: row.date,
            messages: row.messages || 0
        }));

    } catch (error) {
        logger.error('[Stats Fetch] Error:', error);
    }

    return stats;
}

/**
 * Broadcast stats update to guild subscribers
 * Called externally when stats change
 */
export function broadcastStatsUpdate(io, guildId, stats) {
    io.to(`guild:${guildId}`).emit('stats:update', {
        ...stats,
        timestamp: Date.now()
    });

    // Update cache
    statsCache.set(guildId, {
        data: stats,
        timestamp: Date.now()
    });
}

/**
 * Clear stats cache for a guild
 */
export function clearStatsCache(guildId) {
    if (guildId) {
        statsCache.delete(guildId);
    } else {
        statsCache.clear();
    }
}

export default statsHandler;
