import { Client, GuildEmoji, MessageReaction, User, Message, Sticker, Guild } from 'discord.js';
import db from '../utils/db';
import logger from '../utils/logger';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

interface EmojiStats extends RowDataPacket {
    emoji_id: string;
    emoji_name: string;
    usage_count: number;
    last_used: Date;
}

interface StickerStats extends RowDataPacket {
    sticker_id: string;
    sticker_name: string;
    usage_count: number;
    last_used: Date;
}

class AssetsManager {
    private client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    async init(): Promise<void> {
        logger.info('[Assets] Initializing Assets Manager...');

        // Track emoji usage
        this.client.on('messageReactionAdd', (reaction, user) => this.trackEmojiUsage(reaction, user));

        // Track sticker usage
        this.client.on('messageCreate', (message) => this.trackStickerUsage(message));

        // Sync existing emojis and stickers
        this.client.on('ready', () => this.syncAllGuildAssets());

        // Listen for emoji events
        this.client.on('emojiCreate', (emoji) => this.handleEmojiCreate(emoji));
        this.client.on('emojiDelete', (emoji) => this.handleEmojiDelete(emoji));
        this.client.on('emojiUpdate', (_oldEmoji, newEmoji) => this.handleEmojiUpdate(_oldEmoji, newEmoji));

        // Listen for sticker events
        this.client.on('stickerCreate', (sticker) => this.handleStickerCreate(sticker));
        this.client.on('stickerDelete', (sticker) => this.handleStickerDelete(sticker));
        this.client.on('stickerUpdate', (_oldSticker, newSticker) => this.handleStickerUpdate(_oldSticker, newSticker));

        logger.info('[Assets] Assets Manager initialized');
    }

    async syncAllGuildAssets(): Promise<void> {
        logger.info('[Assets] Syncing guild assets...');

        for (const guild of this.client.guilds.cache.values()) {
            await this.syncGuildEmojis(guild);
            await this.syncGuildStickers(guild);
        }

        logger.info('[Assets] Guild assets synced');
    }

    async syncGuildEmojis(guild: Guild): Promise<void> {
        try {
            const emojis = await guild.emojis.fetch();

            for (const emoji of emojis.values()) {
                await db.execute(`INSERT INTO custom_emojis
                    (guild_id, emoji_id, emoji_name, animated, managed, available, require_colons, created_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE
                    emoji_name = VALUES(emoji_name),
                    animated = VALUES(animated),
                    managed = VALUES(managed),
                    available = VALUES(available)`, [
                    guild.id,
                    emoji.id,
                    emoji.name,
                    emoji.animated || false,
                    emoji.managed || false,
                    emoji.available || true,
                    emoji.requiresColons || true,
                    emoji.author?.id || null
                ]);
            }

            logger.info(`[Assets] Synced ${emojis.size} emojis for guild ${guild.id}`);
        } catch (error) {
            logger.error(`[Assets] Error syncing emojis for guild ${guild.id}:`, error as Record<string, any>);
        }
    }

    async syncGuildStickers(guild: Guild): Promise<void> {
        try {
            const stickers = await guild.stickers.fetch();

            for (const sticker of stickers.values()) {
                await db.execute(`INSERT INTO custom_stickers
                    (guild_id, sticker_id, sticker_name, description, tags, format_type, available, created_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE
                    sticker_name = VALUES(sticker_name),
                    description = VALUES(description),
                    tags = VALUES(tags),
                    available = VALUES(available)`, [
                    guild.id,
                    sticker.id,
                    sticker.name,
                    sticker.description,
                    sticker.tags || '',
                    this.getStickerFormatType(sticker.format),
                    sticker.available || true,
                    sticker.user?.id || null
                ]);
            }

            logger.info(`[Assets] Synced ${stickers.size} stickers for guild ${guild.id}`);
        } catch (error) {
            logger.error(`[Assets] Error syncing stickers for guild ${guild.id}:`, error as Record<string, any>);
        }
    }

    async handleEmojiCreate(emoji: GuildEmoji): Promise<void> {
        try {
            await db.execute(`INSERT INTO custom_emojis
                (guild_id, emoji_id, emoji_name, animated, managed, available, require_colons, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
                emoji.guild.id,
                emoji.id,
                emoji.name,
                emoji.animated || false,
                emoji.managed || false,
                emoji.available || true,
                emoji.requiresColons || true,
                emoji.author?.id || null
            ]);

            logger.info(`[Assets] Emoji created: ${emoji.name} (${emoji.id})`);
        } catch (error) {
            logger.error('[Assets] Error handling emoji create:', error as Record<string, any>);
        }
    }

    async handleEmojiDelete(emoji: GuildEmoji): Promise<void> {
        try {
            await db.execute('DELETE FROM custom_emojis WHERE emoji_id = ?', [emoji.id]);
            await db.execute('DELETE FROM emoji_usage_stats WHERE emoji_id = ?', [emoji.id]);

            logger.info(`[Assets] Emoji deleted: ${emoji.name} (${emoji.id})`);
        } catch (error) {
            logger.error('[Assets] Error handling emoji delete:', error as Record<string, any>);
        }
    }

    async handleEmojiUpdate(oldEmoji: GuildEmoji, newEmoji: GuildEmoji): Promise<void> {
        try {
            await db.execute(`UPDATE custom_emojis
                SET emoji_name = ?, available = ?
                WHERE emoji_id = ?`, [newEmoji.name, newEmoji.available || true, newEmoji.id]);

            logger.info(`[Assets] Emoji updated: ${newEmoji.name} (${newEmoji.id})`);
        } catch (error) {
            logger.error('[Assets] Error handling emoji update:', error as Record<string, any>);
        }
    }

    async handleStickerCreate(sticker: Sticker): Promise<void> {
        if (!sticker.guildId) return;

        try {
            await db.execute(`INSERT INTO custom_stickers
                (guild_id, sticker_id, sticker_name, description, tags, format_type, available, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
                sticker.guildId,
                sticker.id,
                sticker.name,
                sticker.description,
                sticker.tags || '',
                this.getStickerFormatType(sticker.format),
                sticker.available || true,
                sticker.user?.id || null
            ]);

            logger.info(`[Assets] Sticker created: ${sticker.name} (${sticker.id})`);
        } catch (error) {
            logger.error('[Assets] Error handling sticker create:', error as Record<string, any>);
        }
    }

    async handleStickerDelete(sticker: Sticker): Promise<void> {
        try {
            await db.execute('DELETE FROM custom_stickers WHERE sticker_id = ?', [sticker.id]);
            await db.execute('DELETE FROM sticker_usage_stats WHERE sticker_id = ?', [sticker.id]);

            logger.info(`[Assets] Sticker deleted: ${sticker.name} (${sticker.id})`);
        } catch (error) {
            logger.error('[Assets] Error handling sticker delete:', error as Record<string, any>);
        }
    }

    async handleStickerUpdate(oldSticker: Sticker, newSticker: Sticker): Promise<void> {
        try {
            await db.execute(`UPDATE custom_stickers
                SET sticker_name = ?, description = ?, tags = ?, available = ?
                WHERE sticker_id = ?`, [newSticker.name, newSticker.description, newSticker.tags || '', newSticker.available || true, newSticker.id]);

            logger.info(`[Assets] Sticker updated: ${newSticker.name} (${newSticker.id})`);
        } catch (error) {
            logger.error('[Assets] Error handling sticker update:', error as Record<string, any>);
        }
    }

    async trackEmojiUsage(reaction: MessageReaction, user: User): Promise<void> {
        if (user.bot) return;
        if (!reaction.emoji.id) return; // Skip default Discord emojis

        try {
            await db.execute(`INSERT INTO emoji_usage_stats (emoji_id, guild_id, user_id, channel_id)
                 VALUES (?, ?, ?, ?)`, [reaction.emoji.id, reaction.message.guildId, user.id, reaction.message.channelId]);

            await db.execute(`UPDATE custom_emojis
                 SET usage_count = usage_count + 1, last_used = NOW()
                 WHERE emoji_id = ?`, [reaction.emoji.id]);
        } catch (error) {
            logger.error('[Assets] Error tracking emoji usage:', error as Record<string, any>);
        }
    }

    async trackStickerUsage(message: Message): Promise<void> {
        if (message.author.bot || !message.stickers || message.stickers.size === 0) return;

        try {
            for (const sticker of message.stickers.values()) {
                await db.execute(`INSERT INTO sticker_usage_stats (sticker_id, guild_id, user_id, channel_id)
                     VALUES (?, ?, ?, ?)`, [sticker.id, message.guildId, message.author.id, message.channelId]);

                await db.execute(`UPDATE custom_stickers
                     SET usage_count = usage_count + 1, last_used = NOW()
                     WHERE sticker_id = ?`, [sticker.id]);
            }
        } catch (error) {
            logger.error('[Assets] Error tracking sticker usage:', error as Record<string, any>);
        }
    }

    async getEmojiStats(guildId: string, limit: number = 20): Promise<EmojiStats[]> {
        try {
            const [stats] = await db.execute<EmojiStats[]>(`SELECT emoji_id, emoji_name, usage_count, last_used
                 FROM custom_emojis
                 WHERE guild_id = ?
                 ORDER BY usage_count DESC
                 LIMIT ?`, [guildId, limit]);

            return stats;
        } catch (error) {
            logger.error('[Assets] Error getting emoji stats:', error as Record<string, any>);
            return [];
        }
    }

    async getStickerStats(guildId: string, limit: number = 20): Promise<StickerStats[]> {
        try {
            const [stats] = await db.execute<StickerStats[]>(`SELECT sticker_id, sticker_name, usage_count, last_used
                 FROM custom_stickers
                 WHERE guild_id = ?
                 ORDER BY usage_count DESC
                 LIMIT ?`, [guildId, limit]);

            return stats;
        } catch (error) {
            logger.error('[Assets] Error getting sticker stats:', error as Record<string, any>);
            return [];
        }
    }

    getStickerFormatType(format: number): string {
        switch (format) {
            case 1: return 'png';
            case 2: return 'apng';
            case 3: return 'lottie';
            default: return 'png';
        }
    }

    shutdown(): void {
        logger.info('[Assets] Assets Manager shut down');
    }
}

export = AssetsManager;
