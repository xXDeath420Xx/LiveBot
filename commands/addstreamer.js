const {SlashCommandBuilder, PermissionsBitField, StringSelectMenuBuilder, ActionRowBuilder, MessageFlags} = require("discord.js");
const {getAvatarUploadChannel} = require("../utils/channel-helpers.js");
const logger = require("../utils/logger");

// This map will temporarily store the initial command data
const pendingInteractions = new Map();

// Define a constant for the timeout duration for better readability
const INTERACTION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

module.exports = {
  data: new SlashCommandBuilder()
    .setName("addstreamer")
    .setDescription("Adds a streamer to the notification list using an interactive form.")
    .addStringOption(option =>
      option.setName("username")
        .setDescription("The streamer\'s username or channel ID. Must be the same on all chosen platforms.")
        .setRequired(true))
    .addUserOption(option =>
      option.setName("user")
        .setDescription("Optional: Link a Discord user to receive the Live Role.")
        .setRequired(false))
    .addAttachmentOption(option =>
      option.setName("avatar")
        .setDescription("Optional: A custom avatar for this streamer\'s webhook announcements.")
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName("youtube-vod-notifications")
        .setDescription("Enable notifications for new YouTube VODs.")
        .setRequired(false))
    .addBooleanOption(option =>
      option.setName("tiktok-vod-notifications")
        .setDescription("Enable notifications for new TikTok VODs.")
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  async execute(interaction) {
    await interaction.deferReply({flags: [MessageFlags.Ephemeral]});

    const username = interaction.options.getString("username");
    const discordUser = interaction.options.getUser("user");
    const avatar = interaction.options.getAttachment("avatar");
    const youtubeVODs = interaction.options.getBoolean("youtube-vod-notifications") ?? false;
    const tiktokVODs = interaction.options.getBoolean("tiktok-vod-notifications") ?? false;

    let avatarUrl = null;
    if (avatar) {
      if (!avatar.contentType?.startsWith("image/")) {
        return interaction.editReply({content: "The provided avatar must be an image file (PNG, JPG, GIF)."});
      }

      const uploadChannel = await getAvatarUploadChannel(interaction);
      if (!uploadChannel) {
        return;
      } // Error is handled by the helper function

      try {
        const tempMessage = await uploadChannel.send({files: [{attachment: avatar.url, name: avatar.name}]});
        avatarUrl = tempMessage.attachments.first().url;
      } catch (uploadError) {
        logger.error("[Add Streamer Command] Error uploading temporary avatar to Discord:", {error: uploadError});
        return interaction.editReply({content: `Failed to upload custom avatar: ${uploadError.message || "An unknown error occurred"}.`});
      }
    }

    const interactionId = interaction.id;
    pendingInteractions.set(interactionId, {
      username,
      discordUserId: discordUser?.id || null,
      avatarUrl,
      guildId: interaction.guild.id,
      youtubeVODs,
      tiktokVODs
    });

    setTimeout(() => pendingInteractions.delete(interactionId), INTERACTION_TIMEOUT_MS);

    const platformSelect = new StringSelectMenuBuilder()
      .setCustomId(`addstreamer_platforms_${interactionId}`)
      .setPlaceholder("Select the platform(s) to add this streamer on")
      .setMinValues(1)
      .setMaxValues(7)
      .addOptions([
        {label: "Twitch", value: "twitch", emoji: "🟣"},
        {label: "Kick", value: "kick", emoji: "🟢"},
        {label: "YouTube", value: "youtube", emoji: "🔴"},
        {label: "TikTok", value: "tiktok", emoji: "⚫"},
        {label: "Trovo", value: "trovo", emoji: "🟢"},
        {label: "Facebook", value: "facebook", emoji: "🔵"},
        {label: "Instagram", value: "instagram", emoji: "📸"}
      ]);

    const row = new ActionRowBuilder().addComponents(platformSelect);

    await interaction.editReply({
      content: `Adding streamer \`${username}\`. Please select the platforms below to continue.`,
      components: [row]
    });
  },
  pendingInteractions
};