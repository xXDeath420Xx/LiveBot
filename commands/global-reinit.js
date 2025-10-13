const {SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder} = require("discord.js");
require("dotenv").config(); // Ensure dotenv is loaded

module.exports = {
  data: new SlashCommandBuilder()
    .setName("global-reinit")
    .setDescription("Restarts the entire bot application (Bot Owner Only).")
    .setDefaultMemberPermissions(0), // Only accessible by owner

  async execute(interaction) {
    const BOT_OWNER_ID = process.env.BOT_OWNER_ID; // Load from environment variable

    if (!BOT_OWNER_ID) {
      return interaction.reply({content: "Bot owner ID is not configured. Please set BOT_OWNER_ID in your .env file.", ephemeral: true});
    }

    if (interaction.user.id !== BOT_OWNER_ID) {
      return interaction.reply({content: "You do not have permission to use this command.", ephemeral: true});
    }

    const embed = new EmbedBuilder()
      .setTitle("⚠️ Global Bot Reinitialization Confirmation")
      .setDescription(
        "This action will restart the entire bot application. This will cause a brief downtime for all guilds.\n\n"
        + "**This will:**\n"
        + "- Restart the bot process (via PM2).\n"
        + "- Temporarily disconnect the bot from all Discord guilds.\n"
        + "- Clear any in-memory caches.\n\n"
        + "This action cannot be undone once confirmed. Only proceed if you understand the implications."
      )
      .setColor(0xFFCC00) // Yellow for warning
      .setFooter({text: "Please confirm you want to proceed."});

    const confirmButton = new ButtonBuilder()
      .setCustomId("confirm_global_reinit")
      .setLabel("I understand, restart the bot globally")
      .setStyle(ButtonStyle.Danger);

    const cancelButton = new ButtonBuilder()
      .setCustomId("cancel_global_reinit")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

    await interaction.reply({
      embeds: [embed],
      components: [row],
      ephemeral: true
    });
  },
  category: "Utility",
};