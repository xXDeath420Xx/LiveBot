import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const commandCache = new Map();

// Clear cache every 5 minutes
setInterval(() => commandCache.clear(), 5 * 60 * 1000);

/**
 * Handle custom command from interaction
 * @param {ChatInputCommandInteraction} interaction - Discord interaction object
 * @returns {Promise<boolean>} - Whether a custom command was handled
 */
export async function handleCustomCommand(interaction) {
  if (!interaction.isChatInputCommand()) return false;

  const guildId = interaction.guild.id;
  const commandName = interaction.commandName.toLowerCase();
  const cacheKey = `${guildId}:${commandName}`;
  let command;

  // Check cache first
  if (commandCache.has(cacheKey)) {
    command = commandCache.get(cacheKey);
  } else {
    // Fetch from database
    const [rows] = await pool.execute(
      'SELECT * FROM custom_commands WHERE guild_id = ? AND command_name = ?',
      [guildId, commandName]
    );

    if (rows.length > 0) {
      command = rows[0];
      commandCache.set(cacheKey, command);
    }
  }

  if (command) {
    try {
      // Permission Checks - Required Roles
      const requiredRoles = command.required_roles ? JSON.parse(command.required_roles) : [];
      if (requiredRoles.length > 0 && !interaction.member.roles.cache.some(r => requiredRoles.includes(r.id))) {
        await interaction.reply({
          content: 'You do not have the required role to use this command.',
          ephemeral: true
        });
        return true;
      }

      // Permission Checks - Allowed Channels
      const allowedChannels = command.allowed_channels ? JSON.parse(command.allowed_channels) : [];
      if (allowedChannels.length > 0 && !allowedChannels.includes(interaction.channelId)) {
        await interaction.reply({
          content: `This command can only be used in the following channels: ${allowedChannels.map(id => `<#${id}>`).join(', ')}.`,
          ephemeral: true
        });
        return true;
      }

      // Parse response with variable substitution
      const response = parseVariables(command.response, interaction);
      const targetMember = interaction.options.getMember('user') || interaction.member;

      // Execute action based on action type
      switch (command.action_type) {
        case 'reply':
          await interaction.reply(response);
          break;

        case 'add_role':
          const roleToAdd = await interaction.guild.roles.fetch(command.action_content).catch(() => null);
          if (!roleToAdd || !roleToAdd.editable) {
            await interaction.reply({
              content: 'Error: The role configured for this command is invalid or I cannot manage it.',
              ephemeral: true
            });
            return true;
          }
          await targetMember.roles.add(roleToAdd);
          await interaction.reply({
            content: `Added the ${roleToAdd.name} role to ${targetMember.displayName}.`,
            ephemeral: true
          });
          break;

        case 'remove_role':
          const roleToRemove = await interaction.guild.roles.fetch(command.action_content).catch(() => null);
          if (!roleToRemove || !roleToRemove.editable) {
            await interaction.reply({
              content: 'Error: The role configured for this command is invalid or I cannot manage it.',
              ephemeral: true
            });
            return true;
          }
          await targetMember.roles.remove(roleToRemove);
          await interaction.reply({
            content: `Removed the ${roleToRemove.name} role from ${targetMember.displayName}.`,
            ephemeral: true
          });
          break;
      }
      return true;

    } catch (error) {
      if (error.code !== 'ER_BAD_FIELD_ERROR') {
        logger.error(`[CustomCommandHandler] Error executing command '${commandName}'`, {
          error: error.message,
          stack: error.stack,
          guildId,
          commandName
        });
      }
      await interaction.reply({
        content: 'There was an error trying to execute that custom command. It may not be configured correctly.',
        ephemeral: true
      });
      return true;
    }
  }

  return false;
}

/**
 * Parse variables in text
 * @param {string} text - Text with variables to parse
 * @param {ChatInputCommandInteraction} interaction - Discord interaction object
 * @returns {string} - Parsed text
 */
function parseVariables(text, interaction) {
  if (!text) return '';

  const targetUser = interaction.options.getUser('user') || interaction.user;
  const replacements = {
    '{user.name}': targetUser.username,
    '{user.mention}': targetUser.toString(),
    '{user.id}': targetUser.id,
    '{user.tag}': targetUser.tag,
    '{channel.name}': interaction.channel.isDMBased() ? 'DM' : interaction.channel.name,
    '{channel.mention}': interaction.channel.toString(),
    '{channel.id}': interaction.channel.id,
    '{server.name}': interaction.guild.name,
    '{server.id}': interaction.guild.id,
  };

  let parsedText = text;
  for (const [variable, value] of Object.entries(replacements)) {
    parsedText = parsedText.replace(new RegExp(variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), value);
  }

  return parsedText;
}

/**
 * Invalidate command cache for a specific command
 * @param {string} guildId - Guild ID
 * @param {string} commandName - Command name
 */
export function invalidateCommandCache(guildId, commandName) {
  const cacheKey = `${guildId}:${commandName.toLowerCase()}`;
  if (commandCache.has(cacheKey)) {
    commandCache.delete(cacheKey);
  }
}
