import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
    name: Events.MessagePollVoteAdd,
    async execute(pollAnswer, userId) {
        try {
            const message = pollAnswer.poll?.message;
            if (!message?.guild) return;

            if (message.client.isDefaultBot && await shouldIgnoreGuild(message.guild.id)) return;

            logger.info(`[Poll] User ${userId} voted in poll`, {
                guildId: message.guild.id,
                channelId: message.channel.id,
                messageId: message.id,
                userId,
                category: 'poll'
            });

            const embed = new EmbedBuilder()
                .setColor(0x57F287)
                .setTitle('🗳️ Poll Vote')
                .setDescription(`<@${userId}> voted in a poll`)
                .addFields(
                    { name: 'Channel', value: `${message.channel}`, inline: true },
                    { name: 'Answer', value: pollAnswer.text || 'Unknown', inline: true },
                    { name: 'Message', value: `[Jump](${message.url})`, inline: true }
                )
                .setTimestamp();

            await sendLogEmbed(message.guild, 'pollVoteAdd', embed);

            await saveAuditLog(message.guild.id, 'POLL_VOTE_ADD', userId, message.id, null, message.channel.id, 'Poll vote', null, null, pollAnswer.text, {});
        } catch (error) {
            logger.error('[Poll] Error logging poll vote add:', { error: error.message });
        }
    }
};
