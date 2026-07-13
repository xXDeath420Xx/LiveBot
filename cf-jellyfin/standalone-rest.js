// ============================================================================
// CertiFried Jellyfin federation — REST-only standalone runner
// ----------------------------------------------------------------------------
// Runs as its own pm2 process. Uses Discord's REST API (with the bot token)
// instead of a gateway connection, so it doesn't conflict with the main bot.
//
// Tradeoff: no gateway events means guildMemberAdd/Remove events don't fire
// from this process. The auth-app's nightly reconcile cron picks up drift
// within 24h. For real-time revocation, integrate the gateway-based modules
// into the main bot using example-integration.js as the template.
// ============================================================================

import 'dotenv/config';
import express from 'express';
import { createFederationRouter, pingAuthApp } from './cf-jellyfin-federation.js';

const DISCORD_API = 'https://discord.com/api/v10';
const TOKEN       = process.env.DISCORD_BOT_TOKEN;
const PORT        = parseInt(process.env.FEDERATION_PORT || '4099', 10);

if (!TOKEN) {
    console.error('[cf-fed] DISCORD_BOT_TOKEN missing in .env — exiting');
    process.exit(1);
}

// --- Discord REST helpers --------------------------------------------------

async function discordFetch(path) {
    const res = await fetch(DISCORD_API + path, {
        headers: { Authorization: 'Bot ' + TOKEN }
    });
    return res;
}

let cachedGuildIds = [];
let lastGuildRefresh = 0;
const GUILD_CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchAllBotGuilds() {
    if (Date.now() - lastGuildRefresh < GUILD_CACHE_TTL_MS && cachedGuildIds.length > 0) {
        return cachedGuildIds;
    }
    const all = [];
    let after = '0';
    while (true) {
        const res = await discordFetch('/users/@me/guilds?limit=200&after=' + after);
        if (!res.ok) {
            console.error('[cf-fed] /users/@me/guilds -> HTTP ' + res.status);
            break;
        }
        const batch = await res.json();
        if (!Array.isArray(batch) || batch.length === 0) break;
        for (const g of batch) all.push(g.id);
        if (batch.length < 200) break;
        after = batch[batch.length - 1].id;
    }
    cachedGuildIds = all;
    lastGuildRefresh = Date.now();
    console.log('[cf-fed] Cached ' + all.length + ' guild(s) from Discord REST');
    return all;
}

// Per-user shared-guild check via REST.
// For each cached guild, GET /guilds/{id}/members/{user_id}. 200 = member, 404 = not.
// We short-circuit on first match for speed (auth-app only needs to know "any").
//
// PRIMARY_GUILD_ID (env, optional) is checked FIRST — this is the main
// CertiFried server. Most users share that one and we want to short-circuit
// before chewing through 25+ unrelated guilds and risking rate-limit drops.
const PRIMARY_GUILD_ID = process.env.CF_PRIMARY_GUILD_ID || '';

async function checkGuildMembership(guildId, userId) {
    // Single-guild check with one rate-limit retry. Returns 'in', 'out',
    // or 'unknown' (transient/network/auth failure).
    for (let attempt = 0; attempt < 2; attempt++) {
        let res;
        try {
            res = await discordFetch('/guilds/' + guildId + '/members/' + userId);
        } catch (e) {
            return 'unknown';
        }
        if (res.status === 200) return 'in';
        if (res.status === 404) return 'out';
        if (res.status === 429) {
            const data = await res.json().catch(() => null);
            const retryAfter = data && data.retry_after ? data.retry_after * 1000 : 1000;
            await new Promise(r => setTimeout(r, Math.min(retryAfter, 5000)));
            continue;
        }
        // 401/403/5xx — bot lacks access or transient. Treat as unknown rather
        // than "out" so we don't falsely report user as not-in-guild.
        return 'unknown';
    }
    return 'unknown';
}

async function userSharesAnyGuild(userId) {
    const guildIds = await fetchAllBotGuilds();
    const sharedIds = [];

    // Build check order: primary guild first if configured, then the rest.
    const ordered = [];
    if (PRIMARY_GUILD_ID && guildIds.includes(PRIMARY_GUILD_ID)) {
        ordered.push(PRIMARY_GUILD_ID);
        for (const g of guildIds) if (g !== PRIMARY_GUILD_ID) ordered.push(g);
    } else {
        ordered.push(...guildIds);
    }

    let unknownCount = 0;
    for (const guildId of ordered) {
        const r = await checkGuildMembership(guildId, userId);
        if (r === 'in') {
            sharedIds.push(guildId);
            // Short-circuit on first hit
            return { shared: true, guild_ids: sharedIds };
        }
        if (r === 'unknown') unknownCount++;
    }

    // If we got no hits AND every check was unknown/errored, treat as
    // indeterminate (return null-like). The auth-app's failure-open logic
    // already treats null/missing-keys as "don't disable".
    if (sharedIds.length === 0 && unknownCount === ordered.length) {
        return { shared: null, guild_ids: [], indeterminate: true };
    }
    return { shared: sharedIds.length > 0, guild_ids: sharedIds };
}

// --- Shim a discord.js-like client for the federation router ---------------

const restClientShim = {
    isReady: () => true,
    guilds: {
        get cache() {
            // Return a Map-like with the IDs we've cached
            return new Map(cachedGuildIds.map(id => [id, { id, members: { cache: new Map() } }]));
        }
    }
};

// --- Express app -----------------------------------------------------------

const app = express();
app.set('trust proxy', 1);

// --- REST-based /api/shares-guild — MUST register BEFORE the federation
// router so Express matches this handler first. The federation router has its
// own /api/shares-guild that walks discord.js client cache, which is empty in
// REST-only mode. If that route runs, every check returns shared:false and the
// auth-app's reconcile incorrectly disables every linked user.
app.get('/api/shares-guild', express.json({ verify: (req,res,buf) => { req.rawBody = buf?.toString('utf8') || ''; } }), async (req, res) => {
    // HMAC verify (re-implement here since we're bypassing the router)
    const name = req.header('X-CF-Bot-Name');
    const ts   = req.header('X-CF-Bot-Timestamp');
    const sig  = req.header('X-CF-Bot-Signature');
    if (!name || !ts || !sig || name !== 'auth-app') return res.status(401).json({ error: 'auth' });
    const tsNum = parseInt(ts, 10);
    if (!tsNum || Math.abs(Date.now() - tsNum) > 5 * 60 * 1000) return res.status(401).json({ error: 'stale' });
    const crypto = await import('crypto');
    const expected = crypto.createHmac('sha256', process.env.CF_FED_TOKEN)
        .update(ts + '.' + (req.rawBody || '')).digest('hex');
    try {
        const a = Buffer.from(sig, 'hex'), b = Buffer.from(expected, 'hex');
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'sig' });
    } catch { return res.status(401).json({ error: 'sig' }); }

    const userId = String(req.query.user_id || '');
    if (!/^\d+$/.test(userId)) return res.status(400).json({ error: 'user_id required' });
    try {
        const result = await userSharesAnyGuild(userId);
        res.json(result);
    } catch (err) {
        console.error('[cf-fed] shares-guild error:', err.message);
        res.status(500).json({ error: 'internal' });
    }
});

// Mount the federation router AFTER our REST shares-guild override.
// fedRouter handles other federation endpoints (ping, reset-password etc.)
// but its built-in /api/shares-guild won't match because we already registered
// our REST-based handler above.
const fedRouter = createFederationRouter({
    sharedToken: process.env.CF_FED_TOKEN,
    botName:     process.env.CF_BOT_NAME,
    getClient:   () => restClientShim
});
app.use(fedRouter);

// Public health endpoint (no auth) — useful for uptime checks
app.get('/health', async (req, res) => {
    const ids = await fetchAllBotGuilds().catch(() => []);
    res.json({ ok: true, guild_count: ids.length, last_refresh: new Date(lastGuildRefresh).toISOString() });
});

app.listen(PORT, '127.0.0.1', () => {
    console.log('[cf-fed] REST-only federation listening on 127.0.0.1:' + PORT);
});

// Warm the guild cache on boot
fetchAllBotGuilds().catch(err => console.error('[cf-fed] initial fetch failed:', err.message));

// Sanity-check the auth-app handshake (uses outbound HMAC sign)
(async () => {
    try {
        const pong = await pingAuthApp({
            authAppUrl:  process.env.CF_AUTH_APP_URL,
            sharedToken: process.env.CF_FED_TOKEN,
            botName:     process.env.CF_BOT_NAME
        });
        console.log('[cf-fed] auth-app handshake OK:', pong);
    } catch (err) {
        console.warn('[cf-fed] auth-app handshake failed (auth-app may not have us in bots.json yet):', err.message);
    }
})();
