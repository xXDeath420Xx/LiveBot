import pool from '../utils/db.js';
import { EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { displayNameFor } from '../utils/display-name.js';
import { getOrCreateUserEconomy, getEconomyConfig, logTransaction, economyStatus } from './economy-manager.js';

/**
 * Achievement Manager - Cross-feature achievement tracking system
 * Tracks user progress across all bot features and awards achievements
 */
export default class AchievementManager {
  constructor(client) {
    this.client = client;
    this.achievementCache = new Map();
    this.userProgressCache = new Map();
    this.cacheExpiry = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Initialize achievement manager and load achievements into cache
   */
  async initialize() {
    try {
      const [achievements] = await pool.execute('SELECT * FROM achievements');
      achievements.forEach(achievement => {
        this.achievementCache.set(achievement.achievement_key, achievement);
      });
      logger.info(`[Achievement Manager] Loaded ${achievements.length} achievements into cache`);
    } catch (error) {
      logger.error('[Achievement Manager] Error initializing', { error: error.message });
    }
  }

  /**
   * Track an achievement event for a user
   * @param {string} userId - Discord user ID
   * @param {string} guildId - Discord guild ID
   * @param {string} achievementKey - Achievement key to track
   * @param {number} progress - Progress amount to add (default 1)
   * @param {Object} eventData - Optional event data for special achievements
   */
  async trackAchievement(userId, guildId, achievementKey, progress = 1, eventData = {}) {
    try {
      const achievement = this.achievementCache.get(achievementKey);
      if (!achievement) {
        logger.warn(`[Achievement Manager] Unknown achievement key: ${achievementKey}`);
        return null;
      }

      // Get or create user achievement progress
      const [existingProgress] = await pool.execute(
        `SELECT * FROM user_achievements
         WHERE user_id = ? AND guild_id = ? AND achievement_id = ?`,
        [userId, guildId, achievement.id]
      );

      let userAchievement;
      if (existingProgress.length === 0) {
        // Create new progress entry
        await pool.execute(
          `INSERT INTO user_achievements (user_id, guild_id, achievement_id, progress)
           VALUES (?, ?, ?, ?)`,
          [userId, guildId, achievement.id, progress]
        );
        userAchievement = { progress, completed: false };
      } else {
        userAchievement = existingProgress[0];

        // Don't update if already completed and not repeatable
        if (userAchievement.completed && !achievement.is_repeatable) {
          return null;
        }

        // Update progress
        const newProgress = userAchievement.progress + progress;
        await pool.execute(
          `UPDATE user_achievements
           SET progress = ?, updated_at = NOW()
           WHERE user_id = ? AND guild_id = ? AND achievement_id = ?`,
          [newProgress, userId, guildId, achievement.id]
        );
        userAchievement.progress = newProgress;
      }

      // Check if achievement is now complete
      if (this.checkAchievementComplete(achievement, userAchievement.progress, eventData)) {
        return await this.completeAchievement(userId, guildId, achievement, userAchievement.progress);
      }

      return null;
    } catch (error) {
      logger.error('[Achievement Manager] Error tracking achievement', {
        error: error.message,
        userId,
        achievementKey
      });
      return null;
    }
  }

  /**
   * Like trackAchievement, for a count the feature already keeps (Pokémon caught, animal pictures seen, Last.fm
   * scrobbles): progress is raised to `total`, never added to, so the same total twice changes nothing (H-817).
   */
  async recordTotal(userId, guildId, achievementKey, total, eventData = {}) {
    const achievement = this.achievementCache.get(achievementKey);
    const n = Math.floor(Number(total));
    if (!achievement || !(n > 0)) return null;
    try {
      const [[row]] = await pool.execute(
        'SELECT progress FROM user_achievements WHERE user_id = ? AND guild_id = ? AND achievement_id = ?',
        [userId, guildId, achievement.id]
      );
      const delta = n - (Number(row?.progress) || 0);
      if (delta <= 0) return null;
      return await this.trackAchievement(userId, guildId, achievementKey, delta, eventData);
    } catch (error) {
      logger.error('[Achievement Manager] Error recording a total', { error: error.message, userId, achievementKey });
      return null;
    }
  }

  /**
   * Check if achievement requirements are met
   * @param {Object} achievement - Achievement object
   * @param {number} progress - Current progress
   * @param {Object} eventData - Event data
   */
  checkAchievementComplete(achievement, progress, eventData) {
    switch (achievement.requirement_type) {
      case 'count':
      case 'milestone':
        return progress >= achievement.requirement_value;

      case 'event':
        // Event-based achievements check the event data
        return eventData.value && eventData.value >= achievement.requirement_value;

      case 'special':
        // Special achievements have custom logic
        return eventData.completed === true;

      default:
        return false;
    }
  }

  /**
   * Complete an achievement for a user
   * @param {string} userId - Discord user ID
   * @param {string} guildId - Discord guild ID
   * @param {Object} achievement - Achievement object
   */
  async completeAchievement(userId, guildId, achievement, progressSeen = null) {
    try {
      const completedAt = new Date();

      // Claim the completion. Now that achievements pay rewards, two events landing at once (a
      // message and a voice update, say) must not both complete — and pay — the same achievement:
      // only the call whose guarded UPDATE changes the row goes on. A repeatable achievement starts
      // counting again from 0, guarded on the progress this call saw.
      const repeatable = Number(achievement.is_repeatable) === 1;
      const [claim] = repeatable
        ? await pool.execute(
          `UPDATE user_achievements
           SET completed = TRUE, completed_at = ?, times_completed = times_completed + 1, progress = 0
           WHERE user_id = ? AND guild_id = ? AND achievement_id = ? AND (? IS NULL OR progress = ?)`,
          [completedAt, userId, guildId, achievement.id, progressSeen, progressSeen]
        )
        : await pool.execute(
          `UPDATE user_achievements
           SET completed = TRUE, completed_at = ?, times_completed = times_completed + 1
           WHERE user_id = ? AND guild_id = ? AND achievement_id = ? AND completed = FALSE`,
          [completedAt, userId, guildId, achievement.id]
        );
      if (!claim || claim.affectedRows === 0) {
        return null; // another event completed it first
      }

      // Update achievement statistics
      await pool.execute(
        `INSERT INTO achievement_stats (guild_id, achievement_id, total_completions, last_completed_by, last_completed_at, first_completed_by, first_completed_at)
         VALUES (?, ?, 1, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           total_completions = total_completions + 1,
           last_completed_by = ?,
           last_completed_at = ?`,
        [guildId, achievement.id, userId, completedAt, userId, completedAt, userId, completedAt]
      );

      // Get rewards for this achievement
      const allRewards = await this.getAchievementRewards(achievement.id);

      // Award rewards — only the ones this server has switched on are paid (and announced)
      const rewards = allRewards.length > 0
        ? await this.awardRewards(userId, guildId, allRewards, achievement)
        : [];

      // Send notification
      await this.sendAchievementNotification(userId, guildId, achievement, rewards);

      // Check for meta-achievements (achievements for getting achievements)
      await this.checkMetaAchievements(userId, guildId);

      logger.info(`[Achievement Manager] User ${userId} completed achievement: ${achievement.achievement_key}`);

      return {
        achievement,
        rewards,
        completedAt
      };
    } catch (error) {
      logger.error('[Achievement Manager] Error completing achievement', {
        error: error.message,
        userId,
        achievementId: achievement.id
      });
      return null;
    }
  }

  /**
   * Get rewards for an achievement
   * @param {number} achievementId - Achievement ID
   */
  async getAchievementRewards(achievementId) {
    try {
      const [rewards] = await pool.execute(
        'SELECT * FROM achievement_rewards WHERE achievement_id = ?',
        [achievementId]
      );
      return rewards;
    } catch (error) {
      logger.error('[Achievement Manager] Error getting rewards', { error: error.message });
      return [];
    }
  }

  /**
   * Award rewards to a user
   * @param {string} userId - Discord user ID
   * @param {string} guildId - Discord guild ID
   * @param {Array} rewards - Array of reward objects
   * @param {Object} [achievement] - The achievement being rewarded (for the transaction description)
   */
  async awardRewards(userId, guildId, rewards, achievement = null) {
    const label = achievement?.name ? `Achievement reward: ${achievement.name}` : 'Achievement reward';
    const paid = [];

    // Per-server switches, read once: coins only where the economy is switched on
    // (economy_config.enabled = 1 — the rule counting/hangman/trivia rewards use), XP only where
    // leveling is switched on.
    let economyOn = null;
    let levelingOn = null;

    for (const reward of rewards) {
      try {
        const amount = Number(reward.reward_amount) || 0;

        switch (reward.reward_type) {
          case 'currency':
            // Award coins into the live economy wallet (user_economy) with a ledger row
            if (amount <= 0) break;
            if (economyOn === null) economyOn = (await economyStatus(guildId)) === 'enabled';
            if (!economyOn) break;
            await this.payCurrency(userId, guildId, amount, label);
            paid.push(reward);
            break;

          case 'xp': {
            // Award XP through the leveling manager (user_levels, level maths included)
            if (amount <= 0) break;
            const levelingManager = this.getLevelingManager(guildId);
            if (!levelingManager) {
              logger.error('[Achievement Manager] Leveling manager unavailable — XP reward not paid', { userId, guildId, amount });
              break;
            }
            if (levelingOn === null) {
              levelingOn = typeof levelingManager.isEnabledForGuild === 'function'
                ? await levelingManager.isEnabledForGuild(guildId)
                : true;
            }
            if (!levelingOn) break;
            await levelingManager.addXP(guildId, userId, amount);
            paid.push(reward);
            break;
          }

          case 'item':
            // Award item through RPG system (if exists)
            // This would integrate with your RPG inventory system
            logger.info(`[Achievement Manager] Item reward "${reward.reward_value}" for user ${userId}`);
            break;

          case 'title':
            // Store special title (could be displayed in profiles)
            logger.info(`[Achievement Manager] Title reward "${reward.reward_value}" for user ${userId}`);
            break;

          default:
            logger.warn(`[Achievement Manager] Unknown reward type: ${reward.reward_type}`);
        }
      } catch (error) {
        logger.error('[Achievement Manager] Error awarding reward', {
          error: error.message,
          rewardType: reward.reward_type,
          userId,
          guildId
        });
      }
    }

    return paid;
  }

  /**
   * The leveling manager for the bot serving this guild (custom bots each carry their own).
   */
  getLevelingManager(guildId) {
    return this.client?.levelingManager
      || global.botManager?.getClientForGuild?.(guildId)?.levelingManager
      || null;
  }

  /**
   * Pay currency into user_economy.wallet and record it in economy_transactions.
   * The ledger insert runs after the wallet changed, so its failure is logged, not thrown.
   */
  async payCurrency(userId, guildId, amount, description) {
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
      logger.error('[Achievement Manager] Failed to log reward transaction', { error: error.message, userId, guildId, amount });
    }
  }

  /**
   * Send achievement completion notification to user
   * @param {string} userId - Discord user ID
   * @param {string} guildId - Discord guild ID
   * @param {Object} achievement - Achievement object
   * @param {Array} rewards - Array of rewards
   */
  async sendAchievementNotification(userId, guildId, achievement, rewards) {
    try {
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) return;

      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) return;

      // Get achievement config for this guild
      const [[config]] = await pool.execute(
        'SELECT * FROM achievement_config WHERE guild_id = ?',
        [guildId]
      );

      // Require config exists AND is enabled AND has a channel configured
      if (!config || !config.enabled || !config.announcement_channel_id) {
        return;
      }

      // Try to get the configured announcement channel
      const channel = guild.channels.cache.get(config.announcement_channel_id);

      // If channel not found or bot lost access, don't send
      if (!channel) return;

      const tierColors = {
        bronze: '#CD7F32',
        silver: '#C0C0C0',
        gold: '#FFD700',
        platinum: '#E5E4E2',
        diamond: '#B9F2FF'
      };

      const embed = new EmbedBuilder()
        .setColor(tierColors[achievement.tier] || '#FFD700')
        .setTitle(`${achievement.icon_emoji || '🏆'} Achievement Unlocked!`)
        .setDescription(`**${achievement.name}**\n${achievement.description}`)
        .addFields(
          { name: 'Tier', value: achievement.tier.charAt(0).toUpperCase() + achievement.tier.slice(1), inline: true },
          { name: 'Points', value: `${achievement.points} pts`, inline: true }
        )
        .setAuthor({ name: displayNameFor(member), iconURL: member.user.displayAvatarURL() })
        .setTimestamp();

      // Add rewards if any
      if (rewards.length > 0) {
        const economyConfig = rewards.some(r => r.reward_type === 'currency') ? await getEconomyConfig(guildId) : null;
        const rewardText = rewards.map(r => {
          switch (r.reward_type) {
            case 'currency':
              return `💰 ${Number(r.reward_amount).toLocaleString()} ${economyConfig?.currency_name || 'coins'}`;
            case 'xp':
              return `⭐ ${Number(r.reward_amount).toLocaleString()} XP`;
            case 'item':
              return `📦 ${r.reward_value}`;
            case 'title':
              return `🏅 Title: ${r.reward_value}`;
            default:
              return `${r.reward_value}`;
          }
        }).join('\n');

        embed.addFields({ name: 'Rewards', value: rewardText });
      }

      await channel.send({ content: `<@${userId}>`, embeds: [embed] });
    } catch (error) {
      logger.error('[Achievement Manager] Error sending notification', {
        error: error.message,
        userId,
        achievementId: achievement.id
      });
    }
  }

  /**
   * Check meta-achievements (achievements for getting achievements)
   * @param {string} userId - Discord user ID
   * @param {string} guildId - Discord guild ID
   */
  async checkMetaAchievements(userId, guildId) {
    try {
      // Count total achievements completed
      const [countResult] = await pool.execute(
        `SELECT COUNT(*) as count FROM user_achievements
         WHERE user_id = ? AND guild_id = ? AND completed = TRUE`,
        [userId, guildId]
      );

      const totalAchievements = countResult[0].count;

      // Completionist: its own requirement_value (migration 468: 10; it said 50 of 26 achievements, H-808)
      const completionist = this.achievementCache.get('completionist');
      const need = Number(completionist?.requirement_value) || 50;
      if (completionist && totalAchievements >= need) {
        await this.trackAchievement(userId, guildId, 'completionist', need, { completed: true });
      }
    } catch (error) {
      logger.error('[Achievement Manager] Error checking meta-achievements', {
        error: error.message,
        userId
      });
    }
  }

  /**
   * Get user's achievement progress
   * @param {string} userId - Discord user ID
   * @param {string} guildId - Discord guild ID
   * @param {string} category - Optional category filter
   */
  async getUserAchievements(userId, guildId, category = null) {
    try {
      let query = `
        SELECT a.*,
               ua.progress,
               ua.completed,
               ua.completed_at,
               ua.times_completed
        FROM achievements a
        LEFT JOIN user_achievements ua ON a.id = ua.achievement_id
          AND ua.user_id = ? AND ua.guild_id = ?
        WHERE a.is_hidden = FALSE
      `;
      const params = [userId, guildId];

      if (category) {
        query += ' AND a.category = ?';
        params.push(category);
      }

      query += ' ORDER BY a.tier, a.category, a.points DESC';

      const [achievements] = await pool.execute(query, params);
      return achievements;
    } catch (error) {
      logger.error('[Achievement Manager] Error getting user achievements', {
        error: error.message,
        userId
      });
      return [];
    }
  }

  /**
   * Get achievement leaderboard for a guild
   * @param {string} guildId - Discord guild ID
   * @param {number} limit - Number of users to return
   */
  async getAchievementLeaderboard(guildId, limit = 10) {
    try {
      const [leaderboard] = await pool.execute(
        `SELECT
           ua.user_id,
           COUNT(DISTINCT ua.achievement_id) as achievement_count,
           SUM(a.points) as total_points
         FROM user_achievements ua
         JOIN achievements a ON ua.achievement_id = a.id
         WHERE ua.guild_id = ? AND ua.completed = TRUE
         GROUP BY ua.user_id
         ORDER BY total_points DESC, achievement_count DESC
         LIMIT ?`,
        [guildId, limit]
      );

      return leaderboard;
    } catch (error) {
      logger.error('[Achievement Manager] Error getting leaderboard', {
        error: error.message,
        guildId
      });
      return [];
    }
  }

  /**
   * Get achievement statistics for a guild
   * @param {string} guildId - Discord guild ID
   */
  async getGuildAchievementStats(guildId) {
    try {
      const [stats] = await pool.execute(
        `SELECT
           COUNT(DISTINCT ua.user_id) as active_users,
           COUNT(DISTINCT CASE WHEN ua.completed = TRUE THEN ua.achievement_id END) as unique_achievements_earned,
           SUM(CASE WHEN ua.completed = TRUE THEN 1 ELSE 0 END) as total_completions,
           AVG(CASE WHEN ua.completed = TRUE THEN 1 ELSE 0 END) as completion_rate
         FROM user_achievements ua
         WHERE ua.guild_id = ?`,
        [guildId]
      );

      return stats[0];
    } catch (error) {
      logger.error('[Achievement Manager] Error getting guild stats', {
        error: error.message,
        guildId
      });
      return null;
    }
  }

  /**
   * Get recently completed achievements in a guild
   * @param {string} guildId - Discord guild ID
   * @param {number} limit - Number of achievements to return
   */
  async getRecentCompletions(guildId, limit = 10) {
    try {
      const [recent] = await pool.execute(
        `SELECT
           ua.user_id,
           ua.completed_at,
           a.name,
           a.tier,
           a.icon_emoji,
           a.points
         FROM user_achievements ua
         JOIN achievements a ON ua.achievement_id = a.id
         WHERE ua.guild_id = ? AND ua.completed = TRUE
         ORDER BY ua.completed_at DESC
         LIMIT ?`,
        [guildId, limit]
      );

      return recent;
    } catch (error) {
      logger.error('[Achievement Manager] Error getting recent completions', {
        error: error.message,
        guildId
      });
      return [];
    }
  }
}
