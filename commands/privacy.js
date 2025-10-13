const {SlashCommandBuilder} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("privacy")
    .setDescription("Set your personal announcement privacy preference.")
    .addStringOption(option =>
      option.setName("level")
        .setDescription("Choose your default privacy level for announcements.")
        .setRequired(true)
        .addChoices(
          {name: "Public", value: "public"},
          {name: "Members Only", value: "members"},
          {name: "Subscribers Only", value: "subscribers"}
        )),
  async execute(interaction) {
    const userId = interaction.user.id;
    const privacyLevel = interaction.options.getString("level");

    try {
      await db.execute(
        "INSERT INTO user_preferences (discord_user_id, privacy_level) VALUES (?, ?) ON DUPLICATE KEY UPDATE privacy_level = VALUES(privacy_level)",
        [userId, privacyLevel]
      );
      await interaction.reply({
        content: `Your privacy preference has been set to **${privacyLevel}**.`,
        ephemeral: true
      });
    } catch (error) {
      logger.error("Error setting user privacy preference:", error);
      await interaction.reply({content: "There was an error saving your preference.", ephemeral: true});
    }
  },
};