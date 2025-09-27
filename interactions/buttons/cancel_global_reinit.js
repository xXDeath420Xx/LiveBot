const BOT_OWNER_ID = process.env.BOT_OWNER_ID || "365905620060340224";

module.exports = {
  customId: "cancel_global_reinit",
  async execute(interaction) {
    if (interaction.user.id !== BOT_OWNER_ID) {
      return interaction.reply({
        content: "You do not have permission to use this button.",
        ephemeral: true,
      });
    }
    await interaction.reply({ content: "Global bot re-initialization cancelled.", ephemeral: true });
  },
};