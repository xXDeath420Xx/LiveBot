"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleInteraction = handleInteraction;
const logger_1 = __importDefault(require("../utils/logger"));
const status_manager_1 = require("./status-manager");
const db_1 = __importDefault(require("../utils/db"));
const discord_js_1 = require("discord.js");
const custom_command_handler_1 = require("./custom-command-handler");
async function handleInteraction(interaction) {
    const guildId = interaction.guild ? interaction.guild.id : 'DM';
    const botStatus = (0, status_manager_1.getStatus)();
    if (botStatus.state !== "ONLINE") {
        if (interaction.isRepliable()) {
            await interaction.reply({ content: `The bot is currently ${botStatus.state.toLowerCase()}. Please try again in a moment.`, ephemeral: true });
        }
        return;
    }
    try {
        if (interaction.isChatInputCommand()) {
            const command = interaction.client.commands.get(interaction.commandName);
            if (!command) {
                const isCustom = await (0, custom_command_handler_1.handleCustomCommand)(interaction);
                if (!isCustom) {
                    logger_1.default.warn(`No command matching ${interaction.commandName} was found.`, { guildId, category: 'interaction' });
                }
                return;
            }
            const member = interaction.member;
            if (!member)
                return;
            const isAdministrator = member.permissions.has(discord_js_1.PermissionsBitField.Flags.Administrator);
            if (!isAdministrator) {
                const [allowedRoles] = await db_1.default.execute("SELECT role_id FROM bot_permissions WHERE guild_id = ? AND command = ?", [interaction.guild.id, interaction.commandName]);
                const requiredRoles = allowedRoles.map(r => r.role_id);
                if (requiredRoles.length > 0) {
                    const hasRole = member.roles.cache.some(role => requiredRoles.includes(role.id));
                    if (!hasRole) {
                        return interaction.reply({ content: "You do not have the required role to use this command.", ephemeral: true });
                    }
                }
                else {
                    const defaultPermissions = command.data.defaultMemberPermissions;
                    if (defaultPermissions && !member.permissions.has(defaultPermissions)) {
                        return interaction.reply({ content: "You do not have the default required permissions to use this command.", ephemeral: true });
                    }
                }
            }
            await command.execute(interaction);
        }
        else if (interaction.isAutocomplete()) {
            const command = interaction.client.commands.get(interaction.commandName);
            if (command && command.autocomplete) {
                await command.autocomplete(interaction);
            }
        }
        else if (interaction.isButton()) {
            const handler = findHandler(interaction.client.buttons, interaction.customId);
            if (handler) {
                await handler.execute(interaction);
            }
            else {
                logger_1.default.warn(`No button handler found for custom ID: ${interaction.customId}`, { guildId, category: 'interaction' });
            }
        }
        else if (interaction.isModalSubmit()) {
            const handler = findHandler(interaction.client.modals, interaction.customId);
            if (handler) {
                await handler.execute(interaction);
            }
            else {
                logger_1.default.warn(`No modal handler found for custom ID: ${interaction.customId}`, { guildId, category: 'interaction' });
            }
        }
        else if (interaction.isStringSelectMenu() || interaction.isChannelSelectMenu()) {
            const handler = findHandler(interaction.client.selects, interaction.customId);
            if (handler) {
                await handler.execute(interaction);
            }
            else {
                logger_1.default.warn(`No select menu handler found for custom ID: ${interaction.customId}`, { guildId, category: 'interaction' });
            }
        }
    }
    catch (error) {
        logger_1.default.error(`Error during interaction handling for custom ID ${interaction.isRepliable() ? interaction.customId : 'N/A'}`, { guildId, category: 'interaction', error: error.stack });
        try {
            // Only attempt to respond if the interaction is still valid
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: "There was an error while processing this interaction!", ephemeral: true }).catch(e => {
                    logger_1.default.warn(`Failed to send error reply: ${e.message}`, { guildId, category: 'interaction' });
                });
            }
            else if (interaction.isRepliable()) {
                await interaction.followUp({ content: "There was an error while processing this interaction!", ephemeral: true }).catch(e => {
                    logger_1.default.warn(`Failed to send error followup: ${e.message}`, { guildId, category: 'interaction' });
                });
            }
        }
        catch (replyError) {
            logger_1.default.warn(`Could not respond to interaction error: ${replyError.message}`, { guildId, category: 'interaction' });
        }
    }
}
function findHandler(collection, customId) {
    return collection.find(handler => {
        if (typeof handler.customId === "string") {
            return handler.customId === customId;
        }
        else if (handler.customId instanceof RegExp) {
            return handler.customId.test(customId);
        }
        return false;
    });
}
