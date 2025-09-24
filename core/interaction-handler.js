const logger = require("../utils/logger");
const {getStatus} = require("./status-manager");
const db = require("../utils/db");
const {PermissionsBitField} = require("discord.js");

async function handleInteraction(interaction) {
  const botStatus = getStatus();
  if (botStatus.state !== "ONLINE") {
    if (interaction.isRepliable()) {
      await interaction.reply({content: `The bot is currently ${botStatus.state.toLowerCase()}. Please try again in a moment.`, ephemeral: true});
    }
    return;
  }

  try {
    if (interaction.isChatInputCommand()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (!command) {
        logger.warn(`No command matching ${interaction.commandName} was found.`);
        return;
      }

      // --- Permission Check Logic ---
      const isAdministrator = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
      if (!isAdministrator) {
        const [allowedRoles] = await db.execute("SELECT role_id FROM bot_permissions WHERE guild_id = ? AND command = ?", [interaction.guild.id, interaction.commandName]);
        const requiredRoles = allowedRoles.map(r => r.role_id);

        if (requiredRoles.length > 0) {
          const hasRole = interaction.member.roles.cache.some(role => requiredRoles.includes(role.id));
          if (!hasRole) {
            return interaction.reply({content: "You do not have the required role to use this command.", ephemeral: true});
          }
        } else {
          // Fallback to default permissions if no override is set
          const defaultPermissions = command.data.defaultMemberPermissions;
          if (defaultPermissions && !interaction.member.permissions.has(defaultPermissions)) {
            return interaction.reply({content: "You do not have the default required permissions to use this command.", ephemeral: true});
          }
        }
      }
      // --- End Permission Check ---

      await command.execute(interaction);

    } else if (interaction.isAutocomplete()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (command && command.autocomplete) {
        await command.autocomplete(interaction);
      }
    } else if (interaction.isButton()) {
      const handler = findHandler(interaction.client.buttons, interaction.customId);
      if (handler) {
        await handler.execute(interaction);
      } else {
        logger.warn(`No button handler found for custom ID: ${interaction.customId}`);
      }
    } else if (interaction.isModalSubmit()) {
      const handler = findHandler(interaction.client.modals, interaction.customId);
      if (handler) {
        await handler.execute(interaction);
      } else {
        logger.warn(`No modal handler found for custom ID: ${interaction.customId}`);
      }
    } else if (interaction.isStringSelectMenu() || interaction.isChannelSelectMenu()) {
      const handler = findHandler(interaction.client.selects, interaction.customId);
      if (handler) {
        await handler.execute(interaction);
      } else {
        logger.warn(`No select menu handler found for custom ID: ${interaction.customId}`);
      }
    }
  } catch (error) {
    logger.error(`Error during interaction handling for custom ID ${interaction.customId}`, {error});
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({content: "There was an error while processing this interaction!", ephemeral: true});
    } else {
      await interaction.reply({content: "There was an error while processing this interaction!", ephemeral: true});
    }
  }
}

function findHandler(collection, customId) {
  return collection.find(handler => {
    if (typeof handler.customId === "string") {
      return handler.customId === customId;
    } else if (handler.customId instanceof RegExp) {
      return handler.customId.test(customId);
    }
    return false;
  });
}

module.exports = {handleInteraction};