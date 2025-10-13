const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("statrole")
    .setDescription("Manage roles automatically assigned by activity.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addSubcommand(subcommand =>
      subcommand
        .setName("add")
        .setDescription("Assign a role based on activity metrics.")
        .addRoleOption(option => option.setName("role").setDescription("The role to assign.").setRequired(true))
        .addStringOption(option =>
          option.setName("activity-type")
            .setDescription("The type of activity to track.")
            .setRequired(true)
            .addChoices(
              {name: "Messages Sent", value: "messages"},
              {name: "Minutes in Voice", value: "voice_minutes"}
            )
        )
        .addIntegerOption(option => option.setName("threshold").setDescription("The amount of activity required.").setRequired(true))
        .addIntegerOption(option => option.setName("period-days").setDescription("The number of days to measure activity over.").setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("remove")
        .setDescription("Stops automatically assigning a role based on activity.")
        .addRoleOption(option => option.setName("role").setDescription("The role to remove from the system.").setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("list")
        .setDescription("Lists all configured activity-based roles.")
    ),

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    try {
      if (subcommand === "add") {
        const role = interaction.options.getRole("role");
        const activityType = interaction.options.getString("activity-type");
        const threshold = interaction.options.getInteger("threshold");
        const periodDays = interaction.options.getInteger("period-days");

        if (!role.editable) {
          return interaction.editReply("I cannot manage this role. Please make sure it is below my highest role.");
        }

        await db.execute(
          "INSERT INTO statroles_config (guild_id, role_id, activity_type, threshold, period_days) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE activity_type=VALUES(activity_type), threshold=VALUES(threshold), period_days=VALUES(period_days)",
          [guildId, role.id, activityType, threshold, periodDays]
        );

        await interaction.editReply(`✅ Okay! I will now assign the **${role.name}** role to members who have **${threshold} ${activityType === "messages" ? "messages" : "minutes in voice"}** over the last **${periodDays} days**.`);

      } else if (subcommand === "remove") {
        const role = interaction.options.getRole("role");
        const [result] = await db.execute("DELETE FROM statroles_config WHERE guild_id = ? AND role_id = ?", [guildId, role.id]);
        if (result.affectedRows > 0) {
          await interaction.editReply(`🗑️ The **${role.name}** role will no longer be automatically assigned.`);
        } else {
          await interaction.editReply(`❌ That role was not configured as a statrole.`);
        }

      } else if (subcommand === "list") {
        const [roles] = await db.execute("SELECT * FROM statroles_config WHERE guild_id = ?", [guildId]);
        if (roles.length === 0) {
          return interaction.editReply("There are no activity-based roles configured on this server.");
        }

        const embed = new EmbedBuilder().setColor("#5865F2").setTitle("Activity-Based Roles");
        const description = roles.map(r =>
          `> <@&${r.role_id}>: **${r.threshold}** ${r.activity_type === "messages" ? "messages" : "minutes in voice"} / **${r.period_days}** days`
        ).join("\n");
        embed.setDescription(description);
        await interaction.editReply({embeds: [embed]});
      }
    } catch (error) {
      if (error.code === "ER_NO_SUCH_TABLE") {
        await interaction.editReply("The database tables for this feature have not been created yet. Please ask the bot owner to update the schema.");
      } else {
        logger.error("[Statrole Command Error]", error);
        await interaction.editReply("An error occurred while managing stat roles.");
      }
    }
  },
};