// The game API client. Every error has the server's shape { code, message } (or NETWORK / TIMEOUT when
// nothing came back). Gameplay POSTs get ONE Idempotency-Key per player action, reused on every retry, so
// a retry after a lost answer can never pay twice; requests are never merged.
import { API_BASE, REQUEST_TIMEOUT_MS } from '../config.js';
import { UI } from '../copy.js';

export class ApiError extends Error {
    constructor(code, message, { status = 0, details = null, retryAfterMs = null } = {}) {
        super(message);
        this.name = 'ApiError';
        this.code = code;
        this.status = status;
        this.details = details;
        this.retryAfterMs = retryAfterMs;
    }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** A request id for the Idempotency-Key header: 8-64 of A-Z a-z 0-9 . _ : - */
export function newKey() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    let out = 'gh-' + Date.now().toString(36) + '-';
    for (const b of bytes) out += (b % 36).toString(36);
    return out;
}

/** Network trouble or a gateway error: worth one or two more tries with the same key. */
export function isTransient(err) {
    return err instanceof ApiError && (err.code === 'NETWORK' || err.code === 'TIMEOUT' || [500, 502, 504].includes(err.status));
}

/**
 * getToken()      the current session token (or null)
 * renew(code)     get a new session token after a 401; throws when the player has to sign in again
 * onRateLimited   told about every 429 (the app shows a short notice)
 */
export function createApi({ getToken, renew, onRateLimited = null, base = API_BASE }) {
    async function raw(method, path, { body, token = null, key = null } = {}) {
        const headers = {};
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (token) headers.Authorization = `Bearer ${token}`;
        if (key) headers['Idempotency-Key'] = key;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        let res;
        try {
            res = await fetch(base + path, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: ctrl.signal,
                cache: 'no-store',
                credentials: 'omit'
            });
        } catch (err) {
            const timeout = err && err.name === 'AbortError';
            throw new ApiError(timeout ? 'TIMEOUT' : 'NETWORK', timeout ? UI.errors.timeout : UI.errors.network);
        } finally {
            clearTimeout(timer);
        }
        if (res.status === 304) return { status: 304, data: null };
        let data = null;
        try { data = await res.json(); } catch { /* not JSON: a gateway page */ }
        if (!res.ok) {
            const e = (data && data.error) || {};
            const retryAfter = Number(res.headers.get('Retry-After'));
            throw new ApiError(e.code || (res.status >= 500 ? 'SERVER' : `HTTP_${res.status}`), e.message || UI.errors.generic, {
                status: res.status,
                details: e.details || null,
                retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null
            });
        }
        return { status: res.status, data };
    }

    /** One request with the session token; after a 401 the token is renewed once and the request repeated. */
    async function call(method, path, { body, auth = true, key = null } = {}) {
        const token = auth ? await getToken() : null;
        try {
            return await raw(method, path, { body, token, key });
        } catch (err) {
            if (auth && err.status === 401 && (err.code === 'UNAUTHORIZED' || err.code === 'SESSION_STALE')) {
                const fresh = await renew(err.code);
                return raw(method, path, { body, token: fresh, key });
            }
            if (err.status === 429 && onRateLimited) onRateLimited(err);
            throw err;
        }
    }

    /** A gameplay POST that answers { result, state }. Retried on network trouble with the SAME key. */
    async function action(path, body = {}) {
        const key = newKey();
        for (let attempt = 1; ; attempt++) {
            try {
                return (await call('POST', path, { body, key })).data;
            } catch (err) {
                if (err.status === 429 && attempt === 1 && (err.retryAfterMs ?? 2000) <= 5000) {
                    await sleep(err.retryAfterMs ?? 2000);
                    continue;
                }
                if (isTransient(err) && attempt <= 2) {
                    await sleep(attempt * 800);
                    continue;
                }
                throw err;
            }
        }
    }

    return {
        raw,
        call,
        action,
        get: async (path) => (await call('GET', path)).data,
        /** POST that is not a game action (account routes): still one key per call. */
        post: async (path, body = {}, opts = {}) => (await call('POST', path, { body, key: newKey(), ...opts })).data
    };
}
