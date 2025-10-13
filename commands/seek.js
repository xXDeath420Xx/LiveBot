const { SlashCommandBuilder } = require('discord.js');
const { checkMusicPermissions } = require('../utils/music_helpers');

// Helper to convert time string (like 1m30s) to milliseconds
function toMilliseconds(timeString) {
    const timeRegex = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/;
    const matches = timeString.match(timeRegex);
    if (!matches) return 0;

    const hours = parseInt(matches[1], 10) || 0;
    const minutes = parseInt(matches[2], 10) || 0;
    const seconds = parseInt(matches[3], 10) || 0;

    return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('seek')
    .setDescription('Seeks to a specific time in the current song.')
    .addStringOption(option =>
        option.setName('time')
            .setDescription('The time to seek to (e.g., 1m30s, 2h, 45s).')
            .setRequired(true)),

  async execute(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
      return interaction.reply({ content: 'There is nothing playing right now!', ephemeral: true });
    }

    const timeString = interaction.options.getString('time');
    const timeMs = toMilliseconds(timeString);

    if (timeMs <= 0) {
        return interaction.reply({ content: '❌ Invalid time format. Use format like `1m30s`, `2h`, `45s`.', ephemeral: true });
    }

    try {
      await queue.node.seek(timeMs);
      await interaction.reply({ content: `⏩ Seeked to **${timeString}**.` });
    } catch (e) {
      await interaction.reply({ content: `❌ Error: ${e.message}` });
    }
  },
};