const {SlashCommandBuilder, EmbedBuilder} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

// Basic time string parser (e.g., "10m", "1h", "2d")
function parseTime(timeStr) {
  const match = timeStr.match(/^(\d+)(s|m|h|d)$/);
  if (!match) {
    return null;
  }

  const value = parseInt(match[1]);
  const unit = match[2];
  let seconds = 0;

  switch (unit) {
    case "s":
      seconds = value;
      break;
    case "m":
      seconds = value * 60;
      break;
    case "h":
      seconds = value * 60 * 60;
      break;
    case "d":
      seconds = value * 24 * 60 * 60;
      break;
  }
  return new Date(Date.now() + seconds * 1000);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("remind")
    .setDescription("Set, view, or delete reminders.")
    .addSubcommand(subcommand =>
      subcommand
        .setName("me")
        .setDescription("Set a personal reminder (sent via DM).")
        .addStringOption(option => option.setName("when").setDescription("When to remind (e.g., 10m, 2h, 1d).").setRequired(true))
        .addStringOption(option => option.setName("message").setDescription("The reminder message.").setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("in")
        .setDescription("Set a reminder for this channel.")
        .addStringOption(option => option.setName("when").setDescription("When to remind (e.g., 30m, 1h).").setRequired(true))
        .addStringOption(option => option.setName("message").setDescription("The reminder message.").setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("list")
        .setDescription("View your active reminders in this server.")
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("delete")
        .setDescription("Delete one of your reminders.")
        .addIntegerOption(option => option.setName("id").setDescription("The ID of the reminder to delete.").setRequired(true))
    ),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});
    const subcommand = interaction.options.getSubcommand();
    const user = interaction.user;

    try {
      if (subcommand === "me" || subcommand === "in") {
        const when = interaction.options.getString("when");
        const message = interaction.options.getString("message");
        const remindAt = parseTime(when);

        if (!remindAt) {
          return interaction.editReply("Invalid time format. Please use formats like `30m`, `2h`, `1d`.");
        }

        const isDm = subcommand === "me";
        const channelId = isDm ? user.id : interaction.channel.id;

        await db.execute(
          "INSERT INTO reminders (user_id, guild_id, channel_id, is_dm, remind_at, message) VALUES (?, ?, ?, ?, ?, ?)",
          [user.id, interaction.guild.id, channelId, isDm, remindAt, message]
        );

        await interaction.editReply(`✅ Got it! I'll remind you <t:${Math.floor(remindAt.getTime() / 1000)}:R>.`);

      } else if (subcommand === "list") {
        const [reminders] = await db.execute("SELECT id, remind_at, message, is_dm FROM reminders WHERE user_id = ? AND guild_id = ? AND remind_at > NOW() ORDER BY remind_at ASC", [user.id, interaction.guild.id]);

        if (reminders.length === 0) {
          return interaction.editReply("You have no active reminders in this server.");
        }

        const embed = new EmbedBuilder()
          .setTitle("Your Active Reminders")
          .setColor("#5865F2")
          .setDescription(reminders.map(r =>
            `**ID: ${r.id}** - <t:${Math.floor(new Date(r.remind_at).getTime() / 1000)}:R>\n> ${r.message.substring(0, 100)}${r.is_dm ? " (in DM)" : ""}`
          ).join("\n\n"));

        await interaction.editReply({embeds: [embed]});

      } else if (subcommand === "delete") {
        const reminderId = interaction.options.getInteger("id");
        const [result] = await db.execute("DELETE FROM reminders WHERE id = ? AND user_id = ?", [reminderId, user.id]);

        if (result.affectedRows > 0) {
          await interaction.editReply(`🗑️ Reminder with ID \`${reminderId}\` has been deleted.`);
        } else {
          await interaction.editReply("❌ No reminder found with that ID, or you do not own it.");
        }
      }
    } catch (error) {
      logger.error("[Remind Command Error]", error);
      await interaction.editReply("An error occurred while managing your reminders.");
    }
  },
  category: "Utility",
};