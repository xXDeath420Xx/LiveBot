import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { getOrCreateUserEconomy, getEconomyConfig, logTransaction } from './economy-manager.js';

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

    forgetOpenTypes(guildId, userId);
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

/*
 * Progress is reported from hot paths (every message, reaction and command), but only members who
 * opened /selfcare challenges today have rows. Cache which challenge types each member still has
 * open today so everyone else costs a Map lookup instead of a query.
 */
const OPEN_TTL_MS = 2 * 60 * 1000;
const openTypes = new Map();      // `${guildId}:${userId}` -> { day, at, types: Set }
const activityMinute = new Map(); // `${guildId}:${userId}` -> last minute counted toward 'activity'

function todayUtc() {
  return new Date().toISOString().split('T')[0];
}

function forgetOpenTypes(guildId, userId) {
  openTypes.delete(`${guildId}:${userId}`);
}

async function hasOpenChallenge(guildId, userId, challengeType) {
  const key = `${guildId}:${userId}`;
  const day = todayUtc();
  let entry = openTypes.get(key);
  if (!entry || entry.day !== day || Date.now() - entry.at > OPEN_TTL_MS) {
    const [rows] = await pool.execute(
      `SELECT DISTINCT dc.challenge_type
       FROM user_daily_challenges uc
       JOIN daily_challenges dc ON uc.challenge_id = dc.id
       WHERE uc.guild_id = ? AND uc.user_id = ? AND uc.assigned_date = ? AND uc.completed = 0`,
      [guildId, userId, day]
    );
    if (openTypes.size > 50000) openTypes.clear();
    entry = { day, at: Date.now(), types: new Set(rows.map(r => r.challenge_type)) };
    openTypes.set(key, entry);
  }
  return entry.types.has(challengeType);
}

/** Count at most one minute of 'activity' per member per minute of chatting. */
export function noteActivityMinute(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const minute = Math.floor(Date.now() / 60000);
  if (activityMinute.get(key) === minute) return;
  if (activityMinute.size > 50000) activityMinute.clear();
  activityMinute.set(key, minute);
  updateChallengeProgress(guildId, userId, 'activity', 1)
    .catch(err => logger.warn('[Daily Challenges] activity progress failed', { error: err.message }));
}

/** 'streak' challenges track consecutive days with a completed challenge, so they are set, not added. */
async function syncStreakChallenge(guildId, userId) {
  const streak = await getCurrentStreak(guildId, userId);
  const [result] = await pool.execute(
    `UPDATE user_daily_challenges uc
     JOIN daily_challenges dc ON uc.challenge_id = dc.id
     SET uc.progress = LEAST(?, dc.requirement_count),
         uc.completed = (? >= dc.requirement_count),
         uc.completed_at = IF(? >= dc.requirement_count, NOW(), NULL)
     WHERE uc.guild_id = ? AND uc.user_id = ? AND uc.assigned_date = ?
       AND dc.challenge_type = 'streak' AND uc.completed = 0`,
    [streak, streak, streak, guildId, userId, todayUtc()]
  );
  if (result.affectedRows) forgetOpenTypes(guildId, userId);
}

export async function updateChallengeProgress(guildId, userId, challengeType, amount = 1) {
  try {
    if (!guildId || !userId || !(amount > 0)) return [];
    if (!(await hasOpenChallenge(guildId, userId, challengeType))) return [];

    const today = todayUtc();

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

    if (completedChallenges.length) {
      forgetOpenTypes(guildId, userId);
      if (challengeType !== 'streak') {
        await syncStreakChallenge(guildId, userId)
          .catch(err => logger.warn('[Daily Challenges] streak sync failed', { error: err.message }));
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

    // Mark as claimed — guarded so a double-click can't pay the same challenge twice
    const [claim] = await pool.execute(
      'UPDATE user_daily_challenges SET claimed = 1 WHERE id = ? AND claimed = 0',
      [userChallenge.id]
    );

    if (claim.affectedRows === 0) {
      return {
        success: false,
        message: 'Challenge not found, not completed, or already claimed'
      };
    }

    const xpReward = Number(userChallenge.xp_reward) || 0;
    const currencyReward = Number(userChallenge.currency_reward) || 0;

    // Currency → live economy wallet (user_economy) + ledger row. If the wallet credit itself fails,
    // un-claim so the member can try again instead of silently losing the reward.
    if (currencyReward > 0) {
      try {
        await payCurrency(guildId, userId, currencyReward, `Daily challenge: ${userChallenge.challenge_name}`);
      } catch (error) {
        logger.error('[Daily Challenges] Failed to pay currency reward', { error: error.message, guildId, userId, challengeId, currencyReward });
        await pool.execute('UPDATE user_daily_challenges SET claimed = 0 WHERE id = ?', [userChallenge.id])
          .catch(err => logger.error('[Daily Challenges] Failed to un-claim after payout error', { error: err.message, id: userChallenge.id }));
        return {
          success: false,
          message: 'Failed to pay your reward — please try claiming again'
        };
      }
    }

    // XP → leveling manager (user_levels, level maths included)
    if (xpReward > 0) {
      const levelingManager = getLevelingManager(guildId);
      if (levelingManager) {
        await levelingManager.addXP(guildId, userId, xpReward);
      } else {
        logger.error('[Daily Challenges] Leveling manager unavailable — XP reward not paid', { guildId, userId, challengeId, xpReward });
      }
    }

    logger.info(`[Daily Challenges] User ${userId} claimed rewards for challenge ${challengeId}`);

    return {
      success: true,
      challenge: userChallenge.challenge_name,
      xpReward,
      currencyReward
    };

  } catch (error) {
    logger.error('[Daily Challenges] Error claiming rewards:', { error: error.message });
    return {
      success: false,
      message: 'Failed to claim rewards'
    };
  }
}

/**
 * The leveling manager of the bot serving this guild (custom bots each carry their own).
 */
function getLevelingManager(guildId) {
  const bm = global.botManager;
  return bm?.getClientForGuild?.(guildId)?.levelingManager
    || bm?.getDefaultClient?.()?.levelingManager
    || null;
}

/**
 * Credit currency to user_economy.wallet and record it in economy_transactions.
 * The ledger insert runs after the wallet changed, so its failure is logged, not thrown.
 */
async function payCurrency(guildId, userId, amount, description) {
  const config = await getEconomyConfig(guildId);
  const economy = await getOrCreateUserEconomy(guildId, userId, config);
  const before = Number(economy.wallet) || 0;

  await pool.execute(
    'UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?',
    [amount, amount, guildId, userId]
  );

  try {
    await logTransaction(guildId, userId, 'reward', amount, before, before + amount, description);
  } catch (error) {
    logger.error('[Daily Challenges] Failed to log reward transaction', { error: error.message, guildId, userId, amount });
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
  noteActivityMinute,
  claimRewards,
  getStats,
  getDifficultyColor,
  getDifficultyEmoji
};
