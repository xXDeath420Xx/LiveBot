const {SlashCommandBuilder} = require("discord.js");
const {checkMusicPermissions} = require("../utils/music_helpers");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Removes a song from the queue.")
    .addIntegerOption(option =>
      option.setName("position")
        .setDescription("The position of the song to remove.")
        .setRequired(true)
        .setMinValue(1)),

  async execute(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
      return interaction.reply({content: permissionCheck.message, ephemeral: true});
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
      return interaction.reply({content: "There is nothing in the queue right now!", ephemeral: true});
    }

    const position = interaction.options.getInteger("position") - 1;
    const tracks = queue.tracks.toArray();

    if (position >= tracks.length) {
      return interaction.reply({content: "❌ Invalid track position.", ephemeral: true});
    }

    try {
      const removedTrack = queue.node.remove(tracks[position]);
      await interaction.reply({content: `🗑️ Removed **${removedTrack.title}** from the queue.`});
    } catch (e) {
      await interaction.reply({content: `❌ Error: ${e.message}`});
    }
  },
};