const {SlashCommandBuilder, PermissionsBitField, ChannelType, EmbedBuilder} = require("discord.js");
const db = require("../utils/db");
const axios = require("axios");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("youtube-feed")
    .setDescription("Manage YouTube upload notifications.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addSubcommand(subcommand =>
      subcommand
        .setName("add")
        .setDescription("Get notifications for a new YouTube channel.")
        .addStringOption(option => option.setName("youtube-channel-id").setDescription("The ID of the YouTube channel (e.g., UC-lHJZR3Gqxm24_Vd_AJ5Yw).").setRequired(true))
        .addChannelOption(option => option.setName("discord-channel").setDescription("The Discord channel to post updates in.").addChannelTypes(ChannelType.GuildText).setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("remove")
        .setDescription("Removes a YouTube feed.")
        .addStringOption(option => option.setName("youtube-channel-id").setDescription("The ID of the channel to remove.").setRequired(true).setAutocomplete(true))
        .addChannelOption(option => option.setName("discord-channel").setDescription("The Discord channel the feed is in.").addChannelTypes(ChannelType.GuildText).setRequired(true))
    ),

  async autocomplete(interaction) {
    const focusedValue = interaction.options.getFocused();
    const [feeds] = await db.execute("SELECT DISTINCT youtube_channel_id, channel_name FROM youtube_feeds WHERE guild_id = ? AND (youtube_channel_id LIKE ? OR channel_name LIKE ?)", [interaction.guild.id, `${focusedValue}%`, `%${focusedValue}%`]);
    await interaction.respond(feeds.map(feed => ({name: `${feed.channel_name || "Unknown"} (${feed.youtube_channel_id})`, value: feed.youtube_channel_id})));
  },

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    try {
      if (subcommand === "add") {
        const youtubeChannelId = interaction.options.getString("youtube-channel-id");
        const discordChannel = interaction.options.getChannel("discord-channel");

        // Basic validation
        if (!youtubeChannelId.startsWith("UC")) {
          return interaction.editReply("❌ That doesn't look like a valid YouTube Channel ID. It should start with \"UC\".");
        }

        await db.execute("INSERT INTO youtube_feeds (guild_id, youtube_channel_id, discord_channel_id) VALUES (?, ?, ?)", [guildId, youtubeChannelId, discordChannel.id]);
        await interaction.editReply(`✅ Successfully created a feed for the YouTube channel \`${youtubeChannelId}\` in ${discordChannel}. The first video will be posted on the next upload.`);
      } else if (subcommand === "remove") {
        const youtubeChannelId = interaction.options.getString("youtube-channel-id");
        const discordChannel = interaction.options.getChannel("discord-channel");
        const [result] = await db.execute("DELETE FROM youtube_feeds WHERE guild_id = ? AND youtube_channel_id = ? AND discord_channel_id = ?", [guildId, youtubeChannelId, discordChannel.id]);

        if (result.affectedRows > 0) {
          await interaction.editReply(`🗑️ Removed the YouTube feed for \`${youtubeChannelId}\` from ${discordChannel}.`);
        } else {
          await interaction.editReply("❌ No feed found for that YouTube channel in that Discord channel.");
        }
      }
    } catch (error) {
      console.error("[YouTube Feed Command Error]", error);
      if (error.code === "ER_DUP_ENTRY") {
        await interaction.editReply("A feed for that YouTube channel in that Discord channel already exists.");
      } else {
        await interaction.editReply("An error occurred while managing YouTube feeds.");
      }
    }
  },
};