import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import configCache from '../utils/configCache.js';
import { themeColor } from './guild-theme.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import {
  xpScope, isNoXp, boostMultiplier, levelUpMode, shouldAnnounce, renderLevelUpMessage, rewardRolePlan,
  LEVEL_UP_MODES, DEFAULT_LEVEL_UP_MESSAGE
} from './leveling-settings.js';
import {
  HEARTBEAT_MS, voiceTransition, sessionMinutes, reconcileSession,
  saveSession, loadSession, deleteSession, listSessions, touchSessions
} from './leveling-voice-sessions.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

// Memory limits to prevent unbounded growth
const MAX_VOICE_SESSIONS = 10000;
const MAX_XP_COOLDOWNS = 50000;

// Dashboard XP edits (adjustMemberXP): total XP and level ceilings. getTotalXP(1000) is ~1.69e9,
// which still fits user_levels.xp (INT) as the remainder never exceeds one level's worth.
export const MAX_TOTAL_XP = 2000000000;
export const MAX_LEVEL = 1000;
const isOn = (v) => v === true || v === 1 || v === '1';

class LevelingManager {
  constructor(client) {
    this.client = client;
    // Open voice-XP sessions, `${guildId}_${userId}` -> { startedAt (ms), channelId }. A copy of the
    // level_voice_sessions rows (core/leveling-voice-sessions.js), which survive a restart.
    this.voiceSessions = new Map();
    this.xpCooldowns = new Map(); // Track XP cooldowns per user
    logger.info('[LevelingManager] Leveling manager initialized');

    // Periodic cleanup every 5 minutes to enforce max sizes
    setInterval(() => this.cleanupCaches(), 5 * 60 * 1000);

    // Keep stored sessions marked as running, so a restart credits time up to the last beat.
    setInterval(() => {
      const guildIds = [...new Set([...this.voiceSessions.keys()].map(k => k.split('_')[0]))];
      touchSessions(guildIds);
    }, HEARTBEAT_MS).unref?.();

    // Pick up sessions left open by the last run once this client can see voice states.
    if (client?.isReady?.()) {
      this.reconcileVoiceSessions().catch(err => logger.error(`[LevelingManager] Voice session restore failed: ${err.message}`));
    } else {
      client?.once?.('clientReady', () => {
        this.reconcileVoiceSessions().catch(err => logger.error(`[LevelingManager] Voice session restore failed: ${err.message}`));
      });
    }
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
      level_up_message: DEFAULT_LEVEL_UP_MESSAGE,
      level_up_channel_id: null,
      xp_multiplier_weekends: 1.0,
      xp_multiplier_events: 1.0,
      ignored_channels: null,
      ignored_roles: null,
      // migrations/418 columns (absent from the row until that migration has run: same defaults)
      level_up_mode: 'channel',
      announce_every_n: 1,
      announce_min_level: 0,
      announce_rewards_only: 0,
      reward_mode: 'stack',
      remove_reward_on_loss: 0,
      xp_boost_roles: null,
      xp_boost_channels: null
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
      // `enabled` was missing here, so `/level setup enabled:true` replied "enabled" without saving it
      // (message XP checks it). Left out of the config object = keep the stored value.
      const enabled = config.enabled === undefined || config.enabled === null ? null : (config.enabled ? 1 : 0);
      await pool.execute(
        `INSERT INTO level_config (guild_id, enabled, xp_per_message, xp_cooldown_seconds, xp_per_voice_minute,
          voice_xp_enabled, level_up_message, level_up_channel_id, xp_multiplier_weekends, xp_multiplier_events)
         VALUES (?, COALESCE(?, 0), ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           enabled = IF(? IS NULL, enabled, VALUES(enabled)),
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
          enabled,
          config.xp_per_message || 15,
          config.xp_cooldown_seconds || 60,
          config.xp_per_voice_minute || 5,
          config.voice_xp_enabled !== undefined ? config.voice_xp_enabled : true,
          config.level_up_message || 'Congrats {user}! You reached **Level {level}**!',
          config.level_up_channel_id || null,
          config.xp_multiplier_weekends || 1.0,
          config.xp_multiplier_events || 1.0,
          enabled
        ]
      );

      // `/level setup level_up_channel:` picks a channel, so it also switches DM/off announcements back
      // to that channel. Optional: only written when the caller passes it (migration 418 column).
      if (LEVEL_UP_MODES.includes(config.level_up_mode)) {
        await pool.execute('UPDATE level_config SET level_up_mode = ? WHERE guild_id = ?', [config.level_up_mode, guildId])
          .catch((err) => logger.warn(`[LevelingManager] level_up_mode not saved (migration 418?): ${err.message}`, { guildId }));
      }

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

    // No-XP channels (a thread follows its parent, a channel its category) and no-XP roles
    const scope = xpScope(message.member, message.channel);
    if (isNoXp(config, scope)) return;

    // Calculate XP with multipliers: weekend/event, times boosted role and boosted channel
    const baseXP = config.xp_per_message + Math.floor(Math.random() * 10); // Add 0-10 random bonus
    const multiplier = (await this.getActiveMultiplier(guildId)) * boostMultiplier(config, scope);
    const xpToAdd = Math.floor(baseXP * multiplier);

    // Add XP to database (checkLevelUp below logs the level-up, so addXP doesn't)
    const oldLevel = await this.addXP(guildId, userId, xpToAdd, false);
    this.xpCooldowns.set(key, now);

    // Check for level up
    await this.checkLevelUp(message, oldLevel);
  }

  /**
   * Add XP to a user
   * @param {boolean} [logLevelUp=true] post xp.levelUp to the server log when this crosses a level.
   *        false when the caller logs it itself (message XP → checkLevelUp, /level add-xp → xp.adjusted).
   */
  async addXP(guildId, userId, xpAmount, logLevelUp = true) {
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

      // Bonus XP (achievements, daily challenges, games) can level a user up without a message
      if (logLevelUp && newLevel > currentLevel) {
        void logFeatureEvent(() => (this.client?.guilds?.cache?.get(guildId)), 'xp.levelUp', () => ({
          title: '⬆️ Level Up',
          description: `${userLabel(userId)} reached **Level ${newLevel}**`,
          fields: [['Level', `${currentLevel} → ${newLevel}`], ['XP Added', xpAmount]],
        }));
        // ...and earns the role rewards for the levels it crossed, like a message level-up does
        void this.grantRewardsForLevelUp(guildId, userId, currentLevel, newLevel);
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
      const mode = levelUpMode(config);

      const levelUpMessage = renderLevelUpMessage(config.level_up_message, {
        userId: message.author.id,
        username: message.author.username,
        level: newLevel,
        serverName: message.guild.name
      });

      const embed = new EmbedBuilder()
        .setColor(themeColor(message.guild?.id, 'warning'))
        .setTitle('Level Up!')
        .setDescription(levelUpMessage)
        .setThumbnail(message.author.displayAvatarURL())
        .setFooter({ text: mode === 'dm' ? `Level ${newLevel} in ${message.guild.name}`.slice(0, 2048) : `You are now level ${newLevel}!` });

      // Role rewards for every level crossed, stacked or replacing the previous one (reward_mode)
      const rewards = await this.getRoleRewards(message.guild.id);
      const crossedReward = rewards.some(r => Number(r.level) > oldLevel && Number(r.level) <= newLevel);
      const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
      if (member && crossedReward) {
        const { added } = await this.applyRewardRoles(member, newLevel, config, { rewards, fromLevel: oldLevel });
        if (added.length > 0) {
          // A role mention does not resolve in a DM, so the DM names the role instead
          const names = added.map(role => (mode === 'dm' ? `**${role.name}**` : `${role}`)).join(', ');
          embed.addFields({ name: 'Role Reward', value: `You earned the ${names} role${added.length > 1 ? 's' : ''}!`.slice(0, 1024) });
        }
      }

      // Auto-resume paused stream subscriptions — only in servers that run the level-gated stream
      // signup, and only the subs that signup manages (its announcement channel), once the member
      // first reaches that server's gate. Anywhere else a paused sub was paused by staff on purpose
      // (e.g. a hand-picked list) and a level-up must never undo it.
      try {
        const [[signup]] = await pool.execute(
          'SELECT stream_announcement_channel_id, level_gate FROM stream_signup_config WHERE guild_id = ?',
          [message.guild.id]
        );
        const gate = Number(signup?.level_gate ?? 3);
        if (signup && oldLevel < gate && newLevel >= gate) {
          const [resumed] = await pool.execute(
            `UPDATE subscriptions sub
             JOIN streamers s ON s.streamer_id = sub.streamer_id
             SET sub.paused = 0
             WHERE sub.guild_id = ? AND s.discord_user_id = ? AND sub.paused = 1 AND sub.announcement_channel_id = ?`,
            [message.guild.id, message.author.id, signup.stream_announcement_channel_id]
          );
          if (resumed.affectedRows > 0) {
            logger.info(`[LevelingManager] Resumed ${resumed.affectedRows} paused subs for ${message.author.tag} at level ${newLevel}`);
          }
        }
      } catch (e) {
        logger.error('[LevelingManager] Failed to resume paused subs on level-up', { error: e.message });
      }

      // Announce: to the configured channel (or the message's channel), by DM, or not at all;
      // and only on the levels the server picked (every Nth, from a minimum, reward levels).
      let channel = null;
      if (shouldAnnounce(config, newLevel, crossedReward)) {
        if (mode === 'dm') {
          await message.author.send({ embeds: [embed] }).catch((error) => {
            // Closed DMs (50007) are the member's choice, not a fault
            logger.debug('[LevelingManager] Level-up DM not delivered', { guildId: message.guild.id, userId: message.author.id, error: error.message });
          });
        } else {
          const channelId = config.level_up_channel_id || message.channel.id;
          channel = message.guild.channels.cache.get(channelId);

          if (channel && channel.isTextBased()) {
            await channel.send({ embeds: [embed] }).catch((error) => {
              logger.error('[LevelingManager] Failed to send level up message', { error: error.message });
            });
          }
        }
      }

      void logFeatureEvent(() => (message.guild), 'xp.levelUp', () => ({
        title: '⬆️ Level Up',
        description: `${userLabel(message.member ?? message.author)} reached **Level ${newLevel}**`,
        fields: [['Level', `${oldLevel} → ${newLevel}`], ['Channel', `<#${message.channel.id}>`]],
        url: message.url,
        avoidChannelIds: [channel?.isTextBased() ? channel.id : null],
      }));

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
   * Give and take level reward roles so they match `level` (core/leveling-settings.js rewardRolePlan).
   * @param {import('discord.js').GuildMember} member
   * @param {Object} opts
   * @param {Array} [opts.rewards]     level_role_rewards rows, when the caller already has them
   * @param {number|null} [opts.fromLevel] level before a level-up (only rewards above it are given);
   *        null = full sync (dashboard XP edits), which also applies remove_reward_on_loss
   * @returns {Promise<{added: import('discord.js').Role[], removed: import('discord.js').Role[], skipped: string[]}>}
   */
  async applyRewardRoles(member, level, config, { rewards = null, fromLevel = null, reason = 'Level role reward' } = {}) {
    const result = { added: [], removed: [], skipped: [] };
    try {
      const list = rewards ?? await this.getRoleRewards(member.guild.id);
      if (!list.length) return result;
      const plan = rewardRolePlan(list, {
        level,
        fromLevel,
        mode: config.reward_mode === 'replace' ? 'replace' : 'stack',
        removeOnLoss: isOn(config.remove_reward_on_loss),
        heldRoleIds: new Set(member.roles.cache.keys())
      });
      for (const [ids, verb] of [[plan.add, 'add'], [plan.remove, 'remove']]) {
        for (const id of ids) {
          const role = member.guild.roles.cache.get(id);
          // Deleted roles, and roles above the bot's own, cannot be given or taken
          if (!role || !role.editable) { result.skipped.push(id); continue; }
          try {
            await member.roles[verb](role, reason);
            (verb === 'add' ? result.added : result.removed).push(role);
          } catch (error) {
            result.skipped.push(id);
            logger.error(`[LevelingManager] Failed to ${verb} reward role`, { guildId: member.guild.id, roleId: id, error: error.message });
          }
        }
      }
      for (const role of result.added) {
        void logFeatureEvent(() => (member.guild), 'xp.roleReward', () => ({
          title: '🏅 Level Role Granted',
          fields: [['Member', userLabel(member)], ['Role', `<@&${role.id}>`], ['Level', level]],
        }));
      }
      if (result.removed.length) {
        logger.info('[LevelingManager] Reward roles removed', { guildId: member.guild.id, userId: member.id, level, roles: result.removed.map(r => r.id) });
      }
    } catch (error) {
      logger.error(`[LevelingManager] Reward role sync failed: ${error.message}`, { guildId: member?.guild?.id, userId: member?.id });
    }
    return result;
  }

  /**
   * Reward roles for a level-up that did not come from a message (achievement or challenge XP).
   */
  async grantRewardsForLevelUp(guildId, userId, oldLevel, newLevel) {
    try {
      const guild = this.client?.guilds?.cache?.get(guildId);
      if (!guild) return;
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) return;
      const config = await this.getConfig(guildId);
      await this.applyRewardRoles(member, newLevel, config, { fromLevel: oldLevel });
    } catch (error) {
      logger.error(`[LevelingManager] Level-up reward grant failed: ${error.message}`, { guildId, userId });
    }
  }

  /**
   * Change a member's XP from the dashboard and bring their reward roles in line.
   * @param {import('discord.js').Guild} guild
   * @param {string} userId
   * @param {{action: 'set'|'add'|'remove'|'set-level', amount: number}} op
   *        set/add/remove work on total XP; set-level puts them at the start of that level
   * @returns {Promise<{before, after, roles, inServer: boolean}>}
   */
  async adjustMemberXP(guild, userId, { action, amount }) {
    const guildId = guild.id;
    const [rows] = await pool.execute(
      'SELECT level, xp FROM user_levels WHERE guild_id = ? AND user_id = ?',
      [guildId, userId]
    );
    const before = rows.length > 0 ? { level: Number(rows[0].level) || 0, xp: Number(rows[0].xp) || 0 } : { level: 0, xp: 0 };
    before.totalXP = this.getTotalXP(before.level, before.xp);

    const n = Math.max(0, Math.floor(Number(amount) || 0));
    let target;
    switch (action) {
      case 'set': target = n; break;
      case 'add': target = before.totalXP + n; break;
      case 'remove': target = before.totalXP - n; break;
      case 'set-level': target = this.getTotalXP(Math.min(n, MAX_LEVEL), 0); break;
      default: throw new Error(`Unknown XP action: ${action}`);
    }
    target = Math.min(MAX_TOTAL_XP, Math.max(0, target));

    const saved = await this.setXP(guildId, userId, target);
    if (!saved) throw new Error('The new XP could not be saved');
    const after = { level: saved.level, xp: saved.xp, totalXP: target };

    const { roles, inServer } = await this.syncMemberRewards(guild, userId, after.level, 'Level reward roles updated after an XP change on the dashboard');
    return { before, after, roles, inServer };
  }

  /**
   * Full reward-role sync for one member after an admin XP change (dashboard or /level set-xp,
   * add-xp, remove-xp). `level` is read from user_levels when not given.
   */
  async syncMemberRewards(guild, userId, level = null, reason = 'Level reward roles updated after an XP change') {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return { roles: { added: [], removed: [], skipped: [] }, inServer: false };
    if (level === null) {
      const [rows] = await pool.execute('SELECT level FROM user_levels WHERE guild_id = ? AND user_id = ?', [guild.id, userId]);
      level = rows.length > 0 ? Number(rows[0].level) || 0 : 0;
    }
    const config = await this.getConfig(guild.id);
    const roles = await this.applyRewardRoles(member, level, config, { reason });
    return { roles, inServer: true };
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

  // ============================================
  // XP MULTIPLIER EVENTS (/level xp-event) — rows getActiveMultiplier() applies
  // ============================================

  /**
   * The guild's running (or not yet ended) XP event, if any.
   */
  async getActiveXPEvent(guildId) {
    const [rows] = await pool.execute(
      `SELECT id, event_name, multiplier, UNIX_TIMESTAMP(start_time) AS start_ts, UNIX_TIMESTAMP(end_time) AS end_ts
       FROM xp_multiplier_events
       WHERE guild_id = ? AND enabled = 1 AND end_time >= NOW()
       ORDER BY start_time ASC
       LIMIT 1`,
      [guildId]
    );
    return rows[0] || null;
  }

  /**
   * Start an XP multiplier event now. One event at a time: getActiveMultiplier() applies a single row.
   * @returns {Promise<{event?: Object, conflict?: Object}>}
   */
  async startXPEvent(guildId, { name, multiplier, durationSeconds }) {
    const conflict = await this.getActiveXPEvent(guildId);
    if (conflict) return { conflict };

    // Times come from the DB clock so they compare cleanly with NOW() in getActiveMultiplier()
    const [result] = await pool.execute(
      `INSERT INTO xp_multiplier_events (guild_id, event_name, multiplier, start_time, end_time, enabled)
       VALUES (?, ?, ?, NOW(), NOW() + INTERVAL ? SECOND, 1)`,
      [guildId, name, multiplier, durationSeconds]
    );

    const [rows] = await pool.execute(
      `SELECT id, event_name, multiplier, UNIX_TIMESTAMP(start_time) AS start_ts, UNIX_TIMESTAMP(end_time) AS end_ts
       FROM xp_multiplier_events WHERE id = ?`,
      [result.insertId]
    );

    logger.info('[LevelingManager] XP event started', { guildId, name, multiplier, durationSeconds });
    return { event: rows[0] };
  }

  /**
   * End every running/pending XP event for the guild now.
   * @returns {Promise<number>} How many events were stopped
   */
  async stopXPEvents(guildId) {
    const [result] = await pool.execute(
      `UPDATE xp_multiplier_events
       SET enabled = 0, end_time = LEAST(end_time, NOW())
       WHERE guild_id = ? AND enabled = 1 AND end_time >= NOW()`,
      [guildId]
    );

    logger.info('[LevelingManager] XP events stopped', { guildId, stopped: result.affectedRows });
    return result.affectedRows;
  }

  /**
   * Recent XP events for the guild, newest first.
   */
  async listXPEvents(guildId, limit = 10) {
    const [rows] = await pool.execute(
      `SELECT id, event_name, multiplier, enabled,
              UNIX_TIMESTAMP(start_time) AS start_ts, UNIX_TIMESTAMP(end_time) AS end_ts,
              (enabled = 1 AND start_time <= NOW() AND end_time >= NOW()) AS is_active
       FROM xp_multiplier_events
       WHERE guild_id = ?
       ORDER BY end_time DESC
       LIMIT ?`,
      [guildId, limit]
    );
    return rows;
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
         WHERE guild_id = ? AND user_id NOT IN (SELECT user_id FROM user_privacy_settings WHERE opt_out_leaderboards = 1)
         ORDER BY level DESC, xp DESC
         LIMIT ? OFFSET ?`,
        [guildId, limit, offset]
      );

      // Get total count
      const [countRows] = await pool.execute(
        'SELECT COUNT(*) as total FROM user_levels WHERE guild_id = ? AND user_id NOT IN (SELECT user_id FROM user_privacy_settings WHERE opt_out_leaderboards = 1)',
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

      // Join, leave or move. Mute, deafen, stream and camera changes keep the channel.
      const step = voiceTransition(oldState.channelId, newState.channelId);
      if (!step.end && !step.start) return;

      const config = await this.getConfig(guildId);
      // Voice XP is part of leveling: off when leveling is off, as well as when voice XP is
      const voiceOn = isOn(config.enabled) && isOn(config.voice_xp_enabled);
      const now = Date.now();

      // Leaving a channel (or moving out of it) ends the session there. The session may only be in
      // the database, when it began before a restart.
      if (step.end) {
        let session = this.voiceSessions.get(key);
        if (!session) {
          const row = await loadSession(guildId, userId).catch(() => null);
          if (row) session = { startedAt: new Date(row.started_at).getTime(), channelId: row.channel_id };
        }
        this.voiceSessions.delete(key);
        if (session && voiceOn) {
          // The channel the time was spent in decides no-XP and boost, like the channel of a message does
          const channel = oldState.channel || newState.guild.channels.cache.get(session.channelId) || null;
          await this.creditVoiceTime(guildId, userId, member, channel, session.startedAt, now, config);
        }
        if (session && !step.start) await deleteSession(guildId, userId).catch(() => {});
      }

      if (step.start) {
        if (!voiceOn) {
          if (step.end) await deleteSession(guildId, userId).catch(() => {});
          return;
        }
        this.voiceSessions.set(key, { startedAt: now, channelId: newState.channelId });
        await saveSession(guildId, userId, newState.channelId, now);
        logger.debug(`[LevelingManager] ${member.user.tag} started voice session in ${newState.channelId}`, { guildId, userId });
      }
    } catch (error) {
      logger.error(`[LevelingManager] Voice state update error: ${error.message}`, { error: error.message });
    }
  }

  /** Credit the whole minutes from startMs to endMs spent in `channel`, unless it is a no-XP place. */
  async creditVoiceTime(guildId, userId, member, channel, startMs, endMs, config) {
    const minutes = sessionMinutes(startMs, endMs);
    if (minutes <= 0) return 0;
    const scope = xpScope(member, channel);
    if (isNoXp(config, scope)) return 0;
    await this.addVoiceXP(guildId, userId, minutes, config, boostMultiplier(config, scope));
    return minutes;
  }

  /**
   * After a (re)start: credit stored sessions whose member has left voice since (up to the last
   * heartbeat), carry on the ones still in the same channel, restart the ones that moved, and open
   * sessions for members already in voice that have none.
   */
  async reconcileVoiceSessions() {
    const guilds = this.client?.guilds?.cache;
    if (!guilds?.size) return;
    const now = Date.now();
    const owned = async (guild) => !(this.client.isDefaultBot && await shouldIgnoreGuild(guild.id).catch(() => false));

    const rows = await listSessions([...guilds.keys()]);
    const seen = new Set();
    let credited = 0;
    for (const row of rows) {
      const guild = guilds.get(row.guild_id);
      if (!guild || !(await owned(guild))) continue;
      const key = `${row.guild_id}_${row.user_id}`;
      seen.add(key);
      const live = guild.voiceStates.cache.get(row.user_id)?.channelId || null;
      const plan = reconcileSession(row, live, now);
      if (plan.keep) {
        this.voiceSessions.set(key, { startedAt: new Date(row.started_at).getTime(), channelId: row.channel_id });
        continue;
      }
      const config = await this.getConfig(row.guild_id);
      if (isOn(config.enabled) && isOn(config.voice_xp_enabled)) {
        const member = guild.members.cache.get(row.user_id) || await guild.members.fetch(row.user_id).catch(() => null);
        const channel = guild.channels.cache.get(row.channel_id) || null;
        credited += await this.creditVoiceTime(row.guild_id, row.user_id, member, channel,
          new Date(row.started_at).getTime(), plan.creditUntil, config).catch(() => 0);
      }
      if (plan.restartIn) {
        this.voiceSessions.set(key, { startedAt: now, channelId: plan.restartIn });
        await saveSession(row.guild_id, row.user_id, plan.restartIn, now).catch(() => {});
      } else {
        await deleteSession(row.guild_id, row.user_id).catch(() => {});
      }
    }

    // Members who were already in voice with no stored session: count from now.
    let opened = 0;
    for (const guild of guilds.values()) {
      const inVoice = [...guild.voiceStates.cache.values()].filter(vs => vs.channelId && !vs.member?.user?.bot);
      if (!inVoice.length || !(await owned(guild))) continue;
      const config = await this.getConfig(guild.id);
      if (!isOn(config.enabled) || !isOn(config.voice_xp_enabled)) continue;
      for (const vs of inVoice) {
        const key = `${guild.id}_${vs.id}`;
        if (seen.has(key) || this.voiceSessions.has(key)) continue;
        this.voiceSessions.set(key, { startedAt: now, channelId: vs.channelId });
        await saveSession(guild.id, vs.id, vs.channelId, now).catch(() => {});
        opened++;
      }
    }
    logger.info(`[LevelingManager] Voice sessions restored: ${rows.length} stored, ${credited} minutes credited, ${opened} opened`);
  }

  /**
   * Add voice XP to a user
   */
  async addVoiceXP(guildId, userId, minutes, config, boost = 1) {
    try {
      const xpPerMinute = config.xp_per_voice_minute;
      const multiplier = (await this.getActiveMultiplier(guildId)) * boost;
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
