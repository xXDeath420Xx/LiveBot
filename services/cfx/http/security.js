// Greenhouse Tycoon (cfx v2): request hardening. CORS, helmet, rate limits, the client address and the
// public path prefix.
import net from 'node:net';
import cors from 'cors';
import helmet from 'helmet';
import { gameError } from '../lib/errors.js';
import { DEFAULT_PUBLIC_URL, DEFAULT_TWITCH_EXT_CLIENT_ID, PUBLIC_PREFIX } from '../config/env.js';

// ------------------------------------------------------------------ CORS

/**
 * The origins allowed to call the API, matched EXACTLY (the old game's hardened rule, H-402; an origin
 * that merely contains "twitch.tv" is refused):
 *   - the site itself (CFX2_PUBLIC_URL) and its www. twin
 *   - the panel's hosted files, https://<extension client id>.ext-twitch.tv
 *   - Twitch's frames: supervisor.ext-twitch.tv, extension-files.twitch.tv, www.twitch.tv, dashboard.twitch.tv
 * Requests without an Origin header (same-origin GETs, server-to-server, curl) are not CORS requests.
 */
export function allowedOrigins({ publicOrigin = DEFAULT_PUBLIC_URL, twitchExtClientId = DEFAULT_TWITCH_EXT_CLIENT_ID } = {}) {
    const site = new URL(publicOrigin);
    const set = new Set([site.origin]);
    if (!site.hostname.startsWith('www.') && site.hostname !== '127.0.0.1') set.add(`${site.protocol}//www.${site.host}`);
    if (/^[a-z0-9]{1,64}$/.test(twitchExtClientId)) set.add(`https://${twitchExtClientId}.ext-twitch.tv`);
    for (const host of ['supervisor.ext-twitch.tv', 'extension-files.twitch.tv', 'www.twitch.tv', 'dashboard.twitch.tv']) set.add(`https://${host}`);
    return set;
}

export function corsMiddleware(origins) {
    return cors({
        origin: (origin, cb) => (!origin || origins.has(origin) ? cb(null, true) : cb(gameError('CORS_ORIGIN'))),
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'If-None-Match'],
        exposedHeaders: ['ETag', 'Retry-After'],
        credentials: false, // bearer tokens only; no cookies
        maxAge: 600
    });
}

// ------------------------------------------------------------------ helmet

/** JSON API defaults: nothing may load, frame or be framed. HTML pages set their own CSP with a nonce. */
export function helmetMiddleware() {
    return helmet({
        contentSecurityPolicy: {
            useDefaults: false,
            directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] }
        },
        crossOriginResourcePolicy: { policy: 'cross-origin' }, // the Twitch panel reads the API from its own origin
        crossOriginOpenerPolicy: false, // the OAuth popup page must keep its opener
        referrerPolicy: { policy: 'no-referrer' }
    });
}

// ------------------------------------------------------------------ client address and prefix

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The client's address for rate limits. Behind Cloudflare and LiteSpeed the TCP peer is loopback, so the
 * Cloudflare header is used when (and only when) the request came from loopback; otherwise Express's
 * req.ip ('trust proxy' is loopback only).
 */
export function clientIp(req) {
    const peer = req.socket?.remoteAddress || '';
    if (LOOPBACK.has(peer)) {
        const cf = req.get('cf-connecting-ip');
        if (cf && net.isIP(cf)) return cf;
    }
    return req.ip || peer || 'unknown';
}

export function isDirectLoopback(req) {
    return LOOPBACK.has(req.socket?.remoteAddress || '') && !req.get('x-forwarded-for') && !req.get('cf-connecting-ip');
}

/** The front server forwards /gh-api/... unchanged; strip the prefix so routes are the same either way. */
export function stripPublicPrefix(prefix = PUBLIC_PREFIX) {
    return (req, res, next) => {
        if (req.url === prefix || req.url.startsWith(`${prefix}/`) || req.url.startsWith(`${prefix}?`)) {
            req.url = req.url.slice(prefix.length) || '/';
            if (req.url.startsWith('?')) req.url = `/${req.url}`;
        }
        next();
    };
}

// ------------------------------------------------------------------ rate limits

// Token buckets: `burst` requests at once, refilled at `perSec`. Keys: ip:<address>, auth:<address>,
// acc:<id>:r (reads), acc:<id>:w (writes), acc:<id>:export and acc:<id>:delete (the website's "Your data"
// card, H-641: 3 exports an hour, 5 delete attempts an hour). In memory, one process.
export const DEFAULT_RATE_LIMITS = Object.freeze({
    ip: Object.freeze({ burst: 300, perSec: 30 }),
    auth: Object.freeze({ burst: 20, perSec: 0.2 }),
    read: Object.freeze({ burst: 30, perSec: 3 }),
    write: Object.freeze({ burst: 10, perSec: 4 }),
    export: Object.freeze({ burst: 3, perSec: 3 / 3600 }),
    delete: Object.freeze({ burst: 5, perSec: 5 / 3600 })
});

export function createRateLimiter({ burst, perSec, maxKeys = 100_000, now = () => Date.now() }) {
    const buckets = new Map();
    function take(key) {
        const t = now();
        let b = buckets.get(key);
        if (!b) {
            if (buckets.size >= maxKeys) {
                for (const [k, v] of buckets) if (v.tokens + ((t - v.at) / 1000) * perSec >= burst) buckets.delete(k);
                if (buckets.size >= maxKeys) buckets.clear();
            }
            b = { tokens: burst, at: t };
            buckets.set(key, b);
        }
        b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * perSec);
        b.at = t;
        if (b.tokens >= 1) {
            b.tokens -= 1;
            return { ok: true, retryAfterSec: 0 };
        }
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / perSec)) };
    }
    return { take, size: () => buckets.size };
}

export function rateLimit(limiter, keyFn) {
    return (req, res, next) => {
        const key = keyFn(req);
        if (!key) return next();
        const r = limiter.take(key);
        if (r.ok) return next();
        res.set('Retry-After', String(r.retryAfterSec));
        next(gameError('RATE_LIMITED', { retryAfterSec: r.retryAfterSec }));
    };
}

/** Build the limiters from a config ({ ip, auth, read, write, export, delete }); `false` turns limits off (tests only). */
export function createLimiters(limits = DEFAULT_RATE_LIMITS, now) {
    if (limits === false) return null;
    const l = { ...DEFAULT_RATE_LIMITS, ...limits };
    return {
        ip: createRateLimiter({ ...l.ip, now }),
        auth: createRateLimiter({ ...l.auth, now }),
        read: createRateLimiter({ ...l.read, now }),
        write: createRateLimiter({ ...l.write, now }),
        export: createRateLimiter({ ...l.export, now }),
        delete: createRateLimiter({ ...l.delete, now })
    };
}
