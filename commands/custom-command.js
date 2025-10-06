const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');
const { invalidateCommandCache } = require('../core/custom-command-handler');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('custom-command')
    .setDescription('Manage custom commands for this server.')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addSubcommand(subcommand =>
      subcommand
        .setName('add')
        .setDescription('Adds a new custom command.')
        .addStringOption(option => option.setName('name').setDescription('The name of the command (no slash).').setRequired(true))
        .addStringOption(option => option.setName('response').setDescription('The text the bot will respond with.').setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('remove')
        .setDescription('Removes a custom command.')
        .addStringOption(option => option.setName('name').setDescription('The name of the command to remove.').setRequired(true).setAutocomplete(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('Lists all custom commands on this server.')),

  async autocomplete(interaction) {
    if (interaction.options.getSubcommand() === 'remove') {
        const focusedValue = interaction.options.getFocused();
        const [commands] = await db.execute('SELECT command_name FROM custom_commands WHERE guild_id = ? AND command_name LIKE ? LIMIT 25', [interaction.guild.id, `${focusedValue}%`]);
        await interaction.respond(commands.map(cmd => ({ name: cmd.command_name, value: cmd.command_name })));
    }
  },

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    try {
      if (subcommand === 'add') {
        await interaction.deferReply({ ephemeral: true });
        const name = interaction.options.getString('name').toLowerCase();
        const response = interaction.options.getString('response');

        await db.execute('INSERT INTO custom_commands (guild_id, command_name, response) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE response = VALUES(response)', [guildId, name, response]);
        invalidateCommandCache(guildId, name);
        await interaction.editReply(`✅ Custom command \`${name}\` has been created/updated.`);

      } else if (subcommand === 'remove') {
        await interaction.deferReply({ ephemeral: true });
        const name = interaction.options.getString('name').toLowerCase();
        
        const [result] = await db.execute('DELETE FROM custom_commands WHERE guild_id = ? AND command_name = ?', [guildId, name]);
        if (result.affectedRows > 0) {
            invalidateCommandCache(guildId, name);
            await interaction.editReply(`🗑️ Custom command \`${name}\` has been deleted.`);
        } else {
            await interaction.editReply(`❌ No custom command found with the name \`${name}\`.`);
        }

      } else if (subcommand === 'list') {
        await interaction.deferReply({ ephemeral: true });
        const [commands] = await db.execute('SELECT command_name FROM custom_commands WHERE guild_id = ? ORDER BY command_name', [guildId]);
        
        if (commands.length === 0) {
            return interaction.editReply('There are no custom commands on this server.');
        }

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle(`Custom Commands for ${interaction.guild.name}`)
            .setDescription(commands.map(cmd => `\`${cmd.command_name}\``).join(', '));
        
        await interaction.editReply({ embeds: [embed] });
      }
    } catch (error) {
      console.error('[CustomCommand Error]', error);
      await interaction.editReply({ content: 'An error occurred while managing custom commands.' });
    }
  },
};