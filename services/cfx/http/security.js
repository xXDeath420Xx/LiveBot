// Greenhouse Tycoon (cfx v2): request hardening. CORS, helmet, rate limits, the client address and the
// public path prefix.
import crypto from 'node:crypto';
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
 *   - activity host mode (docs/activities.md): CertiFried's Discord Activity, https://<application id>.discordsays.com,
 *     whose frame reaches /gh-api through Discord's URL mapping
 * Requests without an Origin header (same-origin GETs, server-to-server, curl) are not CORS requests.
 */
export function allowedOrigins({ publicOrigin = DEFAULT_PUBLIC_URL, twitchExtClientId = DEFAULT_TWITCH_EXT_CLIENT_ID, activityAppId = null } = {}) {
    const site = new URL(publicOrigin);
    const set = new Set([site.origin]);
    if (!site.hostname.startsWith('www.') && site.hostname !== '127.0.0.1') set.add(`${site.protocol}//www.${site.host}`);
    if (/^[a-z0-9]{1,64}$/.test(twitchExtClientId)) set.add(`https://${twitchExtClientId}.ext-twitch.tv`);
    for (const host of ['supervisor.ext-twitch.tv', 'extension-files.twitch.tv', 'www.twitch.tv', 'dashboard.twitch.tv']) set.add(`https://${host}`);
    const activity = activityOrigin(activityAppId);
    if (activity) set.add(activity);
    return set;
}

/** The Discord Activity's origin (https://<application id>.discordsays.com), or null without a valid id. */
export function activityOrigin(appId) {
    return /^\d{17,20}$/.test(String(appId || '')) ? `https://${appId}.discordsays.com` : null;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Is a request from the Discord Activity? Everyone in an Activity reaches us through Discord's proxy, so they share
 * a few addresses: such requests get their own, larger per-address buckets (DEFAULT_RATE_LIMITS activityIp and
 * activityAuth) instead of the website's, and the per-account limits still apply after sign-in. Recognised by the
 * Activity's Origin, or by Discord's proxy signature (X-Signature-Ed25519 over X-Discord-Proxy-Payload with the
 * application's public key) when Discord does not pass the Origin on.
 */
export function createActivityMatcher({ appId = null, publicKey = null } = {}) {
    const origin = activityOrigin(appId);
    let key = null;
    try {
        if (/^[0-9a-f]{64}$/i.test(String(publicKey || ''))) {
            key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey, 'hex')]), format: 'der', type: 'spki' });
        }
    } catch {
        key = null;
    }
    const seen = new WeakMap();
    return function isActivity(req) {
        if (!origin) return false;
        if (seen.has(req)) return seen.get(req);
        let ok = req.get?.('origin') === origin;
        if (!ok && key) {
            try {
                const sig = String(req.get('x-signature-ed25519') || '');
                const ts = String(req.get('x-signature-timestamp') || '');
                const b64 = String(req.get('x-discord-proxy-payload') || '');
                if (/^[0-9a-f]{128}$/i.test(sig) && ts && b64 && b64.length <= 4096) {
                    const payload = Buffer.from(b64, 'base64');
                    const data = JSON.parse(payload.toString('utf8'));
                    ok = String(data.created_at) === ts && Number(data.expires_at) >= Math.floor(Date.now() / 1000)
                        && crypto.verify(null, payload, key, Buffer.from(sig, 'hex'));
                }
            } catch {
                ok = false;
            }
        }
        seen.set(req, ok);
        return ok;
    };
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
    delete: Object.freeze({ burst: 5, perSec: 5 / 3600 }),
    // The Discord Activity (createActivityMatcher): everyone in it shares Discord's proxy addresses.
    activityIp: Object.freeze({ burst: 1500, perSec: 150 }),
    activityAuth: Object.freeze({ burst: 120, perSec: 2 })
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
        delete: createRateLimiter({ ...l.delete, now }),
        activityIp: createRateLimiter({ ...l.activityIp, now }),
        activityAuth: createRateLimiter({ ...l.activityAuth, now })
    };
}
