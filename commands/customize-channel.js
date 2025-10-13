const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder, ChannelType} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("customize-channel")
    .setDescription("Sets a default webhook appearance for all announcements in a specific channel.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addChannelOption(option =>
      option.setName("channel")
        .setDescription("The channel to customize.")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true))
    .addStringOption(option => option.setName("nickname").setDescription("Default name for announcements in this channel. Type \"reset\" to clear."))
    .addAttachmentOption(option => option.setName("avatar").setDescription("Default avatar for announcements in this channel (upload file)."))
    .addStringOption(option => option.setName("avatar_url_text").setDescription("Default avatar URL (overrides file upload). Type \"reset\" to clear.")),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});

    const channel = interaction.options.getChannel("channel");
    const newNickname = interaction.options.getString("nickname");
    const newAvatarAttachment = interaction.options.getAttachment("avatar");
    const newAvatarUrlText = interaction.options.getString("avatar_url_text");

    if (newNickname === null && newAvatarAttachment === null && newAvatarUrlText === null) {
      return interaction.editReply("You must provide a nickname, an avatar file, or an avatar URL to set/reset.");
    }

    let finalAvatarUrl = undefined;

    try {
      if (newAvatarAttachment) {
        if (!newAvatarAttachment.contentType?.startsWith("image/")) {
          return interaction.editReply({content: "Avatar must be an image file (PNG, JPG, GIF)."});
        }
        const tempUploadChannelId = process.env.TEMP_UPLOAD_CHANNEL_ID;
        if (!tempUploadChannelId) {
          logger.error("[Customize Channel Command] TEMP_UPLOAD_CHANNEL_ID is not configured.");
          return interaction.editReply({content: "Temporary upload channel ID is not configured. Please set TEMP_UPLOAD_CHANNEL_ID in your .env file."});
        }
        try {
          const tempChannel = await interaction.client.channels.fetch(tempUploadChannelId);
          if (!tempChannel) {
            throw new Error("Temporary upload channel not found.");
          }
          const tempMessage = await tempChannel.send({files: [{attachment: newAvatarAttachment.url, name: newAvatarAttachment.name}]});
          finalAvatarUrl = tempMessage.attachments.first().url;
        } catch (uploadError) {
          logger.error("[Customize Channel Command] Error uploading temporary avatar to Discord:", uploadError);
          return interaction.editReply({content: "Failed to upload custom avatar. Please check bot\'s permissions or TEMP_UPLOAD_CHANNEL_ID."});
        }
      } else if (newAvatarUrlText !== null) {
        if (newAvatarUrlText?.toLowerCase() === "reset" || newAvatarUrlText === "") {
          finalAvatarUrl = null;
        } else {
          if (!/^https?:\/\//.test(newAvatarUrlText)) {
            return interaction.editReply("The provided avatar URL must start with `http://` or `https://`.");
          }
          finalAvatarUrl = newAvatarUrlText;
        }
      }

      const insertColumns = ["channel_id", "guild_id"];
      const insertPlaceholders = ["?", "?"];
      const insertValues = [channel.id, interaction.guild.id];
      const updateClauses = [];
      const updateValuesForDuplicateKey = [];

      if (newNickname !== null) {
        insertColumns.push("override_nickname");
        insertPlaceholders.push("?");
        const nicknameToSet = newNickname?.toLowerCase() === "reset" ? null : newNickname;
        insertValues.push(nicknameToSet);
        updateClauses.push("override_nickname = ?");
        updateValuesForDuplicateKey.push(nicknameToSet);
      }

      if (finalAvatarUrl !== undefined) {
        insertColumns.push("override_avatar_url");
        insertPlaceholders.push("?");
        insertValues.push(finalAvatarUrl);
        updateClauses.push("override_avatar_url = ?");
        updateValuesForDuplicateKey.push(finalAvatarUrl);
      }

      await db.execute(
        `INSERT INTO channel_settings (${insertColumns.join(", ")}) 
             VALUES (${insertPlaceholders.join(", ")}) 
             ON DUPLICATE KEY UPDATE ${updateClauses.join(", ")}`,
        [...insertValues, ...updateValuesForDuplicateKey]
      );

      const embed = new EmbedBuilder().setColor("#57F287").setTitle(`Channel Customization Updated for #${channel.name}`);
      let description = "";

      if (newNickname?.toLowerCase() === "reset") {
        description += `Nickname has been reset to default.\n`;
      } else if (newNickname) {
        description += `Nickname set to: **${newNickname}**\n`;
      }
      if (finalAvatarUrl === null) {
        description += `Avatar has been reset to default.\n`;
      } else if (finalAvatarUrl !== undefined) {
        description += `Avatar has been updated.\n`;
      }

      embed.setDescription(description.trim());
      if (finalAvatarUrl) {
        embed.setThumbnail(finalAvatarUrl);
      }

      await interaction.editReply({embeds: [embed]});

    } catch (error) {
      logger.error("[Customize Channel Error]", error);
      await interaction.editReply(`An error occurred while updating the channel customization: ${error.message}.`);
    }
  }
};