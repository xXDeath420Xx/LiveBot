const db = require('../utils/db');
const logger = require('../utils/logger');

// A simple cache to reduce database lookups
const commandCache = new Map();
setInterval(() => commandCache.clear(), 5 * 60 * 1000); // Clear cache every 5 minutes

async function handleCustomCommand(interaction) {
    if (!interaction.isChatInputCommand()) return false;

    const guildId = interaction.guild.id;
    const commandName = interaction.commandName.toLowerCase();
    const cacheKey = `${guildId}:${commandName}`;
    let command;

    if (commandCache.has(cacheKey)) {
        command = commandCache.get(cacheKey);
    } else {
        const [rows] = await db.execute('SELECT response, action_type, action_content FROM custom_commands WHERE guild_id = ? AND command_name = ?', [guildId, commandName]);
        if (rows.length > 0) {
            command = rows[0];
            commandCache.set(cacheKey, command);
        }
    }

    if (command) {
        try {
            const response = parseVariables(command.response, interaction);
            
            switch (command.action_type) {
                case 'reply':
                    await interaction.reply(response);
                    break;
                case 'send_to_channel':
                    const channel = await interaction.guild.channels.fetch(command.action_content).catch(() => null);
                    if (channel && channel.isTextBased()) {
                        await channel.send(response);
                        await interaction.reply({ content: 'Custom command executed.', ephemeral: true });
                    } else {
                        await interaction.reply({ content: 'Error: The channel configured for this command no longer exists.', ephemeral: true });
                    }
                    break;
                case 'dm_user':
                    await interaction.user.send(response);
                    await interaction.reply({ content: 'Custom command executed. Check your DMs.', ephemeral: true });
                    break;
            }
            return true;
        } catch (error) {
            logger.error(`[CustomCommandHandler] Error executing command '${commandName}':`, error);
            await interaction.reply({ content: 'There was an error trying to execute that custom command.', ephemeral: true });
            return true; // Still counts as handled
        }
    }
    return false;
}

function parseVariables(text, interaction) {
    const replacements = {
        '{user.name}': interaction.user.username,
        '{user.mention}': interaction.user.toString(),
        '{user.id}': interaction.user.id,
        '{user.tag}': interaction.user.tag,
        '{channel.name}': interaction.channel.name,
        '{channel.mention}': interaction.channel.toString(),
        '{channel.id}': interaction.channel.id,
        '{server.name}': interaction.guild.name,
        '{server.id}': interaction.guild.id,
    };

    let parsedText = text;
    for (const [variable, value] of Object.entries(replacements)) {
        parsedText = parsedText.replace(new RegExp(variable, 'g'), value);
    }
    return parsedText;
}

function invalidateCommandCache(guildId, commandName) {
    const cacheKey = `${guildId}:${commandName.toLowerCase()}`;
    if (commandCache.has(cacheKey)) {
        commandCache.delete(cacheKey);
    }
}

module.exports = { handleCustomCommand, invalidateCommandCache };