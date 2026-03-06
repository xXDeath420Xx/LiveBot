import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
    name: Events.GuildSoundboardSoundDelete,
    async execute(sound) {
        try {
            const guild = sound.guild;
            if (!guild) return;

            if (sound.client.isDefaultBot && await shouldIgnoreGuild(guild.id)) return;

            logger.info(`[Soundboard] Sound deleted: ${sound.name}`, {
                guildId: guild.id,
                soundId: sound.soundId,
                category: 'soundboard'
            });

            const embed = new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle('🔊 Soundboard Sound Removed')
                .setDescription(`Soundboard sound deleted: **${sound.name}**`)
                .addFields(
                    { name: 'Name', value: sound.name, inline: true },
                    { name: 'Sound ID', value: sound.soundId, inline: true }
                )
                .setTimestamp();

            await sendLogEmbed(guild, 'soundboardSoundDelete', embed);

            await saveAuditLog(guild.id, 'SOUNDBOARD_SOUND_DELETE', null, sound.soundId, null, null, 'Soundboard sound deleted', null, sound.name, null, {});
        } catch (error) {
            logger.error('[Soundboard] Error logging sound delete:', { error: error.message });
        }
    }
};
