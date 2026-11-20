/*
 * Multicast and stream bot sign-ins on Twitch and Kick in /privacy (H-820). Called from core/stream-bot/privacy.js.
 *
 *   stream_platform_accounts  one row per member and platform (owner_discord_id), with encrypted access and refresh
 *                             tokens: the "Connect Twitch / Kick" sign-in of the multicast page, which the stream bot
 *                             also reads to prove a Kick channel is yours. YouTube rows are handled by youtube/privacy.js.
 *   stream_destinations       multicast destinations made from one of those sign-ins (account_id). They belong to the
 *                             same member and go with the sign-in (the FK cascades too; deleted explicitly so the count
 *                             is exact and throwaway test tables without the FK behave the same).
 *
 * Export: the sign-ins without tokens, and those destinations without the RTMP address, stream key or config.
 * Delete: each token is revoked at the platform first (best effort: Twitch's /oauth2/revoke takes an access token and
 * the client id; Kick's /oauth/revoke takes either token with a hint), then the destinations and the rows go.
 * Destinations the member typed in by hand (no account_id) and their stream keys are not touched here.
 */

const missing = (err) => err?.code === 'ER_NO_SUCH_TABLE';
export const SIGN_IN_PLATFORMS = Object.freeze(['twitch', 'kick']);
export const REVOKE_URLS = Object.freeze({
    twitch: 'https://id.twitch.tv/oauth2/revoke',
    kick: 'https://id.kick.com/oauth/revoke',
});
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

const placeholders = (list) => list.map(() => '?').join(', ');

/** The member's Twitch and Kick sign-ins (no tokens) and the multicast destinations made from them (no keys). */
export async function platformAccountsExport(db, ownerId, { platforms = SIGN_IN_PLATFORMS, table = 'stream_platform_accounts', destinations = 'stream_destinations' } = {}) {
    const out = {};
    if (!db || !ownerId || !platforms.length) return out;
    let accounts;
    try {
        [accounts] = await db.query(`SELECT id, platform, platform_user_id, platform_username, scopes, status, expires_at, created_at
            FROM \`${table}\` WHERE owner_discord_id = ? AND platform IN (${placeholders(platforms)}) ORDER BY id`, [String(ownerId), ...platforms]);
    } catch (err) {
        if (missing(err)) return out;
        throw err;
    }
    if (!accounts.length) return out;
    out.accounts = accounts.map(({ id, ...rest }) => rest);
    try {
        const [rows] = await db.query(`SELECT d.platform, d.name, d.enabled, d.priority, d.created_at, a.platform AS signed_in_with
            FROM \`${destinations}\` d JOIN \`${table}\` a ON a.id = d.account_id
            WHERE d.account_id IN (${placeholders(accounts)}) ORDER BY d.id`, accounts.map((a) => a.id));
        if (rows.length) out.destinations = rows;
    } catch (err) { if (!missing(err)) throw err; }
    return out;
}

/** Best effort: tell the platform to drop the tokens. Never throws; our copy is deleted either way. */
export async function revokePlatformTokens(platform, { accessToken = null, refreshToken = null } = {}, { fetchImpl = (...a) => globalThis.fetch(...a), clientIds = {}, clientSecrets = {} } = {}) {
    const calls = [];
    const post = async (url, body) => {
        try {
            const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, ...(body ? { body } : {}), signal: AbortSignal.timeout(8000) });
            calls.push(res?.ok !== false);
            return res;
        } catch { calls.push(false); return null; }
    };
    if (platform === 'twitch') {
        // Twitch revokes access tokens only (with the app's client id), and revoking one ends its refresh token too.
        // An expired access token cannot be revoked, so the refresh token buys a fresh one to revoke.
        const clientId = clientIds.twitch ?? process.env.TWITCH_CLIENT_ID;
        const clientSecret = clientSecrets.twitch ?? process.env.TWITCH_CLIENT_SECRET;
        if (!clientId) return calls;
        let done = false;
        if (accessToken) done = (await post(REVOKE_URLS.twitch, new URLSearchParams({ client_id: clientId, token: accessToken })))?.ok === true;
        if (!done && refreshToken && clientSecret) {
            const res = await post(TWITCH_TOKEN_URL, new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }));
            let fresh = null;
            try { fresh = res?.ok ? (await res.json())?.access_token : null; } catch { fresh = null; }
            if (fresh) await post(REVOKE_URLS.twitch, new URLSearchParams({ client_id: clientId, token: fresh }));
        }
    } else if (platform === 'kick') {
        for (const [token, hint] of [[refreshToken, 'refresh_token'], [accessToken, 'access_token']]) {
            if (!token) continue;
            const u = new URL(REVOKE_URLS.kick);
            u.searchParams.set('token', token);
            u.searchParams.set('token_hint_type', hint);
            await post(u.toString(), null);
        }
    }
    return calls;
}

/**
 * Remove the member's Twitch and Kick sign-ins and the multicast destinations made from them.
 * revoke: revoke each token at the platform first (needs `encryption` to read the stored tokens).
 * → { stream_destinations: n, stream_platform_accounts: n } (only the tables something was removed from)
 */
export async function platformAccountsDelete(db, ownerId, { platforms = SIGN_IN_PLATFORMS, revoke = false, encryption = null, fetchImpl, clientIds, clientSecrets, table = 'stream_platform_accounts', destinations = 'stream_destinations' } = {}) {
    const out = {};
    if (!db || !ownerId || !platforms.length) return out;
    let rows;
    try {
        [rows] = await db.query(`SELECT id, platform, access_token, refresh_token FROM \`${table}\` WHERE owner_discord_id = ? AND platform IN (${placeholders(platforms)})`, [String(ownerId), ...platforms]);
    } catch (err) {
        if (missing(err)) return out;
        throw err;
    }
    if (!rows.length) return out;
    if (revoke && encryption) {
        const open = (v) => { if (!v) return null; try { return encryption.decrypt(JSON.parse(v)); } catch { return null; } };
        for (const r of rows) await revokePlatformTokens(r.platform, { accessToken: open(r.access_token), refreshToken: open(r.refresh_token) }, { fetchImpl, clientIds, clientSecrets });
    }
    const ids = rows.map((r) => r.id);
    try {
        const [d] = await db.query(`DELETE FROM \`${destinations}\` WHERE account_id IN (${placeholders(ids)})`, ids);
        if (d?.affectedRows) out[destinations] = d.affectedRows;
    } catch (err) { if (!missing(err)) throw err; }
    const [r] = await db.query(`DELETE FROM \`${table}\` WHERE id IN (${placeholders(ids)})`, ids);
    if (r?.affectedRows) out[table] = r.affectedRows;
    return out;
}

export default { platformAccountsExport, platformAccountsDelete, revokePlatformTokens, SIGN_IN_PLATFORMS, REVOKE_URLS };
