const {SlashCommandBuilder, PermissionsBitField, ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder} = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("reinit")
    .setDescription("Purges all announcements and re-validates roles for this server.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  async execute(interaction) {

    const embed = new EmbedBuilder()
      .setTitle("⚠️ Server Reinitialization Confirmation")
      .setDescription(
        "This is a destructive action that will purge this server's announcement data from the bot.\n\n"
        + "**This will:**\n"
        + "- Delete ALL of the bot's active announcement messages from your channels.\n"
        + "- Remove all of this server's announcements from the database.\n"
        + "- Remove any active live roles from members in this server.\n"
        + "- Validate all configured 'Live Roles' and remove any that are invalid.\n\n"
        + "This action cannot be undone. The bot will automatically post new announcements for any currently live streamers on its next cycle."
      )
      .setColor(0xFFCC00) // Yellow for warning
      .setFooter({text: "Please confirm you want to proceed."});

    const confirmButton = new ButtonBuilder()
      .setCustomId("confirm_reinit")
      .setLabel("I understand, reinitialize this server")
      .setStyle(ButtonStyle.Danger);

    const cancelButton = new ButtonBuilder()
      .setCustomId("cancel_reinit")
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