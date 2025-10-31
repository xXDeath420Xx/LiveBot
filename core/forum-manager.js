"use strict";
const discord_js_1 = require("discord.js");
const { db } = require('../utils/db');
const { logger } = require('../utils/logger');
class ForumManager {
    constructor(client) {
        this.client = client;
    }
    async init() {
        logger.info('[Forum] Initializing Forum Manager...');
        this.client.on('threadCreate', (thread) => this.handleThreadCreate(thread));
        this.client.on('threadUpdate', (oldThread, newThread) => this.handleThreadUpdate(oldThread, newThread));
        this.client.on('threadDelete', (thread) => this.handleThreadDelete(thread));
        this.client.on('messageCreate', (message) => this.handleForumMessage(message));
        logger.info('[Forum] Forum Manager initialized');
    }
    async setupForumChannel(guildId, forumChannelId, config = {}) {
        try {
            const guild = this.client.guilds.cache.get(guildId);
            if (!guild)
                return { success: false, error: 'Guild not found' };
            const channel = guild.channels.cache.get(forumChannelId);
            if (!channel || channel.type !== discord_js_1.ChannelType.GuildForum) {
                return { success: false, error: 'Channel is not a forum channel' };
            }
            await db.execute(`INSERT INTO forum_config
                (guild_id, forum_channel_id, auto_create_enabled, auto_archive_duration,
                 auto_lock_on_archive, require_tag, default_reaction_emoji, default_slowmode, default_auto_archive)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                auto_create_enabled = VALUES(auto_create_enabled),
                auto_archive_duration = VALUES(auto_archive_duration),
                auto_lock_on_archive = VALUES(auto_lock_on_archive),
                require_tag = VALUES(require_tag),
                default_reaction_emoji = VALUES(default_reaction_emoji),
                default_slowmode = VALUES(default_slowmode),
                default_auto_archive = VALUES(default_auto_archive)`, [
                guildId,
                forumChannelId,
                config.autoCreateEnabled || false,
                config.autoArchiveDuration || 1440,
                config.autoLockOnArchive !== false,
                config.requireTag || false,
                config.defaultReactionEmoji || null,
                config.defaultSlowmode || 0,
                config.defaultAutoArchive || 1440
            ]);
            logger.info(`[Forum] Setup forum channel ${forumChannelId} in guild ${guildId}`);
            return { success: true, message: 'Forum configured successfully' };
        }
        catch (error) {
            logger.error('[Forum] Error setting up forum channel:', error);
            return { success: false, error: error.message };
        }
    }
    async handleThreadCreate(thread) {
        if (thread.parent?.type !== discord_js_1.ChannelType.GuildForum)
            return;
        try {
            const [[config]] = await db.execute('SELECT * FROM forum_config WHERE forum_channel_id = ?', [thread.parentId]);
            if (!config)
                return;
            await db.execute(`INSERT INTO forum_posts
                (guild_id, forum_channel_id, thread_id, author_id, title, tags)
                VALUES (?, ?, ?, ?, ?, ?)`, [
                thread.guildId,
                thread.parentId,
                thread.id,
                thread.ownerId,
                thread.name,
                JSON.stringify(thread.appliedTags)
            ]);
            const forumConfig = config;
            if (forumConfig.default_reaction_emoji) {
                const starterMessage = await thread.fetchStarterMessage().catch(() => null);
                if (starterMessage) {
                    await starterMessage.react(forumConfig.default_reaction_emoji).catch(() => { });
                }
            }
            logger.info(`[Forum] Thread created: ${thread.name} (${thread.id}) in ${thread.parentId}`);
        }
        catch (error) {
            logger.error('[Forum] Error handling thread create:', error);
        }
    }
    async handleThreadUpdate(oldThread, newThread) {
        if (newThread.parent?.type !== discord_js_1.ChannelType.GuildForum)
            return;
        try {
            const [[config]] = await db.execute('SELECT * FROM forum_config WHERE forum_channel_id = ?', [newThread.parentId]);
            if (!config)
                return;
            await db.execute(`UPDATE forum_posts
                SET archived_at = ?, locked_at = ?, pinned = ?, tags = ?
                WHERE thread_id = ?`, [
                newThread.archived ? new Date() : null,
                newThread.locked ? new Date() : null,
                newThread.pinned || false,
                JSON.stringify(newThread.appliedTags),
                newThread.id
            ]);
            const forumConfig = config;
            if (forumConfig.auto_lock_on_archive && newThread.archived && !newThread.locked) {
                await newThread.setLocked(true).catch(() => { });
            }
            logger.info(`[Forum] Thread updated: ${newThread.name} (${newThread.id})`);
        }
        catch (error) {
            logger.error('[Forum] Error handling thread update:', error);
        }
    }
    async handleThreadDelete(thread) {
        if (thread.parent?.type !== discord_js_1.ChannelType.GuildForum)
            return;
        try {
            await db.execute('DELETE FROM forum_posts WHERE thread_id = ?', [thread.id]);
            await db.execute('DELETE FROM thread_activity WHERE thread_id = ?', [thread.id]);
            logger.info(`[Forum] Thread deleted: ${thread.id}`);
        }
        catch (error) {
            logger.error('[Forum] Error handling thread delete:', error);
        }
    }
    async handleForumMessage(message) {
        if (!message.channel.isThread() || message.channel.parent?.type !== discord_js_1.ChannelType.GuildForum)
            return;
        if (message.author.bot)
            return;
        try {
            await db.execute(`INSERT INTO thread_activity (thread_id, user_id, message_count, last_activity)
                 VALUES (?, ?, 1, NOW())
                 ON DUPLICATE KEY UPDATE
                 message_count = message_count + 1,
                 last_activity = NOW()`, [message.channel.id, message.author.id]);
            await db.execute(`UPDATE forum_posts
                 SET message_count = message_count + 1
                 WHERE thread_id = ?`, [message.channel.id]);
        }
        catch (error) {
            logger.error('[Forum] Error tracking thread activity:', error);
        }
    }
    async getForumStats(guildId, forumChannelId) {
        try {
            const [[stats]] = await db.execute(`SELECT
                    COUNT(*) as total_posts,
                    SUM(message_count) as total_messages,
                    COUNT(DISTINCT author_id) as unique_authors,
                    AVG(message_count) as avg_messages_per_post
                FROM forum_posts
                WHERE guild_id = ? AND forum_channel_id = ?`, [guildId, forumChannelId]);
            return stats;
        }
        catch (error) {
            logger.error('[Forum] Error getting forum stats:', error);
            return null;
        }
    }
    shutdown() {
        logger.info('[Forum] Forum Manager shut down');
    }
}
module.exports = ForumManager;
