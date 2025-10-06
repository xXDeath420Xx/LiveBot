const {ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder} = require("discord.js");
const {pendingInteractions} = require("../../pending-interactions");

module.exports = {
  customId: /^addstreamer_platforms_/,
  async execute(interaction) {
    const interactionId = interaction.customId.split("_")[2];
    const initialData = pendingInteractions.get(interactionId);
    if (!initialData) {
      return interaction.update({content: "This interaction has expired. Please run the command again.", components: []});
    }

    initialData.platforms = interaction.values;
    const modal = new ModalBuilder().setCustomId(`addstreamer_details_${interactionId}`).setTitle(`Details for ${initialData.username}`);
    
    const rows = [
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("channels").setLabel("Channel IDs (comma-separated, optional)").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("Leave blank for current channel")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("nickname").setLabel("Custom Webhook Name (Optional)").setStyle(TextInputStyle.Short).setRequired(false)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("message").setLabel("Custom Message (Optional)").setStyle(TextInputStyle.Paragraph).setRequired(false))
    ];

    if (interaction.values.includes('youtube')) {
        rows.push(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('youtube_vods').setLabel('Post YouTube VODs? (yes/no)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('no')));
    }
    
    if (interaction.values.includes('tiktok')) {
        rows.push(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tiktok_vods').setLabel('Post TikTok VODs? (yes/no)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('no')));
    }

    modal.addComponents(...rows);
    await interaction.showModal(modal);
  },
};