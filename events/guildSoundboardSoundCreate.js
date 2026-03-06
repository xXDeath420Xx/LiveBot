import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
    name: Events.GuildSoundboardSoundCreate,
    async execute(sound) {
        try {
            const guild = sound.guild;
            if (!guild) return;

            if (sound.client.isDefaultBot && await shouldIgnoreGuild(guild.id)) return;

            logger.info(`[Soundboard] Sound created: ${sound.name}`, {
                guildId: guild.id,
                soundId: sound.soundId,
                category: 'soundboard'
            });

            const embed = new EmbedBuilder()
                .setColor(0x57F287)
                .setTitle('🔊 Soundboard Sound Added')
                .setDescription(`New soundboard sound: **${sound.name}**`)
                .addFields(
                    { name: 'Name', value: sound.name, inline: true },
                    { name: 'Sound ID', value: sound.soundId, inline: true },
                    { name: 'Added By', value: sound.user ? `${sound.user.tag}` : 'Unknown', inline: true }
                )
                .setTimestamp();

            await sendLogEmbed(guild, 'soundboardSoundCreate', embed);

            await saveAuditLog(guild.id, 'SOUNDBOARD_SOUND_CREATE', sound.user?.id, sound.soundId, null, null, 'Soundboard sound created', null, null, sound.name, {});
        } catch (error) {
            logger.error('[Soundboard] Error logging sound create:', { error: error.message });
        }
    }
};
