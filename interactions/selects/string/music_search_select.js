const musicManager = require('../../../core/music-manager');
const { EmbedBuilder } = require('discord.js');

module.exports = {
  customId: 'music_search_select',
  async execute(interaction) {
    if (!interaction.member.voice.channel) {
      return interaction.reply({ content: 'You must be in a voice channel to select a song!', ephemeral: true });
    }

    const url = interaction.values[0];
    await interaction.update({ content: 'Adding your selection to the queue...', components: [] });

    try {
        const result = await musicManager.play(interaction.member.voice.channel, url, interaction.user);
        
        const embed = new EmbedBuilder()
            .setColor('#57F287')
            .setAuthor({ name: result.addedToQueue ? 'Added to Queue' : 'Now Playing' })
            .setTitle(result.song.title)
            .setURL(result.song.url)
            .setThumbnail(result.song.thumbnail)
            .addFields(
                { name: 'Channel', value: result.song.channel, inline: true },
                { name: 'Duration', value: result.song.duration, inline: true }
            )
            .setFooter({ text: `Requested by ${interaction.user.tag}` });
        
        // Send a new message to the channel instead of editing the ephemeral one
        await interaction.channel.send({ embeds: [embed] });
    } catch (error) {
        console.error('[Music Search Select Error]', error);
        await interaction.followUp({ content: `❌ Error: ${error.message}`, ephemeral: true });
    }
  },
};