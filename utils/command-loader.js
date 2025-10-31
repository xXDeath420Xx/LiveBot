/**
 * Command Loader Utility
 * Shared utility for loading command data from the filesystem
 * Can be used by both the bot and the dashboard
 */

const fs = require('fs');
const path = require('path');

/**
 * Load all commands from the commands directory
 * @returns {Array} Array of command data objects
 */
function loadCommands() {
    const commands = [];
    const commandsPath = path.join(__dirname, '..', 'commands');

    try {
        const commandFiles = fs.readdirSync(commandsPath)
            .filter(file => file.endsWith('.js'));

        for (const file of commandFiles) {
            try {
                const filePath = path.join(commandsPath, file);
                // Clear require cache to get fresh data
                delete require.cache[require.resolve(filePath)];

                const command = require(filePath);

                if (command && command.data) {
                    const commandData = {
                        name: command.data.name,
                        description: command.data.description,
                        category: command.category || 'General',
                        options: command.data.options || [],
                        defaultMemberPermissions: command.data.default_member_permissions,
                        dmPermission: command.data.dm_permission,
                        // Convert to JSON format for dashboard
                        data: typeof command.data.toJSON === 'function'
                            ? command.data.toJSON()
                            : command.data
                    };

                    commands.push(commandData);
                }
            } catch (error) {
                console.error(`Error loading command from ${file}:`, error.message);
            }
        }

        console.log(`[CommandLoader] Loaded ${commands.length} commands`);
        return commands;
    } catch (error) {
        console.error('[CommandLoader] Error reading commands directory:', error);
        return [];
    }
}

/**
 * Get all unique categories from commands
 * @returns {Array} Array of category names
 */
function getCategories() {
    const commands = loadCommands();
    const categories = [...new Set(commands.map(c => c.category || 'General'))];
    return categories.sort();
}

/**
 * Get commands grouped by category
 * @returns {Object} Object with categories as keys and command arrays as values
 */
function getCommandsByCategory() {
    const commands = loadCommands();
    const grouped = {};

    for (const command of commands) {
        const category = command.category || 'General';
        if (!grouped[category]) {
            grouped[category] = [];
        }
        grouped[category].push(command);
    }

    return grouped;
}

/**
 * Get command count per category
 * @returns {Object} Object with categories as keys and counts as values
 */
function getCategoryCounts() {
    const grouped = getCommandsByCategory();
    const counts = {};

    for (const [category, commands] of Object.entries(grouped)) {
        counts[category] = commands.length;
    }

    return counts;
}

module.exports = {
    loadCommands,
    getCategories,
    getCommandsByCategory,
    getCategoryCounts
};
