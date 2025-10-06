const { ChannelType } = require('discord.js');
const db = require('../utils/db');
const logger = require('../utils/logger');

async function handleNewMessage(message) {
    if (message.channel.type !== ChannelType.GuildAnnouncement) {
        return; // Only act on announcement channels
    }

    if (message.author.bot) {
        return; // Don't try to publish messages from other bots
    }

    try {
        const [[config]] = await db.execute('SELECT is_enabled FROM auto_publisher_config WHERE guild_id = ?', [message.guild.id]);

        if (config && config.is_enabled) {
            await message.crosspost();
            logger.info(`[AutoPublisher] Automatically published message ${message.id} in channel ${message.channel.id} for guild ${message.guild.id}.`);
        }
    } catch (error) {
        if (error.code === 50024) { // Cannot crosspost message
            logger.warn(`[AutoPublisher] Failed to publish message ${message.id}. It may have already been published.`);
        } else {
            logger.error(`[AutoPublisher] Error processing message ${message.id}:`, error);
        }
    }
}

module.exports = { handleNewMessage };
