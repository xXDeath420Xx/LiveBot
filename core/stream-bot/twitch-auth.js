/*
 * Stream bot: the Stream bot grant's Twitch token, refreshed before use (design §7.1).
 *
 *   createGrantAuth({ store, fetchImpl?, now?, clientId?, clientSecret?, logger?, earlyMs? })
 *     .token(profileId, { need?: string[], force?: boolean })  → { token, userId, login, scopes[] }   (throws GrantError)
 *     .refresh(profileId)                                       force a refresh now (a Helix 401 does this once)
 *
 * The token is used as is while it has more than `earlyMs` (10 minutes) left. Otherwise it is refreshed with the
 * stored refresh token: Twitch hands back a new access token and a new refresh token, and both replace the old ones
 * (store.rotateTwitchGrant). Concurrent callers for one profile share one refresh. When Twitch refuses the refresh
 * token (400/401: revoked, password changed, app disconnected) the grant is marked `needs_reauth`, which the
 * Connections page shows as "reconnect", and every later call fails fast until the streamer reconnects. A network
 * error or a Twitch 5xx does not mark anything: the current token is used while it is still valid.
 *
 * Tokens are never logged or put in an error message.
 *
 * Tested in tests/stream-bot-gaps.test.js (fake store and fetch).
 */
import { scopeSatisfied } from './scopes.js';

export class GrantError extends Error {
    constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

export const GRANT_MESSAGES = Object.freeze({
    no_grant: 'Twitch is not connected for the stream bot. Connect it on the Connections page.',
    needs_reauth: 'Twitch no longer accepts the Stream bot grant. Reconnect Twitch on the Connections page.',
    twitch_down: 'Twitch did not answer when CertiFried renewed its access. It will try again on the next run.',
});

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

export function createGrantAuth({
    store, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), clientId = process.env.TWITCH_CLIENT_ID,
    clientSecret = process.env.TWITCH_CLIENT_SECRET, logger = null, earlyMs = 10 * 60_000,
} = {}) {
    const inflight = new Map();   // profileId -> Promise<grant>
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[StreamBotGrant] ${msg}`, meta); } catch { /* ignore */ } };

    const view = (g) => ({ token: g.accessToken, userId: String(g.twitchUserId), login: g.twitchLogin || null, scopes: g.scopes || [] });
    const expiresMs = (g) => (g.expiresAt ? new Date(g.expiresAt).getTime() : 0);

    async function doRefresh(profileId, g) {
        if (!g.refreshToken) {
            await store.setTwitchGrantStatus(profileId, 'needs_reauth').catch(() => {});
            throw new GrantError('needs_reauth', GRANT_MESSAGES.needs_reauth);
        }
        let res;
        try {
            res = await fetchImpl(TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: g.refreshToken, client_id: clientId || '', client_secret: clientSecret || '' }).toString(),
            });
        } catch (err) {
            log('warn', 'refresh request failed', { profileId, error: err?.code || 'network' });
            throw new GrantError('twitch_down', GRANT_MESSAGES.twitch_down);
        }
        let body = null;
        try { body = await res.json(); } catch { body = null; }
        if (res.status === 400 || res.status === 401) {
            // "Invalid refresh token": revoked at Twitch, or the streamer disconnected the app. Only a new consent helps.
            await store.setTwitchGrantStatus(profileId, 'needs_reauth').catch(() => {});
            log('warn', 'Twitch refused the refresh token; grant marked needs_reauth', { profileId, status: res.status });
            throw new GrantError('needs_reauth', GRANT_MESSAGES.needs_reauth);
        }
        if (!res.ok || !body?.access_token) {
            log('warn', 'refresh failed', { profileId, status: res.status });
            throw new GrantError('twitch_down', GRANT_MESSAGES.twitch_down);
        }
        const scopes = Array.isArray(body.scope) ? body.scope : String(body.scope || '').split(/\s+/).filter(Boolean);
        const next = {
            accessToken: body.access_token,
            refreshToken: body.refresh_token || g.refreshToken,
            expiresAt: new Date(now() + (Number(body.expires_in) || 3600) * 1000),
            scopes: scopes.length ? scopes : g.scopes,
        };
        const rotated = await store.rotateTwitchGrant(profileId, { ...next, scopes: next.scopes.join(' '), previous: g.refreshEnc ?? null });
        if (rotated === false) {
            // The grant changed while we refreshed (removed, or reconnected): read it again rather than overwrite.
            const fresh = await store.getTwitchGrantSecrets(profileId);
            if (!fresh || fresh.status !== 'active') throw new GrantError(fresh ? 'needs_reauth' : 'no_grant', GRANT_MESSAGES[fresh ? 'needs_reauth' : 'no_grant']);
            return fresh;
        }
        log('info', 'token refreshed', { profileId, expiresInS: Number(body.expires_in) || null });
        return { ...g, ...next };
    }

    function refreshShared(profileId, g) {
        if (!inflight.has(profileId)) {
            inflight.set(profileId, doRefresh(profileId, g).finally(() => inflight.delete(profileId)));
        }
        return inflight.get(profileId);
    }

    async function token(profileId, { need = [], force = false } = {}) {
        const g = await store.getTwitchGrantSecrets(profileId);
        if (!g) throw new GrantError('no_grant', GRANT_MESSAGES.no_grant);
        if (g.status !== 'active') throw new GrantError('needs_reauth', GRANT_MESSAGES.needs_reauth);
        const have = new Set(g.scopes || []);
        const missing = (need || []).filter((s) => !scopeSatisfied(have, s));
        if (missing.length) {
            throw new GrantError('missing_scope', `The Stream bot grant does not include ${missing.join(', ')}. Re-approve Twitch on the Connections page to turn this on.`, { missing });
        }
        const left = expiresMs(g) - now();
        if (!force && g.accessToken && left > earlyMs) return view(g);
        try {
            return view(await refreshShared(profileId, g));
        } catch (err) {
            // Twitch down: the current token still works until it expires.
            if (err.code === 'twitch_down' && g.accessToken && left > 0 && !force) return view(g);
            throw err;
        }
    }

    return {
        token,
        async refresh(profileId) {
            const g = await store.getTwitchGrantSecrets(profileId);
            if (!g) throw new GrantError('no_grant', GRANT_MESSAGES.no_grant);
            return view(await refreshShared(profileId, g));
        },
        _inflight: inflight,
    };
}

export default { createGrantAuth, GrantError, GRANT_MESSAGES };
