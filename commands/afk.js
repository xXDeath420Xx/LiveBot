const {SlashCommandBuilder} = require("discord.js");
const db = require("../utils/db");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("afk")
    .setDescription("Sets or removes your AFK status.")
    .addStringOption(option =>
      option.setName("message")
        .setDescription("The message to display when someone mentions you (optional).")
    ),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});

    const message = interaction.options.getString("message") || "AFK";
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;

    try {
      // Check if the user is already AFK to remove it
      const [[existingAfk]] = await db.execute("SELECT * FROM afk_statuses WHERE guild_id = ? AND user_id = ?", [guildId, userId]);

      if (existingAfk) {
        await db.execute("DELETE FROM afk_statuses WHERE guild_id = ? AND user_id = ?", [guildId, userId]);
        await interaction.editReply("Welcome back! Your AFK status has been removed.");
      } else {
        await db.execute(
          "INSERT INTO afk_statuses (guild_id, user_id, message, timestamp) VALUES (?, ?, ?, NOW())",
          [guildId, userId, message]
        );
        await interaction.editReply(`You are now set as AFK with the message: "${message}"`);
      }
    } catch (error) {
      console.error("[AFK Command Error]", error);
      await interaction.editReply("An error occurred while setting your AFK status.");
    }
  },
};