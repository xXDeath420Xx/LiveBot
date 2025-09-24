const {StringSelectMenuBuilder, ActionRowBuilder, MessageFlags} = require("discord.js");

module.exports = {
  customId: /^request_announcement_button_/,
  async execute(interaction) {
    const requestsChannelId = interaction.customId.split("_")[3];
    const platformSelect = new StringSelectMenuBuilder()
      .setCustomId(`request_platforms_${requestsChannelId}`)
      .setPlaceholder("Select the platform(s) you stream on")
      .setMinValues(1)
      .setMaxValues(5)
      .addOptions([
        {label: "Twitch", value: "twitch", emoji: "🟣"},
        {label: "Kick", value: "kick", emoji: "🟢"},
        {label: "YouTube", value: "youtube", emoji: "🔴"},
        {label: "TikTok", value: "tiktok", emoji: "⚫"},
        {label: "Trovo", value: "trovo", emoji: "🟢"},
      ]);
    const row = new ActionRowBuilder().addComponents(platformSelect);
    await interaction.reply({content: "Please select all platforms you would like to be announced for.", components: [row], flags: [MessageFlags.Ephemeral]});
  },
};