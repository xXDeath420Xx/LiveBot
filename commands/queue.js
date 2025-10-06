const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const musicManager = require('../core/music-manager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Displays the current song queue.'),

  async execute(interaction) {
    const queue = musicManager.getQueue(interaction.guild.id);

    if (!queue || queue.songs.length === 0) {
      return interaction.reply({ content: 'The queue is currently empty!', ephemeral: true });
    }

    const nowPlaying = queue.songs[0];
    const queueDescription = queue.songs
      .slice(1, 11)
      .map((song, index) => `${index + 1}. [${song.title}](${song.url})`)
      .join('\n');

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('Music Queue')
      .setDescription(`**Now Playing:**\n[${nowPlaying.title}](${nowPlaying.url})\n\n**Up Next:**\n${queueDescription || 'Nothing else in the queue.'}`)
      .setFooter({ text: `${queue.songs.length} songs in queue` });

    await interaction.reply({ embeds: [embed] });
  },
};