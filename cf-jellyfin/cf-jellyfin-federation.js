// ============================================================================
// CertiFried Jellyfin Federation — bot-side drop-in module
// ----------------------------------------------------------------------------
// Provides the bot's half of the federation contract with the Jellyfin
// auth-app at jellyfin.certifriedmultitool.net.
//
// HTTP endpoints exposed (all HMAC-authed, callable only by the auth-app):
//   GET  /api/ping                          → { ok, bot }
//   GET  /api/guilds                        → { guild_ids: [...] }
//   GET  /api/shares-guild?user_id=<id>     → { shared: bool, guild_ids: [...] }
//
// Discord event handlers (notify the auth-app, which runs full-federation
// revocation/restore checks):
//   guildMemberRemove → POST /account/internal/check-revocation
//   guildMemberAdd    → POST /account/internal/check-restore
//
// USAGE: see ./example-integration.js
//
// REQUIREMENTS:
//   - discord.js v14
//   - Express
//   - Discord intents: Guilds + GuildMembers (privileged — enable in Dev Portal)
//   - GuildMember partial (so guildMemberRemove fires for uncached members)
//   - The bot's `name` and `shared_token` must match an entry in the auth-app's
//     bots.json registry.
//
// THREAT MODEL:
//   - Inbound: only the auth-app (X-CF-Bot-Name === 'auth-app') with a valid
//     HMAC-SHA256 over `timestamp.body` using the shared token, and a 5-minute
//     timestamp window. Replays inside the window are not separately blocked
//     (acceptable: each call is idempotent).
//   - Outbound: same envelope, signed as botName so the auth-app can look up
//     this bot in its registry.
//   - The shared token MUST be a high-entropy secret (>=32 hex chars). Don't
//     check it into git. Rotate by updating both bots.json and the bot env.
// ============================================================================

import express from 'express';
import crypto from 'crypto';

// --- HMAC ------------------------------------------------------------------

function signaturePayload(timestamp, body) {
    return timestamp + '.' + (body || '');
}

function signOutgoing(sharedToken, botName, body) {
    const timestamp = Date.now().toString();
    const payload = signaturePayload(timestamp, body || '');
    const sig = crypto.createHmac('sha256', sharedToken).update(payload).digest('hex');
    return {
        'X-CF-Bot-Name': botName,
        'X-CF-Bot-Timestamp': timestamp,
        'X-CF-Bot-Signature': sig
    };
}

function verifyIncoming(req, sharedToken) {
    const name = req.header('X-CF-Bot-Name');
    const ts = req.header('X-CF-Bot-Timestamp');
    const sig = req.header('X-CF-Bot-Signature');
    if (!name || !ts || !sig) return false;
    // The auth-app is the only legitimate caller of this bot's federation
    // endpoints. The auth-app signs with name='auth-app'.
    if (name !== 'auth-app') return false;
    const tsNum = parseInt(ts, 10);
    if (!tsNum || Math.abs(Date.now() - tsNum) > 5 * 60 * 1000) return false;
    const expected = crypto.createHmac('sha256', sharedToken)
        .update(signaturePayload(ts, req.rawBody || '')).digest('hex');
    try {
        const a = Buffer.from(sig, 'hex');
        const b = Buffer.from(expected, 'hex');
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    } catch {
        return false;
    }
}

// --- HTTP router -----------------------------------------------------------

/**
 * Returns an Express Router with the three federation endpoints.
 *
 * @param {Object} opts
 * @param {string} opts.sharedToken  - HMAC secret matching auth-app bots.json
 * @param {string} opts.botName      - This bot's registry name (e.g. 'certifried-default')
 * @param {() => import('discord.js').Client} opts.getClient - Returns the discord.js client
 */
export function createFederationRouter({ sharedToken, botName, getClient }) {
    if (!sharedToken || sharedToken.length < 16) {
        throw new Error('cf-federation: sharedToken must be at least 16 chars');
    }
    if (!botName) throw new Error('cf-federation: botName required');
    if (typeof getClient !== 'function') throw new Error('cf-federation: getClient must be a function');

    const router = express.Router();

    // Capture raw body so HMAC verification is over the exact bytes.
    // Safe to mount alongside an existing express.json() — this only applies
    // to routes inside this router.
    router.use(express.json({
        verify: (req, res, buf) => {
            req.rawBody = buf && buf.length ? buf.toString('utf8') : '';
        }
    }));

    function requireAuthApp(req, res, next) {
        if (!verifyIncoming(req, sharedToken)) {
            return res.status(401).json({ error: 'Invalid or missing federation signature' });
        }
        next();
    }

    router.get('/api/ping', requireAuthApp, (req, res) => {
        const client = getClient();
        res.json({
            ok: true,
            bot: botName,
            ready: !!(client && client.isReady && client.isReady()),
            guild_count: client && client.guilds ? client.guilds.cache.size : 0
        });
    });

    router.get('/api/guilds', requireAuthApp, (req, res) => {
        const client = getClient();
        if (!client || !client.guilds) return res.json({ guild_ids: [] });
        res.json({ guild_ids: Array.from(client.guilds.cache.keys()) });
    });

    router.get('/api/shares-guild', requireAuthApp, async (req, res) => {
        const userId = String(req.query.user_id || '');
        if (!/^\d+$/.test(userId)) {
            return res.status(400).json({ error: 'user_id (numeric Discord ID) required' });
        }
        const client = getClient();
        if (!client || !client.guilds) return res.json({ shared: false, guild_ids: [] });

        const sharedIds = [];
        // Cache-only check — fast, eventually consistent. The auth-app's
        // nightly reconcile cron is the backstop for cache drift.
        for (const [guildId, guild] of client.guilds.cache) {
            if (guild.members.cache.has(userId)) sharedIds.push(guildId);
        }
        res.json({ shared: sharedIds.length > 0, guild_ids: sharedIds });
    });

    return router;
}

// --- Discord event wiring --------------------------------------------------

/**
 * Attaches guildMemberAdd / guildMemberRemove listeners that notify the auth-app.
 *
 * @param {import('discord.js').Client} client
 * @param {Object} opts
 * @param {string} opts.authAppUrl   - e.g. https://jellyfin.certifriedmultitool.net
 * @param {string} opts.sharedToken
 * @param {string} opts.botName
 */
export function attachMemberEventHandlers(client, { authAppUrl, sharedToken, botName }) {
    if (!authAppUrl || !sharedToken || !botName) {
        throw new Error('cf-federation: authAppUrl, sharedToken, and botName are required');
    }
    const base = authAppUrl.replace(/\/$/, '');

    async function notify(endpoint, discordId) {
        const body = JSON.stringify({ discord_id: String(discordId) });
        const headers = signOutgoing(sharedToken, botName, body);
        headers['Content-Type'] = 'application/json';
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        try {
            const res = await fetch(base + endpoint, {
                method: 'POST', headers, body, signal: ctrl.signal
            });
            if (!res.ok) {
                console.error('[cf-federation] ' + endpoint + ' -> HTTP ' + res.status);
                return;
            }
            const data = await res.json().catch(() => null);
            if (data && data.action && data.action !== 'noop') {
                console.log('[cf-federation] ' + endpoint + ' (' + discordId + ') -> ' + data.action);
            }
        } catch (err) {
            console.error('[cf-federation] ' + endpoint + ' failed:', err.message);
        } finally {
            clearTimeout(t);
        }
    }

    client.on('guildMemberRemove', (member) => {
        if (!member || !member.id) return;
        // Fire-and-forget — must not block the gateway
        notify('/account/internal/check-revocation', member.id);
    });

    client.on('guildMemberAdd', (member) => {
        if (!member || !member.id) return;
        notify('/account/internal/check-restore', member.id);
    });
}

// --- Standalone diagnostic — call this manually if needed -------------------

export async function pingAuthApp({ authAppUrl, sharedToken, botName }) {
    const headers = signOutgoing(sharedToken, botName, '');
    const res = await fetch(authAppUrl.replace(/\/$/, '') + '/account/internal/ping', { headers });
    if (!res.ok) throw new Error('Ping failed: HTTP ' + res.status);
    return res.json();
}

// --- Auth-app HTTP client (signed) ------------------------------------------
// Returns an object with .get(path) and .post(path, body) that handle HMAC
// signing for you. Used by the slash-command module.

export function createAuthAppClient({ authAppUrl, sharedToken, botName, timeoutMs = 5000 }) {
    if (!authAppUrl || !sharedToken || !botName) {
        throw new Error('cf-federation: authAppUrl, sharedToken, and botName are required');
    }
    const base = authAppUrl.replace(/\/$/, '');

    async function request(method, urlPath, bodyObj) {
        const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
        const headers = signOutgoing(sharedToken, botName, bodyStr);
        if (bodyObj) headers['Content-Type'] = 'application/json';
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(base + urlPath, {
                method, headers, body: bodyStr || undefined, signal: ctrl.signal
            });
            const data = await res.json().catch(() => null);
            return { ok: res.ok, status: res.status, data };
        } catch (err) {
            return { ok: false, status: 0, error: err.message };
        } finally {
            clearTimeout(t);
        }
    }

    return {
        get:  (path)             => request('GET',  path, null),
        post: (path, body)       => request('POST', path, body || {})
    };
}
