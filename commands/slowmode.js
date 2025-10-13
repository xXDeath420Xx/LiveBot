const {SlashCommandBuilder, PermissionsBitField, ChannelType, EmbedBuilder} = require("discord.js");
const logger = require("../utils/logger");

// Helper to parse time strings like "10s", "5m", "1h" into seconds
function parseTimeToSeconds(timeStr) {
  if (timeStr === "off" || timeStr === "0") {
    return 0;
  }
  const match = timeStr.match(/^(\d+)(s|m|h)$/);
  if (!match) {
    return null;
  }

  const value = parseInt(match[1]);
  const unit = match[2];

  switch (unit) {
    case "s":
      return value;
    case "m":
      return value * 60;
    case "h":
      return value * 60 * 60;
  }
  return null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("slowmode")
    .setDescription("Sets or removes a slowmode cooldown for the current channel.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
    .addStringOption(option =>
      option.setName("duration")
        .setDescription("The slowmode duration (e.g., 10s, 5m, 1h) or \"off\".")
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName("reason")
        .setDescription("The reason for changing the slowmode.")
    ),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});
    const durationStr = interaction.options.getString("duration").toLowerCase();
    const reason = interaction.options.getString("reason") || "No reason provided.";
    const channel = interaction.channel;

    if (channel.type !== ChannelType.GuildText) {
      return interaction.editReply({content: "This command can only be used in text channels."});
    }

    const seconds = parseTimeToSeconds(durationStr);

    if (seconds === null) {
      return interaction.editReply({content: "Invalid duration format. Use formats like `10s`, `5m`, `1h`, or `off`."});
    }

    if (seconds > 21600) { // Discord's max is 6 hours (21600 seconds)
      return interaction.editReply({content: "The maximum slowmode duration is 6 hours (6h)."});
    }

    try {
      await channel.setRateLimitPerUser(seconds, reason);

      const embed = new EmbedBuilder()
        .setColor(seconds > 0 ? "#E67E22" : "#2ECC71");

      if (seconds > 0) {
        embed.setTitle("⏳ Channel Slowmode Enabled")
          .setDescription(`Users must now wait **${durationStr}** between messages.`);
      } else {
        embed.setTitle("✅ Channel Slowmode Disabled")
          .setDescription("The slowmode cooldown has been removed.");
      }

      await interaction.editReply({embeds: [embed]});

    } catch (error) {
      logger.error("[Slowmode Command Error]", error);
      await interaction.editReply({content: "Failed to set the slowmode. Do I have the Manage Channels permission?"});
    }
  },
  category: "Utility",
};