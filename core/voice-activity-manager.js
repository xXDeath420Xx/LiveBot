import logger from '../utils/logger.js';
import pool from '../utils/db.js';

/**
 * Voice Activity Manager - Tracks voice channel usage and statistics
 */
class VoiceActivityManager {
  constructor(client) {
    this.client = client;
    this.activeSessions = new Map();
    logger.info('[VoiceActivityManager] Voice activity manager initialized');
  }

  /**
   * Handle when a user joins a voice channel
   */
  async handleVoiceJoin(guildId, userId, channelId) {
    try {
      const key = `${guildId}_${userId}`;
      this.activeSessions.set(key, {
        joinedAt: new Date(),
        channelId
      });

      logger.info(`[VoiceActivityManager] User ${userId} joined voice channel ${channelId}`, { guildId, userId, channelId });
    } catch (error) {
      logger.error(`[VoiceActivityManager] Voice join error: ${error.message}`, { guildId, userId });
    }
  }

  /**
   * Handle when a user leaves a voice channel
   */
  async handleVoiceLeave(guildId, userId, channelId) {
    try {
      const key = `${guildId}_${userId}`;
      const session = this.activeSessions.get(key);

      if (session) {
        const leftAt = new Date();
        const duration = Math.floor((leftAt.getTime() - session.joinedAt.getTime()) / 1000);

        await pool.execute(
          'INSERT INTO voice_activity (guild_id, user_id, channel_id, joined_at, left_at, duration) VALUES (?, ?, ?, ?, ?, ?)',
          [guildId, userId, channelId, session.joinedAt, leftAt, duration]
        );

        this.activeSessions.delete(key);
        logger.info(`[VoiceActivityManager] Logged voice session for ${userId}: ${duration}s`, { guildId, userId, duration });

        // Track voice achievements
        await this.trackVoiceAchievements(guildId, userId, duration);
      }
    } catch (error) {
      logger.error(`[VoiceActivityManager] Voice leave error: ${error.message}`, { guildId, userId });
    }
  }

  /**
   * Track voice-related achievements
   */
  async trackVoiceAchievements(guildId, userId, sessionDuration) {
    try {
      const achievementManager = this.client.achievementManager;
      if (!achievementManager) return;

      // Get total voice time for this user
      const stats = await this.getVoiceActivityStats(guildId, userId);
      const totalMinutes = Math.floor(stats.total_time / 60);

      // Voice Novice - 1 hour (60 minutes)
      if (totalMinutes >= 60) {
        await achievementManager.trackAchievement(userId, guildId, 'voice_novice', totalMinutes);
      }

      // Voice Expert - 100 hours (6000 minutes)
      if (totalMinutes >= 6000) {
        await achievementManager.trackAchievement(userId, guildId, 'voice_expert', totalMinutes);
      }
    } catch (error) {
      logger.error(`[VoiceActivityManager] Achievement tracking error: ${error.message}`, { guildId, userId });
    }
  }

  /**
   * Handle voice state updates
   */
  async handleVoiceStateUpdate(oldState, newState) {
    try {
      const member = newState.member;
      if (!member || member.user.bot) return;

      const guildId = newState.guild.id;
      const userId = member.id;

      // User joined a voice channel
      if (!oldState.channelId && newState.channelId) {
        await this.handleVoiceJoin(guildId, userId, newState.channelId);
      }
      // User left a voice channel
      else if (oldState.channelId && !newState.channelId) {
        await this.handleVoiceLeave(guildId, userId, oldState.channelId);
      }
      // User moved between voice channels
      else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
        await this.handleVoiceLeave(guildId, userId, oldState.channelId);
        await this.handleVoiceJoin(guildId, userId, newState.channelId);
      }
    } catch (error) {
      logger.error(`[VoiceActivityManager] Voice state update error: ${error.message}`, { error: error.message });
    }
  }

  /**
   * Get voice activity stats for a user
   */
  async getVoiceActivityStats(guildId, userId = null, period = 'all') {
    try {
      let query = 'SELECT SUM(duration) as total_time, COUNT(*) as session_count FROM voice_activity WHERE guild_id = ?';
      const params = [guildId];

      if (userId) {
        query += ' AND user_id = ?';
        params.push(userId);
      }

      // Add period filtering
      if (period === 'daily') {
        query += ' AND joined_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)';
      } else if (period === 'weekly') {
        query += ' AND joined_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)';
      } else if (period === 'monthly') {
        query += ' AND joined_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)';
      }

      const [rows] = await pool.execute(query, params);
      const stats = rows[0];

      return {
        total_time: stats.total_time || 0,
        session_count: stats.session_count || 0
      };
    } catch (error) {
      logger.error(`[VoiceActivityManager] Stats error: ${error.message}`, { guildId, userId });
      return { total_time: 0, session_count: 0 };
    }
  }

  /**
   * Get top voice users leaderboard
   */
  async getTopVoiceUsers(guildId, limit = 10, period = 'all') {
    try {
      let query = `
        SELECT user_id, SUM(duration) as total_time, COUNT(*) as sessions
        FROM voice_activity
        WHERE guild_id = ?
      `;
      const params = [guildId];

      // Add period filtering
      if (period === 'daily') {
        query += ' AND joined_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)';
      } else if (period === 'weekly') {
        query += ' AND joined_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)';
      } else if (period === 'monthly') {
        query += ' AND joined_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)';
      }

      query += ' GROUP BY user_id ORDER BY total_time DESC LIMIT ?';
      params.push(limit);

      const [users] = await pool.execute(query, params);
      return users;
    } catch (error) {
      logger.error(`[VoiceActivityManager] Top users error: ${error.message}`, { guildId });
      return [];
    }
  }

  /**
   * Get most active voice channels
   */
  async getTopVoiceChannels(guildId, limit = 10, period = 'all') {
    try {
      let query = `
        SELECT channel_id, COUNT(*) as session_count, SUM(duration) as total_time
        FROM voice_activity
        WHERE guild_id = ?
      `;
      const params = [guildId];

      // Add period filtering
      if (period === 'daily') {
        query += ' AND joined_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)';
      } else if (period === 'weekly') {
        query += ' AND joined_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)';
      } else if (period === 'monthly') {
        query += ' AND joined_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)';
      }

      query += ' GROUP BY channel_id ORDER BY total_time DESC LIMIT ?';
      params.push(limit);

      const [channels] = await pool.execute(query, params);
      return channels;
    } catch (error) {
      logger.error(`[VoiceActivityManager] Top channels error: ${error.message}`, { guildId });
      return [];
    }
  }

  /**
   * Format duration in seconds to human readable format
   */
  formatDuration(seconds) {
    if (!seconds || seconds === 0) return '0m';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }
}

export default VoiceActivityManager;
