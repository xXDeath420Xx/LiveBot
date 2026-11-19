import pool from './db.js';
import { PermissionsBitField } from 'discord.js';
import logger from './logger.js';
import { EMPTY_IDLE_MS } from '../core/music-leave-policy.js';

const configCache = new Map();
setInterval(() => {
    configCache.clear();
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
 * The Music switch, the music channels and (unless `requireDJ: false`) the DJ role.
 * `requireDJ: false` is for what every listener may do even when a DJ role is set: starting a vote to skip.
 */
async function checkMusicPermissions(interaction, { requireDJ = true } = {}) {
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

    // The DJ role limits who controls playback, not who may ask the room to skip (H-667).
    if (!requireDJ) return { permitted: true };

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

/**
 * The AI DJ switch. ai_dj_config.enabled is the only one: the Music page's AI DJ switch and the AI DJ
 * page both write it (H-667; music_config.dj_enabled is no longer read).
 */
async function isAIDJEnabled(guildId) {
    const [rows] = await pool.execute('SELECT enabled FROM ai_dj_config WHERE guild_id = ?', [guildId]);
    return Number(rows[0]?.enabled) === 1;
}

/** Who may start an AI DJ session (/music dj, the panel's Start DJ form): the music checks, then the AI DJ switch. */
async function checkAIDJAccess(interaction) {
    const music = await checkMusicPermissions(interaction);
    if (!music.permitted) return music;
    if (!(await isAIDJEnabled(interaction.guild.id))) {
        return { permitted: false, message: 'The AI DJ is not enabled on this server. An admin can switch it on in the dashboard.' };
    }
    return { permitted: true };
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

/**
 * The leave-related nodeOptions for a new queue.
 *
 * Leaving voice is decided by core/music-leave-policy.js (stay while music plays, with 24/7 on, or while a
 * voice tool needs the connection; otherwise leave as soon as the queue ends), so discord-player's own
 * leave timers are always off — they only dropped the connection and left a zombie queue behind, and
 * could not see transcription, the chat reader or a recording. The policy's queueCreate / playerStart
 * hooks apply the same values to every queue; these keep a freshly created one consistent from the start.
 *
 * Kept async with the guildId parameter: many callers spread it into nodeOptions, e.g.
 *   nodeOptions: { metadata, volume, ...(await getLeaveOptions(guildId)) }
 *
 * @param {string} _guildId
 * @returns {Promise<{leaveOnEmpty:false, leaveOnEnd:false, leaveOnStop:false, pauseOnEmpty:false, leaveOnEmptyCooldown:number}>}
 */
async function getLeaveOptions(_guildId) {
    return {
        leaveOnEmpty: false,
        leaveOnEnd: false,
        leaveOnStop: false,
        pauseOnEmpty: false,
        leaveOnEmptyCooldown: EMPTY_IDLE_MS
    };
}

export {
    isAIDJEnabled,
    checkAIDJAccess,
    checkMusicPermissions,
    useMainPlayer,
    getMusicConfig,
    updateMusicConfig,
    invalidateMusicConfigCache,
    is247Enabled,
    getLeaveOptions,
    isAutoplayEnabled,
    getAutoplaySource,
    getRequestChannel,
    isVoteSkipEnabled,
    getVoteSkipPercentage
};
