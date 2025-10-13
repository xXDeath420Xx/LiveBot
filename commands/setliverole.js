const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder, MessageFlags} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("setliverole")
    .setDescription("Sets or clears the role to be assigned when a linked user goes live.")
    .addRoleOption(option => option.setName("role").setDescription("The role to assign. Leave blank to clear/disable.").setRequired(false))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  async execute(interaction) {
    const role = interaction.options.getRole("role");
    const roleId = role ? role.id : null;
    const guildId = interaction.guild.id;

    await interaction.deferReply({flags: [MessageFlags.Ephemeral]});

    try {
      if (role) {
        const botMember = await interaction.guild.members.fetch(interaction.client.user.id);
        if (role.position >= botMember.roles.highest.position) {
          return interaction.editReply({content: `Error: The "${role.name}" role is higher than my role in the server hierarchy, so I cannot assign it.`});
        }
      }

      await db.execute(
        "INSERT INTO guilds (guild_id, live_role_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE live_role_id = VALUES(live_role_id)",
        [guildId, roleId]
      );

      const embed = new EmbedBuilder().setColor(role ? "#57F287" : "#ED4245").setTitle("Live Role Updated");
      embed.setDescription(role ? `The live role has been set to ${role}.` : "The live role has been cleared and is now disabled.");
      await interaction.editReply({embeds: [embed]});

    } catch (e) {
      logger.error("[SetLiveRole Error]", e);
      await interaction.editReply({content: "A critical database error occurred."});
    }
  },
  category: "Streamer Management",
};