const {ChannelSelectMenuBuilder, ActionRowBuilder, PermissionsBitField, ChannelType} = require("discord.js");

module.exports = {
  customId: /^approve_request_/,
  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({content: "You do not have permission to approve requests.", ephemeral: true});
    }
    const parts = interaction.customId.split("_");
    const requestingUserId = parts[2];
    const serializedData = parts.slice(3).join("_");

    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId(`approve_channels_${requestingUserId}_${interaction.channelId}_${interaction.message.id}_${serializedData}`)
      .setPlaceholder("Select announcement channels for this user.")
      .setMinValues(1)
      .setMaxValues(25)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

    const row = new ActionRowBuilder().addComponents(channelSelect);
    await interaction.reply({content: "Please select the channel(s) to add this streamer to:", components: [row], ephemeral: true});
  },
};