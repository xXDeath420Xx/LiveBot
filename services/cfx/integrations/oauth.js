// Greenhouse Tycoon (cfx v2): website sign-in with Twitch and Kick (OAuth 2 authorisation code).
//
//   GET  <prefix>/api/v2/auth/<provider>/start     302 to the provider, with a one-time `state`
//                                                  (and a PKCE verifier for Kick)
//   GET  <prefix>/api/v2/auth/<provider>/callback  exchange the code, read the user id, sign in, then hand
//                                                  the browser a one-time TICKET (not the tokens):
//                                                  postMessage to the opener (popup) or a redirect to
//                                                  <game path>#gh_ticket=...; the game posts it to
//                                                  /api/v2/auth/ticket for its tokens
//
// The redirect URLs (register them on the apps) are <public url><prefix>/api/v2/auth/<provider>/callback.
// States and tickets live in memory (one process; a restart only means signing in again).
import crypto from 'node:crypto';
import { gameError } from '../lib/errors.js';

export const PROVIDERS = Object.freeze({
    twitch: Object.freeze({
        authorize: 'https://id.twitch.tv/oauth2/authorize',
        token: 'https://id.twitch.tv/oauth2/token',
        user: 'https://api.twitch.tv/helix/users',
        scope: '',
        pkce: false
    }),
    kick: Object.freeze({
        authorize: 'https://id.kick.com/oauth/authorize',
        token: 'https://id.kick.com/oauth/token',
        user: 'https://api.kick.com/public/v1/users',
        scope: 'user:read',
        pkce: true
    })
});

const STATE_TTL_MS = 10 * 60_000;
const TICKET_TTL_MS = 2 * 60_000;
const MAX_ENTRIES = 5000;

/** A bounded map of one-time values with expiry. */
function oneTimeStore(now, ttlMs) {
    const map = new Map();
    return {
        put(value) {
            const t = now();
            if (map.size >= MAX_ENTRIES) for (const [k, v] of map) if (v.exp <= t) map.delete(k);
            if (map.size >= MAX_ENTRIES) throw gameError('RATE_LIMITED');
            const key = crypto.randomBytes(24).toString('base64url');
            map.set(key, { value, exp: t + ttlMs });
            return key;
        },
        take(key) {
            if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(key)) return null;
            const hit = map.get(key);
            map.delete(key);
            if (!hit || hit.exp <= now()) return null;
            return hit.value;
        },
        size: () => map.size
    };
}

export function redirectUri(config, provider) {
    return `${config.publicUrl}${config.publicPrefix}/api/v2/auth/${provider}/callback`;
}

export function createOAuth({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 8000, logger = null }) {
    const states = oneTimeStore(now, STATE_TTL_MS);
    const tickets = oneTimeStore(now, TICKET_TTL_MS);
    const creds = { twitch: config.twitchOAuth, kick: config.kickOAuth };

    function configured(provider) {
        const c = creds[provider];
        return !!(PROVIDERS[provider] && c && c.clientId && c.clientSecret);
    }

    /** URL to send the browser to. */
    function start(provider) {
        if (!configured(provider)) throw gameError('SIGNIN_UNAVAILABLE', { platform: provider });
        const p = PROVIDERS[provider];
        const verifier = p.pkce ? crypto.randomBytes(32).toString('base64url') : null;
        const state = states.put({ provider, verifier });
        const url = new URL(p.authorize);
        url.searchParams.set('client_id', creds[provider].clientId);
        url.searchParams.set('redirect_uri', redirectUri(config, provider));
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('scope', p.scope);
        url.searchParams.set('state', state);
        if (verifier) {
            url.searchParams.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url'));
            url.searchParams.set('code_challenge_method', 'S256');
        }
        return url.toString();
    }

    async function call(url, init) {
        const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        let body = null;
        try { body = await res.json(); } catch { /* not JSON */ }
        return { ok: res.ok, status: res.status, body };
    }

    /** Finish the callback: returns { platform, platformUserId, displayName }. */
    async function finish(provider, { code, state, error }) {
        if (!configured(provider)) throw gameError('SIGNIN_UNAVAILABLE', { platform: provider });
        const saved = states.take(state);
        if (!saved || saved.provider !== provider) throw gameError('SIGNIN_FAILED', { reason: 'expired' });
        if (error) throw gameError('SIGNIN_FAILED', { reason: 'denied' });
        if (typeof code !== 'string' || !/^[A-Za-z0-9._~-]{1,512}$/.test(code)) throw gameError('SIGNIN_FAILED', { reason: 'no code' });
        const p = PROVIDERS[provider];
        const form = new URLSearchParams({
            client_id: creds[provider].clientId,
            client_secret: creds[provider].clientSecret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri(config, provider)
        });
        if (saved.verifier) form.set('code_verifier', saved.verifier);
        let tok;
        try {
            tok = await call(p.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
        } catch (err) {
            logger?.warn?.('[cfx2] oauth token request failed', { provider, error: err.message });
            throw gameError('SIGNIN_FAILED', { reason: 'provider unreachable' });
        }
        const accessToken = tok.body?.access_token;
        if (!tok.ok || typeof accessToken !== 'string') {
            logger?.warn?.('[cfx2] oauth code exchange refused', { provider, status: tok.status });
            throw gameError('SIGNIN_FAILED', { reason: 'code refused' });
        }
        const headers = { Authorization: `Bearer ${accessToken}` };
        if (provider === 'twitch') headers['Client-Id'] = creds.twitch.clientId;
        let user;
        try {
            user = await call(p.user, { headers });
        } catch (err) {
            logger?.warn?.('[cfx2] oauth user request failed', { provider, error: err.message });
            throw gameError('SIGNIN_FAILED', { reason: 'provider unreachable' });
        }
        const data = user.body?.data;
        const u = Array.isArray(data) ? data[0] : data;
        if (!user.ok || !u) throw gameError('SIGNIN_FAILED', { reason: 'no user' });
        const id = provider === 'twitch' ? u.id : u.user_id;
        const name = provider === 'twitch' ? (u.display_name || u.login) : u.name;
        if ((typeof id !== 'string' && typeof id !== 'number') || !/^\d{1,20}$/.test(String(id))) throw gameError('SIGNIN_FAILED', { reason: 'bad user id' });
        return { platform: provider, platformUserId: String(id), displayName: typeof name === 'string' ? name : null };
    }

    return {
        configured,
        start,
        finish,
        /** One-time ticket for a finished sign-in ({ accountId, identityId, ... }). */
        issueTicket: (session) => tickets.put(session),
        redeemTicket: (ticket) => {
            const s = tickets.take(ticket);
            if (!s) throw gameError('TICKET_INVALID');
            return s;
        },
        sizes: () => ({ states: states.size(), tickets: tickets.size() })
    };
}
