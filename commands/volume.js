const {SlashCommandBuilder} = require("discord.js");
const {checkMusicPermissions} = require("../utils/music_helpers");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Adjusts the playback volume.")
    .addIntegerOption(option =>
      option.setName("level")
        .setDescription("The volume level (0-100).")
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(100)),

  async execute(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
      return interaction.reply({content: permissionCheck.message, ephemeral: true});
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
      return interaction.reply({content: "There is nothing playing right now!", ephemeral: true});
    }

    const volume = interaction.options.getInteger("level");

    try {
      queue.node.setVolume(volume);
      await interaction.reply({content: `🔊 Volume set to **${volume}%**.`});
    } catch (e) {
      await interaction.reply({content: `❌ Error: ${e.message}`});
    }
  },
  category: "Utility",
};