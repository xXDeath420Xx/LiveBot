import pool from './db.js';
import logger from './logger.js';

// Cache: guildId -> { users: Set<userId>, loadedAt: number }
const cache = new Map();
const CACHE_TTL = 2 * 60 * 1000; // 2 minutes

async function loadWhitelist(guildId) {
    const cached = cache.get(guildId);
    if (cached && Date.now() - cached.loadedAt < CACHE_TTL) {
        return cached.users;
    }

    try {
        const [rows] = await pool.execute(
            'SELECT user_id FROM automod_user_whitelist WHERE guild_id = ?',
            [guildId]
        );
        const users = new Set(rows.map(r => r.user_id));
        cache.set(guildId, { users, loadedAt: Date.now() });
        return users;
    } catch (error) {
        logger.error('[AutomodWhitelist] Failed to load whitelist:', { error: error.message, guildId });
        return new Set();
    }
}

export async function isWhitelisted(guildId, userId) {
    const users = await loadWhitelist(guildId);
    return users.has(userId);
}

export async function addToWhitelist(guildId, userId, addedBy = null, reason = null) {
    await pool.execute(
        'INSERT IGNORE INTO automod_user_whitelist (guild_id, user_id, added_by, reason) VALUES (?, ?, ?, ?)',
        [guildId, userId, addedBy, reason]
    );
    cache.delete(guildId);
}

export async function removeFromWhitelist(guildId, userId) {
    await pool.execute(
        'DELETE FROM automod_user_whitelist WHERE guild_id = ? AND user_id = ?',
        [guildId, userId]
    );
    cache.delete(guildId);
}

export async function getWhitelist(guildId) {
    const [rows] = await pool.execute(
        'SELECT user_id, added_by, reason, created_at FROM automod_user_whitelist WHERE guild_id = ? ORDER BY created_at DESC',
        [guildId]
    );
    return rows;
}

export default { isWhitelisted, addToWhitelist, removeFromWhitelist, getWhitelist };
