const {ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder} = require("discord.js");

module.exports = {
  customId: /^request_platforms_/,
  async execute(interaction) {
    const requestsChannelId = interaction.customId.split("_")[2];
    const platforms = interaction.values;
    const modal = new ModalBuilder()
      .setCustomId(`request_submit_${requestsChannelId}_${platforms.join(",")}`)
      .setTitle("Enter Your Usernames");
    platforms.forEach(platform => {
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(`${platform}_username`)
          .setLabel(`${platform.charAt(0).toUpperCase() + platform.slice(1)} Username`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ));
    });
    await interaction.showModal(modal);
  },
};