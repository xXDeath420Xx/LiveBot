import pool from './db.js';
import { PermissionsBitField } from 'discord.js';
import logger from './logger.js';

const configCache = new Map();
const permissionsCache = new Map(); // Cache for role permissions per guild
setInterval(() => {
    configCache.clear();
    permissionsCache.clear();
}, 5 * 60 * 1000);

/**
 * Get full music config for a guild
 */
async function getMusicConfig(guildId) {
    let config = configCache.get(guildId);
    if (config === undefined) {
        const [dbConfigRows] = await pool.execute(
            'SELECT * FROM music_config WHERE guild_id = ?',
            [guildId]
        );
        config = dbConfigRows[0] || null;
        configCache.set(guildId, config);
    }
    return config;
}

/**
 * Update music config for a guild
 */
async function updateMusicConfig(guildId, updates) {
    const keys = Object.keys(updates);
    const values = Object.values(updates);

    // Build SET clause
    const setClause = keys.map(key => `${key} = ?`).join(', ');

    await pool.execute(
        `UPDATE music_config SET ${setClause} WHERE guild_id = ?`,
        [...values, guildId]
    );

    // Clear cache
    configCache.delete(guildId);
}

/**
 * Check if 24/7 mode is enabled for a guild
 */
async function is247Enabled(guildId) {
    const config = await getMusicConfig(guildId);
    return config?.twenty_four_seven === 1;
}

/**
 * Check if autoplay is enabled for a guild
 */
async function isAutoplayEnabled(guildId) {
    const config = await getMusicConfig(guildId);
    return config?.autoplay_enabled === 1;
}

/**
 * Get autoplay source (youtube, spotify, ai)
 */
async function getAutoplaySource(guildId) {
    const config = await getMusicConfig(guildId);
    return config?.autoplay_source || 'youtube';
}

/**
 * Get request channel ID for a guild
 */
async function getRequestChannel(guildId) {
    const config = await getMusicConfig(guildId);
    return config?.request_channel_id || null;
}

/**
 * Check if vote skip is enabled
 */
async function isVoteSkipEnabled(guildId) {
    const config = await getMusicConfig(guildId);
    return config?.vote_skip_enabled === 1;
}

/**
 * Get vote skip percentage threshold
 */
async function getVoteSkipPercentage(guildId) {
    const config = await getMusicConfig(guildId);
    return config?.vote_skip_percentage || 50;
}

/**
 * Get all role permissions for a guild (batched query with caching)
 * Fixes N+1 query pattern by loading all permissions at once
 */
async function getAllGuildPermissions(guildId) {
    // Check cache first
    if (permissionsCache.has(guildId)) {
        return permissionsCache.get(guildId);
    }

    // Load all role permissions for this guild in one query
    const [rows] = await pool.execute(
        'SELECT * FROM music_permissions WHERE guild_id = ?',
        [guildId]
    );

    // Convert to Map for O(1) lookup by role_id
    const permsMap = new Map();
    for (const row of rows) {
        permsMap.set(row.role_id, row);
    }

    permissionsCache.set(guildId, permsMap);
    return permsMap;
}

/**
 * Get granular permissions for a role
 */
async function getRolePermissions(guildId, roleId) {
    const allPerms = await getAllGuildPermissions(guildId);
    return allPerms.get(roleId) || null;
}

/**
 * Check if user has specific music permission
 * Optimized: loads all guild permissions once, then checks in memory
 */
async function hasPermission(member, permission) {
    // Admins always have all permissions
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return true;
    }

    const guildId = member.guild.id;

    // Load all permissions for this guild (single query, cached)
    const allPerms = await getAllGuildPermissions(guildId);

    // Check each role the user has (no more DB queries!)
    for (const [roleId] of member.roles.cache) {
        const perms = allPerms.get(roleId);
        if (perms && perms[permission]) {
            return true;
        }
    }

    // Check @everyone permissions
    const everyonePerms = allPerms.get(guildId);
    if (everyonePerms && everyonePerms[permission]) {
        return true;
    }

    return false;
}

async function checkMusicPermissions(interaction) {
    const guildId = interaction.guild.id;

    let config = configCache.get(guildId);
    if (config === undefined) {
        const [dbConfigRows] = await pool.execute(
            'SELECT * FROM music_config WHERE guild_id = ?',
            [guildId]
        );
        config = dbConfigRows[0] || null;
        configCache.set(guildId, config);
    }

    if (!config || !config.enabled) {
        return { permitted: false, message: 'The music system is disabled on this server.' };
    }

    const textChannels = config.text_channel_ids ? JSON.parse(config.text_channel_ids) : [];
    if (textChannels.length > 0 && !textChannels.includes(interaction.channelId)) {
        return {
            permitted: false,
            message: `Music commands can only be used in the following channels: ${textChannels.map(id => `<#${id}>`).join(', ')}.`
        };
    }

    const member = interaction.member;
    const djRoleId = config.dj_role_id;

    if (!djRoleId) {
        return { permitted: true }; // No DJ role configured, so everyone is permitted
    }

    const isDJ = member.roles.cache.has(djRoleId);
    const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);
    const isAlone = member.voice.channel ? member.voice.channel.members.filter(m => !m.user.bot).size <= 1 : false;

    // Bot owner / super admin always has access
    let isBotOwner = false;
    try {
        const { isSuperAdmin } = await import('./constants.js');
        isBotOwner = isSuperAdmin(member.id);
    } catch {}

    if (isDJ || isAdmin || isAlone || isBotOwner) {
        return { permitted: true };
    } else {
        return {
            permitted: false,
            message: `You need the <@&${djRoleId}> role, be an Administrator, or be alone in the voice channel to use this command.`
        };
    }
}

// Helper function to get the player instance for a specific client
// Accepts either a client object or an interaction object
function useMainPlayer(clientOrInteraction) {
    if (!clientOrInteraction) {
        // Fallback to global player for backward compatibility
        return global.player;
    }

    // If it's an interaction, get the client from it
    const client = clientOrInteraction.client || clientOrInteraction;

    // Return the client-specific player (works for both default and custom bots)
    return client.player || global.player;
}

/**
 * Invalidate the cached music config for a guild.
 * Call this after directly writing to the music_config table outside of updateMusicConfig().
 */
function invalidateMusicConfigCache(guildId) {
    configCache.delete(guildId);
}

// Default leave-timer cooldown (ms) used when 24/7 is OFF.
const LEAVE_COOLDOWN_MS = 300000; // 5 minutes

/**
 * Build the leave-related nodeOptions for a guild based on its 24/7 setting.
 *
 * When 24/7 is enabled, discord-player must NEVER arm its empty/end leave timers,
 * so the bot stays connected even when the channel is empty or the queue ends.
 * When disabled, fall back to the standard 5-minute auto-leave behavior.
 *
 * Spread the result into a play call's `nodeOptions`, e.g.:
 *   nodeOptions: { metadata, volume, ...(await getLeaveOptions(guildId)) }
 *
 * @param {string} guildId
 * @returns {Promise<{leaveOnEmpty:boolean, leaveOnEmptyCooldown:number, leaveOnEnd:boolean, leaveOnEndCooldown:number}>}
 */
async function getLeaveOptions(guildId) {
    const is247 = await is247Enabled(guildId);
    return {
        leaveOnEmpty: !is247,
        leaveOnEmptyCooldown: LEAVE_COOLDOWN_MS,
        leaveOnEnd: !is247,
        leaveOnEndCooldown: LEAVE_COOLDOWN_MS
    };
}

/**
 * Apply the current 24/7 leave policy to an already-active queue.
 *
 * discord-player reads leaveOnEmpty/leaveOnEnd off the mutable `queue.options`
 * each time its internal timers fire, so mutating them here takes effect on the
 * live session without re-queueing. Returns false if there is no live queue.
 *
 * @param {import('discord-player').GuildQueue} queue
 * @param {boolean} is247
 * @returns {boolean} whether options were applied
 */
function applyLeaveOptionsToQueue(queue, is247) {
    if (!queue?.options) return false;
    queue.options.leaveOnEmpty = !is247;
    queue.options.leaveOnEnd = !is247;
    return true;
}

export {
    checkMusicPermissions,
    useMainPlayer,
    getMusicConfig,
    updateMusicConfig,
    invalidateMusicConfigCache,
    is247Enabled,
    getLeaveOptions,
    applyLeaveOptionsToQueue,
    isAutoplayEnabled,
    getAutoplaySource,
    getRequestChannel,
    isVoteSkipEnabled,
    getVoteSkipPercentage,
    getRolePermissions,
    hasPermission
};
