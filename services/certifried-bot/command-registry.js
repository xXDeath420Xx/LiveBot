/**
 * Command Registry for CertiFriedUtility Bot
 * Dynamically loads commands from database and merges with channel-specific configs
 */

import logger from '../../utils/logger.js';
import pool from '../../utils/db.js';

// Import built-in command handlers
import { litCommand } from './commands/lit.js';
import { sparkCommand } from './commands/spark.js';
import { fireboardCommand } from './commands/fireboard.js';
import { seshCommand, hitCommand, passCommand, dousedCommand } from './commands/sesh.js';
import { strainCommand, lineageCommand } from './commands/strain.js';
import { triviaCommand, answerCommand } from './commands/trivia.js';
import { elevatedCommand } from './commands/elevated.js';
import { tokesHelpCommand } from './commands/help.js';
import { embersCommand } from './commands/embers.js';
import { cfxCommand, cfxDailyCommand, cfxMarketCommand, cfxLeaderboardCommand, cfxSellCommand } from './commands/cfx.js';

// Map command keys to their handler functions
const commandHandlers = {
    'lit': litCommand,
    'spark': sparkCommand,
    'fireboard': fireboardCommand,
    'embers': embersCommand,
    'sesh': seshCommand,
    'hit': hitCommand,
    'pass': passCommand,
    'doused': dousedCommand,
    'strain': strainCommand,
    'lineage': lineageCommand,
    'trivia': triviaCommand,
    'answer': answerCommand,
    'elevated': elevatedCommand,
    'tokes': tokesHelpCommand,
    // CertiFried Extension game commands
    'cfx': cfxCommand,
    'cfxdaily': cfxDailyCommand,
    'cfxmarket': cfxMarketCommand,
    'cfxleaderboard': cfxLeaderboardCommand,
    'cfxsell': cfxSellCommand
};

// Cache for global command configs (TTL: 5 minutes)
let globalCommandCache = null;
let globalCacheTime = 0;
const GLOBAL_CACHE_TTL = 5 * 60 * 1000;

// Cache for channel-specific configs (Map<channelId, {config, time}>)
const channelCommandCache = new Map();
const CHANNEL_CACHE_TTL = 2 * 60 * 1000;

// Cache for custom commands (Map<channelId, {commands, time}>)
const customCommandCache = new Map();
const CUSTOM_CACHE_TTL = 2 * 60 * 1000;

/**
 * Load global command configurations from database
 */
async function loadGlobalCommands() {
    const now = Date.now();

    // Return cached if valid
    if (globalCommandCache && (now - globalCacheTime) < GLOBAL_CACHE_TTL) {
        return globalCommandCache;
    }

    try {
        const [rows] = await pool.execute(
            `SELECT * FROM tokes_global_command_config WHERE is_enabled = 1`
        );

        // Build command map: key -> config
        const commandMap = new Map();
        for (const row of rows) {
            commandMap.set(row.command_key, {
                key: row.command_key,
                handler: commandHandlers[row.command_key],
                aliases: JSON.parse(row.default_aliases || '[]'),
                response: row.default_response,
                cooldown: row.cooldown_default || 5,
                modOnly: row.mod_only === 1,
                broadcasterOnly: row.broadcaster_only === 1,
                category: row.category,
                description: row.description
            });
        }

        globalCommandCache = commandMap;
        globalCacheTime = now;

        logger.debug('[CommandRegistry] Loaded global commands', { count: commandMap.size });
        return commandMap;

    } catch (error) {
        logger.error('[CommandRegistry] Failed to load global commands', { error: error.message });
        return new Map();
    }
}

/**
 * Load channel-specific command configurations
 */
async function loadChannelCommands(channelId) {
    const now = Date.now();
    const cached = channelCommandCache.get(channelId);

    // Return cached if valid
    if (cached && (now - cached.time) < CHANNEL_CACHE_TTL) {
        return cached.config;
    }

    try {
        const [rows] = await pool.execute(
            `SELECT * FROM tokes_channel_commands WHERE channel_id = ?`,
            [channelId]
        );

        // Build override map: command_key -> config
        const overrideMap = new Map();
        for (const row of rows) {
            overrideMap.set(row.command_key, {
                enabled: row.is_enabled === 1,
                aliases: row.custom_aliases ? JSON.parse(row.custom_aliases) : null,
                response: row.custom_response,
                cooldown: row.cooldown_override,
                modOnly: row.mod_only === 1
            });
        }

        channelCommandCache.set(channelId, { config: overrideMap, time: now });
        return overrideMap;

    } catch (error) {
        logger.error('[CommandRegistry] Failed to load channel commands', { error: error.message, channelId });
        return new Map();
    }
}

/**
 * Load custom commands for a channel
 */
async function loadCustomCommands(channelId) {
    const now = Date.now();
    const cached = customCommandCache.get(channelId);

    // Return cached if valid
    if (cached && (now - cached.time) < CUSTOM_CACHE_TTL) {
        return cached.commands;
    }

    try {
        const [rows] = await pool.execute(
            `SELECT * FROM tokes_custom_commands WHERE channel_id = ? AND is_enabled = 1`,
            [channelId]
        );

        // Build custom command map: name -> config
        const customMap = new Map();
        for (const row of rows) {
            customMap.set(row.command_name.toLowerCase(), {
                id: row.id,
                name: row.command_name,
                response: row.response,
                cooldown: row.cooldown || 5,
                modOnly: row.mod_only === 1,
                useCount: row.use_count
            });
        }

        customCommandCache.set(channelId, { commands: customMap, time: now });
        return customMap;

    } catch (error) {
        logger.error('[CommandRegistry] Failed to load custom commands', { error: error.message, channelId });
        return new Map();
    }
}

/**
 * Get merged command configuration for a channel
 * Returns: { handler, response, cooldown, modOnly, isCustom }
 */
export async function getCommand(channelId, commandName) {
    const cmdLower = commandName.toLowerCase();

    // Load all configurations
    const globalCommands = await loadGlobalCommands();
    const channelOverrides = await loadChannelCommands(channelId);
    const customCommands = await loadCustomCommands(channelId);

    // Priority 1: Check custom commands
    if (customCommands.has(cmdLower)) {
        const custom = customCommands.get(cmdLower);
        return {
            key: custom.name,
            handler: null, // Custom commands use response template
            response: custom.response,
            cooldown: custom.cooldown,
            modOnly: custom.modOnly,
            isCustom: true,
            customId: custom.id
        };
    }

    // Priority 2: Find built-in command (by key or alias)
    let foundKey = null;
    let foundConfig = null;

    for (const [key, config] of globalCommands) {
        if (key === cmdLower) {
            foundKey = key;
            foundConfig = config;
            break;
        }
        // Check aliases
        const aliases = config.aliases || [];
        if (aliases.includes(cmdLower)) {
            foundKey = key;
            foundConfig = config;
            break;
        }
    }

    // Also check channel-specific aliases
    if (!foundKey) {
        for (const [key, config] of globalCommands) {
            const override = channelOverrides.get(key);
            if (override && override.aliases && override.aliases.includes(cmdLower)) {
                foundKey = key;
                foundConfig = config;
                break;
            }
        }
    }

    if (!foundKey || !foundConfig) {
        return null; // Command not found
    }

    // Check if globally disabled
    if (!foundConfig.handler) {
        return null;
    }

    // Check channel override
    const override = channelOverrides.get(foundKey);
    if (override && override.enabled === false) {
        return null; // Disabled for this channel
    }

    // Merge configs
    return {
        key: foundKey,
        handler: foundConfig.handler,
        response: override?.response || foundConfig.response,
        cooldown: override?.cooldown ?? foundConfig.cooldown,
        modOnly: override?.modOnly ?? foundConfig.modOnly,
        broadcasterOnly: foundConfig.broadcasterOnly,
        isCustom: false
    };
}

/**
 * Get all available commands for a channel (for help display)
 */
export async function getAvailableCommands(channelId) {
    const globalCommands = await loadGlobalCommands();
    const channelOverrides = await loadChannelCommands(channelId);
    const customCommands = await loadCustomCommands(channelId);

    const available = [];

    // Add built-in commands
    for (const [key, config] of globalCommands) {
        const override = channelOverrides.get(key);

        // Skip if disabled for this channel
        if (override && override.enabled === false) {
            continue;
        }

        available.push({
            key,
            aliases: override?.aliases || config.aliases,
            description: config.description,
            cooldown: override?.cooldown ?? config.cooldown,
            modOnly: override?.modOnly ?? config.modOnly,
            category: config.category,
            isCustom: false
        });
    }

    // Add custom commands
    for (const [name, config] of customCommands) {
        available.push({
            key: name,
            aliases: [],
            description: `Custom command`,
            cooldown: config.cooldown,
            modOnly: config.modOnly,
            category: 'custom',
            isCustom: true
        });
    }

    return available;
}

/**
 * Increment custom command use count
 */
export async function incrementCustomCommandUse(customId) {
    try {
        await pool.execute(
            `UPDATE tokes_custom_commands SET use_count = use_count + 1 WHERE id = ?`,
            [customId]
        );
    } catch (error) {
        logger.error('[CommandRegistry] Failed to increment custom command use', { error: error.message });
    }
}

/**
 * Invalidate cache for a channel
 */
export function invalidateChannelCache(channelId) {
    channelCommandCache.delete(channelId);
    customCommandCache.delete(channelId);
    logger.debug('[CommandRegistry] Invalidated cache for channel', { channelId });
}

/**
 * Invalidate global command cache
 */
export function invalidateGlobalCache() {
    globalCommandCache = null;
    globalCacheTime = 0;
    logger.debug('[CommandRegistry] Invalidated global command cache');
}

export { commandHandlers };
