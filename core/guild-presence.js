/**
 * Guild presence: keeping `guilds.left_at` true across 40-odd bot clients.
 *
 * `guilds` is one table shared by every client in the process, but each client
 * only sees its own servers. Two things went wrong because of that:
 *
 *  - guildDelete marked the whole server as left whenever ANY client left it.
 *    On 2026-10-11 the main bot handed Bubbamike77's server to Bubba Bot and
 *    left, and the server was recorded as abandoned while Bubba Bot was serving
 *    it. left_at is not cosmetic: sticky roles throws away its member snapshots
 *    for a left server, and guildCreate treats the next join as a "rejoin".
 *
 *  - Nothing ever recorded a bot being removed while the process was down,
 *    because a single client cannot tell "not mine" from "gone". Five servers
 *    sat as "served" for months with no bot in them.
 *
 * The rule for both: a server is left only when no ready client has it. For the
 * startup sweep there is one more condition — the bot responsible for the server
 * (its custom bot, else the main bot) must itself be ready. A bot that failed to
 * log in this boot says nothing about whether it is still in its server, and a
 * flaky login must not mark a server left.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { servedByAnotherClient, guildsToMarkLeft } from './guild-presence-logic.js';

export { servedByAnotherClient, guildsToMarkLeft };

export async function reconcileGuildPresence(botManager) {
    const readyBotIds = new Set();
    const presentGuildIds = new Set();
    for (const [botId, client] of botManager.clients) {
        if (!client.isReady()) continue;
        readyBotIds.add(botId);
        for (const id of client.guilds.cache.keys()) presentGuildIds.add(id);
    }
    if (!readyBotIds.size) return [];

    const [open] = await pool.execute('SELECT guild_id FROM guilds WHERE left_at IS NULL');
    const [maps] = await pool.execute('SELECT guild_id, bot_id FROM guild_bot_mapping');
    const gone = guildsToMarkLeft({
        openGuildIds: open.map(r => r.guild_id),
        presentGuildIds,
        readyBotIds,
        mapping: new Map(maps.map(m => [m.guild_id, m.bot_id])),
        mainBotId: botManager.defaultBotId,
    });
    if (!gone.length) return gone;

    // left_at = last_seen, not NOW(): the bot left some time after it last saw the server,
    // and last_seen is the closest thing to that we have.
    await pool.query(
        'UPDATE guilds SET left_at = COALESCE(last_seen, NOW()) WHERE left_at IS NULL AND guild_id IN (?)', [gone]);
    logger.warn('[GuildPresence] Marked servers left that no bot is in any more', { guildIds: gone });
    return gone;
}

export default { servedByAnotherClient, guildsToMarkLeft, reconcileGuildPresence };
