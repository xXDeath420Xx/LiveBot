const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder, ChannelType} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("customize-streamer")
    .setDescription("Sets a custom name, avatar, or message for a specific streamer's announcements.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addStringOption(option =>
      option.setName("platform")
        .setDescription("The platform of the streamer to customize.")
        .setRequired(true)
        .addChoices(
          {name: "Twitch", value: "twitch"}, {name: "Kick", value: "kick"},
          {name: "YouTube", value: "youtube"}, {name: "TikTok", value: "tiktok"},
          {name: "Trovo", value: "trovo"}
        ))
    .addStringOption(option => option.setName("username").setDescription("The username of the streamer to customize.").setRequired(true))
    .addChannelOption(option =>
      option.setName("channel")
        .setDescription("The specific channel to customize. Leave blank for the server default channel.")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false))
    .addStringOption(option => option.setName("nickname").setDescription("Custom name for announcements (max 80 chars). Type \"reset\" to clear.").setMaxLength(80))
    .addAttachmentOption(option =>
      option.setName("avatar").setDescription("Custom avatar for announcements (upload file)."))
    .addStringOption(option =>
      option.setName("avatar_url_text").setDescription("Custom avatar URL (overrides file upload). Type \"reset\" to clear."))
    .addStringOption(option => option.setName("message").setDescription("Custom message. Placeholders: {username}, {url}, etc. Type \"reset\" to clear.")),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});

    const platform = interaction.options.getString("platform");
    const username = interaction.options.getString("username");
    const channel = interaction.options.getChannel("channel");
    const targetChannelId = channel ? channel.id : null;

    const newNickname = interaction.options.getString("nickname");
    const newAvatarAttachment = interaction.options.getAttachment("avatar");
    const newAvatarUrlText = interaction.options.getString("avatar_url_text");
    const newMessage = interaction.options.getString("message");

    if (newNickname === null && newAvatarAttachment === null && newAvatarUrlText === null && newMessage === null) {
      return interaction.editReply("You must provide at least one item to customize (nickname, avatar, or message).");
    }

    let finalAvatarUrl = undefined;

    try {
      if (newAvatarUrlText !== null) {
        const lowerCaseText = newAvatarUrlText.toLowerCase();
        if (lowerCaseText === "reset" || lowerCaseText === "") {
          finalAvatarUrl = null;
        } else {
          if (!/^https?:\/\//.test(newAvatarUrlText)) {
            return interaction.editReply("The provided avatar URL must start with `http://` or `https://`.");
          }
          finalAvatarUrl = newAvatarUrlText;
        }
      } else if (newAvatarAttachment) {
        if (!newAvatarAttachment.contentType?.startsWith("image/")) {
          return interaction.editReply({content: "Avatar must be an image file (PNG, JPG, GIF)."});
        }
        const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
        if (!tempUploadChannelId) {
          logger.error("[Customize Streamer Command] TEMP_UPLOAD_CHANNEL_ID is not configured.");
          return interaction.editReply({content: "Temporary upload channel ID is not configured. Please set TEMP_UPLOAD_CHANNEL_ID in your .env file."});
        }
        try {
          const tempChannel = await interaction.client.channels.fetch(tempUploadChannelId);
          if (!tempChannel) {
            return interaction.editReply({content: "Temporary upload channel not found. Check TEMP_UPLOAD_CHANNEL_ID in .env."});
          }
          const tempMessage = await tempChannel.send({files: [{attachment: newAvatarAttachment.url, name: newAvatarAttachment.name}]});
          finalAvatarUrl = tempMessage.attachments.first().url;
        } catch (uploadError) {
          logger.error("[Customize Streamer Command] Error uploading temporary avatar to Discord:", uploadError);
          return interaction.editReply({content: "Failed to upload custom avatar. Please check bot\'s permissions or TEMP_UPLOAD_CHANNEL_ID."});
        }
      }

      const [[streamer]] = await db.execute("SELECT s.streamer_id FROM streamers s WHERE s.platform = ? AND s.username = ?", [platform, username]);
      if (!streamer) {
        return interaction.editReply(`Streamer \`${username}\` (${platform}) was not found.`);
      }

      const [[subscription]] = await db.execute("SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ? AND announcement_channel_id <=> ?", [interaction.guild.id, streamer.streamer_id, targetChannelId]);
      if (!subscription) {
        const channelName = channel ? `in ${channel}` : "in the default channel";
        return interaction.editReply(`That streamer is not configured to announce ${channelName}.`);
      }

      const updates = [];
      const values = [];

      if (newNickname !== null) {
        updates.push("override_nickname = ?");
        values.push(newNickname?.toLowerCase() === "reset" ? null : newNickname);
      }
      if (finalAvatarUrl !== undefined) {
        updates.push("override_avatar_url = ?");
        values.push(finalAvatarUrl);
      }
      if (newMessage !== null) {
        updates.push("custom_message = ?");
        values.push(newMessage?.toLowerCase() === "reset" ? null : newMessage);
      }

      if (updates.length === 0) {
        return interaction.editReply("No changes were made.");
      }

      values.push(interaction.guild.id, streamer.streamer_id, targetChannelId);

      await db.execute(`UPDATE subscriptions SET ${updates.join(", ")} WHERE guild_id = ? AND streamer_id = ? AND announcement_channel_id <=> ?`, values);

      const embed = new EmbedBuilder()
        .setColor("#57F287")
        .setTitle(`Customization updated for ${username}`)
        .setDescription(`Settings for announcements ${channel ? `in ${channel}` : "in the server default channel"} have been updated.`);

      if (finalAvatarUrl) {
        embed.setThumbnail(finalAvatarUrl);
      }

      await interaction.editReply({embeds: [embed]});

    } catch (error) {
      logger.error("[Customize Streamer Error]", error);
      await interaction.editReply(`An error occurred while updating the streamer customization: ${error.message}`);
    }
  },
  category: "Streamer Management",
};