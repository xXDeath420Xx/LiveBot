import { EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';

// The text lives in `tags.tag_content` (the dashboard's Tags page reads that column too). Callers of
// this manager — /engage tags and the `!name` trigger in events/messageCreate.js — read `tag.content`,
// so every SELECT exposes it under both names. use_count / embed_data / updated_at come from migration
// 265; updated_at stays NULL until a tag is first edited, so it falls back to created_at.
const TAG_COLUMNS = `id, guild_id, tag_name, tag_content, tag_content AS content, embed_data, creator_id,
  use_count, created_at, COALESCE(updated_at, created_at) AS updated_at`;

/**
 * Tags Manager - Handles tag creation, retrieval, and management
 */
class TagsManager {
  constructor(client) {
    this.client = client;
    this.tagCache = new Map();
    logger.info('[TagsManager] Tags manager initialized');
  }

  /**
   * Load all tags for a guild into cache
   * @param {string} guildId - Guild ID
   */
  async loadTags(guildId) {
    try {
      const [tags] = await pool.execute(`SELECT ${TAG_COLUMNS} FROM tags WHERE guild_id = ?`, [guildId]);

      if (!this.tagCache.has(guildId)) {
        this.tagCache.set(guildId, new Map());
      }

      const guildTags = this.tagCache.get(guildId);
      for (const tag of tags) {
        guildTags.set(tag.tag_name.toLowerCase(), tag);
      }

      logger.info(`[TagsManager] Loaded ${tags.length} tags for guild ${guildId}`, { guildId });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[TagsManager] Failed to load tags: ${errorMessage}`, { guildId });
    }
  }

  /**
   * Create a new tag
   * @param {string} guildId - Guild ID
   * @param {string} tagName - Tag name
   * @param {string} content - Tag content
   * @param {string} creatorId - Creator user ID
   * @param {object|null} embedData - Embed data (optional)
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async createTag(guildId, tagName, content, creatorId, embedData = null) {
    try {
      const [existing] = await pool.execute(
        'SELECT id FROM tags WHERE guild_id = ? AND tag_name = ?',
        [guildId, tagName.toLowerCase()]
      );

      if (existing.length > 0) {
        return { success: false, error: 'A tag with this name already exists!' };
      }

      const embedJson = embedData ? JSON.stringify(embedData) : null;
      const [result] = await pool.execute(
        `INSERT INTO tags (guild_id, tag_name, tag_content, embed_data, creator_id)
         VALUES (?, ?, ?, ?, ?)`,
        [guildId, tagName.toLowerCase(), content, embedJson, creatorId]
      );

      if (!this.tagCache.has(guildId)) {
        this.tagCache.set(guildId, new Map());
      }

      // Same shape as a DB row: embed_data is the JSON string (callers JSON.parse it).
      this.tagCache.get(guildId).set(tagName.toLowerCase(), {
        id: result.insertId,
        tag_name: tagName.toLowerCase(),
        tag_content: content,
        content,
        embed_data: embedJson,
        creator_id: creatorId,
        use_count: 0,
        created_at: new Date(),
        updated_at: new Date()
      });

      logger.info(`[TagsManager] Created tag "${tagName}" in guild ${guildId}`, { guildId, tagName });
      return { success: true };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[TagsManager] Failed to create tag: ${errorMessage}`, { guildId, tagName });
      return { success: false, error: 'Failed to create tag. Please try again.' };
    }
  }

  /**
   * Get a tag and increment its use count
   * @param {string} guildId - Guild ID
   * @param {string} tagName - Tag name
   * @returns {Promise<object|null>} - Tag object or null
   */
  async getTag(guildId, tagName) {
    try {
      // Always read the row: /engage tags and events/messageCreate.js each hold their own manager
      // instance and the dashboard deletes tags directly, so a cached copy goes stale (edits not
      // showing, deleted tags still answering). Every use has to bump use_count anyway.
      const [rows] = await pool.execute(
        `SELECT ${TAG_COLUMNS} FROM tags WHERE guild_id = ? AND tag_name = ?`,
        [guildId, tagName.toLowerCase()]
      );

      if (rows.length === 0) {
        return null;
      }

      const tag = rows[0];

      // Cache the tag
      if (!this.tagCache.has(guildId)) {
        this.tagCache.set(guildId, new Map());
      }
      this.tagCache.get(guildId).set(tagName.toLowerCase(), tag);

      // Increment use count
      await pool.execute('UPDATE tags SET use_count = use_count + 1 WHERE id = ?', [tag.id]);
      tag.use_count++;

      return tag;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[TagsManager] Failed to get tag: ${errorMessage}`, { guildId, tagName });
      return null;
    }
  }

  /**
   * Send a tag to a channel
   * @param {TextChannel} channel - Discord text channel
   * @param {string} guildId - Guild ID
   * @param {string} tagName - Tag name
   * @param {string} requestedBy - User ID who requested the tag
   * @returns {Promise<boolean>} - Whether the tag was sent successfully
   */
  async sendTag(channel, guildId, tagName, requestedBy) {
    try {
      const tag = await this.getTag(guildId, tagName);
      if (!tag) {
        await channel.send(`❌ Tag \`${tagName}\` not found.`);
        return false;
      }

      const messageOptions = {};

      if (tag.content) {
        messageOptions.content = tag.content;
      }

      if (tag.embed_data) {
        try {
          const embedData = JSON.parse(tag.embed_data);
          const embed = new EmbedBuilder(embedData);
          messageOptions.embeds = [embed];
        } catch (embedError) {
          const errorMessage = embedError instanceof Error ? embedError.message : String(embedError);
          logger.error(`[TagsManager] Failed to parse embed data: ${errorMessage}`);
        }
      }

      await channel.send(messageOptions);

      logger.info(`[TagsManager] Sent tag "${tagName}" to channel ${channel.id}`, {
        guildId,
        tagName,
        requestedBy
      });

      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[TagsManager] Failed to send tag: ${errorMessage}`, { guildId, tagName });
      return false;
    }
  }

  /**
   * Edit an existing tag
   * @param {string} guildId - Guild ID
   * @param {string} tagName - Tag name
   * @param {string} newContent - New tag content
   * @param {string} editorId - Editor user ID
   * @param {object|null} newEmbedData - New embed data (optional)
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async editTag(guildId, tagName, newContent, editorId, newEmbedData = null) {
    try {
      const [rows] = await pool.execute(
        'SELECT * FROM tags WHERE guild_id = ? AND tag_name = ?',
        [guildId, tagName.toLowerCase()]
      );

      if (rows.length === 0) {
        return { success: false, error: 'Tag not found!' };
      }

      const tag = rows[0];

      if (tag.creator_id !== editorId) {
        return { success: false, error: 'You can only edit tags you created!' };
      }

      const newEmbedJson = newEmbedData ? JSON.stringify(newEmbedData) : null;
      await pool.execute(
        `UPDATE tags
         SET tag_content = ?, embed_data = ?, updated_at = NOW()
         WHERE id = ?`,
        [newContent, newEmbedJson, tag.id]
      );

      // Update cache
      if (this.tagCache.has(guildId)) {
        const cached = this.tagCache.get(guildId).get(tagName.toLowerCase());
        if (cached) {
          cached.tag_content = newContent;
          cached.content = newContent;
          cached.embed_data = newEmbedJson;
        }
      }

      logger.info(`[TagsManager] Edited tag "${tagName}" in guild ${guildId}`, { guildId, tagName });
      return { success: true };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[TagsManager] Failed to edit tag: ${errorMessage}`, { guildId, tagName });
      return { success: false, error: 'Failed to edit tag. Please try again.' };
    }
  }

  /**
   * Delete a tag
   * @param {string} guildId - Guild ID
   * @param {string} tagName - Tag name
   * @param {string} deleterId - Deleter user ID
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async deleteTag(guildId, tagName, deleterId) {
    try {
      const [rows] = await pool.execute(
        'SELECT * FROM tags WHERE guild_id = ? AND tag_name = ?',
        [guildId, tagName.toLowerCase()]
      );

      if (rows.length === 0) {
        return { success: false, error: 'Tag not found!' };
      }

      const tag = rows[0];

      if (tag.creator_id !== deleterId) {
        return { success: false, error: 'You can only delete tags you created!' };
      }

      await pool.execute('DELETE FROM tags WHERE id = ?', [tag.id]);

      // Remove from cache
      if (this.tagCache.has(guildId)) {
        this.tagCache.get(guildId).delete(tagName.toLowerCase());
      }

      logger.info(`[TagsManager] Deleted tag "${tagName}" from guild ${guildId}`, { guildId, tagName });
      return { success: true };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[TagsManager] Failed to delete tag: ${errorMessage}`, { guildId, tagName });
      return { success: false, error: 'Failed to delete tag. Please try again.' };
    }
  }

  /**
   * List tags with pagination
   * @param {string} guildId - Guild ID
   * @param {number} page - Page number (1-indexed)
   * @param {number} perPage - Items per page
   * @returns {Promise<{tags: Array, totalTags: number, currentPage: number, totalPages: number}>}
   */
  async listTags(guildId, page = 1, perPage = 10) {
    try {
      const offset = (page - 1) * perPage;

      const [tags] = await pool.execute(
        'SELECT tag_name, use_count, creator_id FROM tags WHERE guild_id = ? ORDER BY use_count DESC LIMIT ? OFFSET ?',
        [guildId, perPage, offset]
      );

      const [countResult] = await pool.execute(
        'SELECT COUNT(*) as total FROM tags WHERE guild_id = ?',
        [guildId]
      );

      return {
        tags,
        totalTags: countResult[0].total,
        currentPage: page,
        totalPages: Math.ceil(countResult[0].total / perPage)
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[TagsManager] Failed to list tags: ${errorMessage}`, { guildId });
      return { tags: [], totalTags: 0, currentPage: 1, totalPages: 0 };
    }
  }

  /**
   * Search for tags by name
   * @param {string} guildId - Guild ID
   * @param {string} query - Search query
   * @returns {Promise<Array>} - Array of matching tags
   */
  async searchTags(guildId, query) {
    try {
      const [tags] = await pool.execute(
        'SELECT tag_name, use_count FROM tags WHERE guild_id = ? AND tag_name LIKE ? ORDER BY use_count DESC LIMIT 10',
        [guildId, `%${query}%`]
      );

      return tags;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[TagsManager] Failed to search tags: ${errorMessage}`, { guildId });
      return [];
    }
  }

  /**
   * Get detailed information about a tag
   * @param {string} guildId - Guild ID
   * @param {string} tagName - Tag name
   * @returns {Promise<object|null>} - Tag object or null
   */
  async getTagInfo(guildId, tagName) {
    try {
      const [rows] = await pool.execute(
        `SELECT ${TAG_COLUMNS} FROM tags WHERE guild_id = ? AND tag_name = ?`,
        [guildId, tagName.toLowerCase()]
      );

      return rows.length > 0 ? rows[0] : null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[TagsManager] Failed to get tag info: ${errorMessage}`, { guildId, tagName });
      return null;
    }
  }

  /**
   * Get top tags by usage
   * @param {string} guildId - Guild ID
   * @param {number} limit - Number of tags to return
   * @returns {Promise<Array>} - Array of top tags
   */
  async getTopTags(guildId, limit = 10) {
    try {
      const [tags] = await pool.execute(
        'SELECT tag_name, use_count, creator_id FROM tags WHERE guild_id = ? ORDER BY use_count DESC LIMIT ?',
        [guildId, limit]
      );

      return tags;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[TagsManager] Failed to get top tags: ${errorMessage}`, { guildId });
      return [];
    }
  }
}

export default TagsManager;
