import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import { themeColor } from '../core/guild-theme.js';

export default {
    name: Events.VoiceChannelEffectSend,
    async execute(voiceEffect) {
        try {
            const guild = voiceEffect.guild;
            if (!guild) return;

            if (voiceEffect.client.isDefaultBot && await shouldIgnoreGuild(guild.id)) return;

            logger.info(`[VoiceEffect] Effect sent in voice channel`, {
                guildId: guild.id,
                channelId: voiceEffect.channelId,
                userId: voiceEffect.userId,
                category: 'voiceEffect'
            });

            const embed = new EmbedBuilder()
                .setColor(themeColor(guild?.id, 'accent'))
                .setTitle('✨ Voice Channel Effect')
                .setDescription(`<@${voiceEffect.userId}> sent an effect`)
                .addFields(
                    { name: 'Channel', value: `<#${voiceEffect.channelId}>`, inline: true },
                    { name: 'Animation Type', value: `${voiceEffect.animationType || 'Unknown'}`, inline: true }
                )
                .setTimestamp();

            if (voiceEffect.emoji) {
                embed.addFields({ name: 'Emoji', value: voiceEffect.emoji.toString(), inline: true });
            }

            await sendLogEmbed(guild, 'voiceChannelEffect', embed);

            await saveAuditLog(guild.id, 'VOICE_CHANNEL_EFFECT', voiceEffect.userId, null, null, voiceEffect.channelId, 'Voice effect sent', null, null, null, { animationType: voiceEffect.animationType });
        } catch (error) {
            logger.error('[VoiceEffect] Error logging voice effect:', { error: error.message });
        }
    }
};
