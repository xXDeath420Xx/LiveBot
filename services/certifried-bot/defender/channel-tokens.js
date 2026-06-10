/**
 * Resolve a defender-enrolled channel's broadcaster id, a valid owner access
 * token (refreshing if expired), and the granted OAuth scopes.
 *
 * makeResolveChannel injects collaborators for testing; the default export
 * wires the real pool / token crypto / refresher.
 */
import realPool from '../../../utils/db.js';
import { decryptToken as realDecrypt } from '../../../utils/token-encryption.js';

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export function makeResolveChannel({ pool, decryptToken, refresh }) {
    return async function resolveChannel(channelId) {
        // NOTE: tokes_channels.channel_id IS the Kick broadcaster_user_id
        // (the same value kick-client uses as broadcasterId when sending chat).
        const [rows] = await pool.execute(`
            SELECT c.channel_id AS broadcaster_id,
                   pc.id AS connection_id, pc.access_token, pc.refresh_token,
                   pc.expires_at, pc.scopes
            FROM tokes_channels c
            JOIN tokes_platform_connections pc ON c.connection_id = pc.id
            WHERE c.channel_id = ? AND c.platform = 'kick' AND c.defender_enabled = 1
        `, [channelId]);

        const row = rows[0];
        if (!row || !row.access_token) return null;

        const scopes = (row.scopes ? String(row.scopes).split(/\s+/) : []).filter(Boolean);
        const isExpired = row.expires_at && new Date(row.expires_at) < new Date(Date.now() + EXPIRY_BUFFER_MS);

        let token = null;
        if (isExpired && row.refresh_token) {
            token = await refresh(row.connection_id, row.refresh_token);
        }
        if (!token) token = decryptToken(row.access_token);
        if (!token) return null;

        return { broadcasterId: String(row.broadcaster_id), token, scopes };
    };
}

// Default wiring. `refresh` is bound lazily to the running KickBot instance to
// reuse its refreshAccessToken; falls back to no-refresh if unavailable.
export const resolveChannel = makeResolveChannel({
    pool: realPool,
    decryptToken: realDecrypt,
    refresh: async (connectionId, encryptedRefreshToken) => {
        const bot = global.kickBot; // set in kick-client (Task 7)
        if (bot && typeof bot.refreshAccessToken === 'function') {
            return bot.refreshAccessToken(connectionId, encryptedRefreshToken);
        }
        return null;
    }
});
