const { SlashCommandBuilder } = require('discord.js');
const { checkMusicPermissions } = require('../utils/music_helpers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stops the music and clears the queue.'),

  async execute(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const queue = interaction.client.distube.getQueue(interaction.guildId);
    if (!queue) {
      return interaction.reply({ content: 'There is nothing playing right now!', ephemeral: true });
    }

    try {
      await queue.stop();
      await interaction.reply({ content: '⏹️ Music stopped and queue cleared.' });
    } catch (e) {
      await interaction.reply({ content: `❌ Error: ${e.message}` });
    }
  },
};