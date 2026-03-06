import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
    name: Events.StageInstanceCreate,
    async execute(stageInstance) {
        try {
            const guild = stageInstance.guild;
            if (!guild) return;

            if (stageInstance.client.isDefaultBot && await shouldIgnoreGuild(guild.id)) return;

            logger.info(`[Stage] Stage started: ${stageInstance.topic}`, {
                guildId: guild.id,
                channelId: stageInstance.channelId,
                category: 'stageInstance'
            });

            const embed = new EmbedBuilder()
                .setColor(0x57F287)
                .setTitle('🎭 Stage Started')
                .setDescription(`Stage instance started`)
                .addFields(
                    { name: 'Topic', value: stageInstance.topic || 'No topic', inline: true },
                    { name: 'Channel', value: `<#${stageInstance.channelId}>`, inline: true },
                    { name: 'Privacy', value: stageInstance.privacyLevel === 2 ? 'Guild Only' : 'Public', inline: true }
                )
                .setTimestamp();

            await sendLogEmbed(guild, 'stageInstanceCreate', embed);

            await saveAuditLog(guild.id, 'STAGE_INSTANCE_CREATE', null, stageInstance.id, null, stageInstance.channelId, 'Stage started', null, null, stageInstance.topic, {});
        } catch (error) {
            logger.error('[Stage] Error logging stage create:', { error: error.message });
        }
    }
};
