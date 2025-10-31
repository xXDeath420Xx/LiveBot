"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const logger_1 = __importDefault(require("../utils/logger"));
const db_1 = __importDefault(require("../utils/db"));
class TagsManager {
    constructor(client) {
        this.client = client;
        this.tagCache = new Map();
        logger_1.default.info('[TagsManager] Tags manager initialized');
    }
    async loadTags(guildId) {
        try {
            const [tags] = await db_1.default.execute('SELECT * FROM tags WHERE guild_id = ?', [guildId]);
            if (!this.tagCache.has(guildId)) {
                this.tagCache.set(guildId, new Map());
            }
            const guildTags = this.tagCache.get(guildId);
            for (const tag of tags) {
                guildTags.set(tag.tag_name.toLowerCase(), tag);
            }
            logger_1.default.info(`[TagsManager] Loaded ${tags.length} tags for guild ${guildId}`, { guildId });
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[TagsManager] Failed to load tags: ${errorMessage}`, { guildId });
        }
    }
    async createTag(guildId, tagName, content, creatorId, embedData = null) {
        try {
            const [[existing]] = await db_1.default.execute('SELECT id FROM tags WHERE guild_id = ? AND tag_name = ?', [guildId, tagName.toLowerCase()]);
            if (existing) {
                return { success: false, error: 'A tag with this name already exists!' };
            }
            await db_1.default.execute(`
                INSERT INTO tags (guild_id, tag_name, content, embed_data, creator_id)
                VALUES (?, ?, ?, ?, ?)
            `, [guildId, tagName.toLowerCase(), content, embedData ? JSON.stringify(embedData) : null, creatorId]);
            if (!this.tagCache.has(guildId)) {
                this.tagCache.set(guildId, new Map());
            }
            this.tagCache.get(guildId).set(tagName.toLowerCase(), {
                id: 0,
                tag_name: tagName.toLowerCase(),
                content,
                embed_data: embedData,
                creator_id: creatorId,
                use_count: 0,
                created_at: new Date(),
                updated_at: new Date()
            });
            logger_1.default.info(`[TagsManager] Created tag "${tagName}" in guild ${guildId}`, { guildId, tagName });
            return { success: true };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[TagsManager] Failed to create tag: ${errorMessage}`, { guildId, tagName });
            return { success: false, error: 'Failed to create tag. Please try again.' };
        }
    }
    async getTag(guildId, tagName) {
        try {
            if (this.tagCache.has(guildId)) {
                const cached = this.tagCache.get(guildId).get(tagName.toLowerCase());
                if (cached)
                    return cached;
            }
            const [[tag]] = await db_1.default.execute('SELECT * FROM tags WHERE guild_id = ? AND tag_name = ?', [guildId, tagName.toLowerCase()]);
            if (tag) {
                if (!this.tagCache.has(guildId)) {
                    this.tagCache.set(guildId, new Map());
                }
                this.tagCache.get(guildId).set(tagName.toLowerCase(), tag);
                await db_1.default.execute('UPDATE tags SET use_count = use_count + 1 WHERE id = ?', [tag.id]);
                tag.use_count++;
                return tag;
            }
            return null;
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[TagsManager] Failed to get tag: ${errorMessage}`, { guildId, tagName });
            return null;
        }
    }
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
                    const embed = new discord_js_1.EmbedBuilder(embedData);
                    messageOptions.embeds = [embed];
                }
                catch (embedError) {
                    const errorMessage = embedError instanceof Error ? embedError.message : String(embedError);
                    logger_1.default.error(`[TagsManager] Failed to parse embed data: ${errorMessage}`);
                }
            }
            await channel.send(messageOptions);
            logger_1.default.info(`[TagsManager] Sent tag "${tagName}" to channel ${channel.id}`, {
                guildId,
                tagName,
                requestedBy
            });
            return true;
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[TagsManager] Failed to send tag: ${errorMessage}`, { guildId, tagName });
            return false;
        }
    }
    async editTag(guildId, tagName, newContent, editorId, newEmbedData = null) {
        try {
            const [[tag]] = await db_1.default.execute('SELECT * FROM tags WHERE guild_id = ? AND tag_name = ?', [guildId, tagName.toLowerCase()]);
            if (!tag) {
                return { success: false, error: 'Tag not found!' };
            }
            if (tag.creator_id !== editorId) {
                return { success: false, error: 'You can only edit tags you created!' };
            }
            await db_1.default.execute(`
                UPDATE tags
                SET content = ?, embed_data = ?, updated_at = NOW()
                WHERE id = ?
            `, [newContent, newEmbedData ? JSON.stringify(newEmbedData) : null, tag.id]);
            if (this.tagCache.has(guildId)) {
                const cached = this.tagCache.get(guildId).get(tagName.toLowerCase());
                if (cached) {
                    cached.content = newContent;
                    cached.embed_data = newEmbedData;
                }
            }
            logger_1.default.info(`[TagsManager] Edited tag "${tagName}" in guild ${guildId}`, { guildId, tagName });
            return { success: true };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[TagsManager] Failed to edit tag: ${errorMessage}`, { guildId, tagName });
            return { success: false, error: 'Failed to edit tag. Please try again.' };
        }
    }
    async deleteTag(guildId, tagName, deleterId) {
        try {
            const [[tag]] = await db_1.default.execute('SELECT * FROM tags WHERE guild_id = ? AND tag_name = ?', [guildId, tagName.toLowerCase()]);
            if (!tag) {
                return { success: false, error: 'Tag not found!' };
            }
            if (tag.creator_id !== deleterId) {
                return { success: false, error: 'You can only delete tags you created!' };
            }
            await db_1.default.execute('DELETE FROM tags WHERE id = ?', [tag.id]);
            if (this.tagCache.has(guildId)) {
                this.tagCache.get(guildId).delete(tagName.toLowerCase());
            }
            logger_1.default.info(`[TagsManager] Deleted tag "${tagName}" from guild ${guildId}`, { guildId, tagName });
            return { success: true };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[TagsManager] Failed to delete tag: ${errorMessage}`, { guildId, tagName });
            return { success: false, error: 'Failed to delete tag. Please try again.' };
        }
    }
    async listTags(guildId, page = 1, perPage = 10) {
        try {
            const offset = (page - 1) * perPage;
            const [tags] = await db_1.default.execute('SELECT tag_name, use_count, creator_id FROM tags WHERE guild_id = ? ORDER BY use_count DESC LIMIT ? OFFSET ?', [guildId, perPage, offset]);
            const [[countResult]] = await db_1.default.execute('SELECT COUNT(*) as total FROM tags WHERE guild_id = ?', [guildId]);
            return {
                tags,
                totalTags: countResult.total,
                currentPage: page,
                totalPages: Math.ceil(countResult.total / perPage)
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[TagsManager] Failed to list tags: ${errorMessage}`, { guildId });
            return { tags: [], totalTags: 0, currentPage: 1, totalPages: 0 };
        }
    }
    async searchTags(guildId, query) {
        try {
            const [tags] = await db_1.default.execute('SELECT tag_name, use_count FROM tags WHERE guild_id = ? AND tag_name LIKE ? ORDER BY use_count DESC LIMIT 10', [guildId, `%${query}%`]);
            return tags;
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[TagsManager] Failed to search tags: ${errorMessage}`, { guildId });
            return [];
        }
    }
    async getTagInfo(guildId, tagName) {
        try {
            const [[tag]] = await db_1.default.execute('SELECT * FROM tags WHERE guild_id = ? AND tag_name = ?', [guildId, tagName.toLowerCase()]);
            return tag || null;
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[TagsManager] Failed to get tag info: ${errorMessage}`, { guildId, tagName });
            return null;
        }
    }
    async getTopTags(guildId, limit = 10) {
        try {
            const [tags] = await db_1.default.execute('SELECT tag_name, use_count, creator_id FROM tags WHERE guild_id = ? ORDER BY use_count DESC LIMIT ?', [guildId, limit]);
            return tags;
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[TagsManager] Failed to get top tags: ${errorMessage}`, { guildId });
            return [];
        }
    }
}
exports.default = TagsManager;
