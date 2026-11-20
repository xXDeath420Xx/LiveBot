/*
 * Discord Activities: who is this? (docs/activities.md "How sign-in works")
 *
 *   1. The Activity asks Discord for a code (sdk.commands.authorize, scope identify, prompt none).
 *   2. POST /activity/api/token sends the code here. exchangeCode() trades it for an access token with the
 *      application's client secret (server side only); fetchUser() reads /users/@me with it.
 *   3. checkInstance() asks Discord, with the application's bot token, which channel that Activity instance runs in
 *      and who is connected to it (GET /applications/{app}/activity-instances/{instance}). A session is only bound to a
 *      server and channel that Discord confirms, and only for a person Discord lists in the instance.
 *   4. signSession() issues our own short-lived bearer token (HS256, 4 hours). The Discord access token goes back to
 *      the Activity once, for sdk.commands.authenticate, and is not stored.
 *
 * Cookies are not used: the Activity runs in Discord's frame on <app id>.discordsays.com, where a site cookie would be
 * third-party. Every API call carries the bearer token.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const API = 'https://discord.com/api/v10';
const SNOWFLAKE = /^\d{17,20}$/;
// i-<launch id>-gc-<guild>-<channel> (server channel) or i-<launch id>-pc-<channel> (DM / group DM)
export const INSTANCE_RE = /^i-\d{17,20}-(?:gc-\d{17,20}-\d{17,20}|pc-\d{17,20})$/;
const CODE_RE = /^[A-Za-z0-9]{10,64}$/;

export class ActivityAuthError extends Error {
    constructor(code, status = 401, message = 'Sign-in did not work. Close the Activity and open it again.') {
        super(message);
        this.code = code;
        this.status = status;
    }
}

async function discordJson(fetchImpl, url, init) {
    let res;
    try {
        res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) });
    } catch {
        throw new ActivityAuthError('DISCORD_UNREACHABLE', 503, 'Discord did not answer. Try again in a moment.');
    }
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
}

/** Trade an authorize() code for an access token. Never logs or returns the client secret. */
export async function exchangeCode({ code, cfg, fetchImpl = fetch }) {
    if (typeof code !== 'string' || !CODE_RE.test(code)) throw new ActivityAuthError('BAD_CODE', 400);
    const { status, body } = await discordJson(fetchImpl, `${API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: cfg.appId, client_secret: cfg.clientSecret, grant_type: 'authorization_code', code }),
    });
    if (status !== 200 || typeof body?.access_token !== 'string') throw new ActivityAuthError('CODE_REFUSED');
    const scopes = String(body.scope || '').split(/\s+/);
    if (!scopes.includes('identify')) throw new ActivityAuthError('SCOPE_MISSING');
    return { accessToken: body.access_token, expiresIn: Number(body.expires_in) || 0 };
}

export async function fetchUser({ accessToken, fetchImpl = fetch }) {
    const { status, body } = await discordJson(fetchImpl, `${API}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (status !== 200 || !SNOWFLAKE.test(String(body?.id || ''))) throw new ActivityAuthError('USER_UNKNOWN');
    return {
        id: String(body.id),
        username: String(body.username || '').slice(0, 64),
        name: String(body.global_name || body.username || 'Someone').slice(0, 64),
        avatar: /^(a_)?[0-9a-f]{32}$/.test(String(body.avatar || '')) ? body.avatar : null,
    };
}

/**
 * Where an Activity instance runs and who is in it, as Discord says. null: no such instance (ended, or invented).
 * Retries a few times: right after launch the instance can take a moment to list the person who opened it.
 */
export async function checkInstance({ instanceId, userId, cfg, fetchImpl = fetch, tries = 3, waitMs = 600 }) {
    if (typeof instanceId !== 'string' || !INSTANCE_RE.test(instanceId)) throw new ActivityAuthError('BAD_INSTANCE', 400);
    if (!cfg.botToken) throw new ActivityAuthError('INSTANCE_CHECK_UNAVAILABLE', 503, 'The Activity is not fully set up yet.');
    for (let attempt = 1; attempt <= tries; attempt++) {
        const { status, body } = await discordJson(fetchImpl, `${API}/applications/${cfg.appId}/activity-instances/${encodeURIComponent(instanceId)}`, {
            headers: { Authorization: `Bot ${cfg.botToken}` },
        });
        if (status === 404) return null;
        if (status === 200 && body) {
            const users = Array.isArray(body.users) ? body.users.map(String) : [];
            const loc = body.location || {};
            if (users.includes(String(userId)) || attempt === tries) {
                return {
                    instanceId,
                    kind: loc.kind === 'gc' ? 'gc' : 'pc',
                    guildId: SNOWFLAKE.test(String(loc.guild_id || '')) ? String(loc.guild_id) : null,
                    channelId: SNOWFLAKE.test(String(loc.channel_id || '')) ? String(loc.channel_id) : null,
                    users,
                    member: users.includes(String(userId)),
                };
            }
        } else if (status !== 429 && status < 500) {
            throw new ActivityAuthError('INSTANCE_CHECK_FAILED', 503, 'Discord would not confirm this Activity. Close it and open it again.');
        }
        if (attempt < tries) await new Promise((r) => setTimeout(r, waitMs * attempt));
    }
    throw new ActivityAuthError('INSTANCE_CHECK_FAILED', 503, 'Discord would not confirm this Activity. Try again in a moment.');
}

// ── our session token ───────────────────────────────────────────────────────────────────────

const ISSUER = 'certifried-activity';
const AUDIENCE = 'activity';

/** A bearer token for one person in one Activity instance. `gid`/`cid` only when Discord confirmed them. */
export function signSession({ user, instance, cfg, nowSec = Math.floor(Date.now() / 1000) }) {
    return jwt.sign({
        name: user.name,
        av: user.avatar || undefined,
        iid: instance.instanceId,
        gid: instance.guildId || undefined,
        cid: instance.channelId || undefined,
        iat: nowSec,
        exp: nowSec + cfg.sessionTtlSec,
        jti: crypto.randomBytes(9).toString('base64url'),
    }, cfg.sessionSecret, { algorithm: 'HS256', issuer: ISSUER, audience: AUDIENCE, subject: user.id });
}

/** The session behind a bearer token, or null. */
export function verifySession(token, cfg, nowSec = Math.floor(Date.now() / 1000)) {
    if (typeof token !== 'string' || token.length > 2048 || !cfg.sessionSecret) return null;
    try {
        const p = jwt.verify(token, cfg.sessionSecret, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE, clockTimestamp: nowSec, clockTolerance: 5 });
        if (!SNOWFLAKE.test(String(p.sub)) || typeof p.iid !== 'string' || !INSTANCE_RE.test(p.iid)) return null;
        return {
            userId: String(p.sub),
            name: String(p.name || 'Someone'),
            avatar: p.av || null,
            instanceId: p.iid,
            guildId: p.gid && SNOWFLAKE.test(p.gid) ? p.gid : null,
            channelId: p.cid && SNOWFLAKE.test(p.cid) ? p.cid : null,
            exp: p.exp,
        };
    } catch {
        return null;
    }
}

/** Express middleware: req.activity from `Authorization: Bearer <token>`, else 401. */
export function requireActivitySession(getCfg) {
    return (req, res, next) => {
        const m = String(req.get('authorization') || '').match(/^Bearer\s+([A-Za-z0-9._-]{20,2048})$/);
        const s = m ? verifySession(m[1], getCfg()) : null;
        if (!s) return res.status(401).json({ error: { code: 'SESSION_REQUIRED', message: 'Your Activity session ended. Close the Activity and open it again.' } });
        req.activity = s;
        next();
    };
}

// ── Discord's proxy signature (optional, defence in depth) ───────────────────────────────────

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Did this request come through Discord's Activity proxy? Discord signs proxied requests with the application's key:
 * X-Signature-Ed25519 over the base64-decoded X-Discord-Proxy-Payload, whose created_at equals X-Signature-Timestamp
 * and whose expires_at has not passed. false when the headers are missing or wrong.
 */
export function verifyProxySignature(headers, publicKeyHex, nowSec = Math.floor(Date.now() / 1000)) {
    try {
        if (!/^[0-9a-f]{64}$/.test(publicKeyHex || '')) return false;
        const sig = String(headers['x-signature-ed25519'] || '');
        const ts = String(headers['x-signature-timestamp'] || '');
        const payloadB64 = String(headers['x-discord-proxy-payload'] || '');
        if (!/^[0-9a-f]{128}$/i.test(sig) || !ts || !payloadB64 || payloadB64.length > 4096) return false;
        const payload = Buffer.from(payloadB64, 'base64');
        const data = JSON.parse(payload.toString('utf8'));
        if (String(data.created_at) !== ts || !(Number(data.expires_at) >= nowSec)) return false;
        const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
        return crypto.verify(null, payload, key, Buffer.from(sig, 'hex'));
    } catch {
        return false;
    }
}
