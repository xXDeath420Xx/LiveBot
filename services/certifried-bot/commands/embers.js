/**
 * !embers / !globallit
 * Display global statistics
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

export async function embersCommand(ctx) {
    const { username, reply, profile } = ctx;

    try {
        // Get global stats
        const [[stats]] = await pool.execute(`
            SELECT
                COUNT(*) as total_users,
                SUM(lifetime_tokes) as total_tokes,
                MAX(lifetime_tokes) as top_tokes,
                MAX(current_streak) as top_streak,
                MAX(level) as top_level,
                AVG(level) as avg_level
            FROM tokes_profiles
        `);

        // Get active channels count
        const [[channelStats]] = await pool.execute(`
            SELECT COUNT(*) as active_channels
            FROM tokes_channels
            WHERE is_enabled = 1
        `);

        // Get user's rank
        const [[userRank]] = await pool.execute(`
            SELECT COUNT(*) + 1 as rank
            FROM tokes_profiles
            WHERE lifetime_tokes > ?
        `, [profile.lifetime_tokes || 0]);

        // Format numbers
        const formatNum = (n) => {
            if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
            if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
            return n?.toString() || '0';
        };

        const response = [
            `Global Embers:`,
            `${formatNum(stats.total_tokes)} total tokes`,
            `${formatNum(stats.total_users)} users`,
            `${channelStats.active_channels} active channels`,
            `Top streak: ${stats.top_streak || 0} days`,
            `Your rank: #${userRank.rank} (${profile.lifetime_tokes || 0} tokes)`
        ].join(' | ');

        reply(response);

    } catch (error) {
        logger.error('[EmbersCommand] Error', { error: error.message });
        reply(`${username}, couldn't load global stats right now.`);
    }
}
