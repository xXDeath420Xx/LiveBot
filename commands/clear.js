const {SlashCommandBuilder} = require("discord.js");
const {checkMusicPermissions} = require("../utils/music_helpers");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Clears all songs from the queue."),

  async execute(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
      return interaction.reply({content: permissionCheck.message, ephemeral: true});
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
      return interaction.reply({content: "There is nothing in the queue to clear!", ephemeral: true});
    }

    if (queue.tracks.size < 1) {
      return interaction.reply({content: "The queue is already empty.", ephemeral: true});
    }

    try {
      queue.tracks.clear();
      await interaction.reply({content: "🗑️ The queue has been cleared."});
    } catch (e) {
      await interaction.reply({content: `❌ Error: ${e.message}`});
    }
  },
};