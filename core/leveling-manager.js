import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import configCache from '../utils/configCache.js';

// Memory limits to prevent unbounded growth
const MAX_VOICE_SESSIONS = 10000;
const MAX_XP_COOLDOWNS = 50000;

class LevelingManager {
  constructor(client) {
    this.client = client;
    this.voiceSessions = new Map(); // Track voice session start times
    this.xpCooldowns = new Map(); // Track XP cooldowns per user
    logger.info('[LevelingManager] Leveling manager initialized');

    // Periodic cleanup every 5 minutes to enforce max sizes
    setInterval(() => this.cleanupCaches(), 5 * 60 * 1000);
  }

  /**
   * Clean up caches to prevent memory leaks
   */
  cleanupCaches() {
    const now = Date.now();

    // Remove expired XP cooldowns (older than 2 minutes)
    for (const [key, timestamp] of this.xpCooldowns.entries()) {
      if (now - timestamp > 2 * 60 * 1000) {
        this.xpCooldowns.delete(key);
      }
    }

    // Enforce max sizes with FIFO eviction
    if (this.voiceSessions.size > MAX_VOICE_SESSIONS) {
      const entriesToDelete = this.voiceSessions.size - MAX_VOICE_SESSIONS;
      const iterator = this.voiceSessions.keys();
      for (let i = 0; i < entriesToDelete; i++) {
        this.voiceSessions.delete(iterator.next().value);
      }
      logger.debug(`[LevelingManager] voiceSessions evicted ${entriesToDelete} entries`);
    }

    if (this.xpCooldowns.size > MAX_XP_COOLDOWNS) {
      const entriesToDelete = this.xpCooldowns.size - MAX_XP_COOLDOWNS;
      const iterator = this.xpCooldowns.keys();
      for (let i = 0; i < entriesToDelete; i++) {
        this.xpCooldowns.delete(iterator.next().value);
      }
      logger.debug(`[LevelingManager] xpCooldowns evicted ${entriesToDelete} entries`);
    }

    logger.debug(`[LevelingManager] Cleanup: voiceSessions=${this.voiceSessions.size}, xpCooldowns=${this.xpCooldowns.size}`);
  }

  /**
   * Check if leveling is enabled for a guild (cached)
   */
  async isEnabledForGuild(guildId) {
    try {
      const config = await this.getConfig(guildId);
      return config.enabled === true || config.enabled === 1;
    } catch (error) {
      logger.error(`[LevelingManager] Failed to check if enabled: ${error.message}`, { guildId });
      return false; // Fail closed - if error, assume disabled
    }
  }

  /**
   * Get configuration for a guild (cached - 60s TTL)
   */
  async getConfig(guildId) {
    const defaultConfig = {
      guild_id: guildId,
      enabled: false,
      xp_per_message: 15,
      xp_cooldown_seconds: 60,
      xp_per_voice_minute: 5,
      voice_xp_enabled: true,
      level_up_message: 'Congrats {user}! You reached **Level {level}**!',
      level_up_channel_id: null,
      xp_multiplier_weekends: 1.0,
      xp_multiplier_events: 1.0
    };

    try {
      return await configCache.get('level_config', guildId, async () => {
        const [rows] = await pool.execute(
          'SELECT * FROM level_config WHERE guild_id = ?',
          [guildId]
        );

        if (!rows || rows.length === 0) {
          return defaultConfig;
        }

        return rows[0];
      });
    } catch (error) {
      logger.error(`[LevelingManager] Failed to get config: ${error.message}`, { guildId });
      return defaultConfig;
    }
  }

  /**
   * Update guild configuration
   */
  async updateConfig(guildId, config) {
    try {
      await pool.execute(
        `INSERT INTO level_config (guild_id, xp_per_message, xp_cooldown_seconds, xp_per_voice_minute,
          voice_xp_enabled, level_up_message, level_up_channel_id, xp_multiplier_weekends, xp_multiplier_events)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           xp_per_message = VALUES(xp_per_message),
           xp_cooldown_seconds = VALUES(xp_cooldown_seconds),
           xp_per_voice_minute = VALUES(xp_per_voice_minute),
           voice_xp_enabled = VALUES(voice_xp_enabled),
           level_up_message = VALUES(level_up_message),
           level_up_channel_id = VALUES(level_up_channel_id),
           xp_multiplier_weekends = VALUES(xp_multiplier_weekends),
           xp_multiplier_events = VALUES(xp_multiplier_events)`,
        [
          guildId,
          config.xp_per_message || 15,
          config.xp_cooldown_seconds || 60,
          config.xp_per_voice_minute || 5,
          config.voice_xp_enabled !== undefined ? config.voice_xp_enabled : true,
          config.level_up_message || 'Congrats {user}! You reached **Level {level}**!',
          config.level_up_channel_id || null,
          config.xp_multiplier_weekends || 1.0,
          config.xp_multiplier_events || 1.0
        ]
      );

      // Invalidate cache so next read gets fresh data
      configCache.invalidate('level_config', guildId);
      logger.info('[LevelingManager] Config updated', { guildId });
      return true;
    } catch (error) {
      logger.error(`[LevelingManager] Failed to update config: ${error.message}`, { guildId });
      return false;
    }
  }

  /**
   * Handle message XP awarding
   */
  async handleMessageXP(message) {
    if (!message.guild || message.author.bot) return;

    const guildId = message.guild.id;
    const userId = message.author.id;
    const key = `${guildId}_${userId}`;

    // Check cooldown
    const lastXP = this.xpCooldowns.get(key);
    const config = await this.getConfig(guildId);

    const now = Date.now();
    if (lastXP && now - lastXP < config.xp_cooldown_seconds * 1000) return;

    // Calculate XP with multipliers
    const baseXP = config.xp_per_message + Math.floor(Math.random() * 10); // Add 0-10 random bonus
    const multiplier = await this.getActiveMultiplier(guildId);
    const xpToAdd = Math.floor(baseXP * multiplier);

    // Add XP to database
    const oldLevel = await this.addXP(guildId, userId, xpToAdd);
    this.xpCooldowns.set(key, now);

    // Check for level up
    await this.checkLevelUp(message, oldLevel);
  }

  /**
   * Add XP to a user
   */
  async addXP(guildId, userId, xpAmount) {
    try {
      // Get current user data
      const [rows] = await pool.execute(
        'SELECT * FROM user_levels WHERE guild_id = ? AND user_id = ?',
        [guildId, userId]
      );

      let currentXP = rows.length > 0 ? rows[0].xp : 0;
      let currentLevel = rows.length > 0 ? rows[0].level : 0;

      // Add XP
      currentXP += xpAmount;

      // Calculate new level
      let newLevel = currentLevel;
      while (currentXP >= this.getXPForLevel(newLevel + 1)) {
        currentXP -= this.getXPForLevel(newLevel + 1);
        newLevel++;
      }

      // Update database
      if (rows.length > 0) {
        await pool.execute(
          'UPDATE user_levels SET xp = ?, level = ? WHERE guild_id = ? AND user_id = ?',
          [currentXP, newLevel, guildId, userId]
        );
      } else {
        await pool.execute(
          'INSERT INTO user_levels (guild_id, user_id, xp, level) VALUES (?, ?, ?, ?)',
          [guildId, userId, currentXP, newLevel]
        );
      }

      return currentLevel;
    } catch (error) {
      logger.error(`[LevelingManager] Failed to add XP: ${error.message}`, { guildId, userId });
      return 0;
    }
  }

  /**
   * Set XP for a user
   */
  async setXP(guildId, userId, xpAmount) {
    try {
      let currentLevel = 0;
      let remainingXP = xpAmount;

      // Calculate level from total XP
      while (remainingXP >= this.getXPForLevel(currentLevel + 1)) {
        remainingXP -= this.getXPForLevel(currentLevel + 1);
        currentLevel++;
      }

      await pool.execute(
        `INSERT INTO user_levels (guild_id, user_id, xp, level)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE xp = VALUES(xp), level = VALUES(level)`,
        [guildId, userId, remainingXP, currentLevel]
      );

      logger.info('[LevelingManager] Set user XP', { guildId, userId, xp: remainingXP, level: currentLevel });
      return { level: currentLevel, xp: remainingXP };
    } catch (error) {
      logger.error(`[LevelingManager] Failed to set XP: ${error.message}`, { guildId, userId });
      return null;
    }
  }

  /**
   * Remove XP from a user
   */
  async removeXP(guildId, userId, xpAmount) {
    try {
      const [rows] = await pool.execute(
        'SELECT * FROM user_levels WHERE guild_id = ? AND user_id = ?',
        [guildId, userId]
      );

      if (rows.length === 0) return null;

      let totalXP = this.getTotalXP(rows[0].level, rows[0].xp);
      totalXP = Math.max(0, totalXP - xpAmount);

      return await this.setXP(guildId, userId, totalXP);
    } catch (error) {
      logger.error(`[LevelingManager] Failed to remove XP: ${error.message}`, { guildId, userId });
      return null;
    }
  }

  /**
   * Reset a user's level
   */
  async resetUser(guildId, userId) {
    try {
      await pool.execute(
        'DELETE FROM user_levels WHERE guild_id = ? AND user_id = ?',
        [guildId, userId]
      );
      logger.info('[LevelingManager] Reset user levels', { guildId, userId });
      return true;
    } catch (error) {
      logger.error(`[LevelingManager] Failed to reset user: ${error.message}`, { guildId, userId });
      return false;
    }
  }

  /**
   * Reset all users in a guild
   */
  async resetGuild(guildId) {
    try {
      await pool.execute('DELETE FROM user_levels WHERE guild_id = ?', [guildId]);
      logger.info('[LevelingManager] Reset guild levels', { guildId });
      return true;
    } catch (error) {
      logger.error(`[LevelingManager] Failed to reset guild: ${error.message}`, { guildId });
      return false;
    }
  }

  /**
   * Calculate XP required for a level
   */
  getXPForLevel(level) {
    return 5 * (level ** 2) + 50 * level + 100;
  }

  /**
   * Get total XP from level and current XP
   */
  getTotalXP(level, currentXP) {
    let total = currentXP;
    for (let i = 1; i <= level; i++) {
      total += this.getXPForLevel(i);
    }
    return total;
  }

  /**
   * Check for level up and send notification
   */
  async checkLevelUp(message, oldLevel) {
    try {
      const [rows] = await pool.execute(
        'SELECT level FROM user_levels WHERE guild_id = ? AND user_id = ?',
        [message.guild.id, message.author.id]
      );

      if (rows.length === 0 || rows[0].level <= oldLevel) return;

      const newLevel = rows[0].level;
      const config = await this.getConfig(message.guild.id);

      let levelUpMessage = config.level_up_message
        .replace('{user}', `<@${message.author.id}>`)
        .replace('{level}', newLevel.toString())
        .replace('{username}', message.author.username);

      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('Level Up!')
        .setDescription(levelUpMessage)
        .setThumbnail(message.author.displayAvatarURL())
        .setFooter({ text: `You are now level ${newLevel}!` });

      // Check for role rewards
      const [roleRewards] = await pool.execute(
        'SELECT role_id FROM level_role_rewards WHERE guild_id = ? AND level = ?',
        [message.guild.id, newLevel]
      );

      if (roleRewards.length > 0) {
        const role = message.guild.roles.cache.get(roleRewards[0].role_id);
        if (role) {
          try {
            await message.member.roles.add(role);
            embed.addFields({ name: 'Role Reward', value: `You earned the ${role} role!` });
          } catch (error) {
            logger.error('[LevelingManager] Failed to add role reward', { error: error.message });
          }
        }
      }

      // Send to configured channel or current channel
      const channelId = config.level_up_channel_id || message.channel.id;
      const channel = message.guild.channels.cache.get(channelId);

      if (channel && channel.isTextBased()) {
        await channel.send({ embeds: [embed] }).catch((error) => {
          logger.error('[LevelingManager] Failed to send level up message', { error: error.message });
        });
      }

      logger.info(`[LevelingManager] ${message.author.tag} leveled up to ${newLevel}`, {
        guildId: message.guild.id,
        userId: message.author.id,
        level: newLevel
      });
    } catch (error) {
      logger.error(`[LevelingManager] Failed to check level up: ${error.message}`, { error: error.stack });
    }
  }

  /**
   * Get active XP multiplier for a guild
   */
  async getActiveMultiplier(guildId) {
    const config = await this.getConfig(guildId);
    let multiplier = 1.0;

    // Weekend multiplier
    const now = new Date();
    if (now.getDay() === 0 || now.getDay() === 6) {
      multiplier *= parseFloat(config.xp_multiplier_weekends || 1.0);
    }

    // Check for active events
    try {
      const [events] = await pool.execute(
        'SELECT multiplier FROM xp_multiplier_events WHERE guild_id = ? AND enabled = 1 AND start_time <= NOW() AND end_time >= NOW() LIMIT 1',
        [guildId]
      );

      if (events.length > 0) {
        multiplier *= parseFloat(events[0].multiplier);
      }
    } catch (error) {
      logger.error('[LevelingManager] Failed to get multiplier events', { error: error.message });
    }

    return multiplier;
  }

  /**
   * Get user rank data
   */
  async getUserRank(guildId, userId) {
    try {
      const [rows] = await pool.execute(
        'SELECT * FROM user_levels WHERE guild_id = ? AND user_id = ?',
        [guildId, userId]
      );

      if (rows.length === 0) {
        return {
          xp: 0,
          level: 0,
          rank: 0,
          totalXP: 0,
          xpForNextLevel: this.getXPForLevel(1)
        };
      }

      const user = rows[0];
      const totalXP = this.getTotalXP(user.level, user.xp);

      // Get rank position
      const [rankRows] = await pool.execute(
        `SELECT COUNT(*) as rank FROM user_levels
         WHERE guild_id = ? AND (level > ? OR (level = ? AND xp > ?))`,
        [guildId, user.level, user.level, user.xp]
      );

      const rank = (rankRows[0]?.rank || 0) + 1;
      const xpForNextLevel = this.getXPForLevel(user.level + 1);

      return {
        xp: user.xp,
        level: user.level,
        rank,
        totalXP,
        xpForNextLevel,
        voiceXP: user.voice_xp || 0,
        totalVoiceMinutes: user.total_voice_minutes || 0
      };
    } catch (error) {
      logger.error(`[LevelingManager] Failed to get user rank: ${error.message}`, { guildId, userId });
      return null;
    }
  }

  /**
   * Get leaderboard
   */
  async getLeaderboard(guildId, page = 1, limit = 10) {
    try {
      const offset = (page - 1) * limit;

      const [rows] = await pool.execute(
        `SELECT user_id, xp, level, voice_xp, total_voice_minutes
         FROM user_levels
         WHERE guild_id = ?
         ORDER BY level DESC, xp DESC
         LIMIT ? OFFSET ?`,
        [guildId, limit, offset]
      );

      // Get total count
      const [countRows] = await pool.execute(
        'SELECT COUNT(*) as total FROM user_levels WHERE guild_id = ?',
        [guildId]
      );

      const totalUsers = countRows[0]?.total || 0;
      const totalPages = Math.ceil(totalUsers / limit);

      return {
        users: rows,
        page,
        totalPages,
        totalUsers
      };
    } catch (error) {
      logger.error(`[LevelingManager] Failed to get leaderboard: ${error.message}`, { guildId });
      return null;
    }
  }

  /**
   * Add role reward for a level
   */
  async addRoleReward(guildId, level, roleId) {
    try {
      await pool.execute(
        `INSERT INTO level_role_rewards (guild_id, level, role_id)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)`,
        [guildId, level, roleId]
      );

      logger.info('[LevelingManager] Added role reward', { guildId, level, roleId });
      return true;
    } catch (error) {
      logger.error(`[LevelingManager] Failed to add role reward: ${error.message}`, { guildId });
      return false;
    }
  }

  /**
   * Remove role reward for a level
   */
  async removeRoleReward(guildId, level) {
    try {
      await pool.execute(
        'DELETE FROM level_role_rewards WHERE guild_id = ? AND level = ?',
        [guildId, level]
      );

      logger.info('[LevelingManager] Removed role reward', { guildId, level });
      return true;
    } catch (error) {
      logger.error(`[LevelingManager] Failed to remove role reward: ${error.message}`, { guildId });
      return false;
    }
  }

  /**
   * Get all role rewards for a guild
   */
  async getRoleRewards(guildId) {
    try {
      const [rows] = await pool.execute(
        'SELECT level, role_id FROM level_role_rewards WHERE guild_id = ? ORDER BY level ASC',
        [guildId]
      );

      return rows;
    } catch (error) {
      logger.error(`[LevelingManager] Failed to get role rewards: ${error.message}`, { guildId });
      return [];
    }
  }

  /**
   * Handle voice state updates for voice XP
   */
  async handleVoiceStateUpdate(oldState, newState) {
    try {
      const member = newState.member;
      if (!member || member.user.bot) return;

      const guildId = newState.guild.id;
      const userId = member.id;
      const key = `${guildId}_${userId}`;

      const config = await this.getConfig(guildId);
      if (!config.voice_xp_enabled) return;

      // User joined voice
      if (!oldState.channelId && newState.channelId) {
        this.voiceSessions.set(key, Date.now());
        logger.debug(`[LevelingManager] ${member.user.tag} started voice session`, { guildId, userId });
      }
      // User left voice
      else if (oldState.channelId && !newState.channelId) {
        const startTime = this.voiceSessions.get(key);
        if (startTime) {
          const duration = Date.now() - startTime;
          const minutes = Math.floor(duration / 60000);

          if (minutes > 0) {
            await this.addVoiceXP(guildId, userId, minutes, config);
          }

          this.voiceSessions.delete(key);
        }
      }
    } catch (error) {
      logger.error(`[LevelingManager] Voice state update error: ${error.message}`, { error: error.message });
    }
  }

  /**
   * Add voice XP to a user
   */
  async addVoiceXP(guildId, userId, minutes, config) {
    try {
      const xpPerMinute = config.xp_per_voice_minute;
      const multiplier = await this.getActiveMultiplier(guildId);
      const voiceXP = Math.floor(xpPerMinute * minutes * multiplier);

      await pool.execute(
        `INSERT INTO user_levels (guild_id, user_id, voice_xp, total_voice_minutes, xp, level)
         VALUES (?, ?, ?, ?, 0, 0)
         ON DUPLICATE KEY UPDATE
           voice_xp = voice_xp + VALUES(voice_xp),
           total_voice_minutes = total_voice_minutes + VALUES(total_voice_minutes)`,
        [guildId, userId, voiceXP, minutes]
      );

      logger.info(`[LevelingManager] Added ${voiceXP} voice XP for ${minutes} minutes`, {
        guildId,
        userId,
        minutes,
        voiceXP
      });
    } catch (error) {
      logger.error(`[LevelingManager] Failed to add voice XP: ${error.message}`, { guildId, userId });
    }
  }

  /**
   * Format voice time for display
   */
  formatVoiceTime(minutes) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }
}

export default LevelingManager;
