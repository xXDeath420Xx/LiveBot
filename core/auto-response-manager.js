import logger from '../utils/logger.js';
import pool from '../utils/db.js';

/**
 * Auto-Response Manager - Handles phrase-based automatic responses
 * Triggers when users type specific phrases and responds automatically
 */
class AutoResponseManager {
  constructor(client) {
    this.client = client;
    this.responseCache = new Map(); // guild_id -> array of responses
    this.cacheExpiry = new Map(); // guild_id -> expiry timestamp
    this.CACHE_TTL = 60000; // 1 minute cache
    logger.info('[AutoResponseManager] Auto-response manager initialized');
  }

  /**
   * Load auto-responses for a guild
   * @param {string} guildId - Guild ID
   * @returns {Promise<Array>} Array of auto-responses
   */
  async loadResponses(guildId) {
    try {
      // Check cache
      const expiry = this.cacheExpiry.get(guildId);
      if (expiry && Date.now() < expiry && this.responseCache.has(guildId)) {
        return this.responseCache.get(guildId);
      }

      const [responses] = await pool.execute(
        'SELECT * FROM auto_responses WHERE guild_id = ? AND enabled = TRUE',
        [guildId]
      );

      this.responseCache.set(guildId, responses);
      this.cacheExpiry.set(guildId, Date.now() + this.CACHE_TTL);

      return responses;
    } catch (error) {
      logger.error(`[AutoResponseManager] Failed to load responses: ${error.message}`, { guildId });
      return [];
    }
  }

  /**
   * Check a message for auto-response triggers
   * @param {Message} message - Discord message
   * @returns {Promise<boolean>} Whether a response was sent
   */
  async checkMessage(message) {
    try {
      const responses = await this.loadResponses(message.guild.id);
      if (responses.length === 0) return false;

      const content = message.content;

      for (const autoResponse of responses) {
        const trigger = autoResponse.trigger_phrase;
        const caseSensitive = autoResponse.case_sensitive;
        const matchType = autoResponse.match_type;

        const checkContent = caseSensitive ? content : content.toLowerCase();
        const checkTrigger = caseSensitive ? trigger : trigger.toLowerCase();

        let matches = false;

        switch (matchType) {
          case 'exact':
            matches = checkContent === checkTrigger;
            break;
          case 'contains':
            matches = checkContent.includes(checkTrigger);
            break;
          case 'starts_with':
            matches = checkContent.startsWith(checkTrigger);
            break;
          case 'ends_with':
            matches = checkContent.endsWith(checkTrigger);
            break;
          default:
            matches = checkContent.includes(checkTrigger);
        }

        if (matches) {
          // Parse response for channel mentions like {#channel-name}
          let responseText = autoResponse.response;
          const channelMentionRegex = /\{#([^}]+)\}/g;
          let match;

          while ((match = channelMentionRegex.exec(autoResponse.response)) !== null) {
            const channelName = match[1];
            const channel = message.guild.channels.cache.find(
              c => c.name.toLowerCase() === channelName.toLowerCase()
            );
            if (channel) {
              responseText = responseText.replace(match[0], `<#${channel.id}>`);
            }
          }

          await message.channel.send(responseText);

          // Increment use count
          await pool.execute(
            'UPDATE auto_responses SET uses = uses + 1 WHERE id = ?',
            [autoResponse.id]
          );

          logger.debug('[AutoResponseManager] Auto-response triggered', {
            guildId: message.guild.id,
            trigger: trigger,
            userId: message.author.id
          });

          return true;
        }
      }

      return false;
    } catch (error) {
      logger.error(`[AutoResponseManager] Error checking message: ${error.message}`, {
        guildId: message.guild?.id
      });
      return false;
    }
  }

  /**
   * Create a new auto-response
   * @param {string} guildId - Guild ID
   * @param {string} trigger - Trigger phrase
   * @param {string} response - Response text
   * @param {string} createdBy - User ID who created it
   * @param {object} options - Additional options
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async createResponse(guildId, trigger, response, createdBy, options = {}) {
    try {
      const {
        matchType = 'contains',
        caseSensitive = false
      } = options;

      await pool.execute(
        `INSERT INTO auto_responses (guild_id, trigger_phrase, response, match_type, case_sensitive, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [guildId, trigger, response, matchType, caseSensitive, createdBy]
      );

      // Invalidate cache
      this.responseCache.delete(guildId);
      this.cacheExpiry.delete(guildId);

      logger.info(`[AutoResponseManager] Created auto-response for "${trigger}"`, { guildId });
      return { success: true };
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return { success: false, error: 'An auto-response with this trigger already exists!' };
      }
      logger.error(`[AutoResponseManager] Failed to create response: ${error.message}`, { guildId });
      return { success: false, error: 'Failed to create auto-response.' };
    }
  }

  /**
   * Delete an auto-response
   * @param {string} guildId - Guild ID
   * @param {string} trigger - Trigger phrase
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async deleteResponse(guildId, trigger) {
    try {
      const [result] = await pool.execute(
        'DELETE FROM auto_responses WHERE guild_id = ? AND trigger_phrase = ?',
        [guildId, trigger]
      );

      if (result.affectedRows === 0) {
        return { success: false, error: 'Auto-response not found.' };
      }

      // Invalidate cache
      this.responseCache.delete(guildId);
      this.cacheExpiry.delete(guildId);

      logger.info(`[AutoResponseManager] Deleted auto-response "${trigger}"`, { guildId });
      return { success: true };
    } catch (error) {
      logger.error(`[AutoResponseManager] Failed to delete response: ${error.message}`, { guildId });
      return { success: false, error: 'Failed to delete auto-response.' };
    }
  }

  /**
   * List all auto-responses for a guild
   * @param {string} guildId - Guild ID
   * @returns {Promise<Array>}
   */
  async listResponses(guildId) {
    try {
      const [responses] = await pool.execute(
        'SELECT * FROM auto_responses WHERE guild_id = ? ORDER BY created_at DESC',
        [guildId]
      );
      return responses;
    } catch (error) {
      logger.error(`[AutoResponseManager] Failed to list responses: ${error.message}`, { guildId });
      return [];
    }
  }

  /**
   * Invalidate cache for a guild
   * @param {string} guildId - Guild ID
   */
  invalidateCache(guildId) {
    this.responseCache.delete(guildId);
    this.cacheExpiry.delete(guildId);
  }
}

export default AutoResponseManager;
