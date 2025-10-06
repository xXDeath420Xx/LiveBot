const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const musicManager = require('../core/music-manager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('lyrics')
        .setDescription('Fetches the lyrics for a song.')
        .addStringOption(option =>
            option.setName('song')
                .setDescription('The name of the song to search for (defaults to the current song).')
        ),

    async execute(interaction) {
        await interaction.deferReply();

        let songTitle = interaction.options.getString('song');
        
        if (!songTitle) {
            const queue = await musicManager.getQueue(interaction.guild.id);
            if (!queue || !queue.nowPlaying) {
                return interaction.editReply('You must specify a song, as nothing is currently playing.');
            }
            // Clean up the title from the music manager (removes things like "Official Video")
            songTitle = queue.nowPlaying.title.replace(/(\[.*?\])|(\([A-Za-z0-9\s]*\))/g, '').trim();
        }

        try {
            const response = await axios.get(`https://api.lyrics.ovh/v1/${encodeURIComponent(songTitle.split(' ').slice(0, 5).join(' '))}`);
            const lyrics = response.data.lyrics;

            if (!lyrics) {
                return interaction.editReply(`Could not find lyrics for **${songTitle}**.`);
            }

            // Discord embeds have a 4096 character limit for the description
            const trimmedLyrics = lyrics.length > 4000 ? lyrics.substring(0, 4000) + '\n...' : lyrics;

            const embed = new EmbedBuilder()
                .setColor('#2ECC71')
                .setTitle(`Lyrics for: ${songTitle}`)
                .setDescription(trimmedLyrics);

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            if (error.response && error.response.status === 404) {
                await interaction.editReply(`Could not find lyrics for **${songTitle}**.`);
            } else {
                console.error('[Lyrics Command Error]', error);
                await interaction.editReply('An error occurred while trying to fetch the lyrics.');
            }
        }
    },
};