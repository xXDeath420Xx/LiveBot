import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
    name: Events.MessageReactionRemoveEmoji,
    async execute(reaction) {
        try {
            if (!reaction.message.guild) return;

            if (reaction.client.isDefaultBot && await shouldIgnoreGuild(reaction.message.guild.id)) return;

            const emoji = reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;

            logger.info(`[Reactions] Emoji ${emoji} removed from message ${reaction.message.id}`, {
                guildId: reaction.message.guild.id,
                channelId: reaction.message.channel.id,
                messageId: reaction.message.id,
                emoji: reaction.emoji.name,
                category: 'reactions'
            });

            const embed = new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle('💨 Reaction Emoji Removed')
                .setDescription(`A reaction emoji was removed from a message`)
                .addFields(
                    { name: 'Emoji', value: emoji, inline: true },
                    { name: 'Channel', value: `${reaction.message.channel}`, inline: true },
                    { name: 'Message Link', value: `[Jump](${reaction.message.url})`, inline: true }
                )
                .setTimestamp();

            await sendLogEmbed(reaction.message.guild, 'reactionRemoveEmoji', embed);

            await saveAuditLog(reaction.message.guild.id, 'REACTION_REMOVE_EMOJI', null, reaction.message.id, null, reaction.message.channel.id, 'Reaction emoji removed', null, reaction.emoji.name, null, {});
        } catch (error) {
            logger.error('[Reactions] Error logging reaction emoji remove:', { error: error.message });
        }
    }
};
