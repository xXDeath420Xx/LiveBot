"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleCustomCommand = handleCustomCommand;
exports.invalidateCommandCache = invalidateCommandCache;
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
const commandCache = new Map();
setInterval(() => commandCache.clear(), 5 * 60 * 1000);
async function handleCustomCommand(interaction) {
    if (!interaction.isChatInputCommand())
        return false;
    const guildId = interaction.guild.id;
    const commandName = interaction.commandName.toLowerCase();
    const cacheKey = `${guildId}:${commandName}`;
    let command;
    if (commandCache.has(cacheKey)) {
        command = commandCache.get(cacheKey);
    }
    else {
        const [rows] = await db_1.default.execute('SELECT * FROM custom_commands WHERE guild_id = ? AND command_name = ?', [guildId, commandName]);
        if (rows.length > 0) {
            command = rows[0];
            commandCache.set(cacheKey, command);
        }
    }
    if (command) {
        try {
            // Permission Checks
            const requiredRoles = command.required_roles ? JSON.parse(command.required_roles) : [];
            if (requiredRoles.length > 0 && !interaction.member.roles.cache.some(r => requiredRoles.includes(r.id))) {
                return interaction.reply({ content: 'You do not have the required role to use this command.', ephemeral: true }).then(() => true);
            }
            const allowedChannels = command.allowed_channels ? JSON.parse(command.allowed_channels) : [];
            if (allowedChannels.length > 0 && !allowedChannels.includes(interaction.channelId)) {
                return interaction.reply({ content: `This command can only be used in the following channels: ${allowedChannels.map(id => `<#${id}>`).join(', ')}.`, ephemeral: true }).then(() => true);
            }
            const response = parseVariables(command.response, interaction);
            const targetMember = interaction.options.getMember('user') || interaction.member;
            switch (command.action_type) {
                case 'reply':
                    await interaction.reply(response);
                    break;
                case 'add_role':
                    const roleToAdd = await interaction.guild.roles.fetch(command.action_content).catch(() => null);
                    if (!roleToAdd || !roleToAdd.editable) {
                        return interaction.reply({ content: 'Error: The role configured for this command is invalid or I cannot manage it.', ephemeral: true }).then(() => true);
                    }
                    await targetMember.roles.add(roleToAdd);
                    await interaction.reply({ content: `Added the ${roleToAdd.name} role to ${targetMember.displayName}.`, ephemeral: true });
                    break;
                case 'remove_role':
                    const roleToRemove = await interaction.guild.roles.fetch(command.action_content).catch(() => null);
                    if (!roleToRemove || !roleToRemove.editable) {
                        return interaction.reply({ content: 'Error: The role configured for this command is invalid or I cannot manage it.', ephemeral: true }).then(() => true);
                    }
                    await targetMember.roles.remove(roleToRemove);
                    await interaction.reply({ content: `Removed the ${roleToRemove.name} role from ${targetMember.displayName}.`, ephemeral: true });
                    break;
            }
            return true;
        }
        catch (error) {
            if (error.code !== 'ER_BAD_FIELD_ERROR') {
                logger_1.default.error(`[CustomCommandHandler] Error executing command '${commandName}':`, error);
            }
            await interaction.reply({ content: 'There was an error trying to execute that custom command. It may not be configured correctly.', ephemeral: true });
            return true;
        }
    }
    return false;
}
function parseVariables(text, interaction) {
    if (!text)
        return '';
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
function invalidateCommandCache(guildId, commandName) {
    const cacheKey = `${guildId}:${commandName.toLowerCase()}`;
    if (commandCache.has(cacheKey)) {
        commandCache.delete(cacheKey);
    }
}
