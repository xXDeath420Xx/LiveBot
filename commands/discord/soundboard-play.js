/*
 * /soundboard-play — send a native Discord soundboard sound into a voice
 * channel. The bot DOES NOT need to join: Discord's new
 * `POST /channels/{id}/send-soundboard-sound` endpoint plays through the
 * caller's connection on Discord's side.
 *
 * Caller must be in a voice channel; the sound rings there (same UX as
 * clicking the soundboard button in the Discord client). Requires
 * `SpeakSoundboardSounds` on the member for the channel.
 */
import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    Routes,
} from 'discord.js';
import logger from '../../utils/logger.js';

export default {
    category: 'discord',
    data: new SlashCommandBuilder()
        .setName('soundboard-play')
        .setDescription('Play a Discord-native soundboard sound in the voice channel you\'re in.')
        .addStringOption(o => o
            .setName('sound')
            .setDescription('The sound\'s name or id')
            .setRequired(true)
            .setAutocomplete(true)),

    async autocomplete(interaction) {
        if (!interaction.inGuild()) return interaction.respond([]);
        try {
            const sounds = await interaction.guild.soundboardSounds.fetch();
            const term = (interaction.options.getFocused() || '').toLowerCase();
            const matches = [...sounds.values()]
                .filter(s => !term || s.name?.toLowerCase().includes(term))
                .slice(0, 25)
                .map(s => ({ name: s.name, value: s.soundId ?? s.id }));
            return interaction.respond(matches);
        } catch { return interaction.respond([]); }
    },

    async execute(interaction) {
        if (!interaction.inGuild()) {
            return interaction.reply({ content: 'Server-only.', flags: MessageFlags.Ephemeral });
        }
        const voiceChannel = interaction.member?.voice?.channel;
        if (!voiceChannel) {
            return interaction.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
        }
        if (!voiceChannel.permissionsFor(interaction.member)?.has(PermissionFlagsBits.UseSoundboard)) {
            return interaction.reply({ content: 'You don\'t have permission to use the soundboard here.', flags: MessageFlags.Ephemeral });
        }

        const soundId = interaction.options.getString('sound', true);
        // Resolve name OR id — autocomplete sends an id, but typed input could be a name.
        let resolved = null;
        try {
            const sounds = await interaction.guild.soundboardSounds.fetch();
            resolved = sounds.get(soundId) || [...sounds.values()].find(s => s.name === soundId);
        } catch { /* fall through */ }
        if (!resolved) {
            return interaction.reply({ content: `No soundboard sound matches "${soundId}".`, flags: MessageFlags.Ephemeral });
        }

        try {
            // Discord's send-soundboard-sound endpoint. Body shape:
            //   { sound_id, source_guild_id? (for cross-guild Nitro sounds) }
            await interaction.client.rest.post(
                Routes.sendSoundboardSound(voiceChannel.id),
                { body: { sound_id: resolved.soundId ?? resolved.id, source_guild_id: interaction.guild.id } },
            );
            logger.info('[soundboard-play] played', {
                guildId: interaction.guild.id, soundId: resolved.soundId ?? resolved.id,
                channelId: voiceChannel.id, by: interaction.user.id,
            });
            return interaction.reply({ content: `🔊 Played **${resolved.name}** in ${voiceChannel}.`, flags: MessageFlags.Ephemeral });
        } catch (err) {
            if (err?.code === 50013) return interaction.reply({ content: 'Discord refused — permission missing.', flags: MessageFlags.Ephemeral });
            if (err?.code === 40060) return interaction.reply({ content: 'Rate limited by the soundboard — try again in a moment.', flags: MessageFlags.Ephemeral });
            logger.error('[soundboard-play] failed', { err: err.message, guildId: interaction.guild.id });
            return interaction.reply({ content: `Failed: ${err.message}`, flags: MessageFlags.Ephemeral });
        }
    },
};
