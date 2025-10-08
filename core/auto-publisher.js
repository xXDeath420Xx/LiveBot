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

    const guildId = message.guild.id;

    try {
        const [[config]] = await db.execute('SELECT is_enabled FROM auto_publisher_config WHERE guild_id = ?', [guildId]);

        if (config && config.is_enabled) {
            await message.crosspost();
            logger.info(`Automatically published message ${message.id} in channel ${message.channel.id}.`, { guildId, category: 'auto-publisher' });
        }
    } catch (error) {
        if (error.code === 50024) { // Cannot crosspost message
            logger.warn(`Failed to publish message ${message.id}. It may have already been published.`, { guildId, category: 'auto-publisher' });
        } else {
            logger.error(`Error processing message ${message.id}.`, { guildId, category: 'auto-publisher', error: error.stack });
        }
    }
}

module.exports = { handleNewMessage };