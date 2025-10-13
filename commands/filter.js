const {SlashCommandBuilder} = require("discord.js");
const {checkMusicPermissions} = require("../utils/music_helpers");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("filter")
    .setDescription("Applies an audio filter to the music.")
    .addStringOption(option =>
      option.setName("filter")
        .setDescription("The filter to apply or remove.")
        .setRequired(true)
        .addChoices(
          // You can add all available filters here
          {name: "Bassboost", value: "bassboost"},
          {name: "Nightcore", value: "nightcore"},
          {name: "Vaporwave", value: "vaporwave"},
          {name: "8D", value: "8D"},
          {name: "Treble", value: "treble"},
          {name: "Normalizer", value: "normalizer"}
        ))
    .addStringOption(option =>
      option.setName("action")
        .setDescription("Whether to enable or disable the filter.")
        .setRequired(true)
        .addChoices(
          {name: "Enable", value: "enable"},
          {name: "Disable", value: "disable"}
        )),

  async execute(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
      return interaction.reply({content: permissionCheck.message, ephemeral: true});
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
      return interaction.reply({content: "There is nothing playing right now!", ephemeral: true});
    }

    const filterName = interaction.options.getString("filter");
    const action = interaction.options.getString("action");

    try {
      if (action === "enable") {
        queue.filters.ffmpeg.toggle(filterName);
        await interaction.reply({content: `✅ **${filterName}** filter enabled.`});
      } else {
        queue.filters.ffmpeg.toggle(filterName);
        await interaction.reply({content: `❌ **${filterName}** filter disabled.`});
      }
    } catch (e) {
      await interaction.reply({content: `❌ Error: ${e.message}`});
    }
  },
  category: "Utility",
};