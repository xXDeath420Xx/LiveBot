const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const musicManager = require('../core/music-manager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Shows details about the currently playing song.'),

  async execute(interaction) {
    const queue = musicManager.getQueue(interaction.guild.id);

    if (!queue || queue.songs.length === 0) {
      return interaction.reply({ content: 'Nothing is currently playing!', ephemeral: true });
    }

    const song = queue.songs[0];
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('Now Playing')
      .setDescription(`[${song.title}](${song.url})`)
      .setThumbnail(song.thumbnail)
      .addFields(
        { name: 'Channel', value: song.channel, inline: true },
        { name: 'Duration', value: song.duration, inline: true }
      )
      .setFooter({ text: `Requested by ${song.requestedBy.tag}` });

    await interaction.reply({ embeds: [embed] });
  },
};