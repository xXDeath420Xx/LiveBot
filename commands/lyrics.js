const {SlashCommandBuilder, EmbedBuilder} = require("discord.js");
const {checkMusicPermissions} = require("../utils/music_helpers");
const axios = require("axios");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("lyrics")
    .setDescription("Gets the lyrics for the currently playing song."),

  async execute(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
      return interaction.reply({content: permissionCheck.message, ephemeral: true});
    }

    const queue = interaction.client.player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying()) {
      return interaction.reply({content: "There is nothing playing right now!", ephemeral: true});
    }

    await interaction.deferReply();

    const track = queue.currentTrack;
    // Clean up the title to improve search results
    const trackTitle = track.title.replace(/\(official.*?\)/i, "").replace(/\(feat.*?\)/i, "").trim();

    try {
      const response = await axios.get(`https://api.lyrics.ovh/v1/${track.author}/${trackTitle}`);
      const lyrics = response.data.lyrics;

      if (!lyrics) {
        return interaction.editReply({content: `❌ No lyrics found for **${track.title}**.`});
      }

      const embed = new EmbedBuilder()
        .setColor("#3498DB")
        .setAuthor({name: `Lyrics for ${track.title}`})
        .setDescription(lyrics.length > 4096 ? lyrics.substring(0, 4093) + "..." : lyrics);

      await interaction.editReply({embeds: [embed]});

    } catch (error) {
      if (error.response && error.response.status === 404) {
        return interaction.editReply({content: `❌ No lyrics found for **${track.title}**.`});
      }
      console.error("[Lyrics Command Error]", error);
      await interaction.editReply({content: "❌ An error occurred while fetching the lyrics."});
    }
  },
  category: "Music",
};