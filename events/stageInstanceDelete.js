import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
    name: Events.StageInstanceDelete,
    async execute(stageInstance) {
        try {
            const guild = stageInstance.guild;
            if (!guild) return;

            if (stageInstance.client.isDefaultBot && await shouldIgnoreGuild(guild.id)) return;

            logger.info(`[Stage] Stage ended: ${stageInstance.topic}`, {
                guildId: guild.id,
                channelId: stageInstance.channelId,
                category: 'stageInstance'
            });

            const embed = new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle('🎭 Stage Ended')
                .setDescription(`Stage instance ended`)
                .addFields(
                    { name: 'Topic', value: stageInstance.topic || 'No topic', inline: true },
                    { name: 'Channel', value: `<#${stageInstance.channelId}>`, inline: true }
                )
                .setTimestamp();

            await sendLogEmbed(guild, 'stageInstanceDelete', embed);

            await saveAuditLog(guild.id, 'STAGE_INSTANCE_DELETE', null, stageInstance.id, null, stageInstance.channelId, 'Stage ended', null, stageInstance.topic, null, {});
        } catch (error) {
            logger.error('[Stage] Error logging stage delete:', { error: error.message });
        }
    }
};
