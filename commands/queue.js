const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { checkMusicPermissions } = require('../utils/music_helpers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Displays the current music queue.'),

  async execute(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
      return interaction.reply({ content: 'There is nothing in the queue right now!', ephemeral: true });
    }

    const tracks = queue.tracks.toArray(); // Get all tracks
    const currentTrack = queue.currentTrack;

    if (!currentTrack && tracks.length === 0) {
        return interaction.reply({ content: 'The queue is empty.', ephemeral: true });
    }

    const queueString = tracks.slice(0, 10).map((track, i) => {
        return `**${i + 1}.** \`${track.title}\` - ${track.requestedBy.tag}`;
    }).join('\\n');

    const embed = new EmbedBuilder()
        .setColor('#3498DB')
        .setAuthor({ name: 'Server Queue' })
        .setDescription(`**Currently Playing:**\\n\`${currentTrack.title}\` - ${currentTrack.requestedBy.tag}\\n\\n**Up Next:**\\n${queueString || 'Nothing'}`)
        .setFooter({ text: `Total songs in queue: ${tracks.length}` });

    await interaction.reply({ embeds: [embed] });
  },
};