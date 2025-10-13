const {SlashCommandBuilder} = require("discord.js");
const {checkMusicPermissions} = require("../utils/music_helpers");
const {QueueRepeatMode} = require("discord-player");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Sets the loop mode for the music player.")
    .addIntegerOption(option =>
      option.setName("mode")
        .setDescription("The loop mode to set.")
        .setRequired(true)
        .addChoices(
          {name: "Off", value: QueueRepeatMode.OFF},
          {name: "Track", value: QueueRepeatMode.TRACK},
          {name: "Queue", value: QueueRepeatMode.QUEUE},
          {name: "Autoplay", value: QueueRepeatMode.AUTOPLAY},
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

    const loopMode = interaction.options.getInteger("mode");

    try {
      queue.setRepeatMode(loopMode);
      const modeName = Object.keys(QueueRepeatMode).find(key => QueueRepeatMode[key] === loopMode);
      await interaction.reply({content: `🔄 Loop mode set to **${modeName}**.`});
    } catch (e) {
      await interaction.reply({content: `❌ Error: ${e.message}`});
    }
  },
  category: "Music",
};