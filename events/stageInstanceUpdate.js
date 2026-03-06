import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
    name: Events.StageInstanceUpdate,
    async execute(oldStage, newStage) {
        try {
            const guild = newStage.guild;
            if (!guild) return;

            if (newStage.client.isDefaultBot && await shouldIgnoreGuild(guild.id)) return;

            const changes = [];
            if (oldStage?.topic !== newStage.topic) changes.push(`Topic: ${oldStage?.topic || 'None'} → ${newStage.topic || 'None'}`);
            if (oldStage?.privacyLevel !== newStage.privacyLevel) changes.push(`Privacy changed`);

            if (changes.length === 0) return;

            logger.info(`[Stage] Stage updated: ${newStage.topic}`, {
                guildId: guild.id,
                channelId: newStage.channelId,
                changes,
                category: 'stageInstance'
            });

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('🎭 Stage Updated')
                .setDescription(`Stage instance was modified`)
                .addFields(
                    { name: 'Channel', value: `<#${newStage.channelId}>`, inline: true },
                    { name: 'Changes', value: changes.join('\n'), inline: false }
                )
                .setTimestamp();

            await sendLogEmbed(guild, 'stageInstanceUpdate', embed);

            await saveAuditLog(guild.id, 'STAGE_INSTANCE_UPDATE', null, newStage.id, null, newStage.channelId, 'Stage updated', null, oldStage?.topic, newStage.topic, { changes });
        } catch (error) {
            logger.error('[Stage] Error logging stage update:', { error: error.message });
        }
    }
};
