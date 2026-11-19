/**
 * !fireboard / !fb / !top / !leaderboard
 * Display channel leaderboard
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

export async function fireboardCommand(ctx) {
    const { channel, username, reply, args } = ctx;

    try {
        // Check for specific leaderboard type
        const type = args[0]?.toLowerCase();

        let query, title;

        if (type === 'global' || type === 'all') {
            // Global leaderboard (only show claimed/verified profiles)
            query = `
                SELECT display_name, lifetime_tokes as tokes, level
                FROM tokes_profiles
                WHERE is_claimed = 1 AND show_on_leaderboard = 1
                ORDER BY lifetime_tokes DESC
                LIMIT 10
            `;
            title = 'Global Fireboard';
        } else if (type === 'streaks') {
            // Streak leaderboard (only claimed profiles)
            query = `
                SELECT display_name, current_streak as streak, best_streak
                FROM tokes_profiles
                WHERE is_claimed = 1 AND show_on_leaderboard = 1 AND current_streak > 0
                ORDER BY current_streak DESC
                LIMIT 10
            `;
            title = 'Top Streaks';
        } else if (type === 'level' || type === 'levels') {
            // Level leaderboard (only claimed profiles)
            query = `
                SELECT display_name, level, xp
                FROM tokes_profiles
                WHERE is_claimed = 1 AND show_on_leaderboard = 1
                ORDER BY level DESC, xp DESC
                LIMIT 10
            `;
            title = 'Top Levels';
        } else {
            // Default: Channel leaderboard (skips chatters who opted out of public
            // leaderboards on their Tokes profile)
            const [rows] = await pool.execute(
                `SELECT cs.display_name, cs.tokes
                 FROM tokes_channel_stats cs
                 LEFT JOIN tokes_profiles p
                   ON p.platform = ? AND p.platform_user_id = cs.platform_user_id
                 WHERE cs.channel_id = ? AND COALESCE(p.show_on_leaderboard, 1) = 1
                 ORDER BY cs.tokes DESC
                 LIMIT 10`,
                [channel.platform, channel.id]
            );

            if (rows.length === 0) {
                reply(`No tokes recorded in this channel yet! Be the first with !lit`);
                return;
            }

            const leaderboard = rows.map((row, i) => {
                const medal = i === 0 ? '1st' : i === 1 ? '2nd' : i === 2 ? '3rd' : `${i + 1}th`;
                return `${medal}: ${row.display_name} (${row.tokes})`;
            }).join(' | ');

            reply(`Channel Fireboard: ${leaderboard}`);
            return;
        }

        // Execute query for global/streaks/levels
        const [rows] = await pool.execute(query);

        if (rows.length === 0) {
            reply(`No data for ${title} yet!`);
            return;
        }

        let leaderboard;

        if (type === 'streaks') {
            leaderboard = rows.map((row, i) => {
                const medal = i === 0 ? '1st' : i === 1 ? '2nd' : i === 2 ? '3rd' : `${i + 1}th`;
                return `${medal}: ${row.display_name} (${row.streak}d)`;
            }).join(' | ');
        } else if (type === 'level' || type === 'levels') {
            leaderboard = rows.map((row, i) => {
                const medal = i === 0 ? '1st' : i === 1 ? '2nd' : i === 2 ? '3rd' : `${i + 1}th`;
                return `${medal}: ${row.display_name} (Lv.${row.level})`;
            }).join(' | ');
        } else {
            leaderboard = rows.map((row, i) => {
                const medal = i === 0 ? '1st' : i === 1 ? '2nd' : i === 2 ? '3rd' : `${i + 1}th`;
                return `${medal}: ${row.display_name} (${row.tokes})`;
            }).join(' | ');
        }

        reply(`${title}: ${leaderboard}`);

    } catch (error) {
        logger.error('[FireboardCommand] Error', { error: error.message });
        reply(`${username}, couldn't load the fireboard right now.`);
    }
}
