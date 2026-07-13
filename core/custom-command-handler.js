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

/** The full set of placeholders a custom-command response may use. */
export const TEMPLATE_VARIABLES = Object.freeze([
  { token: '{user.name}', description: "The invoking (or targeted) user's username" },
  { token: '{user.mention}', description: 'Pings that user' },
  { token: '{user.id}', description: "That user's ID" },
  { token: '{user.tag}', description: 'username#0000' },
  { token: '{channel.name}', description: 'Current channel name' },
  { token: '{channel.mention}', description: 'Links the current channel' },
  { token: '{channel.id}', description: 'Current channel ID' },
  { token: '{server.name}', description: 'This server\'s name' },
  { token: '{server.id}', description: "This server's ID" },
  { token: '{random:1-100}', description: 'A random whole number in that range' },
  { token: '{choice:a|b|c}', description: 'Picks one of the options at random' },
]);

const RANDOM_RE = /\{random:(-?\d{1,9})-(-?\d{1,9})\}/g;
const CHOICE_RE = /\{choice:([^{}]{1,300})\}/g;

/**
 * Fill a response template. Dynamic tokens are resolved per invocation, so `!pp` can answer
 * with a different number each time — which is what the bots we replace actually do.
 */
export function substitute(text, values, rng = Math.random) {
  let out = text || '';
  for (const [token, value] of Object.entries(values)) {
    out = out.split(token).join(value);
  }

  out = out.replace(RANDOM_RE, (_, lo, hi) => {
    let a = parseInt(lo, 10), b = parseInt(hi, 10);
    if (a > b) [a, b] = [b, a];
    return String(a + Math.floor(rng() * (b - a + 1)));
  });

  out = out.replace(CHOICE_RE, (_, list) => {
    const options = list.split('|').map(s => s.trim()).filter(Boolean);
    return options.length ? options[Math.floor(rng() * options.length)] : '';
  });

  return out;
}

/** Look a custom command up (cached) by guild + name. */
export async function findCustomCommand(guildId, commandName) {
  const name = String(commandName || '').toLowerCase();
  const cacheKey = `${guildId}:${name}`;
  if (commandCache.has(cacheKey)) return commandCache.get(cacheKey);

  const [rows] = await pool.execute(
    'SELECT * FROM custom_commands WHERE guild_id = ? AND command_name = ?', [guildId, name]);
  const command = rows[0] || null;
  if (command) commandCache.set(cacheKey, command);
  return command;
}

/**
 * Run a custom command from a plain chat message (`!rules`).
 *
 * Custom commands were previously only reachable through `handleCustomCommand`, which
 * nothing called and which needed a slash command that was never registered — so they
 * never ran at all. The prefix bridge is what actually makes them work.
 *
 * @returns {Promise<boolean>} true if a custom command with this name ran.
 */
export async function handleCustomPrefixCommand(message, commandName) {
  if (!message.guild) return false;

  let command;
  try {
    command = await findCustomCommand(message.guild.id, commandName);
  } catch (error) {
    if (error.code !== 'ER_NO_SUCH_TABLE') {
      logger.error(`[CustomCommand] lookup failed: ${error.message}`);
    }
    return false;
  }
  if (!command) return false;

  try {
    const requiredRoles = command.required_roles ? JSON.parse(command.required_roles) : [];
    if (requiredRoles.length && !message.member?.roles.cache.some(r => requiredRoles.includes(r.id))) {
      await message.reply({ content: 'You do not have the required role to use this command.' }).catch(() => {});
      return true;
    }

    const allowedChannels = command.allowed_channels ? JSON.parse(command.allowed_channels) : [];
    if (allowedChannels.length && !allowedChannels.includes(message.channelId)) {
      await message.reply({
        content: `This command can only be used in: ${allowedChannels.map(id => `<#${id}>`).join(', ')}.`,
      }).catch(() => {});
      return true;
    }

    const targetUser = message.mentions.users.first() || message.author;
    const targetMember = message.mentions.members?.first() || message.member;
    const response = substitute(command.response, {
      '{user.name}': targetUser.username,
      '{user.mention}': targetUser.toString(),
      '{user.id}': targetUser.id,
      '{user.tag}': targetUser.tag,
      '{channel.name}': message.channel.name ?? 'DM',
      '{channel.mention}': message.channel.toString(),
      '{channel.id}': message.channelId,
      '{server.name}': message.guild.name,
      '{server.id}': message.guild.id,
    });

    switch (command.action_type) {
      case 'add_role':
      case 'remove_role': {
        const role = await message.guild.roles.fetch(command.action_content).catch(() => null);
        if (!role || !role.editable) {
          await message.reply({ content: 'That role is invalid or I cannot manage it.' }).catch(() => {});
          return true;
        }
        const adding = command.action_type === 'add_role';
        await targetMember.roles[adding ? 'add' : 'remove'](role);
        await message.reply({
          content: `${adding ? 'Added' : 'Removed'} the ${role.name} role ${adding ? 'to' : 'from'} ${targetMember.displayName}.`,
        }).catch(() => {});
        return true;
      }
      case 'reply':
      default:
        if (response) await message.reply({ content: response, allowedMentions: { repliedUser: false } }).catch(() => {});
        return true;
    }
  } catch (error) {
    logger.error(`[CustomCommand] '${commandName}' failed: ${error.message}`, { guildId: message.guild.id });
    await message.reply({ content: 'That custom command is not configured correctly.' }).catch(() => {});
    return true;
  }
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
