const { SlashCommandBuilder } = require('discord.js');
const { checkMusicPermissions } = require('../utils/music_helpers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skips the current song.'),

  async execute(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const queue = interaction.client.distube.getQueue(interaction.guildId);
    if (!queue) {
      return interaction.reply({ content: 'There is nothing in the queue right now!', ephemeral: true });
    }

    try {
      await queue.skip();
      await interaction.reply({ content: '⏭️ Skipped! Now playing the next song.' });
    } catch (e) {
      await interaction.reply({ content: `❌ Error: ${e.message}` });
    }
  },
};