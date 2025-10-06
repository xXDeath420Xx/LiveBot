const { SlashCommandBuilder } = require('@discordjs/builders');
const { PermissionsBitField } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('quarantine')
    .setDescription('Quarantines a user, temporarily restricting their permissions.')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to quarantine.')
        .setRequired(true))
    .addBooleanOption(option =>
      option.setName('enable')
        .setDescription('Enable or disable quarantine for the user.')
        .setRequired(true)),
  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    }

    const user = interaction.options.getUser('user');
    const member = interaction.guild.members.cache.get(user.id);
    const enable = interaction.options.getBoolean('enable');

    if (!member) {
      return interaction.reply({ content: 'That user is not in this server.', ephemeral: true });
    }

    try {
      const quarantineRole = interaction.guild.roles.cache.find(role => role.name === 'Quarantined');
      if (!quarantineRole) {
        return interaction.reply({ content: 'Quarantine role not found. Please create a role named "Quarantined" with restricted permissions.', ephemeral: true });
      }

      if (enable) {
        await member.roles.set(member.roles.cache.filter(role => !role.managed && role.id !== interaction.guild.id).set(quarantineRole.id, quarantineRole));
        await interaction.reply({ content: `${user.tag} has been quarantined.`, ephemeral: true });
      } else {
        await member.roles.remove(quarantineRole);
        await interaction.reply({ content: `${user.tag} has been released from quarantine.`, ephemeral: true });
      }
    } catch (error) {
      console.error(error);
      await interaction.reply({ content: 'An error occurred while trying to quarantine the user.', ephemeral: true });
    }
  },
};