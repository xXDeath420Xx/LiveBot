const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder} = require("discord.js");
const db = require("../utils/db");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("permissions")
    .setDescription("Manage command permissions for roles on this server.")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addSubcommand(subcommand =>
      subcommand
        .setName("grant")
        .setDescription("Grants a role permission to use a specific bot command.")
        .addRoleOption(option => option.setName("role").setDescription("The role to grant permission to.").setRequired(true))
        .addStringOption(option => option.setName("command").setDescription("The command to grant permission for.").setRequired(true).setAutocomplete(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName("revoke")
        .setDescription("Revokes a role's permission to use a specific bot command.")
        .addRoleOption(option => option.setName("role").setDescription("The role to revoke permission from.").setRequired(true))
        .addStringOption(option => option.setName("command").setDescription("The command to revoke permission for.").setRequired(true).setAutocomplete(true))),

  async autocomplete(interaction) {
    const focusedValue = interaction.options.getFocused();
    try {
      const commandNames = Array.from(interaction.client.commands.keys());
      const filtered = commandNames.filter(name => name.startsWith(focusedValue) && name !== "permissions");
      await interaction.respond(filtered.map(name => ({name, value: name})));
    } catch (error) {
      logger.error("[Permissions Command Autocomplete Error]", error);
      await interaction.respond([]); // Respond with an empty array on error
    }
  },

  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});
    const subcommand = interaction.options.getSubcommand();
    const role = interaction.options.getRole("role");
    const commandName = interaction.options.getString("command");

    if (!interaction.client.commands.has(commandName) || commandName === "permissions") {
      return interaction.editReply({content: "That is not a valid command to set permissions for."});
    }

    try {
      if (subcommand === "grant") {
        await db.execute(
          "INSERT INTO bot_permissions (guild_id, role_id, command) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE command=command",
          [interaction.guild.id, role.id, commandName]
        );
        await interaction.editReply({embeds: [new EmbedBuilder().setColor("#57F287").setTitle("✅ Permission Granted").setDescription(`The role ${role} can now use the \`/${commandName}\` command.`)]});
      } else if (subcommand === "revoke") {
        await db.execute(
          "DELETE FROM bot_permissions WHERE guild_id = ? AND role_id = ? AND command = ?",
          [interaction.guild.id, role.id, commandName]
        );
        await interaction.editReply({embeds: [new EmbedBuilder().setColor("#ED4245").setTitle("✅ Permission Revoked").setDescription(`The role ${role} can no longer use the \`/${commandName}\` command.`)]});
      }
    } catch (error) {
      logger.error("[Permissions Command Error]", error);
      await interaction.editReply({content: "An error occurred while updating permissions."});
    }
  },
  category: "Super Admin",
};