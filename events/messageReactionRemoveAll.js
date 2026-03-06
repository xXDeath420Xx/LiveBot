import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
    name: Events.MessageReactionRemoveAll,
    async execute(message, reactions) {
        try {
            if (!message.guild) return;

            if (message.client.isDefaultBot && await shouldIgnoreGuild(message.guild.id)) return;

            logger.info(`[Reactions] All reactions removed from message ${message.id}`, {
                guildId: message.guild.id,
                channelId: message.channel.id,
                messageId: message.id,
                category: 'reactions'
            });

            const embed = new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle('💨 All Reactions Removed')
                .setDescription(`All reactions were removed from a message`)
                .addFields(
                    { name: 'Channel', value: `${message.channel}`, inline: true },
                    { name: 'Message ID', value: message.id, inline: true },
                    { name: 'Message Link', value: `[Jump to message](${message.url})`, inline: true }
                )
                .setTimestamp();

            await sendLogEmbed(message.guild, 'reactionRemoveAll', embed);

            await saveAuditLog(message.guild.id, 'REACTION_REMOVE_ALL', null, message.id, null, message.channel.id, 'All reactions removed', null, null, null, {});
        } catch (error) {
            logger.error('[Reactions] Error logging reaction remove all:', { error: error.message });
        }
    }
};
