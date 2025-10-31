"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleNewMessage = handleNewMessage;
const discord_js_1 = require("discord.js");
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
async function handleNewMessage(message) {
    if (message.channel.type !== discord_js_1.ChannelType.GuildAnnouncement) {
        return; // Only act on announcement channels
    }
    if (message.author.bot) {
        return; // Don't try to publish messages from other bots
    }
    if (!message.guild)
        return;
    const guildId = message.guild.id;
    try {
        const [rows] = await db_1.default.execute('SELECT is_enabled FROM auto_publisher_config WHERE guild_id = ?', [guildId]);
        const config = rows[0];
        if (config && config.is_enabled) {
            await message.crosspost();
            logger_1.default.info(`Automatically published message ${message.id} in channel ${message.channel.id}.`, { guildId, category: 'auto-publisher' });
        }
    }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 50024) { // Cannot crosspost message
            logger_1.default.warn(`Failed to publish message ${message.id}. It may have already been published.`, { guildId, category: 'auto-publisher' });
        }
        else {
            logger_1.default.error(`Error processing message ${message.id}.`, { guildId, category: 'auto-publisher', error: error instanceof Error ? error.stack : error });
        }
    }
}
