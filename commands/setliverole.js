const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setliverole')
    .setDescription('Sets a role to be assigned to users when they go live.')
    .addRoleOption(option =>
        option.setName('role')
            .setDescription('The role to assign. Leave blank to disable.')
            .setRequired(false))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  async execute(interaction) {
    const role = interaction.options.getRole('role');
    const roleId = role ? role.id : null;
    
    await interaction.deferReply({ ephemeral: true });

    try {
        if (role) {
            const botMember = await interaction.guild.members.fetch(interaction.client.user.id);
            if (role.position >= botMember.roles.highest.position) {
                return interaction.editReply({
                    content: `I cannot manage the "${role.name}" role. Please place my role higher than it in the role hierarchy.`,
                    ephemeral: true
                });
            }
        }
      
      await db.execute(
        'INSERT INTO guilds (guild_id, live_role_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE live_role_id = ?',
        [interaction.guild.id, roleId, roleId]
      );

      const embed = new EmbedBuilder().setColor('#00FF00').setTitle('Live Role Updated!');
      
      if (role) {
        embed.setDescription(`The "Live" role has been set to ${role}.`);
      } else {
        embed.setDescription('The "Live" role has been disabled.');
      }

      await interaction.editReply({ embeds: [embed] });

    } catch (e) {
      console.error('Set Live Role Error:', e);
      await interaction.editReply({ content: 'An error occurred.', ephemeral: true });
    }
  },
};
