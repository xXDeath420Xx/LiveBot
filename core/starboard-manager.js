const { EmbedBuilder } = require('discord.js');
const db = require('../utils/db');
const logger = require('../utils/logger');

async function handleReactionAdd(reaction, user) {
    if (reaction.emoji.name !== '⭐') return;
    if (reaction.message.partial) {
        try {
            await reaction.message.fetch();
        } catch (error) {
            logger.error('Failed to fetch partial message for starboard.', { category: 'starboard', error: error.stack });
            return;
        }
    }

    const message = reaction.message;
    const guildId = message.guild.id;

    try {
        const [[config]] = await db.execute('SELECT * FROM starboard_config WHERE guild_id = ?', [guildId]);
        if (!config || !config.channel_id) return;

        if (message.author.id === user.id) {
            try {
                await reaction.users.remove(user.id);
                logger.info(`Removed self-star from ${user.tag}.`, { guildId, category: 'starboard' });
            } catch (error) {
                // Ignore if we can't remove the reaction (e.g. permissions)
            }
            return;
        }

        if (message.channel.id === config.channel_id) return;

        if (reaction.count >= config.star_threshold) {
            const starboardChannel = await message.guild.channels.fetch(config.channel_id).catch(() => null);
            if (!starboardChannel) {
                logger.warn(`Starboard channel not found.`, { guildId, category: 'starboard' });
                return;
            }

            const [[existing]] = await db.execute('SELECT starboard_message_id FROM starboard_messages WHERE original_message_id = ?', [message.id]);

            const starEmbed = new EmbedBuilder()
                .setColor('#FFAC33')
                .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
                .setDescription(`${message.content || ' '}\n\n[Jump to Message](${message.url})`)
                .addFields({ name: 'Channel', value: message.channel.toString() })
                .setTimestamp(message.createdTimestamp);

            if (message.attachments.size > 0) {
                starEmbed.setImage(message.attachments.first().url);
            }

            const content = `⭐ **${reaction.count}**`;

            if (existing) {
                const starboardMessage = await starboardChannel.messages.fetch(existing.starboard_message_id).catch(() => null);
                if (starboardMessage) {
                    await starboardMessage.edit({ content, embeds: [starEmbed] });
                    logger.info(`Updated starboard message for message ${message.id}.`, { guildId, category: 'starboard' });
                } else {
                    // The message was deleted from the starboard channel, so we should remove the DB entry
                    await db.execute('DELETE FROM starboard_messages WHERE original_message_id = ?', [message.id]);
                    logger.warn(`Starboard message for original message ${message.id} was not found, deleting DB entry.`, { guildId, category: 'starboard' });
                }
            } else {
                const starboardMessage = await starboardChannel.send({ content, embeds: [starEmbed] });
                await db.execute('INSERT INTO starboard_messages (guild_id, original_message_id, starboard_message_id) VALUES (?, ?, ?)', [guildId, message.id, starboardMessage.id]);
                logger.info(`Created new starboard message for message ${message.id}.`, { guildId, category: 'starboard' });
            }
        }
    } catch (error) {
        logger.error('Error handling starboard reaction.', { guildId, category: 'starboard', error: error.stack });
    }
}

module.exports = { handleReactionAdd };