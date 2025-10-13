const {SlashCommandBuilder} = require("discord.js");
const {checkMusicPermissions} = require("../utils/music_helpers");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("shuffle")
    .setDescription("Shuffles the current queue."),

  async execute(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
      return interaction.reply({content: permissionCheck.message, ephemeral: true});
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying() || queue.tracks.size < 2) {
      return interaction.reply({content: "There are not enough songs in the queue to shuffle!", ephemeral: true});
    }

    try {
      queue.tracks.shuffle();
      await interaction.reply({content: "🔀 The queue has been shuffled."});
    } catch (e) {
      await interaction.reply({content: `❌ Error: ${e.message}`});
    }
  },
};