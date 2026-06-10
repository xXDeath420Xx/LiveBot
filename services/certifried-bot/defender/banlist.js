/**
 * Shared-list store for the Kick Defender: banlist (+ sublist), unbanlist,
 * malicious sites. Network-global (not per-channel). Cached with a short TTL
 * because isOnBanlist runs on every chat message.
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const CACHE_TTL_MS = 60_000;
let cache = null;        // { ban:Set, sub:Set, unban:Set, banNames:Set, unbanNames:Set, expiresAt }
let cachePromise = null;

function key(platform, id) { return `${platform}:${id}`; }
function nameKey(platform, name) { return `${platform}:${String(name).toLowerCase()}`; }

async function loadCache() {
    const [bans] = await pool.execute('SELECT platform, platform_user_id, username, list_type FROM kbd_banlist');
    const [unbans] = await pool.execute('SELECT platform, platform_user_id, username FROM kbd_unbanlist');

    const ban = new Set(), sub = new Set(), unban = new Set(), banNames = new Set(), unbanNames = new Set();
    for (const r of bans) {
        if (r.platform_user_id) (r.list_type === 'sublist' ? sub : ban).add(key(r.platform, r.platform_user_id));
        if (r.username) banNames.add(nameKey(r.platform, r.username));
    }
    for (const r of unbans) {
        if (r.platform_user_id) unban.add(key(r.platform, r.platform_user_id));
        if (r.username) unbanNames.add(nameKey(r.platform, r.username));
    }
    cache = { ban, sub, unban, banNames, unbanNames, expiresAt: Date.now() + CACHE_TTL_MS };
    return cache;
}

async function getCache() {
    if (cache && cache.expiresAt > Date.now()) return cache;
    if (!cachePromise) {
        cachePromise = loadCache().finally(() => { cachePromise = null; });
    }
    return cachePromise;
}

// Drop both the resolved cache AND any in-flight load, so a write that races a
// reload can't leave a pre-write snapshot cached for the rest of the TTL.
export function invalidateCache() { cache = null; cachePromise = null; }

export async function isOnBanlist(platform, userId, username) {
    const c = await getCache();
    if (userId && (c.ban.has(key(platform, userId)) || c.sub.has(key(platform, userId)))) return true;
    if (username && c.banNames.has(nameKey(platform, username))) return true;
    return false;
}

export async function isOnUnbanlist(platform, userId, username) {
    const c = await getCache();
    if (userId && c.unban.has(key(platform, userId))) return true;
    if (username && c.unbanNames.has(nameKey(platform, username))) return true;
    return false;
}

export async function addBan({ platform = 'kick', userId = null, username, reason = null, listType = 'ban', addedBy = null }) {
    await pool.execute(
        `INSERT INTO kbd_banlist (platform, platform_user_id, username, reason, list_type, added_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE username = VALUES(username), reason = VALUES(reason)`,
        [platform, userId, username, reason, listType, addedBy]
    );
    invalidateCache();
    logger.info('[KBD] Added ban', { platform, userId, username, listType });
}

export async function removeBan(platform, userId, username = null) {
    if (userId) {
        await pool.execute('DELETE FROM kbd_banlist WHERE platform = ? AND platform_user_id = ?', [platform, userId]);
    } else if (username) {
        await pool.execute('DELETE FROM kbd_banlist WHERE platform = ? AND username = ?', [platform, username]);
    } else {
        logger.warn('[KBD] removeBan called with neither userId nor username');
        return;
    }
    invalidateCache();
}

export async function clearSublist() {
    await pool.execute("DELETE FROM kbd_banlist WHERE list_type = 'sublist'");
    invalidateCache();
}

export async function addUnban({ platform = 'kick', userId = null, username, addedBy = null }) {
    await pool.execute(
        `INSERT INTO kbd_unbanlist (platform, platform_user_id, username, added_by)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE username = VALUES(username)`,
        [platform, userId, username, addedBy]
    );
    invalidateCache();
}

export async function removeUnban(platform, userId, username = null) {
    if (userId) {
        await pool.execute('DELETE FROM kbd_unbanlist WHERE platform = ? AND platform_user_id = ?', [platform, userId]);
    } else if (username) {
        await pool.execute('DELETE FROM kbd_unbanlist WHERE platform = ? AND username = ?', [platform, username]);
    } else {
        logger.warn('[KBD] removeUnban called with neither userId nor username');
        return;
    }
    invalidateCache();
}

export async function addSite(uri, addedBy = null) {
    await pool.execute(
        'INSERT IGNORE INTO kbd_malicious_sites (uri, added_by) VALUES (?, ?)', [uri, addedBy]
    );
}

export async function removeSite(uri) {
    await pool.execute('DELETE FROM kbd_malicious_sites WHERE uri = ?', [uri]);
}

export async function listSites() {
    const [rows] = await pool.execute('SELECT id, uri FROM kbd_malicious_sites ORDER BY id');
    return rows;
}

// Paginated entries for the dashboard. listType 'ban' | 'sublist' for kbd_banlist.
export async function listBans(platform = 'kick', listType = 'ban', limit = 100, offset = 0) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const off = Math.max(parseInt(offset, 10) || 0, 0);
    const [rows] = await pool.execute(
        `SELECT id, platform_user_id, username, reason, added_by, created_at
         FROM kbd_banlist WHERE platform = ? AND list_type = ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [platform, listType, lim, off]
    );
    return rows;
}

export async function listUnbans(platform = 'kick', limit = 100, offset = 0) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const off = Math.max(parseInt(offset, 10) || 0, 0);
    const [rows] = await pool.execute(
        `SELECT id, platform_user_id, username, added_by, created_at
         FROM kbd_unbanlist WHERE platform = ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [platform, lim, off]
    );
    return rows;
}

export async function getCounts() {
    const [[ban]] = await pool.execute("SELECT COUNT(*) n FROM kbd_banlist WHERE list_type = 'ban'");
    const [[sub]] = await pool.execute("SELECT COUNT(*) n FROM kbd_banlist WHERE list_type = 'sublist'");
    const [[unban]] = await pool.execute('SELECT COUNT(*) n FROM kbd_unbanlist');
    const [[sites]] = await pool.execute('SELECT COUNT(*) n FROM kbd_malicious_sites');
    return { banlist: Number(ban.n), sublist: Number(sub.n), unbanlist: Number(unban.n), sites: Number(sites.n) };
}
