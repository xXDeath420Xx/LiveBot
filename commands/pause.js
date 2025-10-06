const { SlashCommandBuilder } = require('discord.js');
const musicManager = require('../core/music-manager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pauses the current song.'),

  async execute(interaction) {
    if (!interaction.member.voice.channel) {
      return interaction.reply({ content: 'You must be in a voice channel to use this command!', ephemeral: true });
    }
    
    if (musicManager.pause(interaction.guild.id)) {
        await interaction.reply('⏸️ Music paused.');
    } else {
        await interaction.reply({ content: 'Nothing is currently playing or the music is already paused.', ephemeral: true });
    }
  },
};