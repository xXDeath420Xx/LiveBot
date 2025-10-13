const {SlashCommandBuilder, PermissionsBitField, ChannelType, EmbedBuilder} = require("discord.js");
const db = require("../utils/db");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("welcome")
    .setDescription("Configure the welcome message and banner for new members.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addChannelOption(option =>
      option.setName("channel")
        .setDescription("The channel where welcome messages will be sent.")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true))
    .addStringOption(option =>
      option.setName("message")
        .setDescription("The welcome message. Use {user} for mention and {server} for server name."))
    .addBooleanOption(option =>
      option.setName("enable-banner")
        .setDescription("Enable or disable the welcome banner image (default: false)."))
    .addAttachmentOption(option =>
      option.setName("background")
        .setDescription("Upload a custom background for the welcome banner.")),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});

    const channel = interaction.options.getChannel("channel");
    const message = interaction.options.getString("message") || "Welcome {user} to {server}!";
    const bannerEnabled = interaction.options.getBoolean("enable-banner") || false;
    const background = interaction.options.getAttachment("background");
    const guildId = interaction.guild.id;

    let backgroundUrl = null;
    if (background) {
      if (!background.contentType.startsWith("image/")) {
        return interaction.editReply({content: "Background must be an image file (PNG, JPG, GIF)."});
      }
      backgroundUrl = background.url;
    }

    try {
      await db.execute(
        `INSERT INTO welcome_settings (guild_id, channel_id, message, banner_enabled, banner_background_url)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           channel_id = VALUES(channel_id),
           message = VALUES(message),
           banner_enabled = VALUES(banner_enabled),
           banner_background_url = IF(VALUES(banner_background_url) IS NOT NULL, VALUES(banner_background_url), banner_background_url)`,
        [guildId, channel.id, message, bannerEnabled, backgroundUrl]
      );

      const embed = new EmbedBuilder()
        .setColor("#57F287")
        .setTitle("✅ Welcome Settings Updated")
        .setDescription(`Welcome messages will now be sent to ${channel}.`)
        .addFields(
          {name: "Banner Enabled", value: bannerEnabled ? "Yes" : "No", inline: true},
          {name: "Message", value: message, inline: false}
        );

      if (backgroundUrl) {
        embed.setImage(backgroundUrl);
      }

      await interaction.editReply({embeds: [embed]});

    } catch (error) {
      console.error("[Welcome Command Error]", error);
      await interaction.editReply({content: "An error occurred while saving the welcome settings."});
    }
  },
  category: "Utility",
};