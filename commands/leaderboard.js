const {SlashCommandBuilder, EmbedBuilder} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Displays the server's top members by XP."),
  async execute(interaction) {
    await interaction.deferReply();

    const guildId = interaction.guild.id;

    try {
      const [rows] = await db.execute(
        "SELECT user_id, xp, level FROM user_levels WHERE guild_id = ? ORDER BY xp DESC LIMIT 10",
        [guildId]
      );

      if (rows.length === 0) {
        return interaction.editReply({content: "No one has earned any XP on this server yet."});
      }

      const leaderboardDescription = await Promise.all(rows.map(async (row, index) => {
        try {
          const user = await interaction.client.users.fetch(row.user_id);
          return `**${index + 1}.** ${user.username} - **Level ${row.level}** (${row.xp} XP)`;
        } catch (userFetchError) {
          logger.warn(`[Leaderboard Command] Could not fetch user ${row.user_id}: ${userFetchError.message}`);
          return `**${index + 1}.** *Unknown User* - **Level ${row.level}** (${row.xp} XP)`;
        }
      }));

      const embed = new EmbedBuilder()
        .setColor("#5865F2")
        .setTitle(`Leaderboard for ${interaction.guild.name}`)
        .setDescription(leaderboardDescription.join("\n"));

      await interaction.editReply({embeds: [embed]});

    } catch (error) {
      logger.error("[Leaderboard Command Error]", error);
      await interaction.editReply({content: "An error occurred while fetching the leaderboard."});
    }
  },
  category: "Utility",
};