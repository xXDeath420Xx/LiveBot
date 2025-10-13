const {SlashCommandBuilder, PermissionsBitField, ChannelType} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("temp-channel")
    .setDescription("Manages the automatic temporary voice channel system.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addSubcommand(subcommand =>
      subcommand
        .setName("setup")
        .setDescription("Sets up the temp channel creator.")
        .addChannelOption(option =>
          option.setName("creator-channel")
            .setDescription("The voice channel users join to create a new channel.")
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true)
        )
        .addChannelOption(option =>
          option.setName("category")
            .setDescription("The category where new temp channels will be created.")
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true)
        )
        .addStringOption(option =>
          option.setName("naming-template")
            .setDescription("The name for new channels. Use {user} for the user's name.")
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("disable")
        .setDescription("Disables the temp channel system.")
    ),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});
    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommand === "setup") {
        const creatorChannel = interaction.options.getChannel("creator-channel");
        const category = interaction.options.getChannel("category");
        const template = interaction.options.getString("naming-template") || "{user}'s Channel";

        await db.execute(
          "INSERT INTO temp_channel_config (guild_id, creator_channel_id, category_id, naming_template) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE creator_channel_id = VALUES(creator_channel_id), category_id = VALUES(category_id), naming_template = VALUES(naming_template)",
          [interaction.guild.id, creatorChannel.id, category.id, template]
        );

        await interaction.editReply(`✅ System enabled! Users joining ${creatorChannel} will now create a temporary channel in the **${category.name}** category.`);
      } else if (subcommand === "disable") {
        await db.execute("DELETE FROM temp_channel_config WHERE guild_id = ?", [interaction.guild.id]);
        await interaction.editReply("🗑️ The temporary channel system has been disabled.");
      }
    } catch (error) {
      logger.error("[Temp Channel Command Error]", error);
      await interaction.editReply({content: "An error occurred while managing the temporary channel system."});
    }
  },
  category: "Community",
};