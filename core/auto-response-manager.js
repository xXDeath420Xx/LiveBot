import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { EmbedBuilder } from 'discord.js';

/**
 * Auto-Response Manager — triggers on user messages matching configured phrases
 * Uses the `autoresponders` table (rich schema with regex, embeds, reactions, cooldowns, restrictions)
 */
class AutoResponseManager {
  constructor(client) {
    this.client = client;
    this.responseCache = new Map(); // guild_id -> array of autoresponders
    this.cacheExpiry = new Map();
    this.cooldowns = new Map(); // "guildId:arId:scope:scopeId" -> timestamp
    this.CACHE_TTL = 60000;
    logger.info('[AutoResponseManager] Initialized');
  }

  async loadResponses(guildId) {
    try {
      const expiry = this.cacheExpiry.get(guildId);
      if (expiry && Date.now() < expiry && this.responseCache.has(guildId)) {
        return this.responseCache.get(guildId);
      }

      const [rows] = await pool.execute(
        'SELECT * FROM autoresponders WHERE guild_id = ? AND enabled = 1',
        [guildId]
      );

      // Pre-compile regex patterns
      for (const ar of rows) {
        if (ar.match_type === 'regex') {
          try { ar._regex = new RegExp(ar.trigger_text, ar.case_sensitive ? '' : 'i'); }
          catch { ar._regex = null; }
        } else if (ar.match_type === 'wildcard') {
          try {
            const escaped = ar.trigger_text.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
            ar._regex = new RegExp(`^${escaped}$`, ar.case_sensitive ? '' : 'i');
          } catch { ar._regex = null; }
        }
        // Parse JSON fields once
        ar._allowedChannels = parseJson(ar.allowed_channels);
        ar._blockedChannels = parseJson(ar.blocked_channels);
        ar._allowedRoles = parseJson(ar.allowed_roles);
        ar._blockedRoles = parseJson(ar.blocked_roles);
        ar._reactions = parseJson(ar.reactions);
      }

      this.responseCache.set(guildId, rows);
      this.cacheExpiry.set(guildId, Date.now() + this.CACHE_TTL);
      return rows;
    } catch (error) {
      logger.error(`[AutoResponseManager] Failed to load: ${error.message}`, { guildId });
      return [];
    }
  }

  async checkMessage(message) {
    try {
      const responses = await this.loadResponses(message.guild.id);
      if (responses.length === 0) return false;

      const content = message.content;

      for (const ar of responses) {
        if (!this.matchesTrigger(ar, content)) continue;
        if (!this.passesRestrictions(ar, message)) continue;
        if (this.isOnCooldown(ar, message)) continue;

        // Matched — execute the response
        await this.executeResponse(ar, message);
        this.setCooldown(ar, message);

        // Update stats (fire-and-forget)
        pool.execute(
          'UPDATE autoresponders SET use_count = use_count + 1, last_triggered = NOW() WHERE id = ?',
          [ar.id]
        ).catch(() => {});

        return true;
      }

      return false;
    } catch (error) {
      logger.error(`[AutoResponseManager] Error: ${error.message}`, { guildId: message.guild?.id });
      return false;
    }
  }

  matchesTrigger(ar, content) {
    if (ar.match_type === 'regex' || ar.match_type === 'wildcard') {
      return ar._regex ? ar._regex.test(content) : false;
    }

    const check = ar.case_sensitive ? content : content.toLowerCase();
    const trigger = ar.case_sensitive ? ar.trigger_text : ar.trigger_text.toLowerCase();

    switch (ar.match_type) {
      case 'exact': return check === trigger;
      case 'contains': return check.includes(trigger);
      case 'starts_with': return check.startsWith(trigger);
      case 'ends_with': return check.endsWith(trigger);
      default: return check.includes(trigger);
    }
  }

  passesRestrictions(ar, message) {
    // Channel restrictions
    if (ar._allowedChannels.length > 0 && !ar._allowedChannels.includes(message.channel.id)) return false;
    if (ar._blockedChannels.length > 0 && ar._blockedChannels.includes(message.channel.id)) return false;

    // Role restrictions
    const memberRoles = message.member?.roles?.cache?.map(r => r.id) || [];
    if (ar._blockedRoles.length > 0 && ar._blockedRoles.some(r => memberRoles.includes(r))) return false;
    if (ar._allowedRoles.length > 0) {
      if (ar.require_all_roles) {
        if (!ar._allowedRoles.every(r => memberRoles.includes(r))) return false;
      } else {
        if (!ar._allowedRoles.some(r => memberRoles.includes(r))) return false;
      }
    }

    return true;
  }

  isOnCooldown(ar, message) {
    if (!ar.cooldown_seconds || ar.cooldown_seconds <= 0) return false;

    const now = Date.now();
    const cooldownMs = ar.cooldown_seconds * 1000;

    if (ar.cooldown_per_user) {
      const key = `${ar.id}:u:${message.author.id}`;
      const last = this.cooldowns.get(key);
      if (last && now - last < cooldownMs) return true;
    }

    if (ar.cooldown_per_channel) {
      const key = `${ar.id}:c:${message.channel.id}`;
      const last = this.cooldowns.get(key);
      if (last && now - last < cooldownMs) return true;
    }

    // Global cooldown (neither per-user nor per-channel)
    if (!ar.cooldown_per_user && !ar.cooldown_per_channel) {
      const key = `${ar.id}:g`;
      const last = this.cooldowns.get(key);
      if (last && now - last < cooldownMs) return true;
    }

    return false;
  }

  setCooldown(ar, message) {
    if (!ar.cooldown_seconds || ar.cooldown_seconds <= 0) return;
    const now = Date.now();

    if (ar.cooldown_per_user) this.cooldowns.set(`${ar.id}:u:${message.author.id}`, now);
    if (ar.cooldown_per_channel) this.cooldowns.set(`${ar.id}:c:${message.channel.id}`, now);
    if (!ar.cooldown_per_user && !ar.cooldown_per_channel) this.cooldowns.set(`${ar.id}:g`, now);
  }

  async executeResponse(ar, message) {
    try {
      // Delete the trigger message if configured
      if (ar.delete_trigger) {
        message.delete().catch(() => {});
      }

      if (ar.response_type === 'react') {
        // Add reactions to the message
        for (const emoji of ar._reactions) {
          await message.react(emoji).catch(() => {});
        }
        return;
      }

      if (ar.response_type === 'embed') {
        // Send embed from JSON
        let embedData;
        try { embedData = JSON.parse(ar.embed_json); } catch { return; }
        const embed = new EmbedBuilder(embedData);
        if (ar.reply_to_user) {
          await message.reply({ embeds: [embed] });
        } else {
          await message.channel.send({ embeds: [embed] });
        }
        return;
      }

      // Default: text response
      let responseText = this.parseVariables(ar.response_text, message);

      if (ar.reply_to_user) {
        await message.reply(responseText);
      } else {
        await message.channel.send(responseText);
      }
    } catch (error) {
      logger.error(`[AutoResponseManager] Failed to execute response: ${error.message}`, {
        guildId: message.guild.id, arId: ar.id
      });
    }
  }

  parseVariables(text, message) {
    return text
      .replace(/{user}/g, `<@${message.author.id}>`)
      .replace(/{username}/g, message.author.username)
      .replace(/{displayname}/g, message.member?.displayName || message.author.username)
      .replace(/{server}/g, message.guild.name)
      .replace(/{channel}/g, `<#${message.channel.id}>`)
      .replace(/{membercount}/g, message.guild.memberCount.toString())
      .replace(/\{#([^}]+)\}/g, (match, name) => {
        const ch = message.guild.channels.cache.find(c => c.name.toLowerCase() === name.toLowerCase());
        return ch ? `<#${ch.id}>` : match;
      });
  }

  // CRUD methods for dashboard API

  async createResponse(guildId, data, createdBy) {
    try {
      await pool.execute(
        `INSERT INTO autoresponders (guild_id, trigger_text, response_text, match_type, case_sensitive,
         response_type, embed_json, reactions, delete_trigger, reply_to_user,
         allowed_channels, blocked_channels, allowed_roles, blocked_roles, require_all_roles,
         cooldown_seconds, cooldown_per_user, cooldown_per_channel, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          guildId, data.trigger_text, data.response_text || null,
          data.match_type || 'contains', data.case_sensitive ? 1 : 0,
          data.response_type || 'text', data.embed_json || null, data.reactions || null,
          data.delete_trigger ? 1 : 0, data.reply_to_user !== false ? 1 : 0,
          data.allowed_channels || null, data.blocked_channels || null,
          data.allowed_roles || null, data.blocked_roles || null, data.require_all_roles ? 1 : 0,
          data.cooldown_seconds || 0, data.cooldown_per_user !== false ? 1 : 0, data.cooldown_per_channel ? 1 : 0,
          createdBy
        ]
      );
      this.invalidateCache(guildId);
      return { success: true };
    } catch (error) {
      logger.error(`[AutoResponseManager] Create failed: ${error.message}`, { guildId });
      return { success: false, error: error.code === 'ER_DUP_ENTRY' ? 'Trigger already exists' : 'Failed to create' };
    }
  }

  async updateResponse(guildId, id, data) {
    try {
      const sets = [];
      const params = [];

      for (const [key, value] of Object.entries(data)) {
        if (key === 'id' || key === 'guild_id') continue;
        sets.push(`\`${key}\` = ?`);
        params.push(value);
      }

      if (sets.length === 0) return { success: false, error: 'Nothing to update' };

      params.push(id, guildId);
      await pool.execute(`UPDATE autoresponders SET ${sets.join(', ')} WHERE id = ? AND guild_id = ?`, params);
      this.invalidateCache(guildId);
      return { success: true };
    } catch (error) {
      logger.error(`[AutoResponseManager] Update failed: ${error.message}`, { guildId, id });
      return { success: false, error: 'Failed to update' };
    }
  }

  async deleteResponse(guildId, id) {
    try {
      const [result] = await pool.execute('DELETE FROM autoresponders WHERE id = ? AND guild_id = ?', [id, guildId]);
      this.invalidateCache(guildId);
      return { success: result.affectedRows > 0, error: result.affectedRows === 0 ? 'Not found' : undefined };
    } catch (error) {
      logger.error(`[AutoResponseManager] Delete failed: ${error.message}`, { guildId, id });
      return { success: false, error: 'Failed to delete' };
    }
  }

  async listResponses(guildId) {
    try {
      const [rows] = await pool.execute('SELECT * FROM autoresponders WHERE guild_id = ? ORDER BY created_at DESC', [guildId]);
      return rows;
    } catch (error) {
      logger.error(`[AutoResponseManager] List failed: ${error.message}`, { guildId });
      return [];
    }
  }

  invalidateCache(guildId) {
    this.responseCache.delete(guildId);
    this.cacheExpiry.delete(guildId);
  }
}

function parseJson(val) {
  if (!val) return [];
  try { const arr = JSON.parse(val); return Array.isArray(arr) ? arr : []; }
  catch { return []; }
}

export default AutoResponseManager;
