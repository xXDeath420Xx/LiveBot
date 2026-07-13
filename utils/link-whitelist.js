/**
 * Link filter whitelist + config helper.
 *
 * Backs the invite-link filter (events/inviteLinkFilter.js) and any other
 * automod that needs to exempt specific users, roles, or channels from a
 * link-posting block.
 *
 * Uses a short in-memory cache (2 min TTL) per guild to avoid per-message DB hits.
 */

import pool from './db.js';
import logger from './logger.js';

// Cache: guildId -> { users: Set, roles: Set, channels: Set, config: {...}, loadedAt: number }
const cache = new Map();
const CACHE_TTL = 2 * 60 * 1000;

const DEFAULT_CONFIG = Object.freeze({
    enabled: 1,
    use_whitelist: 0,
    action: 'delete_warn',
    log_channel_id: null
});

function invalidate(guildId) {
    cache.delete(guildId);
}

async function load(guildId) {
    const cached = cache.get(guildId);
    if (cached && Date.now() - cached.loadedAt < CACHE_TTL) return cached;

    try {
        const [[configRow]] = await pool.execute(
            'SELECT enabled, use_whitelist, action, log_channel_id FROM invite_filter_config WHERE guild_id = ?',
            [guildId]
        );
        const [wlRows] = await pool.execute(
            'SELECT target_type, target_id FROM automod_link_whitelist WHERE guild_id = ?',
            [guildId]
        );

        const entry = {
            users: new Set(),
            roles: new Set(),
            channels: new Set(),
            config: configRow ? { ...DEFAULT_CONFIG, ...configRow } : { ...DEFAULT_CONFIG },
            loadedAt: Date.now()
        };
        for (const r of wlRows) {
            if (r.target_type === 'user') entry.users.add(r.target_id);
            else if (r.target_type === 'role') entry.roles.add(r.target_id);
            else if (r.target_type === 'channel') entry.channels.add(r.target_id);
        }
        cache.set(guildId, entry);
        return entry;
    } catch (error) {
        logger.error('[LinkWhitelist] Failed to load:', { error: error.message, guildId });
        // Return a permissive-failure default that doesn't break link filtering
        return {
            users: new Set(),
            roles: new Set(),
            channels: new Set(),
            config: { ...DEFAULT_CONFIG },
            loadedAt: Date.now()
        };
    }
}

/**
 * Fetch the invite-filter config for a guild. Returns defaults if no row exists.
 */
export async function getConfig(guildId) {
    const { config } = await load(guildId);
    return config;
}

/**
 * Update (upsert) the invite-filter config for a guild.
 * `patch` is an object with any subset of: enabled, use_whitelist, action, log_channel_id.
 */
export async function setConfig(guildId, patch) {
    const allowedKeys = ['enabled', 'use_whitelist', 'action', 'log_channel_id'];
    const current = await getConfig(guildId);
    const next = { ...current };
    for (const k of allowedKeys) {
        if (k in patch) next[k] = patch[k];
    }

    await pool.execute(
        `INSERT INTO invite_filter_config (guild_id, enabled, use_whitelist, action, log_channel_id)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            enabled = VALUES(enabled),
            use_whitelist = VALUES(use_whitelist),
            action = VALUES(action),
            log_channel_id = VALUES(log_channel_id)`,
        [guildId, next.enabled ? 1 : 0, next.use_whitelist ? 1 : 0, next.action, next.log_channel_id]
    );
    invalidate(guildId);
    return next;
}

/**
 * Check whether a message's author/roles/channel should be allowed to post a link.
 * Only meaningful when `config.use_whitelist` is enabled — callers should check that first.
 *
 * @param {string} guildId
 * @param {{ userId: string, roleIds?: string[]|Iterable<string>, channelId?: string }} ctx
 */
export async function isAllowed(guildId, { userId, roleIds, channelId }) {
    const { users, roles, channels } = await load(guildId);
    if (userId && users.has(userId)) return true;
    if (channelId && channels.has(channelId)) return true;
    if (roleIds) {
        for (const rid of roleIds) {
            if (roles.has(rid)) return true;
        }
    }
    return false;
}

/**
 * Add a user/role/channel to the whitelist.
 */
export async function addEntry(guildId, targetType, targetId, addedBy = null, reason = null) {
    if (!['user', 'role', 'channel'].includes(targetType)) {
        throw new Error(`Invalid target_type: ${targetType}`);
    }
    await pool.execute(
        'INSERT IGNORE INTO automod_link_whitelist (guild_id, target_type, target_id, added_by, reason) VALUES (?, ?, ?, ?, ?)',
        [guildId, targetType, targetId, addedBy, reason]
    );
    invalidate(guildId);
}

/**
 * Remove a user/role/channel from the whitelist.
 */
export async function removeEntry(guildId, targetType, targetId) {
    await pool.execute(
        'DELETE FROM automod_link_whitelist WHERE guild_id = ? AND target_type = ? AND target_id = ?',
        [guildId, targetType, targetId]
    );
    invalidate(guildId);
}

/**
 * List all whitelist entries for a guild, grouped by type.
 */
export async function listEntries(guildId) {
    const [rows] = await pool.execute(
        'SELECT target_type, target_id, added_by, reason, created_at FROM automod_link_whitelist WHERE guild_id = ? ORDER BY created_at DESC',
        [guildId]
    );
    const grouped = { users: [], roles: [], channels: [] };
    for (const r of rows) {
        if (r.target_type === 'user') grouped.users.push(r);
        else if (r.target_type === 'role') grouped.roles.push(r);
        else if (r.target_type === 'channel') grouped.channels.push(r);
    }
    return grouped;
}

export default { getConfig, setConfig, isAllowed, addEntry, removeEntry, listEntries };
