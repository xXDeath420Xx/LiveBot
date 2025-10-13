const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder, ChannelType} = require("discord.js");
const db = require("../utils/db");
const {getTikTokUser} = require("../utils/api_checks.js");
const {logAuditEvent} = require("../utils/audit-log.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("tiktok")
    .setDescription("Manage TikTok live announcements.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addSubcommand(subcommand =>
      subcommand
        .setName("add")
        .setDescription("Announce new livestreams from a TikTok user.")
        .addStringOption(option => option.setName("username").setDescription("The username of the TikTok user.").setRequired(true))
        .addChannelOption(option => option.setName("channel").setDescription("The Discord channel to post announcements in.").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addStringOption(option => option.setName("custom_message").setDescription("Optional: Use {stream_title}, {stream_url}, {channel_name}."))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("remove")
        .setDescription("Stop announcing new livestreams from a TikTok user.")
        .addStringOption(option => option.setName("username").setDescription("The username of the TikTok user to remove.").setRequired(true).setAutocomplete(true))
    ),

  async autocomplete(interaction) {
    if (interaction.options.getSubcommand() === "remove") {
      const focusedValue = interaction.options.getFocused();
      const [subscriptions] = await db.execute(
        `SELECT s.username
                 FROM subscriptions sub
                 JOIN streamers s ON sub.streamer_id = s.streamer_id
                 WHERE sub.guild_id = ? AND s.platform = 'tiktok'`,
        [interaction.guild.id]
      );
      const filtered = subscriptions.filter(sub => sub.username.toLowerCase().includes(focusedValue.toLowerCase()));
      await interaction.respond(filtered.map(sub => ({name: sub.username, value: sub.username})));
    }
  },

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    try {
      if (subcommand === "add") {
        const username = interaction.options.getString("username");
        const discordChannel = interaction.options.getChannel("channel");
        const customMessage = interaction.options.getString("custom_message");

        const tiktokUser = await getTikTokUser(username);
        if (!tiktokUser || !tiktokUser.userId) {
          return interaction.editReply({content: "Could not find a TikTok user with that username. Please check the name and try again."});
        }

        // Insert/update the streamer in the `streamers` table
        await db.execute(
          "INSERT INTO streamers (platform, platform_user_id, username, profile_image_url) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE username = VALUES(username), profile_image_url = VALUES(profile_image_url)",
          ["tiktok", tiktokUser.userId, tiktokUser.username, tiktokUser.profileImageUrl]
        );

        // Get the streamer_id
        const [[streamer]] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?", ["tiktok", tiktokUser.userId]);
        if (!streamer) {
          return interaction.editReply({content: "There was an error adding the streamer to the database."});
        }

        // Insert into the `subscriptions` table
        await db.execute(
          "INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, custom_message) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE announcement_channel_id = VALUES(announcement_channel_id), custom_message = VALUES(custom_message)",
          [guildId, streamer.streamer_id, discordChannel.id, customMessage || null]
        );

        await logAuditEvent(interaction, "TikTok Subscription Added", `Started announcing new livestreams from **${tiktokUser.username}** in ${discordChannel}.`);
        await interaction.editReply({embeds: [new EmbedBuilder().setColor("#57F287").setTitle("✅ TikTok User Added").setDescription(`I will now announce new livestreams from **${tiktokUser.username}** in ${discordChannel}.`)]});

      } else if (subcommand === "remove") {
        const username = interaction.options.getString("username");

        // Find the streamer_id
        const [[streamer]] = await db.execute("SELECT streamer_id FROM streamers WHERE platform = ? AND username = ?", ["tiktok", username]);
        if (!streamer) {
          return interaction.editReply({content: "That TikTok user was not configured for announcements on this server."});
        }

        // Delete from subscriptions
        const [result] = await db.execute("DELETE FROM subscriptions WHERE guild_id = ? AND streamer_id = ?", [guildId, streamer.streamer_id]);

        if (result.affectedRows > 0) {
          await logAuditEvent(interaction, "TikTok Subscription Removed", `Stopped announcing new livestreams for user **${username}**.`);
          await interaction.editReply({embeds: [new EmbedBuilder().setColor("#ED4245").setTitle("✅ TikTok User Removed").setDescription(`I will no longer announce new livestreams for that TikTok user.`)]});
        } else {
          await interaction.editReply({content: "That TikTok user was not configured for announcements on this server, or was already removed."});
        }
      }
    } catch (error) {
      console.error("[TikTok Command Error]", error);
      await interaction.editReply({content: "An error occurred while processing your request."});
    }
  },
};