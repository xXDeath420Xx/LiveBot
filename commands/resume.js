const {SlashCommandBuilder} = require("discord.js");
const {checkMusicPermissions} = require("../utils/music_helpers");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resumes the current song."),

  async execute(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
      return interaction.reply({content: permissionCheck.message, ephemeral: true});
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
      return interaction.reply({content: "There is nothing playing right now!", ephemeral: true});
    }

    if (!queue.node.isPaused()) {
      return interaction.reply({content: "The music is not paused!", ephemeral: true});
    }

    try {
      queue.node.setPaused(false);
      await interaction.reply({content: "▶️ Resumed the music."});
    } catch (e) {
      await interaction.reply({content: `❌ Error: ${e.message}`});
    }
  },
  category: "Utility",
};