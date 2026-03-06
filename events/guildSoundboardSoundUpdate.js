import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
    name: Events.GuildSoundboardSoundUpdate,
    async execute(oldSound, newSound) {
        try {
            const guild = newSound.guild;
            if (!guild) return;

            if (newSound.client.isDefaultBot && await shouldIgnoreGuild(guild.id)) return;

            const changes = [];
            if (oldSound?.name !== newSound.name) changes.push(`Name: ${oldSound?.name} → ${newSound.name}`);
            if (oldSound?.volume !== newSound.volume) changes.push(`Volume: ${oldSound?.volume} → ${newSound.volume}`);
            if (oldSound?.emojiName !== newSound.emojiName) changes.push(`Emoji changed`);

            if (changes.length === 0) return;

            logger.info(`[Soundboard] Sound updated: ${newSound.name}`, {
                guildId: guild.id,
                soundId: newSound.soundId,
                changes,
                category: 'soundboard'
            });

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('🔊 Soundboard Sound Updated')
                .setDescription(`Soundboard sound modified: **${newSound.name}**`)
                .addFields(
                    { name: 'Sound', value: newSound.name, inline: true },
                    { name: 'Changes', value: changes.join('\n'), inline: false }
                )
                .setTimestamp();

            await sendLogEmbed(guild, 'soundboardSoundUpdate', embed);

            await saveAuditLog(guild.id, 'SOUNDBOARD_SOUND_UPDATE', null, newSound.soundId, null, null, 'Soundboard sound updated', null, oldSound?.name, newSound.name, { changes });
        } catch (error) {
            logger.error('[Soundboard] Error logging sound update:', { error: error.message });
        }
    }
};
