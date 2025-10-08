const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');
const { invalidateCommandCache } = require('../core/custom-command-handler');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('custom-command')
    .setDescription('Manage custom commands for this server.')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addSubcommand(subcommand =>
      subcommand
        .setName('create')
        .setDescription('Creates a new, advanced custom command.')
        .addStringOption(option => option.setName('name').setDescription('The name of the command.').setRequired(true))
        .addStringOption(option => 
            option.setName('action-type')
                .setDescription('The action this command will perform.')
                .setRequired(true)
                .addChoices(
                    { name: 'Reply with Text', value: 'reply' },
                    { name: 'Add Role to User', value: 'add_role' },
                    { name: 'Remove Role from User', value: 'remove_role' }
                )
        )
        .addStringOption(option => option.setName('response-or-role-id').setDescription('The text response or the ID of the role to manage.').setRequired(true))
        .addStringOption(option => option.setName('required-roles').setDescription('Comma-separated list of role IDs required to use this command.'))
        .addStringOption(option => option.setName('allowed-channels').setDescription('Comma-separated list of channel IDs where this command can be used.'))
    )
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
    const focusedValue = interaction.options.getFocused();
    try {
        const [commands] = await db.execute('SELECT command_name FROM custom_commands WHERE guild_id = ? AND command_name LIKE ? LIMIT 25', [interaction.guild.id, `${focusedValue}%`]);
        await interaction.respond(commands.map(cmd => ({ name: cmd.command_name, value: cmd.command_name })));
    } catch (error) {
        await interaction.respond([]);
    }
  },

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    try {
      if (subcommand === 'create') {
        await interaction.deferReply({ ephemeral: true });
        const name = interaction.options.getString('name').toLowerCase();
        const actionType = interaction.options.getString('action-type');
        const actionContent = interaction.options.getString('response-or-role-id');
        const requiredRoles = interaction.options.getString('required-roles')?.split(',').map(id => id.trim());
        const allowedChannels = interaction.options.getString('allowed-channels')?.split(',').map(id => id.trim());

        await db.execute(
            `INSERT INTO custom_commands (guild_id, command_name, response, action_type, action_content, required_roles, allowed_channels) 
             VALUES (?, ?, ?, ?, ?, ?, ?) 
             ON DUPLICATE KEY UPDATE response=VALUES(response), action_type=VALUES(action_type), action_content=VALUES(action_content), required_roles=VALUES(required_roles), allowed_channels=VALUES(allowed_channels)`,
            [guildId, name, actionContent, actionType, actionContent, JSON.stringify(requiredRoles || []), JSON.stringify(allowedChannels || [])]
        );
        invalidateCommandCache(guildId, name);
        await interaction.editReply(`✅ Advanced custom command \`${name}\` has been created/updated.`);

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
        const [commands] = await db.execute('SELECT command_name, action_type FROM custom_commands WHERE guild_id = ? ORDER BY command_name', [guildId]);
        if (commands.length === 0) {
            return interaction.editReply('There are no custom commands on this server.');
        }
        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle(`Custom Commands for ${interaction.guild.name}`)
            .setDescription(commands.map(cmd => `\`${cmd.command_name}\` (*${cmd.action_type}*)`).join('\n'));
        await interaction.editReply({ embeds: [embed] });
      }
    } catch (error) {
        if (error.code === 'ER_BAD_FIELD_ERROR') {
            await interaction.editReply('The database tables for this feature have not been fully updated yet. Please ask the bot owner to update the schema.');
        } else {
            logger.error('[CustomCommand Error]', error);
            await interaction.editReply({ content: 'An error occurred while managing custom commands.' });
        }
    }
  },
};