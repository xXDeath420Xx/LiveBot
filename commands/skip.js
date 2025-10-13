const {SlashCommandBuilder} = require("discord.js");
const {checkMusicPermissions} = require("../utils/music_helpers");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skips the current song."),

  async execute(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
      return interaction.reply({content: permissionCheck.message, ephemeral: true});
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
      return interaction.reply({content: "There is nothing playing to skip!", ephemeral: true});
    }

    try {
      const success = queue.node.skip();
      await interaction.reply({content: success ? "⏭️ Skipped! Now playing the next song." : "❌ Something went wrong while skipping."});
    } catch (e) {
      await interaction.reply({content: `❌ Error: ${e.message}`});
    }
  },
  category: "Utility",
};