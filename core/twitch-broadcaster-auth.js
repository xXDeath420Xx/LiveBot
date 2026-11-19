/**
 * Broadcaster (read-grant) access token, refreshed before it expires.
 *
 * Twitch user tokens last ~4 hours. Before this helper, only VIP/mod role sync refreshed
 * twitch_role_sync_config.broadcaster_token, and it skips servers with no VIP/mod roles, so
 * analytics readers (chatter poll, backfill, churn, EventSub) silently got 401s for hours.
 * Every reader of broadcaster_token should come through here.
 */
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import logger from '../utils/logger.js';
import { refreshBroadcasterToken } from '../utils/platforms/twitch.js';

const LOG = '[TwitchBroadcasterAuth]';
const REFRESH_EARLY_MS = 10 * 60 * 1000;
const inflight = new Map(); // guild_id -> Promise<string|null>, so concurrent callers share one refresh

async function refreshRow(row) {
    const refreshPlain = encryption.decrypt(JSON.parse(row.broadcaster_refresh_token));
    const t = await refreshBroadcasterToken(refreshPlain);
    const expiresAt = new Date(Date.now() + t.expires_in * 1000).toISOString().slice(0, 19).replace('T', ' ');
    await pool.execute(
        `UPDATE twitch_role_sync_config
            SET broadcaster_token = ?, broadcaster_refresh_token = ?, token_expires_at = ?
          WHERE guild_id = ?`,
        [JSON.stringify(encryption.encrypt(t.access_token)),
         t.refresh_token ? JSON.stringify(encryption.encrypt(t.refresh_token)) : row.broadcaster_refresh_token,
         expiresAt, row.guild_id]);
    logger.info(`${LOG} refreshed token for ${row.broadcaster_twitch_username || row.broadcaster_twitch_id}`);
    return t.access_token;
}

/**
 * A usable access token for a broadcaster, or null. Reads the row fresh (callers' rows may be stale).
 * Pass guildId when the caller is bound to one server's grant; otherwise the freshest enabled row is used.
 */
export async function getBroadcasterAccessToken({ broadcasterId, guildId = null }) {
    const [rows] = await pool.execute(
        `SELECT guild_id, broadcaster_twitch_id, broadcaster_twitch_username, broadcaster_token,
                broadcaster_refresh_token, token_expires_at
           FROM twitch_role_sync_config
          WHERE broadcaster_twitch_id = ? AND enabled = 1 AND broadcaster_token IS NOT NULL
                ${guildId ? 'AND guild_id = ?' : ''}
          ORDER BY token_expires_at DESC
          LIMIT 1`,
        guildId ? [String(broadcasterId), String(guildId)] : [String(broadcasterId)]);
    const row = rows[0];
    if (!row) return null;

    let current = null;
    try { current = encryption.decrypt(JSON.parse(row.broadcaster_token)); }
    catch (e) { logger.warn(`${LOG} decrypt failed for ${broadcasterId}: ${e.message}`); }

    const expiresAt = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;
    if (current && expiresAt - Date.now() > REFRESH_EARLY_MS) return current;
    if (!row.broadcaster_refresh_token) return current;

    const key = String(row.guild_id);
    if (!inflight.has(key)) {
        inflight.set(key, refreshRow(row)
            .catch(e => {
                logger.warn(`${LOG} refresh failed for ${row.broadcaster_twitch_username || broadcasterId}: ${e.response?.status || ''} ${e.message}`);
                return null;
            })
            .finally(() => inflight.delete(key)));
    }
    return (await inflight.get(key)) || current;
}
