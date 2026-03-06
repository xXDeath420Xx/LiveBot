import { Client, Collection, GatewayIntentBits, Partials, REST, Routes } from 'discord.js';
import logger from '../utils/logger.js';
import encryption from '../utils/encryption.js';

/**
 * Bot Manager - Manages multiple Discord client connections
 * Each bot instance shares the same commands, events, and database
 * Similar to MEE6's architecture where each server can use a custom bot
 */
class BotManager {
    constructor() {
        this.clients = new Map(); // Map<botId, ClientInstance>
        this.guildBotMapping = new Map(); // Map<guildId, botId>
        this.defaultBotId = 'default';
        this.commandLoader = null;
        this.eventLoader = null;
        // Shared command collection - loaded once, used by all bots
        this.sharedCommands = null;
    }

    /**
     * Create a new bot client with standard configuration
     */
    createClient() {
        return new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMembers,
                GatewayIntentBits.GuildVoiceStates,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMessageReactions,
                GatewayIntentBits.GuildInvites,
                GatewayIntentBits.GuildPresences,
                GatewayIntentBits.GuildModeration,
                GatewayIntentBits.GuildEmojisAndStickers,
                GatewayIntentBits.GuildIntegrations,
                GatewayIntentBits.AutoModerationConfiguration,
                GatewayIntentBits.AutoModerationExecution,
                GatewayIntentBits.DirectMessages
            ],
            partials: [
                Partials.Message,
                Partials.Channel,
                Partials.Reaction,
                Partials.User,
                Partials.GuildMember
            ]
        });
    }

    /**
     * Initialize the default bot (main CertiFried Utility bot)
     */
    async initializeDefaultBot(token) {
        const client = this.createClient();
        client.botId = this.defaultBotId;
        client.isDefaultBot = true;

        // Initialize collections
        client.commands = new Collection();
        client.cooldowns = new Collection();

        await this.attachLoaders(client);

        // Store the loaded commands as shared for other bots to use
        this.sharedCommands = client.commands;
        logger.info(`[BotManager] Shared command collection initialized with ${this.sharedCommands.size} commands`);

        this.setupReconnectionHandler(client);

        await client.login(token);

        this.clients.set(this.defaultBotId, client);
        logger.info('[BotManager] Default bot initialized');

        return client;
    }

    /**
     * Add a custom bot for specific guilds
     * @param {object} botConfig - Bot configuration
     * @param {string} botConfig.bot_id - Discord bot user ID
     * @param {object} botConfig.bot_token - Encrypted token object {iv, encryptedData, authTag}
     * @param {string[]} botConfig.guild_ids - Array of guild IDs this bot serves
     */
    async addCustomBot(botConfig) {
        const { bot_id, bot_name, bot_token, guild_ids } = botConfig;

        try {
            logger.info(`[BotManager] Step 1/7: Decrypting token for ${bot_name}...`);

            // Decrypt token before use
            let decryptedToken;
            try {
                decryptedToken = encryption.decrypt(bot_token);
                logger.info(`[BotManager] Step 1/7: ✅ Token decrypted successfully for ${bot_name}`);
            } catch (decryptError) {
                logger.error(`[BotManager] Step 1/7: ❌ Token decryption failed for ${bot_name}:`, {
                    error: decryptError.message,
                    bot_id,
                    tokenStructure: bot_token ? Object.keys(bot_token) : 'null'
                });
                throw new Error(`Token decryption failed: ${decryptError.message}`);
            }

            logger.info(`[BotManager] Step 2/7: Creating Discord client for ${bot_name}...`);
            const client = this.createClient();
            client.botId = bot_id;
            client.botName = bot_name; // Add bot name to client
            client.isDefaultBot = false;
            client.assignedGuilds = guild_ids;

            // Use shared commands from default bot instead of loading again (saves ~20MB memory per bot)
            if (this.sharedCommands) {
                client.commands = this.sharedCommands;
                logger.info(`[BotManager] Step 2/7: ✅ Using shared command collection (${client.commands.size} commands)`);
            } else {
                client.commands = new Collection();
                logger.warn(`[BotManager] Step 2/7: Shared commands not available, loading fresh`);
            }
            client.cooldowns = new Collection();
            logger.info(`[BotManager] Step 2/7: ✅ Discord client created for ${bot_name}`);

            logger.info(`[BotManager] Step 3/7: Attaching event loaders for ${bot_name}...`);
            // Only load events, not commands (commands are shared)
            if (this.eventLoader) {
                await this.eventLoader(client);
            }
            // Only load commands if shared commands weren't available
            if (!this.sharedCommands && this.commandLoader) {
                await this.commandLoader(client);
            }
            logger.info(`[BotManager] Step 3/7: ✅ Loaders attached (${client.commands.size} commands) for ${bot_name}`);

            logger.info(`[BotManager] Step 4/7: Setting up reconnection handler for ${bot_name}...`);
            this.setupReconnectionHandler(client);
            logger.info(`[BotManager] Step 4/7: ✅ Reconnection handler set up for ${bot_name}`);

            logger.info(`[BotManager] Step 5/7: Logging in to Discord for ${bot_name}...`);
            try {
                await client.login(decryptedToken);
                logger.info(`[BotManager] Step 5/7: ✅ Successfully logged in to Discord as ${bot_name}`);
            } catch (loginError) {
                logger.error(`[BotManager] Step 5/7: ❌ Login failed for ${bot_name}:`, {
                    error: loginError.message,
                    code: loginError.code,
                    bot_id,
                    tokenLength: decryptedToken ? decryptedToken.length : 0
                });
                throw new Error(`Discord login failed: ${loginError.message}`);
            }

            logger.info(`[BotManager] Step 6/7: Registering bot ${bot_name} in bot manager...`);
            this.clients.set(bot_id, client);

            // Map guilds to this bot
            for (const guildId of guild_ids) {
                this.guildBotMapping.set(guildId, bot_id);
            }
            logger.info(`[BotManager] Step 6/7: ✅ Bot ${bot_name} registered, managing ${guild_ids.length} guild(s)`);

            logger.info(`[BotManager] Step 7/7: Deploying slash commands for ${bot_name}...`);
            // Deploy commands to Discord automatically (don't throw on failure)
            await this.deployCommandsForBot(client, bot_id);
            logger.info(`[BotManager] Step 7/7: ✅ Command deployment completed for ${bot_name}`);

            logger.info(`[BotManager] 🎉 Custom bot ${bot_name} (${bot_id}) fully initialized and ready!`);

            return client;
        } catch (error) {
            logger.error(`[BotManager] ❌ CRITICAL: Failed to initialize bot ${bot_name} (${bot_id}):`, {
                error: error.message,
                stack: error.stack,
                code: error.code,
                bot_id,
                bot_name
            });
            throw error;
        }
    }

    /**
     * Deploy slash commands to Discord API for a specific bot
     */
    async deployCommandsForBot(client, botId) {
        try {
            // Extract command data from client.commands collection
            const commandData = Array.from(client.commands.values())
                .map(cmd => cmd.data.toJSON());

            if (commandData.length === 0) {
                logger.warn(`[BotManager] No commands found to deploy for bot ${botId}`);
                return;
            }

            logger.info(`[BotManager] Deploying ${commandData.length} commands for bot ${botId}`);

            const rest = new REST().setToken(client.token);

            // For custom bots, deploy to specific guilds instead of globally
            // This ensures instant command availability and proper visibility
            if (!client.isDefaultBot && client.assignedGuilds && client.assignedGuilds.length > 0) {
                logger.info(`[BotManager] Deploying commands to ${client.assignedGuilds.length} guild(s) for custom bot ${botId}`);

                let successCount = 0;
                for (const guildId of client.assignedGuilds) {
                    try {
                        await rest.put(
                            Routes.applicationGuildCommands(botId, guildId),
                            { body: commandData }
                        );
                        successCount++;
                        logger.debug(`[BotManager] Deployed commands to guild ${guildId} for bot ${botId}`);
                    } catch (guildError) {
                        logger.error(`[BotManager] Failed to deploy commands to guild ${guildId}:`, {
                            error: guildError.message,
                            botId,
                            guildId
                        });
                    }
                }
                logger.info(`[BotManager] Successfully deployed commands to ${successCount}/${client.assignedGuilds.length} guild(s) for bot ${botId}`);

                // Hide the default bot's global commands in this guild by deploying
                // empty guild commands for the default bot. Guild commands override
                // global commands, so this prevents users from seeing duplicate commands.
                await this.hideDefaultBotCommandsInGuilds(client.assignedGuilds);
            } else {
                // Default bot uses global commands
                const deployed = await rest.put(
                    Routes.applicationCommands(botId),
                    { body: commandData }
                );
                logger.info(`[BotManager] Successfully deployed ${deployed.length} global slash commands for bot ${botId}`);
            }
        } catch (error) {
            logger.error(`[BotManager] Failed to deploy commands for bot ${botId}:`, {
                error: error.message,
                stack: error.stack
            });
            // Don't throw - bot can still function without slash commands deployed
        }
    }

    /**
     * Hide the default bot's commands in guilds that have custom bots.
     * Deploys an empty guild command set for the default bot, which overrides
     * its global commands in those specific guilds.
     */
    async hideDefaultBotCommandsInGuilds(guildIds) {
        const defaultClient = this.clients.get(this.defaultBotId);
        if (!defaultClient || !defaultClient.token) {
            logger.warn('[BotManager] Cannot hide default bot commands - default bot not available');
            return;
        }

        const rest = new REST().setToken(defaultClient.token);
        const defaultAppId = defaultClient.application?.id || process.env.DISCORD_CLIENT_ID;

        if (!defaultAppId) {
            logger.warn('[BotManager] Cannot hide default bot commands - no application ID');
            return;
        }

        for (const guildId of guildIds) {
            try {
                await rest.put(
                    Routes.applicationGuildCommands(defaultAppId, guildId),
                    { body: [] }
                );
                logger.info(`[BotManager] Hidden default bot commands in guild ${guildId} (custom bot active)`);
            } catch (error) {
                // "Missing Access" means the default bot isn't in this guild,
                // so its global commands won't show there anyway - not a problem
                if (error.message?.includes('Missing Access') || error.status === 403) {
                    logger.debug(`[BotManager] Default bot not in guild ${guildId}, no commands to hide (OK)`);
                } else {
                    logger.error(`[BotManager] Failed to hide default bot commands in guild ${guildId}:`, {
                        error: error.message
                    });
                }
            }
        }
    }

    /**
     * Remove a custom bot
     */
    async removeCustomBot(botId) {
        const client = this.clients.get(botId);
        if (!client) {
            throw new Error(`Bot ${botId} not found`);
        }
        if (client.isDefaultBot) {
            throw new Error('Cannot remove default bot');
        }

        // Remove guild mappings
        for (const [guildId, mappedBotId] of this.guildBotMapping.entries()) {
            if (mappedBotId === botId) {
                this.guildBotMapping.delete(guildId);
            }
        }

        // Destroy client
        client.destroy();
        this.clients.delete(botId);

        logger.info(`[BotManager] Custom bot ${botId} removed`);
    }

    /**
     * Get the appropriate client for a guild
     * 1. Try the mapped custom bot first
     * 2. Search ALL connected clients for one that has the guild in cache
     * 3. Fall back to default bot only as last resort
     */
    getClientForGuild(guildId) {
        // Try mapped bot first
        const botId = this.guildBotMapping.get(guildId);
        if (botId && this.clients.has(botId)) {
            const client = this.clients.get(botId);
            if (client.isReady()) {
                return client;
            }
        }

        // Search all clients for one that actually has this guild cached
        for (const [id, client] of this.clients) {
            if (client.isReady() && client.guilds.cache.has(guildId)) {
                return client;
            }
        }

        // Last resort fallback to default bot
        return this.clients.get(this.defaultBotId);
    }

    /**
     * Get all connected clients
     */
    getAllClients() {
        return Array.from(this.clients.values());
    }

    /**
     * Get client by bot ID
     */
    getClient(botId) {
        return this.clients.get(botId);
    }

    /**
     * Get default bot client
     */
    getDefaultClient() {
        return this.clients.get(this.defaultBotId);
    }

    /**
     * Attach command and event loaders to a client
     */
    async attachLoaders(client) {
        if (this.commandLoader) {
            await this.commandLoader(client);
        }
        if (this.eventLoader) {
            await this.eventLoader(client);
        }
    }

    /**
     * Set command loader function
     * This function will be called for each bot to load commands
     */
    setCommandLoader(loaderFn) {
        this.commandLoader = loaderFn;
    }

    /**
     * Set event loader function
     * This function will be called for each bot to load events
     */
    setEventLoader(loaderFn) {
        this.eventLoader = loaderFn;
    }

    /**
     * Handle bot reconnection and errors
     */
    setupReconnectionHandler(client) {
        client.on('disconnect', () => {
            logger.warn(`[BotManager] Bot ${client.botId} disconnected`);
        });

        client.on('error', (error) => {
            logger.error(`[BotManager] Bot ${client.botId} error:`, error);
        });

        client.on('warn', (warning) => {
            logger.warn(`[BotManager] Bot ${client.botId} warning:`, warning);
        });
    }

    /**
     * Get bot status information
     */
    getBotStatus(botId) {
        const client = this.clients.get(botId);
        if (!client) return null;

        // Calculate actual HUMAN member count from guilds (exclude bots)
        let totalMembers = 0;
        if (client.isReady()) {
            client.guilds.cache.forEach(guild => {
                // Use cached members to count only humans
                const humanCount = guild.members.cache.filter(m => !m.user.bot).size;
                totalMembers += humanCount;
            });
        }

        return {
            botId: client.botId,
            isDefault: client.isDefaultBot,
            isReady: client.isReady(),
            guilds: client.guilds.cache.size,
            users: totalMembers, // Human members only (excludes bots)
            uptime: client.uptime,
            assignedGuilds: client.assignedGuilds || [],
            username: client.user?.username || 'Unknown',
            discriminator: client.user?.discriminator || '0000',
            avatar: client.user?.displayAvatarURL({ size: 128, extension: 'png' }) || null,
            avatarHash: client.user?.avatar || null
        };
    }

    /**
     * Update guild bot mapping
     */
    updateGuildMapping(guildId, botId) {
        if (botId === 'default' || botId === this.defaultBotId) {
            // Remove mapping to use default bot
            this.guildBotMapping.delete(guildId);
        } else {
            this.guildBotMapping.set(guildId, botId);
        }
        logger.info(`[BotManager] Guild ${guildId} mapped to bot ${botId}`);
    }

    /**
     * Get all bot statuses
     */
    getAllBotStatuses() {
        const statuses = [];
        for (const [botId, client] of this.clients.entries()) {
            statuses.push(this.getBotStatus(botId));
        }
        return statuses;
    }

    /**
     * UNIFIED LOOKUP: Get a guild from ANY connected bot instance
     * This allows commands to find servers across all bot instances
     * @param {string} guildId - The guild ID to find
     * @returns {Guild|null} The guild object or null if not found
     */
    getGuildFromAnyClient(guildId) {
        for (const [botId, client] of this.clients.entries()) {
            if (client.isReady() && client.guilds.cache.has(guildId)) {
                return client.guilds.cache.get(guildId);
            }
        }
        return null;
    }

    /**
     * UNIFIED LOOKUP: Get all guilds across ALL connected bot instances
     * Returns a Map to avoid duplicates (same guild might be in multiple bots theoretically)
     * @returns {Map<string, Guild>} Map of guildId -> Guild object
     */
    getAllGuildsUnified() {
        const allGuilds = new Map();
        for (const [botId, client] of this.clients.entries()) {
            if (client.isReady()) {
                client.guilds.cache.forEach(guild => {
                    if (!allGuilds.has(guild.id)) {
                        allGuilds.set(guild.id, guild);
                    }
                });
            }
        }
        return allGuilds;
    }

    /**
     * UNIFIED LOOKUP: Get total member count across all bot instances
     * @returns {number} Total unique members
     */
    getTotalMemberCount() {
        let total = 0;
        const seenGuilds = new Set();
        for (const [botId, client] of this.clients.entries()) {
            if (client.isReady()) {
                client.guilds.cache.forEach(guild => {
                    if (!seenGuilds.has(guild.id)) {
                        seenGuilds.add(guild.id);
                        total += guild.memberCount || 0;
                    }
                });
            }
        }
        return total;
    }

    /**
     * UNIFIED LOOKUP: Get total guild count across all bot instances
     * @returns {number} Total unique guilds
     */
    getTotalGuildCount() {
        return this.getAllGuildsUnified().size;
    }

    /**
     * UNIFIED LOOKUP: Find a user across all bot instances
     * @param {string} userId - The user ID to find
     * @returns {User|null} The user object or null
     */
    getUserFromAnyClient(userId) {
        for (const [botId, client] of this.clients.entries()) {
            if (client.isReady() && client.users.cache.has(userId)) {
                return client.users.cache.get(userId);
            }
        }
        return null;
    }

    /**
     * UNIFIED LOOKUP: Fetch a user from any client (with API call if needed)
     * @param {string} userId - The user ID to fetch
     * @returns {Promise<User|null>} The user object or null
     */
    async fetchUserFromAnyClient(userId) {
        // First try cache
        const cachedUser = this.getUserFromAnyClient(userId);
        if (cachedUser) return cachedUser;

        // Try fetching from each client
        for (const [botId, client] of this.clients.entries()) {
            if (client.isReady()) {
                try {
                    const user = await client.users.fetch(userId);
                    if (user) return user;
                } catch (e) {
                    // Continue to next client
                }
            }
        }
        return null;
    }

    /**
     * UNIFIED LOOKUP: Find a member in a guild across all bot instances
     * @param {string} guildId - The guild ID
     * @param {string} userId - The user ID
     * @returns {GuildMember|null} The member object or null
     */
    getMemberFromAnyClient(guildId, userId) {
        const guild = this.getGuildFromAnyClient(guildId);
        if (guild && guild.members.cache.has(userId)) {
            return guild.members.cache.get(userId);
        }
        return null;
    }

    /**
     * UNIFIED LOOKUP: Fetch a member from any client (with API call if needed)
     * @param {string} guildId - The guild ID
     * @param {string} userId - The user ID
     * @returns {Promise<GuildMember|null>} The member object or null
     */
    async fetchMemberFromAnyClient(guildId, userId) {
        const guild = this.getGuildFromAnyClient(guildId);
        if (!guild) return null;

        // Try cache first
        if (guild.members.cache.has(userId)) {
            return guild.members.cache.get(userId);
        }

        // Fetch from API
        try {
            return await guild.members.fetch(userId);
        } catch (e) {
            return null;
        }
    }

    /**
     * UNIFIED LOOKUP: Search guilds by name across all bot instances
     * @param {string} query - Search query (partial name match)
     * @returns {Guild[]} Array of matching guilds
     */
    searchGuildsByName(query) {
        const results = [];
        const seenGuilds = new Set();
        const lowerQuery = query.toLowerCase();

        for (const [botId, client] of this.clients.entries()) {
            if (client.isReady()) {
                client.guilds.cache.forEach(guild => {
                    if (!seenGuilds.has(guild.id) && guild.name.toLowerCase().includes(lowerQuery)) {
                        seenGuilds.add(guild.id);
                        results.push(guild);
                    }
                });
            }
        }
        return results;
    }
}

export default new BotManager();
