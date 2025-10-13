const {SlashCommandBuilder, EmbedBuilder, PermissionsBitField} = require("discord.js");
const db = require("../utils/db");

// Helper function to format duration
function formatDuration(seconds) {
  if (seconds < 60) {
    return `${Math.floor(seconds)} sec`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Displays streaming analytics.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.SendMessages)
    .addSubcommand(subcommand =>
      subcommand
        .setName("streamer")
        .setDescription("Shows analytics for a specific streamer on this server.")
        .addUserOption(option => option.setName("user").setDescription("The Discord user to see stats for.").setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName("server")
        .setDescription("Shows aggregate streaming analytics for the entire server.")),

  async execute(interaction) {
    await interaction.deferReply();
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "streamer") {
      const user = interaction.options.getUser("user");
      const [[streamer]] = await db.execute("SELECT streamer_id FROM streamers WHERE discord_user_id = ?", [user.id]);
      if (!streamer) {
        return interaction.editReply({content: `That user is not linked to any streamer profiles on this bot.`});
      }

      const [sessions] = await db.execute(
        "SELECT start_time, end_time, game_name FROM stream_sessions WHERE streamer_id = ? AND guild_id = ? AND end_time IS NOT NULL",
        [streamer.streamer_id, interaction.guild.id]
      );

      if (sessions.length === 0) {
        return interaction.editReply({content: `No completed stream sessions found for ${user.tag} on this server.`});
      }

      let totalDuration = 0;
      const gameTime = {};
      const dayCount = {0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0}; // Sun-Sat

      for (const session of sessions) {
        const start = new Date(session.start_time);
        const end = new Date(session.end_time);
        const duration = (end - start) / 1000;
        totalDuration += duration;
        if (session.game_name) {
          gameTime[session.game_name] = (gameTime[session.game_name] || 0) + duration;
        }
        dayCount[start.getDay()]++;
      }

      const topGames = Object.entries(gameTime).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const topDays = Object.entries(dayCount).sort((a, b) => b[1] - a[1]);
      const avgDuration = totalDuration / sessions.length;

      const embed = new EmbedBuilder()
        .setColor("#5865F2")
        .setTitle(`Stream Stats for ${user.username}`)
        .setThumbnail(user.displayAvatarURL())
        .addFields(
          {name: "Total Stream Time", value: formatDuration(totalDuration), inline: true},
          {name: "Average Session", value: formatDuration(avgDuration), inline: true},
          {name: "Total Sessions", value: sessions.length.toString(), inline: true},
          {name: "Top Games Streamed", value: topGames.length > 0 ? topGames.map((g, i) => `${i + 1}. ${g[0]} (${formatDuration(g[1])})`).join("\n") : "No games tracked."},
          {name: "Most Active Days", value: topDays.map(d => `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d[0]]}`).join(", ")}
        );

      await interaction.editReply({embeds: [embed]});

    } else if (subcommand === "server") {
      const [sessions] = await db.execute(
        "SELECT ss.start_time, ss.end_time, ss.game_name, s.username FROM stream_sessions ss JOIN streamers s ON ss.streamer_id = s.streamer_id WHERE ss.guild_id = ? AND ss.end_time IS NOT NULL",
        [interaction.guild.id]
      );

      if (sessions.length === 0) {
        return interaction.editReply({content: `No completed stream sessions found for this server.`});
      }

      let totalDuration = 0;
      const gameTime = {};
      const streamerTime = {};

      for (const session of sessions) {
        const duration = (new Date(session.end_time) - new Date(session.start_time)) / 1000;
        totalDuration += duration;
        if (session.game_name) {
          gameTime[session.game_name] = (gameTime[session.game_name] || 0) + duration;
        }
        streamerTime[session.username] = (streamerTime[session.username] || 0) + duration;
      }

      const topGames = Object.entries(gameTime).sort((a, b) => b[1] - a[1]).slice(0, 3);
      const topStreamers = Object.entries(streamerTime).sort((a, b) => b[1] - a[1]).slice(0, 3);

      const embed = new EmbedBuilder()
        .setColor("#5865F2")
        .setTitle(`Server Stream Stats for ${interaction.guild.name}`)
        .setThumbnail(interaction.guild.iconURL())
        .addFields(
          {name: "Total Stream Time", value: formatDuration(totalDuration), inline: true},
          {name: "Total Sessions", value: sessions.length.toString(), inline: true},
          {name: "\u200B", value: "\u200B", inline: true}, // Spacer
          {name: "🏆 Top Streamers (by time)", value: topStreamers.length > 0 ? topStreamers.map((s, i) => `${i + 1}. ${s[0]} (${formatDuration(s[1])})`).join("\n") : "No streamers tracked."},
          {name: "🎮 Top Games Streamed", value: topGames.length > 0 ? topGames.map((g, i) => `${i + 1}. ${g[0]} (${formatDuration(g[1])})`).join("\n") : "No games tracked."}
        );

      await interaction.editReply({embeds: [embed]});
    }
  },
  category: "Utility",
};