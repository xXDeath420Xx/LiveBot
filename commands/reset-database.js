const {SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder} = require("discord.js");
require("dotenv").config(); // Ensure dotenv is loaded

module.exports = {
  data: new SlashCommandBuilder()
    .setName("reset-database")
    .setDescription("Wipes the entire bot database (Bot Owner Only).")
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
      .setTitle("⚠️ CRITICAL: Database Reset Confirmation")
      .setDescription(
        "This is an **EXTREMELY DESTRUCTIVE** action that will completely wipe all bot data.\n\n"
        + "**This will:**\n"
        + "- Delete ALL subscriptions, streamers, guilds, and teams from the database.\n"
        + "- Reset the bot to a fresh state, as if it was just installed.\n\n"
        + "**This action is irreversible.** Only proceed if you are absolutely certain."
      )
      .setColor(0xFF0000) // Red for critical warning
      .setFooter({text: "Please confirm you want to proceed."});

    const confirmButton = new ButtonBuilder()
      .setCustomId("confirm_reset_database")
      .setLabel("I understand, wipe the entire database")
      .setStyle(ButtonStyle.Danger);

    const cancelButton = new ButtonBuilder()
      .setCustomId("cancel_reset_database")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

    await interaction.reply({
      embeds: [embed],
      components: [row],
      ephemeral: true
    });
  },
  category: "Super Admin",
};
