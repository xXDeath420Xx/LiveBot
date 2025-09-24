const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder, ChannelType} = require("discord.js");
const db = require("../utils/db");
const {getYouTubeChannelId} = require("../utils/api_checks.js");
const {logAuditEvent} = require("../utils/audit-log.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("youtube")
    .setDescription("Manage YouTube video upload announcements.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addSubcommand(subcommand =>
      subcommand
        .setName("add")
        .setDescription("Announce new video uploads from a YouTube channel.")
        .addStringOption(option => option.setName("youtube_channel_id_or_url").setDescription("The ID or URL of the YouTube channel.").setRequired(true))
        .addChannelOption(option => option.setName("channel").setDescription("The Discord channel to post announcements in.").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addStringOption(option => option.setName("custom_message").setDescription("Optional custom message. Use {video_title}, {video_url}, {channel_name}.")))
    .addSubcommand(subcommand =>
      subcommand
        .setName("remove")
        .setDescription("Stop announcing new videos from a YouTube channel.")
        .addStringOption(option => option.setName("youtube_channel_id").setDescription("The ID of the YouTube channel to remove.").setRequired(true).setAutocomplete(true))),

  async autocomplete(interaction) {
    if (interaction.options.getSubcommand() === "remove") {
      const focusedValue = interaction.options.getFocused();
      const [subscriptions] = await db.execute("SELECT youtube_channel_id, channel_name FROM youtube_subscriptions WHERE guild_id = ?", [interaction.guild.id]);
      const filtered = subscriptions.filter(sub => sub.channel_name.toLowerCase().includes(focusedValue.toLowerCase()));
      await interaction.respond(filtered.map(sub => ({name: `${sub.channel_name} (${sub.youtube_channel_id})`, value: sub.youtube_channel_id})));
    }
  },

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});
    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommand === "add") {
        const youtubeIdentifier = interaction.options.getString("youtube_channel_id_or_url");
        const discordChannel = interaction.options.getChannel("channel");
        const customMessage = interaction.options.getString("custom_message");

        const youtubeChannel = await getYouTubeChannelId(youtubeIdentifier);
        if (!youtubeChannel || !youtubeChannel.channelId) {
          return interaction.editReply({content: "Could not find a YouTube channel with that ID, URL, or username."});
        }

        await db.execute(
          "INSERT INTO youtube_subscriptions (guild_id, discord_channel_id, youtube_channel_id, channel_name, custom_message) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE youtube_channel_id=VALUES(youtube_channel_id), custom_message=VALUES(custom_message)",
          [interaction.guild.id, discordChannel.id, youtubeChannel.channelId, youtubeChannel.channelName, customMessage || null]
        );

        await logAuditEvent(interaction, "YouTube Subscription Added", `Started announcing new videos from **${youtubeChannel.channelName}** in ${discordChannel}.`);
        await interaction.editReply({embeds: [new EmbedBuilder().setColor("#57F287").setTitle("✅ YouTube Channel Added").setDescription(`I will now announce new videos from **${youtubeChannel.channelName}** in ${discordChannel}.`)]});

      } else if (subcommand === "remove") {
        const youtubeChannelId = interaction.options.getString("youtube_channel_id");
        const [result] = await db.execute("DELETE FROM youtube_subscriptions WHERE guild_id = ? AND youtube_channel_id = ?", [interaction.guild.id, youtubeChannelId]);

        if (result.affectedRows > 0) {
          await logAuditEvent(interaction, "YouTube Subscription Removed", `Stopped announcing new videos for channel ID **${youtubeChannelId}**.`);
          await interaction.editReply({embeds: [new EmbedBuilder().setColor("#ED4245").setTitle("✅ YouTube Channel Removed").setDescription(`I will no longer announce new videos for that YouTube channel.`)]});
        } else {
          await interaction.editReply({content: "That YouTube channel was not configured for announcements on this server."});
        }
      }
    } catch (error) {
      console.error("[YouTube Command Error]", error);
      await interaction.editReply({content: "An error occurred while processing your request."});
    }
  },
};