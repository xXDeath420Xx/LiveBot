/*
 * Last.fm ownership check for /music lastfm link (fix wave 7, 2026-11-20: the H-817 caveat, Last.fm links were not ownership-checked).
 *
 * Last.fm's desktop-style web auth (https://www.last.fm/api/desktopauth):
 *   1. getToken()        auth.getToken, signed. A token valid for 60 minutes.
 *   2. approveUrl(token) https://www.last.fm/api/auth/?api_key=…&token=… — the member signs in to Last.fm there and
 *                        allows CertiFried. Only the account owner can do that.
 *   3. getSession(token) auth.getSession, signed. Returns the name of the account that approved it.
 * CertiFried keeps only that name and when it was checked (lastfm_accounts.verified_username / verified_at, migration
 * 473). The session key Last.fm returns is never stored: CertiFried does not scrobble or act on the account.
 *
 * Signing: api_sig = md5 of every parameter except format and callback, sorted by name, written as name + value,
 * followed by the shared secret (LASTFM_SHARED_SECRET). The secret never leaves the server.
 */
import crypto from 'node:crypto';

const API = 'https://ws.audioscrobbler.com/2.0/';
const APPROVE = 'https://www.last.fm/api/auth/';

export class LastfmAuthError extends Error {
    /** reason: 'unconfigured' | 'not_approved' (error 14) | 'expired' (15 or 4) | 'failed' */
    constructor(reason, message) { super(message || reason); this.reason = reason; }
}

export function signParams(params, secret) {
    const base = Object.keys(params).filter((k) => k !== 'format' && k !== 'callback').sort()
        .map((k) => `${k}${params[k]}`).join('');
    return crypto.createHash('md5').update(base + secret, 'utf8').digest('hex');
}

/** Same name on Last.fm (names are case-insensitive there). */
export function sameLastfmName(a, b) {
    return typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** A token as Last.fm issues it (32 hex-like characters); anything else is refused before a call. */
export const TOKEN_RE = /^[A-Za-z0-9]{16,64}$/;

export function createLastfmAuth({ apiKey = process.env.LASTFM_API_KEY, secret = process.env.LASTFM_SHARED_SECRET, fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = 10000 } = {}) {
    const configured = () => !!(apiKey && secret);

    async function call(method, extra = {}) {
        if (!configured()) throw new LastfmAuthError('unconfigured');
        const params = { method, api_key: apiKey, ...extra };
        const body = new URLSearchParams({ ...params, api_sig: signParams(params, secret), format: 'json' });
        let res, data;
        try {
            res = await fetchImpl(API, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(timeoutMs) });
            data = await res.json();
        } catch (e) {
            throw new LastfmAuthError('failed', `Last.fm ${method}: ${e?.message || e}`);
        }
        if (data?.error) {
            const code = Number(data.error);
            if (code === 14) throw new LastfmAuthError('not_approved');
            if (code === 15 || code === 4) throw new LastfmAuthError('expired');
            throw new LastfmAuthError('failed', `Last.fm ${method}: error ${code}`);
        }
        return data;
    }

    return {
        configured,
        async getToken() {
            const data = await call('auth.getToken');
            if (typeof data?.token !== 'string' || !TOKEN_RE.test(data.token)) throw new LastfmAuthError('failed', 'Last.fm auth.getToken: no token');
            return data.token;
        },
        approveUrl(token) {
            const u = new URL(APPROVE);
            u.searchParams.set('api_key', apiKey || '');
            u.searchParams.set('token', token);
            return u.toString();
        },
        /** → the Last.fm username that approved the token. The session key is dropped here. */
        async getSession(token) {
            if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new LastfmAuthError('expired');
            const data = await call('auth.getSession', { token });
            const name = data?.session?.name;
            if (typeof name !== 'string' || !name) throw new LastfmAuthError('failed', 'Last.fm auth.getSession: no name');
            return name;
        },
    };
}

export default { createLastfmAuth, signParams, sameLastfmName, LastfmAuthError, TOKEN_RE };
