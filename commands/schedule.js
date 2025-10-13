const {SlashCommandBuilder, EmbedBuilder, PermissionsBitField} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

// Assuming generateScheduleGrid is defined elsewhere or is a helper function not included in this snippet
function generateScheduleGrid(sessions) {
  // Placeholder for the actual implementation of generateScheduleGrid
  // This function would process stream_sessions to create a visual schedule grid.
  // For example, it might count streams per hour/day and represent intensity with emojis.
  // Since the original snippet had it commented out, I'm keeping this as a placeholder.
  // If you provide the implementation, I can review it.
  return "Schedule grid generation logic is not available in this snippet.";
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("schedule")
    .setDescription("Displays a streamer's official or predicted weekly schedule.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.SendMessages)
    .addUserOption(option => option.setName("user").setDescription("The streamer to check the schedule for.").setRequired(true)),

  async execute(interaction) {
    await interaction.deferReply();
    const user = interaction.options.getUser("user");

    try {
      const [[streamer]] = await db.execute("SELECT streamer_id FROM streamers WHERE discord_user_id = ?", [user.id]);
      if (!streamer) {
        return interaction.editReply({content: `That user is not linked to any streamer profiles on this bot.`});
      }

      // --- BEGIN: Manual Schedule Check ---
      const [[manualSchedule]] = await db.execute("SELECT * FROM manual_schedules WHERE streamer_id = ?", [streamer.streamer_id]);

      if (manualSchedule && Object.values(manualSchedule).some(day => day)) { // Check if at least one day is set
        const embed = new EmbedBuilder()
          .setColor("#57F287") // Green for official
          .setTitle(`Official Schedule for ${user.username}`)
          .setThumbnail(user.displayAvatarURL())
          .setDescription("This is the official schedule as set by the streamer.");

        const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
        for (const day of days) {
          embed.addFields({name: day.charAt(0).toUpperCase() + day.slice(1), value: manualSchedule[day] || "Not Streaming", inline: true});
        }

        return interaction.editReply({embeds: [embed]});
      }
      // --- END: Manual Schedule Check ---

      // Fallback to predictive schedule if no manual one is set
      const [sessions] = await db.execute(
        "SELECT start_time, end_time FROM stream_sessions WHERE streamer_id = ? AND end_time IS NOT NULL AND start_time > DATE_SUB(NOW(), INTERVAL 90 DAY)",
        [streamer.streamer_id]
      );

      if (sessions.length < 3) {
        return interaction.editReply({content: `There is not enough stream history for ${user.tag} to generate a predicted schedule.`});
      }

      const scheduleGrid = generateScheduleGrid(sessions);

      const embed = new EmbedBuilder()
        .setColor("#5865F2")
        .setTitle(`Predicted Schedule for ${user.username}`)
        .setDescription(scheduleGrid)
        .setFooter({text: "Based on streaming activity over the last 90 days. All times are in UTC."})
        .addFields({name: "Legend", value: "⬜ Low Activity -> 🟥 High Activity"});

      await interaction.editReply({embeds: [embed]});

    } catch (error) {
      logger.error("[Schedule Command Error]", error);
      await interaction.editReply({content: "An error occurred while generating the schedule."});
    }
  },
};