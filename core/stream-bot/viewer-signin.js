/*
 * Viewer sign-in for /privacy/viewer (H-772): a viewer with no CertiFried account proves which Twitch or Kick
 * account is theirs, so they can export or delete the stream bot data keyed to it. Identity only:
 *
 *   Twitch  no scopes at all. /oauth2/validate on the new token gives the user id and login. A token that carries
 *           any scope is refused (this flow never asks for one; user:read:follows and revenue scopes are banned
 *           everywhere, tests/twitch-scope-rules.test.js).
 *   Kick    user:read (the least Kick allows to read who signed in), with PKCE. /public/v1/users gives the user.
 *   YouTube youtube.readonly (Google; the least that says which channel is yours), with PKCE. channels.list mine=true gives
 *           the channel (1 quota unit). The stream bot's Google client (GOOGLE_OAUTH_CLIENT_ID; H-741).
 *
 * The token is used once to read the identity and then revoked; nothing from the provider is stored. The caller keeps
 * { state, verifier } in the visitor's session between start and callback, and the identity afterwards.
 *
 *   createViewerSignIn({ creds: { twitch: { clientId, clientSecret }, kick: {...} }, baseUrl, fetchImpl?, timeoutMs?, logger? })
 *     .configured(provider)              both id and secret present
 *     .redirectUri(provider)             <baseUrl>/privacy/viewer/<provider>/callback (register these on the apps)
 *     .start(provider) → { url, state, verifier }
 *     .finish(provider, { code, error, state }, saved) → { platform, id, login, name }   throws ViewerSignInError(reason)
 */
import crypto from 'node:crypto';

export const VIEWER_PROVIDERS = Object.freeze({
    twitch: Object.freeze({
        authorize: 'https://id.twitch.tv/oauth2/authorize',
        token: 'https://id.twitch.tv/oauth2/token',
        validate: 'https://id.twitch.tv/oauth2/validate',
        revoke: 'https://id.twitch.tv/oauth2/revoke',
        scope: '',
        pkce: false,
    }),
    kick: Object.freeze({
        authorize: 'https://id.kick.com/oauth/authorize',
        token: 'https://id.kick.com/oauth/token',
        user: 'https://api.kick.com/public/v1/users',
        revoke: 'https://id.kick.com/oauth/revoke',
        scope: 'user:read',
        pkce: true,
    }),
    youtube: Object.freeze({
        authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
        token: 'https://oauth2.googleapis.com/token',
        channels: 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
        revoke: 'https://oauth2.googleapis.com/revoke',
        scope: 'https://www.googleapis.com/auth/youtube.readonly',
        pkce: true,
    }),
});

export const CALLBACK_PATH = (provider) => `/privacy/viewer/${provider}/callback`;

export class ViewerSignInError extends Error {
    constructor(reason) { super(reason); this.reason = reason; }
}

const fail = (reason) => { throw new ViewerSignInError(reason); };

export function createViewerSignIn({ creds = {}, baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 10_000, logger = null } = {}) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[PrivacyViewer] ${msg}`, meta); } catch { /* ignore */ } };
    const known = (p) => Object.prototype.hasOwnProperty.call(VIEWER_PROVIDERS, p);
    const configured = (p) => known(p) && !!(creds[p]?.clientId && creds[p]?.clientSecret);
    const redirectUri = (p) => `${base}${CALLBACK_PATH(p)}`;

    async function call(url, init = {}) {
        const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        let body = null;
        try { body = await res.json(); } catch { /* not JSON */ }
        return { ok: res.ok, status: res.status, body };
    }

    function start(provider) {
        if (!configured(provider)) fail('unavailable');
        const p = VIEWER_PROVIDERS[provider];
        const state = crypto.randomBytes(24).toString('base64url');
        const verifier = p.pkce ? crypto.randomBytes(32).toString('base64url') : null;
        const url = new URL(p.authorize);
        url.searchParams.set('client_id', creds[provider].clientId);
        url.searchParams.set('redirect_uri', redirectUri(provider));
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('scope', p.scope);
        url.searchParams.set('state', state);
        if (provider === 'twitch') url.searchParams.set('force_verify', 'true');   // pick the account, every time
        if (provider === 'youtube') url.searchParams.set('prompt', 'select_account');   // pick the Google account, every time
        if (verifier) {
            url.searchParams.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url'));
            url.searchParams.set('code_challenge_method', 'S256');
        }
        return { url: url.toString(), state, verifier };
    }

    async function revoke(provider, token) {
        const p = VIEWER_PROVIDERS[provider];
        try {
            if (provider === 'twitch') {
                await call(p.revoke, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ client_id: creds.twitch.clientId, token }) });
            } else if (provider === 'youtube') {
                await call(p.revoke, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) });
            } else {
                const u = new URL(p.revoke);
                u.searchParams.set('token', token);
                u.searchParams.set('token_hint_type', 'access_token');
                await call(u.toString(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
            }
        } catch (e) { log('warn', 'token revoke failed (it expires on its own)', { provider, error: e?.message }); }
    }

    async function finish(provider, { code, error, state } = {}, saved = null) {
        if (!configured(provider)) fail('unavailable');
        if (!saved || saved.provider !== provider || typeof state !== 'string' || !saved.state || saved.state.length !== state.length
            || !crypto.timingSafeEqual(Buffer.from(saved.state), Buffer.from(state))) fail('expired');
        if (saved.at && Date.now() - saved.at > 10 * 60_000) fail('expired');
        if (error) fail('denied');
        if (typeof code !== 'string' || !/^[A-Za-z0-9._~-]{1,512}$/.test(code)) fail('no_code');
        const p = VIEWER_PROVIDERS[provider];
        const form = new URLSearchParams({ client_id: creds[provider].clientId, client_secret: creds[provider].clientSecret, code,
            grant_type: 'authorization_code', redirect_uri: redirectUri(provider) });
        if (p.pkce) form.set('code_verifier', String(saved.verifier || ''));
        let tok;
        try { tok = await call(p.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form }); }
        catch (e) { log('warn', 'token request failed', { provider, error: e?.message }); fail('provider'); }
        const access = tok.body?.access_token;
        if (!tok.ok || typeof access !== 'string' || !access) { log('warn', 'token exchange refused', { provider, status: tok.status }); fail('provider'); }
        try {
            if (provider === 'twitch') {
                const v = await call(p.validate, { headers: { Authorization: `OAuth ${access}` } });
                const scopes = Array.isArray(v.body?.scopes) ? v.body.scopes : [];
                if (scopes.length) { log('warn', 'a viewer sign-in token carried scopes; refused', { count: scopes.length }); fail('scopes'); }
                const id = String(v.body?.user_id || '');
                if (!v.ok || !/^\d{1,20}$/.test(id)) fail('provider');
                const login = String(v.body?.login || '').toLowerCase().slice(0, 50);
                return { platform: 'twitch', id, login, name: login };
            }
            if (provider === 'youtube') {
                const c = await call(p.channels, { headers: { Authorization: `Bearer ${access}`, Accept: 'application/json' } });
                const ch = Array.isArray(c.body?.items) ? c.body.items[0] : null;
                const id = String(ch?.id || '');
                if (!c.ok || !/^UC[A-Za-z0-9_-]{22}$/.test(id)) fail('provider');
                const name = String(ch?.snippet?.title || '').slice(0, 50);
                const login = String(ch?.snippet?.customUrl || '').replace(/^@/, '').toLowerCase().slice(0, 50) || name.toLowerCase();
                return { platform: 'youtube', id, login, name };
            }
            const u = await call(p.user, { headers: { Authorization: `Bearer ${access}`, Accept: 'application/json' } });
            const user = Array.isArray(u.body?.data) ? u.body.data[0] : u.body?.data;
            const id = String(user?.user_id ?? '');
            if (!u.ok || !/^\d{1,20}$/.test(id)) fail('provider');
            const name = String(user?.name || '').slice(0, 50);
            return { platform: 'kick', id, login: name.toLowerCase(), name };
        } finally {
            await revoke(provider, access);
        }
    }

    return { configured, redirectUri, start, finish, providers: Object.keys(VIEWER_PROVIDERS) };
}

export default { createViewerSignIn, VIEWER_PROVIDERS, CALLBACK_PATH, ViewerSignInError };
