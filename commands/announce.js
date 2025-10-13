const {SlashCommandBuilder, PermissionsBitField, ChannelType, EmbedBuilder} = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Sends an announcement to a specified channel.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages)
    .addChannelOption(option =>
      option.setName("channel")
        .setDescription("The channel to send the announcement to.")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName("message")
        .setDescription("The main content of the announcement.")
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName("title")
        .setDescription("An optional title for the embed.")
    )
    .addStringOption(option =>
      option.setName("color")
        .setDescription("An optional hex color for the embed (e.g., #3498DB).")
    )
    .addRoleOption(option =>
      option.setName("mention")
        .setDescription("An optional role to mention with the announcement.")
    ),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});

    const channel = interaction.options.getChannel("channel");
    const message = interaction.options.getString("message");
    const title = interaction.options.getString("title");
    let color = interaction.options.getString("color");
    const mentionRole = interaction.options.getRole("mention");

    // Validate color input
    if (color && !/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(color)) {
      return interaction.editReply({content: "❌ Invalid color format. Please use a valid hex color code (e.g., #3498DB).", ephemeral: true});
    }

    try {
      const announcementContent = {
        content: mentionRole ? `${mentionRole}` : undefined,
      };

      if (title) {
        // If a title is provided, send as an embed
        const embed = new EmbedBuilder()
          .setTitle(title)
          .setDescription(message)
          .setColor(color || "#5865F2") // Default color if none provided or invalid
          .setTimestamp();

        announcementContent.embeds = [embed];
      } else {
        // Otherwise, send as a plain message
        announcementContent.content = `${announcementContent.content || ""} ${message}`.trim();
      }

      await channel.send(announcementContent);

      await interaction.editReply(`✅ Announcement successfully sent to ${channel}.`);

    } catch (error) {
      console.error("[Announce Command Error]", error);
      await interaction.editReply("Failed to send the announcement. Please check my permissions for that channel.");
    }
  },
  category: "Utility",
};