/*
 * Where a per-server (guildScoped) command is available: the same rule its registration follows.
 *
 * guildScoped commands (/ban, /modreason, /weekly-recap, /grow, /cannabis and the smoke-circle commands)
 * are kept out of the main bot's global command set, which is what the Discord App Directory reviews
 * (core/bot-manager.js, deploy-commands.js). They are registered only:
 *   - by the main bot, in servers with an enabled guild_scoped_commands row, limited to that row's
 *     command_names when it has a list (scripts/deploy-guild-scoped-commands.js, migration 436);
 *   - by a custom bot, in the servers it serves (client.assignedGuilds, from guild_bot_mapping).
 *
 * The chat bridge (core/universal-commands.js) and the legacy prefix commands (core/prefix-command-manager.js)
 * check this before running one, so `!puff` or `/cannabis` typed as a message does nothing where the
 * command is not registered (H-711). The dashboard asks the same question for the Ban requests section (H-712).
 *
 * A database error fails closed: the command stays unavailable (or keeps the last answer for that server).
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const TTL_MS = 60_000;
const cache = new Map();   // guildId -> { at, names: null | 'all' | Set<string> }
let db = pool;

/** Tests: use another database handle ({ execute }) and start with an empty cache. */
export function _setDb(next) { db = next || pool; cache.clear(); }

/** Forget the cached opt-in for one server (or all of them). */
export function clearScopedCache(guildId = null) {
    if (guildId == null) cache.clear();
    else cache.delete(String(guildId));
}

/**
 * A guild_scoped_commands row as the deploy script reads it.
 * @returns {null | 'all' | Set<string>} null: not opted in; 'all': every guildScoped command; else the listed names
 */
export function namesFromRow(row) {
    if (!row || !Number(row.enabled)) return null;
    if (row.command_names == null || row.command_names === '') return 'all';
    try {
        const list = JSON.parse(row.command_names);
        return Array.isArray(list) ? new Set(list.map(String)) : 'all';
    } catch {
        return 'all';   // the deploy script registers every guildScoped command when the list cannot be read
    }
}

async function optedIn(guildId) {
    const key = String(guildId);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.names;
    try {
        const [rows] = await db.execute(
            'SELECT enabled, command_names FROM guild_scoped_commands WHERE guild_id = ? LIMIT 1', [key]);
        const names = namesFromRow(rows?.[0]);
        cache.set(key, { at: Date.now(), names });
        if (cache.size > 5000) cache.delete(cache.keys().next().value);
        return names;
    } catch (err) {
        logger.warn(`[GuildScoped] opt-in lookup failed for ${key}: ${err.message}`);
        return hit ? hit.names : null;
    }
}

/** Would the main bot register guildScoped command `name` in this server? */
export async function isOptedIn(guildId, name) {
    if (!guildId || !name) return false;
    const names = await optedIn(guildId);
    return names === 'all' || (names instanceof Set && names.has(String(name)));
}

/**
 * Chat path: may `client` run guildScoped command `name` in `guildId`?
 * A custom bot registers its guildScoped commands in every server it serves; the main bot only in opted-in ones.
 */
export async function isScopedCommandAvailable(client, guildId, name) {
    if (!guildId) return false;
    if (client && client.isDefaultBot === false) {
        const assigned = client.assignedGuilds;
        return !Array.isArray(assigned) || assigned.map(String).includes(String(guildId));
    }
    return isOptedIn(guildId, name);
}

/**
 * Dashboard: is guildScoped command `name` registered in this server, by a custom bot that serves it
 * (a guild_bot_mapping row, the same test utils/custom-bot-check.js uses) or by the main bot's opt-in?
 */
export async function isCommandAvailableInGuild(guildId, name) {
    if (!guildId) return false;
    try {
        const [rows] = await db.execute('SELECT 1 FROM guild_bot_mapping WHERE guild_id = ? LIMIT 1', [String(guildId)]);
        if (rows?.length) return true;
    } catch (err) {
        logger.warn(`[GuildScoped] custom bot lookup failed for ${guildId}: ${err.message}`);
    }
    return isOptedIn(guildId, name);
}

/**
 * The guildScoped command a legacy prefix command (core/prefix-command-registry.js) stands in for:
 * the 'cannabis' category runs the /cannabis toke handlers or the /grow handlers.
 * @returns {string|null}
 */
export function legacyScopedCommand(def) {
    if (!def || def.category !== 'cannabis') return null;
    return /\/grow-[^/]*\.js$/.test(String(def.handler?.file || '')) ? 'grow' : 'cannabis';
}
