import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

/**
 * Daily Challenges Manager
 * Handles assignment, tracking, and completion of daily challenges
 */

export async function assignDailyChallenges(guildId, userId) {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Check if user already has challenges for today
    const [[existing]] = await pool.execute(
      'SELECT COUNT(*) as count FROM user_daily_challenges WHERE guild_id = ? AND user_id = ? AND assigned_date = ?',
      [guildId, userId, today]
    );

    if (existing.count > 0) {
      return false; // Already has challenges for today
    }

    // Get 3 random challenges (1 easy, 1 medium, 1 hard)
    const [easyChallenges] = await pool.execute(
      'SELECT * FROM daily_challenges WHERE difficulty = ? ORDER BY RAND() LIMIT 1',
      ['easy']
    );

    const [mediumChallenges] = await pool.execute(
      'SELECT * FROM daily_challenges WHERE difficulty = ? ORDER BY RAND() LIMIT 1',
      ['medium']
    );

    const [hardChallenges] = await pool.execute(
      'SELECT * FROM daily_challenges WHERE difficulty = ? ORDER BY RAND() LIMIT 1',
      ['hard']
    );

    const selectedChallenges = [
      ...easyChallenges,
      ...mediumChallenges,
      ...hardChallenges
    ];

    // Assign challenges to user
    for (const challenge of selectedChallenges) {
      await pool.execute(
        `INSERT INTO user_daily_challenges (guild_id, user_id, challenge_id, assigned_date)
         VALUES (?, ?, ?, ?)`,
        [guildId, userId, challenge.id, today]
      );
    }

    logger.info(`[Daily Challenges] Assigned 3 challenges to user ${userId} in guild ${guildId}`);
    return true;

  } catch (error) {
    logger.error('[Daily Challenges] Error assigning challenges:', { error: error.message });
    return false;
  }
}

export async function getUserChallenges(guildId, userId) {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Ensure user has challenges for today
    await assignDailyChallenges(guildId, userId);

    const [challenges] = await pool.execute(
      `SELECT uc.*, dc.challenge_name, dc.challenge_description, dc.challenge_type,
              dc.requirement_count, dc.xp_reward, dc.currency_reward, dc.difficulty
       FROM user_daily_challenges uc
       JOIN daily_challenges dc ON uc.challenge_id = dc.id
       WHERE uc.guild_id = ? AND uc.user_id = ? AND uc.assigned_date = ?
       ORDER BY dc.difficulty`,
      [guildId, userId, today]
    );

    return challenges;

  } catch (error) {
    logger.error('[Daily Challenges] Error getting user challenges:', { error: error.message });
    return [];
  }
}

export async function updateChallengeProgress(guildId, userId, challengeType, amount = 1) {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Get relevant challenges
    const [challenges] = await pool.execute(
      `SELECT uc.*, dc.requirement_count
       FROM user_daily_challenges uc
       JOIN daily_challenges dc ON uc.challenge_id = dc.id
       WHERE uc.guild_id = ? AND uc.user_id = ? AND uc.assigned_date = ?
         AND dc.challenge_type = ? AND uc.completed = 0`,
      [guildId, userId, today, challengeType]
    );

    const completedChallenges = [];

    for (const challenge of challenges) {
      const newProgress = challenge.progress + amount;
      const isCompleted = newProgress >= challenge.requirement_count;

      await pool.execute(
        `UPDATE user_daily_challenges
         SET progress = ?, completed = ?, completed_at = ?
         WHERE id = ?`,
        [
          Math.min(newProgress, challenge.requirement_count),
          isCompleted ? 1 : 0,
          isCompleted ? new Date() : null,
          challenge.id
        ]
      );

      if (isCompleted && !challenge.completed) {
        completedChallenges.push(challenge);
      }
    }

    return completedChallenges;

  } catch (error) {
    logger.error('[Daily Challenges] Error updating progress:', { error: error.message });
    return [];
  }
}

export async function claimRewards(guildId, userId, challengeId) {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Get challenge details
    const [[userChallenge]] = await pool.execute(
      `SELECT uc.*, dc.challenge_name, dc.xp_reward, dc.currency_reward
       FROM user_daily_challenges uc
       JOIN daily_challenges dc ON uc.challenge_id = dc.id
       WHERE uc.guild_id = ? AND uc.user_id = ? AND uc.challenge_id = ?
         AND uc.assigned_date = ? AND uc.completed = 1 AND uc.claimed = 0`,
      [guildId, userId, challengeId, today]
    );

    if (!userChallenge) {
      return {
        success: false,
        message: 'Challenge not found, not completed, or already claimed'
      };
    }

    // Mark as claimed
    await pool.execute(
      'UPDATE user_daily_challenges SET claimed = 1 WHERE id = ?',
      [userChallenge.id]
    );

    // Award XP if leveling is enabled
    if (userChallenge.xp_reward > 0) {
      await pool.execute(
        `INSERT INTO leveling_users (guild_id, user_id, xp, level, last_message)
         VALUES (?, ?, ?, 0, NOW())
         ON DUPLICATE KEY UPDATE xp = xp + ?`,
        [guildId, userId, userChallenge.xp_reward, userChallenge.xp_reward]
      ).catch(() => {}); // Ignore if leveling table doesn't exist
    }

    // Award currency if economy is enabled
    if (userChallenge.currency_reward > 0) {
      await pool.execute(
        `INSERT INTO economy_users (guild_id, user_id, wallet, bank, total_earned)
         VALUES (?, ?, ?, 0, ?)
         ON DUPLICATE KEY UPDATE wallet = wallet + ?, total_earned = total_earned + ?`,
        [guildId, userId, userChallenge.currency_reward, userChallenge.currency_reward,
         userChallenge.currency_reward, userChallenge.currency_reward]
      ).catch(() => {}); // Ignore if economy table doesn't exist
    }

    logger.info(`[Daily Challenges] User ${userId} claimed rewards for challenge ${challengeId}`);

    return {
      success: true,
      challenge: userChallenge.challenge_name,
      xpReward: userChallenge.xp_reward,
      currencyReward: userChallenge.currency_reward
    };

  } catch (error) {
    logger.error('[Daily Challenges] Error claiming rewards:', { error: error.message });
    return {
      success: false,
      message: 'Failed to claim rewards'
    };
  }
}

export async function getStats(guildId, userId) {
  try {
    // Total completed challenges
    const [[totalStats]] = await pool.execute(
      `SELECT COUNT(*) as total_completed,
              SUM(claimed) as total_claimed
       FROM user_daily_challenges
       WHERE guild_id = ? AND user_id = ? AND completed = 1`,
      [guildId, userId]
    );

    // Completion rate
    const [[rateStats]] = await pool.execute(
      `SELECT COUNT(*) as total_assigned
       FROM user_daily_challenges
       WHERE guild_id = ? AND user_id = ?`,
      [guildId, userId]
    );

    // Current streak
    const streak = await getCurrentStreak(guildId, userId);

    return {
      totalCompleted: totalStats?.total_completed || 0,
      totalClaimed: totalStats?.total_claimed || 0,
      totalAssigned: rateStats?.total_assigned || 0,
      completionRate: rateStats?.total_assigned > 0
        ? Math.round((totalStats.total_completed / rateStats.total_assigned) * 100)
        : 0,
      currentStreak: streak
    };

  } catch (error) {
    logger.error('[Daily Challenges] Error getting stats:', { error: error.message });
    return null;
  }
}

async function getCurrentStreak(guildId, userId) {
  try {
    const [results] = await pool.execute(
      `SELECT assigned_date, COUNT(*) as completed_count
       FROM user_daily_challenges
       WHERE guild_id = ? AND user_id = ? AND completed = 1
       GROUP BY assigned_date
       ORDER BY assigned_date DESC
       LIMIT 30`,
      [guildId, userId]
    );

    let streak = 0;
    let currentDate = new Date();
    currentDate.setHours(0, 0, 0, 0);

    for (const row of results) {
      const rowDate = new Date(row.assigned_date);
      rowDate.setHours(0, 0, 0, 0);

      const daysDiff = Math.floor((currentDate - rowDate) / (1000 * 60 * 60 * 24));

      if (daysDiff === streak) {
        if (row.completed_count >= 1) { // At least 1 challenge completed
          streak++;
          currentDate.setDate(currentDate.getDate() - 1);
        } else {
          break;
        }
      } else {
        break;
      }
    }

    return streak;

  } catch (error) {
    logger.error('[Daily Challenges] Error calculating streak:', { error: error.message });
    return 0;
  }
}

export function getDifficultyColor(difficulty) {
  const colors = {
    'easy': '#2ECC71',
    'medium': '#F39C12',
    'hard': '#E74C3C'
  };
  return colors[difficulty] || '#3498DB';
}

export function getDifficultyEmoji(difficulty) {
  const emojis = {
    'easy': '🌱',
    'medium': '⚡',
    'hard': '🔥'
  };
  return emojis[difficulty] || '⭐';
}

export default {
  assignDailyChallenges,
  getUserChallenges,
  updateChallengeProgress,
  claimRewards,
  getStats,
  getDifficultyColor,
  getDifficultyEmoji
};
