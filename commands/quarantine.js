const {SlashCommandBuilder, PermissionsBitField} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("quarantine")
    .setDescription("Quarantines a user, temporarily restricting their permissions.")
    .addUserOption(option =>
      option.setName("user")
        .setDescription("The user to quarantine.")
        .setRequired(true))
    .addBooleanOption(option =>
      option.setName("enable")
        .setDescription("Enable or disable quarantine for the user.")
        .setRequired(true)),
  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({content: "You do not have permission to use this command.", ephemeral: true});
    }

    const user = interaction.options.getUser("user");
    const member = interaction.guild.members.cache.get(user.id);
    const enable = interaction.options.getBoolean("enable");
    const guildId = interaction.guild.id;

    if (!member) {
      return interaction.reply({content: "That user is not in this server.", ephemeral: true});
    }

    try {
      const [[quarantineConfig]] = await db.execute("SELECT is_enabled, quarantine_role_id FROM quarantine_config WHERE guild_id = ?", [guildId]);

      if (!quarantineConfig || !quarantineConfig.is_enabled) {
        return interaction.reply({content: "The quarantine system is not enabled for this server.", ephemeral: true});
      }

      const quarantineRoleId = quarantineConfig.quarantine_role_id;
      if (!quarantineRoleId) {
        return interaction.reply({content: "No quarantine role is configured for this server. Please configure it in the dashboard.", ephemeral: true});
      }

      const quarantineRole = interaction.guild.roles.cache.get(quarantineRoleId);
      if (!quarantineRole) {
        return interaction.reply({content: "The configured quarantine role was not found in this server. Please check your dashboard settings.", ephemeral: true});
      }

      if (enable) {
        // Remove all other roles and add the quarantine role
        const rolesToRemove = member.roles.cache.filter(role => !role.managed && role.id !== interaction.guild.id);
        await member.roles.remove(rolesToRemove);
        await member.roles.add(quarantineRole);
        await interaction.reply({content: `${user.tag} has been quarantined.`, ephemeral: true});
      } else {
        await member.roles.remove(quarantineRole);
        await interaction.reply({content: `${user.tag} has been released from quarantine.`, ephemeral: true});
      }
    } catch (error) {
      logger.error("[Quarantine Command Error]", error);
      await interaction.reply({content: "An error occurred while trying to toggle quarantine for the user.", ephemeral: true});
    }
  },
  category: "Moderation",
};