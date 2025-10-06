const { SlashCommandBuilder } = require('discord.js');
const musicManager = require('../core/music-manager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resumes the paused song.'),

  async execute(interaction) {
    if (!interaction.member.voice.channel) {
      return interaction.reply({ content: 'You must be in a voice channel to use this command!', ephemeral: true });
    }

    if (musicManager.resume(interaction.guild.id)) {
        await interaction.reply('▶️ Music resumed.');
    } else {
        await interaction.reply({ content: 'The music is not paused.', ephemeral: true });
    }
  },
};