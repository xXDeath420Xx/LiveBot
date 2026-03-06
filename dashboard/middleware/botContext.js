import logger from '../../utils/logger.js';

/**
 * Middleware to handle bot context switching
 * Allows users to switch between different bot instances when managing a guild
 */
export function botContext(req, res, next) {
    const guildId = req.params.guildId;

    // Get requested bot ID from query param, header, or session
    const requestedBotId = req.query.botId || req.headers['x-bot-id'] || req.session?.selectedBotId;

    // Default bot client
    let botClient = req.app.locals.client;
    let selectedBotId = 'default';

    if (guildId && global.botManager) {
        // Check if a specific bot was requested
        if (requestedBotId && requestedBotId !== 'default') {
            const customClient = global.botManager.clients.get(requestedBotId);
            if (customClient && customClient.guilds.cache.has(guildId)) {
                botClient = customClient;
                selectedBotId = requestedBotId;
            }
        }

        // If no specific bot requested or requested bot doesn't have guild,
        // find any bot that has this guild
        if (selectedBotId === 'default' && !botClient.guilds.cache.has(guildId)) {
            const foundClient = global.botManager.getClientForGuild(guildId);
            if (foundClient) {
                botClient = foundClient;
                // Find the bot ID for this client
                for (const [id, client] of global.botManager.clients.entries()) {
                    if (client === foundClient) {
                        selectedBotId = id;
                        break;
                    }
                }
            }
        }
    }

    // Store in session for persistence
    if (req.session && guildId) {
        req.session.selectedBotId = selectedBotId;
    }

    // Attach to request for use in routes
    req.botClient = botClient;
    req.selectedBotId = selectedBotId;

    // Make available in templates
    res.locals.selectedBotId = selectedBotId;
    res.locals.availableBots = getAvailableBotsForGuild(guildId);

    next();
}

/**
 * Get list of all bots available in a guild
 * @param {string} guildId - Guild ID
 * @returns {Array} Array of { id, name, avatar } objects
 */
function getAvailableBotsForGuild(guildId) {
    const bots = [];

    if (!global.botManager) return bots;

    for (const [botId, client] of global.botManager.clients.entries()) {
        if (client.guilds.cache.has(guildId)) {
            const guild = client.guilds.cache.get(guildId);
            const botMember = guild.members.cache.get(client.user.id);

            bots.push({
                id: botId,
                name: botMember?.displayName || client.user.username,
                username: client.user.username,
                avatar: client.user.displayAvatarURL({ size: 64 }),
                isDefault: botId === 'default'
            });
        }
    }

    return bots;
}

/**
 * API endpoint handler to switch bot context
 */
export function switchBotContext(req, res) {
    const { botId, guildId } = req.body;

    if (!botId || !guildId) {
        return res.status(400).json({ error: 'Missing botId or guildId' });
    }

    // Verify bot has access to guild
    if (global.botManager) {
        const client = global.botManager.clients.get(botId);
        if (!client || !client.guilds.cache.has(guildId)) {
            return res.status(404).json({ error: 'Bot not found in guild' });
        }
    }

    // Store in session
    req.session.selectedBotId = botId;

    logger.info(`[BotContext] User ${req.user?.username} switched to bot ${botId} for guild ${guildId}`);

    res.json({ success: true, botId });
}

/**
 * Get the appropriate Discord client for a guild
 * @param {Object} req - Express request object
 * @param {string} guildId - Guild ID
 * @returns {Object} Discord.js client
 */
export function getClientForGuild(req, guildId) {
    if (global.botManager) {
        return global.botManager.getClientForGuild(guildId) || req.app.locals.client;
    }
    return req.app.locals.client;
}

export default {
    botContext,
    switchBotContext,
    getClientForGuild
};
