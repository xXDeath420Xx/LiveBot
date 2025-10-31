import { Client, MessageReaction, User, PartialMessageReaction, PartialUser, EmbedBuilder, TextChannel } from 'discord.js';
import { RowDataPacket } from 'mysql2';
import logger from '../utils/logger';
import db from '../utils/db';

interface StarboardConfig extends RowDataPacket {
    guild_id: string;
    channel_id: string;
    star_threshold: number;
    emoji: string;
    enabled: boolean;
    self_star: boolean;
    ignore_channels: string;
}

interface StarboardMessage extends RowDataPacket {
    id: number;
    guild_id: string;
    original_message_id: string;
    original_channel_id: string;
    starboard_message_id: string;
    star_count: number;
    starred_by: string;
}

class StarboardManager {
    private client: Client;

    constructor(client: Client) {
        this.client = client;
        logger.info('[StarboardManager] Starboard manager initialized');
    }

    async getConfig(guildId: string): Promise<StarboardConfig | null> {
        try {
            const [[config]] = await db.execute<StarboardConfig[]>(
                'SELECT * FROM starboard_config WHERE guild_id = ?',
                [guildId]
            );
            return config || null;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(_error);
            logger.error(`[StarboardManager] Failed to get config: ${errorMessage}`, { guildId });
            return null;
        }
    }

    async handleReactionAdd(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<void> {
        try {
            if (user.bot) return;
            if (reaction.partial) await reaction.fetch();
            if (reaction.message.partial) await reaction.message.fetch();

            const message = reaction.message;
            if (!message.guild) return;

            const config = await this.getConfig(message.guild.id);
            if (!config || !config.enabled) return;

            if (reaction.emoji.name !== config.emoji && reaction.emoji.toString() !== config.emoji) return;

            const ignoreChannels: string[] = JSON.parse(config.ignore_channels || '[]');
            if (ignoreChannels.includes(message.channel.id)) return;

            if (!config.self_star && message.author.id === user.id) {
                await reaction.users.remove(user.id);
                return;
            }

            const starCount = reaction.count || 0;
            const [[existing]] = await db.execute<StarboardMessage[]>(
                'SELECT * FROM starboard_messages WHERE guild_id = ? AND original_message_id = ?',
                [message.guild.id, message.id]
            );

            if (existing) {
                if (starCount >= config.star_threshold) {
                    await this.updateStarboardMessage(message, existing, starCount, config);
                }
            } else {
                if (starCount >= config.star_threshold) {
                    await this.createStarboardMessage(message, starCount, config);
                }
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(_error);
            logger.error(`[StarboardManager] Reaction add _error: ${errorMessage}`);
        }
    }

    async createStarboardMessage(message: any, starCount: number, config: StarboardConfig): Promise<void> {
        try {
            const starboardChannel = message.guild.channels.cache.get(config.channel_id) as TextChannel;
            if (!starboardChannel) return;

            const embed = new EmbedBuilder()
                .setColor('#FFD700')
                .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
                .setDescription(message.content || '*No text content*')
                .addFields({ name: 'Source', value: `[Jump to message](${message.url}) in ${message.channel}` })
                .setTimestamp(message.createdAt);

            const attachment = message.attachments.first();
            if (attachment && attachment.contentType?.startsWith('image/')) {
                embed.setImage(attachment.url);
            }

            const starboardMessage = await starboardChannel.send({
                content: `${config.emoji} **${starCount}** ${message.channel}`,
                embeds: [embed]
            });

            await db.execute(`
                INSERT INTO starboard_messages (guild_id, original_message_id, original_channel_id, starboard_message_id, star_count, starred_by)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [message.guild.id, message.id, message.channel.id, starboardMessage.id, starCount, '[]']);

            logger.info(`[StarboardManager] Created starboard entry for message ${message.id}`, { guildId: message.guild.id, starCount });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(_error);
            logger.error(`[StarboardManager] Failed to create starboard message: ${errorMessage}`);
        }
    }

    async updateStarboardMessage(message: any, existing: StarboardMessage, starCount: number, config: StarboardConfig): Promise<void> {
        try {
            const starboardChannel = message.guild.channels.cache.get(config.channel_id) as TextChannel;
            if (!starboardChannel) return;

            const starboardMessage = await starboardChannel.messages.fetch(existing.starboard_message_id).catch(() => null);
            if (!starboardMessage) {
                await db.execute('DELETE FROM starboard_messages WHERE id = ?', [existing.id]);
                return;
            }

            await starboardMessage.edit({ content: `${config.emoji} **${starCount}** ${message.channel}` });
            await db.execute('UPDATE starboard_messages SET star_count = ? WHERE id = ?', [starCount, existing.id]);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(_error);
            logger.error(`[StarboardManager] Failed to update starboard message: ${errorMessage}`);
        }
    }
}

export default StarboardManager;
