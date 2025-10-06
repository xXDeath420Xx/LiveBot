const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const musicManager = require('../core/music-manager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stops the music, clears the queue, and disconnects the bot.'),

  async execute(interaction) {
    if (!interaction.member.voice.channel) {
      return interaction.reply({ content: 'You must be in a voice channel to use this command!', ephemeral: true });
    }

    musicManager.stop(interaction.guild.id);
    await interaction.reply('⏹️ Music stopped and queue cleared.');
  },
};