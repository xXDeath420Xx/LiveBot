const { EmbedBuilder } = require('discord.js');
const db = require('../utils/db');
const logger = require('../utils/logger');

async function handleReactionAdd(reaction, user) {
    if (reaction.emoji.name !== '⭐') return;
    if (reaction.message.partial) await reaction.message.fetch();

    const message = reaction.message;
    const guildId = message.guild.id;

    const [[config]] = await db.execute('SELECT * FROM starboard_config WHERE guild_id = ?', [guildId]);
    if (!config || !config.channel_id) return;
    
    // Don't let users star their own messages
    if (message.author.id === user.id) {
        return reaction.users.remove(user.id);
    }
    
    // Don't post messages from the starboard channel to the starboard
    if (message.channel.id === config.channel_id) return;

    if (reaction.count >= config.star_threshold) {
        const starboardChannel = await message.guild.channels.fetch(config.channel_id).catch(() => null);
        if (!starboardChannel) return;

        const [[existing]] = await db.execute('SELECT starboard_message_id FROM starboard_messages WHERE original_message_id = ?', [message.id]);

        const starEmbed = new EmbedBuilder()
            .setColor('#FFAC33')
            .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
            .setDescription(`${message.content}\n\n[Jump to Message](${message.url})`)
            .addFields({ name: 'Channel', value: message.channel.toString() })
            .setTimestamp(message.createdTimestamp);
        
        if (message.attachments.size > 0) {
            starEmbed.setImage(message.attachments.first().url);
        }

        const content = `⭐ **${reaction.count}**`;

        if (existing) {
            // Edit existing message
            const starboardMessage = await starboardChannel.messages.fetch(existing.starboard_message_id).catch(() => null);
            if (starboardMessage) {
                await starboardMessage.edit({ content, embeds: [starEmbed] });
            }
        } else {
            // Post new message
            const starboardMessage = await starboardChannel.send({ content, embeds: [starEmbed] });
            await db.execute('INSERT INTO starboard_messages (guild_id, original_message_id, starboard_message_id) VALUES (?, ?, ?)', [guildId, message.id, starboardMessage.id]);
        }
    }
}


module.exports = { handleReactionAdd };