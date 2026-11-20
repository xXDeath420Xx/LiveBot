// Greenhouse Tycoon (cfx v2): the Express app. Thin routers over the store; every body is validated by a
// schema (http/middleware.js body()), every mutating game request needs an Idempotency-Key, and every error
// has the shape { error: { code, message, details? } } (no stack traces, ever).
//
// Public paths: the front server forwards <public url>/gh-api/... here unchanged; the prefix is stripped,
// so /gh-api/api/v2/x and /api/v2/x (direct, on loopback) are the same route. Route list: README "Routes".
//
// Order: prefix strip -> helmet -> CORS (exact origins) -> per-IP limit -> JSON body (8 KB) -> public
// routes (health, catalog, auth/* with the stricter per-IP 'auth' limit) -> session -> per-account
// limits -> Idempotency-Key -> export / delete limits -> account and game routes -> 404 -> error handler.
import express from 'express';
import { GAME_TITLE } from '../config/copy.js';
import { accountRouter } from './routes/account.js';
import { authRouter } from './routes/auth.js';
import { gameRouter } from './routes/game.js';
import { metaRouter } from './routes/meta.js';
import { errorHandler, notFound, requireIdempotencyKey, handler } from './middleware.js';
import { allowedOrigins, corsMiddleware, helmetMiddleware, stripPublicPrefix, clientIp, createLimiters, rateLimit, createActivityMatcher } from './security.js';
import { createGame, catalogView } from '../store/game.js';
import { createTwitchExtVerifier } from '../integrations/twitch-ext.js';
import { createDiscordVerifier } from '../integrations/discord.js';
import { createOAuth } from '../integrations/oauth.js';
import { DEFAULT_PUBLIC_URL, DEFAULT_TWITCH_EXT_CLIENT_ID, PUBLIC_PREFIX } from '../config/env.js';
import { createPersonPrivacy } from '../privacy/index.js';
import { DEFAULT_PREFIX } from '../store/schema.js';

export const API_VERSION = 2;

export function createApp({
    store,
    auth,
    logger = console,
    config = null,
    game = null,
    oauth = null,
    verifyTwitchExt = null,
    verifyDiscord = null,
    privacy = null,
    rateLimits = undefined,
    rateNow = undefined
}) {
    const cfg = config || {
        publicUrl: DEFAULT_PUBLIC_URL,
        publicOrigin: DEFAULT_PUBLIC_URL,
        publicPrefix: PUBLIC_PREFIX,
        gamePath: '/greenhouse',
        allowDevPlatform: false,
        twitchExt: { clientId: DEFAULT_TWITCH_EXT_CLIENT_ID, secret: null },
        twitchOAuth: {},
        kickOAuth: {},
        dashboardSecret: ''
    };
    const g = game || createGame({ store, logger });
    const o = oauth || createOAuth({ config: cfg, logger });
    const extVerify = verifyTwitchExt || createTwitchExtVerifier({ secret: cfg.twitchExt?.secret || null });
    const discordVerify = verifyDiscord || createDiscordVerifier({ secret: cfg.dashboardSecret || '' });
    // Export and delete for the website's "Your data" card (H-641), the same code as /privacy. The old game's
    // cfx_ tables only sit beside the live prefix; any other prefix (tests) gets a sub-prefix that has no tables.
    const priv = privacy || createPersonPrivacy({
        db: store.db,
        prefix: store.prefix,
        legacyPrefix: store.prefix === DEFAULT_PREFIX ? 'cfx_' : `${store.prefix}legacy_`
    });
    const limiters = createLimiters(rateLimits, rateNow);
    const limit = (name, keyFn) => (limiters ? rateLimit(limiters[name], keyFn) : (req, res, next) => next());

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 'loopback');
    app.set('etag', false); // GET /state sets its own ETag; Express must not answer 304 on its own

    app.use(stripPublicPrefix(cfg.publicPrefix || PUBLIC_PREFIX));
    app.use(helmetMiddleware());
    app.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });
    // Activity host mode (docs/activities.md): the Discord Activity's frame is an allowed origin, and its requests (all
    // through Discord's proxy addresses) use their own per-address buckets.
    const fromActivity = createActivityMatcher({ appId: cfg.activity?.appId, publicKey: cfg.activity?.publicKey });
    app.use(corsMiddleware(allowedOrigins({ publicOrigin: cfg.publicOrigin, twitchExtClientId: cfg.twitchExt?.clientId, activityAppId: cfg.activity?.appId })));
    app.use(limit('ip', req => (fromActivity(req) ? null : `ip:${clientIp(req)}`)));
    app.use(limit('activityIp', req => (fromActivity(req) ? `aip:${clientIp(req)}` : null)));
    app.use(express.json({ limit: '8kb', strict: true }));

    const api = express.Router();
    api.get('/health', (req, res) => res.json({ ok: true, service: GAME_TITLE, version: API_VERSION }));
    api.get('/catalog', (req, res) => {
        res.set('Cache-Control', 'public, max-age=300');
        res.json({ catalog: catalogView() });
    });
    // Is the Twitch review save open? (phase 4; the panel asks before showing its button)
    api.get('/review', handler(async (req, res) => res.json({ review: { enabled: await store.review.enabled() } })));
    api.use('/auth', limit('auth', req => (fromActivity(req) ? null : `auth:${clientIp(req)}`)));
    api.use('/auth', limit('activityAuth', req => (fromActivity(req) ? `aauth:${clientIp(req)}` : null)));
    api.use(authRouter({
        store, auth, oauth: o, verifyTwitchExt: extVerify, verifyDiscord: discordVerify, config: cfg,
        allowDevPlatform: !!cfg.allowDevPlatform, logger
    }));
    api.use(auth.middleware());
    api.use(limit('read', req => (req.method === 'GET' && req.session ? `acc:${req.session.accountId}:r` : null)));
    api.use(requireIdempotencyKey());
    api.use('/account/export', limit('export', req => (req.session ? `acc:${req.session.accountId}:export` : null)));
    api.use('/account/delete', limit('delete', req => (req.session ? `acc:${req.session.accountId}:delete` : null)));
    api.use(accountRouter({ store, auth, privacy: priv, logger }));
    // Per-account write limit on gameplay only: the account routes have their own limits (link codes).
    api.use(limit('write', req => (req.method === 'POST' && req.session && !req.path.startsWith('/account') ? `acc:${req.session.accountId}:w` : null)));
    api.use(gameRouter({ game: g }));
    api.use(metaRouter({ game: g }));

    app.use('/api/v2', api);
    app.use(notFound());
    app.use(errorHandler({ logger }));
    app.locals.game = g;
    app.locals.oauth = o;
    return app;
}
