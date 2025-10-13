const {SlashCommandBuilder, PermissionsBitField, ChannelType} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("starboard")
    .setDescription("Manages the server starboard.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addSubcommand(subcommand =>
      subcommand
        .setName("setup")
        .setDescription("Sets up the starboard channel.")
        .addChannelOption(option =>
          option.setName("channel")
            .setDescription("The channel to post starred messages in.")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
        .addIntegerOption(option =>
          option.setName("threshold")
            .setDescription("The number of stars required to post a message (default: 3).")
            .setMinValue(1)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("disable")
        .setDescription("Disables the starboard.")
    ),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});
    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommand === "setup") {
        const channel = interaction.options.getChannel("channel");
        const threshold = interaction.options.getInteger("threshold") || 3;

        await db.execute(
          "INSERT INTO starboard_config (guild_id, channel_id, star_threshold) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), star_threshold = VALUES(star_threshold)",
          [interaction.guild.id, channel.id, threshold]
        );

        await interaction.editReply(`✅ Starboard enabled! Messages with ${threshold} or more ⭐ reactions will be posted in ${channel}.`);
      } else if (subcommand === "disable") {
        await db.execute("DELETE FROM starboard_config WHERE guild_id = ?", [interaction.guild.id]);
        await interaction.editReply("🗑️ The starboard has been disabled.");
      }
    } catch (error) {
      logger.error("[Starboard Command Error]", error);
      await interaction.editReply({content: "An error occurred while managing the starboard."});
    }
  },
  category: "Community",
};