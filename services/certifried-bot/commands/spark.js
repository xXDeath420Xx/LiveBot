/**
 * !spark / !daily / !ignite
 * Daily claim with streak tracking
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

/**
 * Calculate streak bonus multiplier
 */
function getStreakBonus(streak) {
    if (streak >= 30) return 3.0;
    if (streak >= 14) return 2.0;
    if (streak >= 7) return 1.5;
    if (streak >= 3) return 1.25;
    return 1.0;
}

/**
 * Get streak tier name
 */
function getStreakTier(streak) {
    if (streak >= 30) return 'Inferno';
    if (streak >= 14) return 'Blazing';
    if (streak >= 7) return 'Burning';
    if (streak >= 3) return 'Warming';
    return 'Sparked';
}

export async function sparkCommand(ctx) {
    const { profile, username, reply, platform } = ctx;

    try {
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        // Check if already claimed today
        const [existing] = await pool.execute(
            `SELECT * FROM tokes_spark_claims
             WHERE platform = ? AND platform_user_id = ? AND claim_date = ?`,
            [platform, profile.platform_user_id, today]
        );

        if (existing.length > 0) {
            const nextReset = new Date(now);
            nextReset.setUTCDate(nextReset.getUTCDate() + 1);
            nextReset.setUTCHours(0, 0, 0, 0);
            const hoursUntil = Math.ceil((nextReset.getTime() - now.getTime()) / (1000 * 60 * 60));

            reply(`${username}, you already sparked today! Come back in ~${hoursUntil}h. Streak: ${profile.current_streak || 0} days`);
            return;
        }

        // Calculate streak
        let newStreak = 1;
        if (profile.last_spark === yesterday) {
            newStreak = (profile.current_streak || 0) + 1;
        } else if (profile.last_spark === today) {
            // Edge case: already claimed
            newStreak = profile.current_streak || 1;
        }
        // else streak resets to 1

        // Calculate rewards
        const baseTokes = 5;
        const streakMultiplier = getStreakBonus(newStreak);
        const bonusTokes = Math.floor(baseTokes * (streakMultiplier - 1));
        const totalTokes = baseTokes + bonusTokes;
        const xpGain = 50 + (newStreak * 5); // Base 50 + 5 per streak day

        // Update best streak
        const newBestStreak = Math.max(newStreak, profile.best_streak || 0);

        // Insert claim record
        await pool.execute(
            `INSERT INTO tokes_spark_claims (platform, platform_user_id, claim_date, reward_tokes, streak_bonus)
             VALUES (?, ?, ?, ?, ?)`,
            [platform, profile.platform_user_id, today, baseTokes, bonusTokes]
        );

        // Update profile
        await pool.execute(
            `UPDATE tokes_profiles SET
                lifetime_tokes = lifetime_tokes + ?,
                current_streak = ?,
                best_streak = ?,
                last_spark = ?,
                xp = xp + ?,
                last_active = NOW()
             WHERE id = ?`,
            [totalTokes, newStreak, newBestStreak, today, xpGain, profile.id]
        );

        // Build response
        const tier = getStreakTier(newStreak);
        let response = `${username} sparks their daily! +${baseTokes} tokes`;

        if (bonusTokes > 0) {
            response += ` (+${bonusTokes} streak bonus)`;
        }

        response += ` | ${tier} Streak: ${newStreak} day${newStreak !== 1 ? 's' : ''}`;

        // Milestone messages
        if (newStreak === 7) {
            response += ' | One week strong!';
        } else if (newStreak === 30) {
            response += ' | 30 DAYS! Legendary commitment!';
        } else if (newStreak === 69) {
            response += ' | Nice.';
        } else if (newStreak === 100) {
            response += ' | 100 DAYS! Absolute dedication!';
        } else if (newStreak === 365) {
            response += ' | ONE YEAR STREAK! You are eternal!';
        } else if (newStreak === 420) {
            response += ' | 420 DAY STREAK! The prophecy is fulfilled!';
        }

        // New best streak
        if (newStreak > (profile.best_streak || 0) && newStreak > 1) {
            response += ' | NEW PERSONAL BEST!';
        }

        reply(response);

    } catch (error) {
        logger.error('[SparkCommand] Error', { error: error.message });
        reply(`${username}, failed to spark your daily. Try again!`);
    }
}
