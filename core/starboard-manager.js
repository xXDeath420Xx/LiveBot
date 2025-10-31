"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const logger_1 = __importDefault(require("../utils/logger"));
const db_1 = __importDefault(require("../utils/db"));
class StarboardManager {
    constructor(client) {
        this.client = client;
        logger_1.default.info('[StarboardManager] Starboard manager initialized');
    }
    async getConfig(guildId) {
        try {
            const [[config]] = await db_1.default.execute('SELECT * FROM starboard_config WHERE guild_id = ?', [guildId]);
            return config || null;
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[StarboardManager] Failed to get config: ${errorMessage}`, { guildId });
            return null;
        }
    }
    async handleReactionAdd(reaction, user) {
        try {
            if (user.bot)
                return;
            if (reaction.partial)
                await reaction.fetch();
            if (reaction.message.partial)
                await reaction.message.fetch();
            const message = reaction.message;
            if (!message.guild)
                return;
            const config = await this.getConfig(message.guild.id);
            if (!config || !config.enabled)
                return;
            if (reaction.emoji.name !== config.emoji && reaction.emoji.toString() !== config.emoji)
                return;
            const ignoreChannels = JSON.parse(config.ignore_channels || '[]');
            if (ignoreChannels.includes(message.channel.id))
                return;
            if (!config.self_star && message.author.id === user.id) {
                await reaction.users.remove(user.id);
                return;
            }
            const starCount = reaction.count || 0;
            const [[existing]] = await db_1.default.execute('SELECT * FROM starboard_messages WHERE guild_id = ? AND original_message_id = ?', [message.guild.id, message.id]);
            if (existing) {
                if (starCount >= config.star_threshold) {
                    await this.updateStarboardMessage(message, existing, starCount, config);
                }
            }
            else {
                if (starCount >= config.star_threshold) {
                    await this.createStarboardMessage(message, starCount, config);
                }
            }
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[StarboardManager] Reaction add error: ${errorMessage}`);
        }
    }
    async createStarboardMessage(message, starCount, config) {
        try {
            const starboardChannel = message.guild.channels.cache.get(config.channel_id);
            if (!starboardChannel)
                return;
            const embed = new discord_js_1.EmbedBuilder()
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
            await db_1.default.execute(`
                INSERT INTO starboard_messages (guild_id, original_message_id, original_channel_id, starboard_message_id, star_count, starred_by)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [message.guild.id, message.id, message.channel.id, starboardMessage.id, starCount, '[]']);
            logger_1.default.info(`[StarboardManager] Created starboard entry for message ${message.id}`, { guildId: message.guild.id, starCount });
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[StarboardManager] Failed to create starboard message: ${errorMessage}`);
        }
    }
    async updateStarboardMessage(message, existing, starCount, config) {
        try {
            const starboardChannel = message.guild.channels.cache.get(config.channel_id);
            if (!starboardChannel)
                return;
            const starboardMessage = await starboardChannel.messages.fetch(existing.starboard_message_id).catch(() => null);
            if (!starboardMessage) {
                await db_1.default.execute('DELETE FROM starboard_messages WHERE id = ?', [existing.id]);
                return;
            }
            await starboardMessage.edit({ content: `${config.emoji} **${starCount}** ${message.channel}` });
            await db_1.default.execute('UPDATE starboard_messages SET star_count = ? WHERE id = ?', [starCount, existing.id]);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[StarboardManager] Failed to update starboard message: ${errorMessage}`);
        }
    }
}
exports.default = StarboardManager;
