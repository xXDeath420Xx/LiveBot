const {SlashCommandBuilder, EmbedBuilder} = require("discord.js");
const {checkMusicPermissions} = require("../utils/music_helpers");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("Displays information about the currently playing song."),

  async execute(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
      return interaction.reply({content: permissionCheck.message, ephemeral: true});
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
      return interaction.reply({content: "There is nothing playing right now!", ephemeral: true});
    }

    const track = queue.currentTrack;
    const progress = queue.node.createProgressBar();

    const embed = new EmbedBuilder()
      .setColor("#57F287")
      .setAuthor({name: "Now Playing"})
      .setTitle(track.title)
      .setURL(track.url)
      .setThumbnail(track.thumbnail)
      .addFields(
        {name: "Channel", value: track.author, inline: true},
        {name: "Duration", value: track.duration, inline: true},
        {name: "Requested by", value: `${track.requestedBy.tag}`, inline: true},
        {name: "Progress", value: progress, inline: false}
      );

    await interaction.reply({embeds: [embed]});
  },
  category: "Music",
};