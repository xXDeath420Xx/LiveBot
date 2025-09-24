const {SlashCommandBuilder, PermissionsBitField, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle} = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("setup-requests")
    .setDescription("Creates the panel for users to request live announcements.")
    .addChannelOption(option =>
      option.setName("panel-channel")
        .setDescription("The channel where the request panel will be posted.")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true))
    .addChannelOption(option =>
      option.setName("requests-channel")
        .setDescription("The channel where the bot will post the requests for approval.")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

  async execute(interaction) {
    const panelChannel = interaction.options.getChannel("panel-channel");
    const requestsChannel = interaction.options.getChannel("requests-channel");

    if (!panelChannel || !requestsChannel) {
      return interaction.reply({
        content: "❌ Could not resolve one or both of the channels. Please make sure I have permissions to view both channels and try again.",
        ephemeral: true,
      });
    }

    const embed = new EmbedBuilder()
      .setColor("#5865F2")
      .setTitle("Request Live Stream Announcements")
      .setDescription("Click the button below to open a form and add your stream to the announcement list for this server.")
      .setFooter({text: "CertiFried Announcer | User Requests"});

    const requestButton = new ButtonBuilder()
      .setCustomId(`request_announcement_button_${requestsChannel.id}`)
      .setLabel("Request Announcements")
      .setStyle(ButtonStyle.Success)
      .setEmoji("📡");

    const row = new ActionRowBuilder().addComponents(requestButton);

    try {
      await panelChannel.send({embeds: [embed], components: [row]});
      await interaction.reply({
        content: `✅ Successfully posted the request panel in ${panelChannel} and requests will be sent to ${requestsChannel}.`,
        ephemeral: true
      });
    } catch (error) {
      console.error("Failed to post request panel:", error);
      await interaction.reply({
        content: `❌ Could not post the panel in ${panelChannel}. Please ensure I have permissions to send messages and embeds there.`,
        ephemeral: true
      });
    }
  },
};