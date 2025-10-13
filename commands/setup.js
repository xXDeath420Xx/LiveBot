const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle} = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Starts an interactive setup guide for the bot.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setColor("#5865F2")
      .setTitle("👋 Welcome to the LiveBot Setup Guide!")
      .setDescription("This interactive guide will walk you through the essential steps to get the bot up and running on your server.\n\nClick the **Start Setup** button below to begin.");

    const startButton = new ButtonBuilder()
      .setCustomId(`setup_start_${interaction.user.id}`)
      .setLabel("Start Setup")
      .setStyle(ButtonStyle.Primary);

    const cancelButton = new ButtonBuilder()
      .setCustomId(`setup_cancel_${interaction.user.id}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(startButton, cancelButton);

    await interaction.reply({embeds: [embed], components: [row], ephemeral: true});
  },
  category: "Utility",
};