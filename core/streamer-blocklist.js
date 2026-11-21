/*
 * Per-server "never announce these streamers" list (guild_streamer_blocklist, migration 479).
 * Edited on the dashboard page "Blocked streamers" (dashboard/routes/features/streamer-blocklist.js).
 *
 * Who honours it:
 *   core/stream-manager.js           go-live posts of every kind (stream alerts, shoutout-channel
 *                                    subscriptions, auto-tracked members, team members), because blocked
 *                                    subscriptions are dropped before the live check runs
 *   events/presenceUpdate.js         auto-track does not subscribe a blocked streamer
 *   utils/streamer-cross-pollinate.js  cross-server auto-subscribe skips them
 *   core/community-support-manager.js  the monthly rotation leaves them out of the shoutout
 *   commands/admin/shoutout.js       /alerts shoutout add refuses them
 *   core/showcase-manager.js         the media showcase does not repost their uploads
 *
 * The whole table is small (an entry per blocked account per server), so it is read in one query
 * and cached for a minute; every write clears the cache. A read failure (table missing, DB down)
 * blocks nothing and is logged once: announcing as before is the safe side of an outage here.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { findBlock, findBlockByDiscordId, splitBlockedSubscriptions, normLogin, BLOCK_PLATFORMS } from './streamer-blocklist-logic.js';

const TTL_MS = 60_000;
export const MAX_ENTRIES_PER_GUILD = 500;
let cache = null;          // { at, byGuild: Map<guildId, entry[]> }
let loading = null;
let warned = false;

export function invalidateStreamerBlocklist() { cache = null; }

async function load() {
    if (cache && Date.now() - cache.at < TTL_MS) return cache.byGuild;
    if (loading) return loading;
    loading = (async () => {
        try {
            const [rows] = await pool.query(
                'SELECT id, guild_id, platform, platform_user_id, username, streamer_discord_id FROM guild_streamer_blocklist');
            const byGuild = new Map();
            for (const r of rows) {
                const g = String(r.guild_id);
                if (!byGuild.has(g)) byGuild.set(g, []);
                byGuild.get(g).push(r);
            }
            cache = { at: Date.now(), byGuild };
            warned = false;
            return byGuild;
        } catch (error) {
            if (!warned) {
                warned = true;
                logger.warn(`[StreamerBlocklist] could not read the block list (${error.code || error.message}); nothing is blocked until it can`, { category: 'streams' });
            }
            return new Map();
        } finally {
            loading = null;
        }
    })();
    return loading;
}

async function entriesFor(guildId) {
    return (await load()).get(String(guildId)) || [];
}

/** The entry blocking this account in this server, or null. */
export async function findBlockedStreamer(guildId, { platform, platformUserId = null, username = null }) {
    return findBlock(await entriesFor(guildId), { platform, platformUserId, username });
}

/** Whether a streamers row is blocked in this server (looks the row up by id). */
export async function isStreamerIdBlocked(guildId, streamerId) {
    const entries = await entriesFor(guildId);
    if (!entries.length || !streamerId) return false;
    try {
        const [[s]] = await pool.execute(
            'SELECT platform, platform_user_id, username FROM streamers WHERE streamer_id = ?', [streamerId]);
        return !!(s && findBlock(entries, { platform: s.platform, platformUserId: s.platform_user_id, username: s.username }));
    } catch {
        return false;
    }
}

/** Whether a Discord member is a blocked streamer in this server (by the Discord id stored on the entry). */
export async function isDiscordUserBlocked(guildId, discordUserId) {
    return !!findBlockByDiscordId(await entriesFor(guildId), discordUserId);
}

/** Remove blocked subscriptions from the stream manager's rows. Never throws. */
export async function dropBlockedSubscriptions(subscriptions) {
    if (!Array.isArray(subscriptions) || !subscriptions.length) return { kept: subscriptions || [], dropped: [] };
    const byGuild = await load();
    if (!byGuild.size) return { kept: subscriptions, dropped: [] };
    return splitBlockedSubscriptions(subscriptions, byGuild);
}

// ── Dashboard side ────────────────────────────────────────────────

export async function listBlockedStreamers(guildId) {
    const [rows] = await pool.execute(
        `SELECT id, platform, platform_user_id, username, display_name, streamer_discord_id, reason, added_by, created_at
           FROM guild_streamer_blocklist WHERE guild_id = ? ORDER BY username`, [String(guildId)]);
    return rows;
}

export class BlocklistError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}

/**
 * Add an account. Twitch logins are resolved to their user id (so a rename keeps the block);
 * for other platforms the id comes from our streamers table when we already track the account.
 * @param {{guildId:string, platform:string, login:string, reason?:string|null, addedBy?:string|null,
 *          resolveTwitch?: (login:string) => Promise<{id:string, login:string, display_name?:string}|null>}} opts
 */
export async function addBlockedStreamer({ guildId, platform, login, reason = null, addedBy = null, resolveTwitch = null }) {
    platform = String(platform || '').toLowerCase();
    if (!BLOCK_PLATFORMS.includes(platform)) throw new BlocklistError('Unknown platform');
    let username = normLogin(login);
    if (!username) throw new BlocklistError('Enter the streamer\'s name or channel link');

    const [[count]] = await pool.execute('SELECT COUNT(*) AS n FROM guild_streamer_blocklist WHERE guild_id = ?', [String(guildId)]);
    if (Number(count.n) >= MAX_ENTRIES_PER_GUILD) throw new BlocklistError(`The list holds up to ${MAX_ENTRIES_PER_GUILD} streamers`);

    let platformUserId = null;
    let displayName = null;
    if (platform === 'twitch' && resolveTwitch) {
        const user = await resolveTwitch(username);   // may throw BlocklistError (Twitch down)
        if (!user) throw new BlocklistError(`No Twitch channel called "${username.slice(0, 40)}"`);
        platformUserId = String(user.id);
        username = normLogin(user.login || username);
        displayName = user.display_name || null;
    }
    // What we already know about the account: its id (other platforms) and its Discord owner.
    let discordUserId = null;
    try {
        const [rows] = await pool.execute(
            `SELECT platform_user_id, discord_user_id FROM streamers
              WHERE platform = ? AND (LOWER(username) = ? OR (? IS NOT NULL AND platform_user_id = ?))
              ORDER BY discord_user_id IS NULL, streamer_id LIMIT 1`,
            [platform, username, platformUserId, platformUserId]);
        if (rows[0]) {
            platformUserId = platformUserId || rows[0].platform_user_id || null;
            discordUserId = rows[0].discord_user_id || null;
        }
    } catch { /* streamers lookup is best effort */ }

    try {
        const [r] = await pool.execute(
            `INSERT INTO guild_streamer_blocklist
               (guild_id, platform, platform_user_id, username, display_name, streamer_discord_id, reason, added_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [String(guildId), platform, platformUserId, username, displayName, discordUserId,
             reason ? String(reason).slice(0, 255) : null, addedBy ? String(addedBy) : null]);
        invalidateStreamerBlocklist();
        return { id: r.insertId, platform, platform_user_id: platformUserId, username, display_name: displayName, streamer_discord_id: discordUserId };
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') throw new BlocklistError(`${username} is already on the list`, 409);
        throw e;
    }
}

export async function removeBlockedStreamer(guildId, id) {
    const [r] = await pool.execute('DELETE FROM guild_streamer_blocklist WHERE id = ? AND guild_id = ?', [id, String(guildId)]);
    invalidateStreamerBlocklist();
    if (!r.affectedRows) throw new BlocklistError('Not on the list', 404);
}

export async function updateBlockedStreamerReason(guildId, id, reason) {
    const [r] = await pool.execute('UPDATE guild_streamer_blocklist SET reason = ? WHERE id = ? AND guild_id = ?',
        [reason ? String(reason).slice(0, 255) : null, id, String(guildId)]);
    if (!r.affectedRows) throw new BlocklistError('Not on the list', 404);
}

export default {
    findBlockedStreamer, isStreamerIdBlocked, isDiscordUserBlocked, dropBlockedSubscriptions,
    listBlockedStreamers, addBlockedStreamer, removeBlockedStreamer, updateBlockedStreamerReason,
    invalidateStreamerBlocklist,
};
