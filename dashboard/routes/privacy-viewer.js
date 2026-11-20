/*
 * /privacy/viewer (H-772): viewers in a streamer's channel who have no CertiFried account export or delete the stream
 * bot data keyed to their Twitch or Kick account, in every streamer's channel. No login to CertiFried; they prove the
 * account with an identity-only sign-in (core/stream-bot/viewer-signin.js: Twitch with no scopes, Kick user:read).
 *
 *   GET  /privacy/viewer                     the page: sign-in buttons, or what is held and the two actions
 *   GET  /privacy/viewer/export              JSON download (signed in; rate limited)
 *   POST /privacy/viewer/delete              { confirm: 'DELETE' } (signed in; CSRF; rate limited)
 *   POST /privacy/viewer/sign-out            forget the signed-in accounts (CSRF)
 *   GET  /privacy/viewer/:provider           start the Twitch or Kick sign-in (rate limited)
 *   GET  /privacy/viewer/:provider/callback  finish it; the account is kept in this browser's session for 30 minutes
 *
 * What it covers: core/stream-bot/privacy.js exportForAccounts / deleteForAccounts (events where they are the actor,
 * chat included where a streamer keeps chat; {db:} values; song requests and likes) and, for Twitch, the historical
 * followed-channels list (core/twitch-follows-archive.js). Redirect URLs to register on the apps:
 *   <DASHBOARD_URL>/privacy/viewer/twitch/callback   (Twitch app TWITCH_CLIENT_ID)
 *   <DASHBOARD_URL>/privacy/viewer/kick/callback     (Kick app KICK_BOT_CLIENT_ID or KICK_CLIENT_ID)
 *   <DASHBOARD_URL>/privacy/viewer/youtube/callback  (Google client GOOGLE_OAUTH_CLIENT_ID; H-741)
 * Literal paths come before /:provider. Tested in tests/privacy-viewer.test.js.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import logger from '../../utils/logger.js';
import { createViewerSignIn, ViewerSignInError } from '../../core/stream-bot/viewer-signin.js';

const SESSION_MS = 30 * 60_000;
const PROVIDERS = new Set(['twitch', 'kick', 'youtube']);
const LOG = '[PrivacyViewer]';

const MESSAGES = Object.freeze({
    expired: 'That sign-in expired or was started in another tab. Try again.',
    denied: 'You cancelled the sign-in.',
    no_code: 'The sign-in did not finish. Try again.',
    provider: 'Twitch, Kick or YouTube did not confirm your account. Try again in a minute.',
    scopes: 'That sign-in asked for more than your identity, so it was refused. Try again.',
    unavailable: 'That sign-in is not set up on this server yet. Email support@certifriedmultitool.com instead.',
    deleted: 'Done. Your data is deleted.',
    confirm: 'Type DELETE in the box to confirm.',
});

/** The signed-in accounts still valid in this session (one per platform). */
export function sessionAccounts(session, now = Date.now()) {
    const list = Array.isArray(session?.privacyViewer?.accounts) ? session.privacyViewer.accounts : [];
    return list.filter((a) => a && PROVIDERS.has(a.platform) && (a.platform === 'youtube' ? /^UC[A-Za-z0-9_-]{22}$/ : /^\d{1,20}$/).test(String(a.id)) && now - Number(a.at || 0) < SESSION_MS);
}

/**
 * The router. deps: signIn (createViewerSignIn result), privacy (createStreamBotPrivacy result), follows
 * ({ followsExport, followsDelete } with db bound), now, limits (false turns the rate limits off for tests).
 */
export function createPrivacyViewerRouter({ signIn, privacy, follows = null, now = () => Date.now(), limits = true } = {}) {
    const router = express.Router();
    const lim = (windowMs, max) => (limits ? rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: 'Too many tries. Wait a few minutes.' }) : (req, res, next) => next());
    const startLimiter = lim(10 * 60_000, 20);
    const exportLimiter = lim(60 * 60_000, 6);
    const deleteLimiter = lim(60 * 60_000, 6);
    const form = express.urlencoded({ extended: false, limit: '4kb' });

    const accountsOf = (req) => sessionAccounts(req.session, now());
    const plain = (accounts) => accounts.map(({ platform, id }) => ({ platform, id }));

    async function gather(accounts) {
        const out = await privacy.exportForAccounts(plain(accounts));
        const tables = { ...out.tables };
        const twitchIds = accounts.filter((a) => a.platform === 'twitch').map((a) => a.id);
        if (follows && twitchIds.length) {
            const rows = await follows.followsExport(twitchIds);
            if (rows.length) tables.twitch_user_follows = { total: rows.length, rows, note: 'Historical: the channels you followed, read once on 2026-10-28; no longer collected' };
        }
        return { tables, note: out.note };
    }

    function render(req, res, locals = {}) {
        const accounts = accountsOf(req);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.render('privacy-viewer', {
            user: req.user || null,
            accounts: accounts.map(({ platform, login, name }) => ({ platform, login, name })),
            providers: { twitch: signIn.configured('twitch'), kick: signIn.configured('kick'), youtube: signIn.configured('youtube') },
            counts: null, message: null, error: null, deleted: null, ...locals,
        });
    }

    router.get('/privacy/viewer', async (req, res) => {
        const accounts = accountsOf(req);
        const flash = req.session?.privacyViewerFlash || null;
        if (req.session) delete req.session.privacyViewerFlash;
        let counts = null;
        if (accounts.length) {
            try {
                const g = await gather(accounts);
                counts = Object.entries(g.tables).map(([table, t]) => ({ table, total: t.total }));
            } catch (err) {
                logger.warn(`${LOG} counting failed`, { error: err?.message });
                return render(req, res, { error: 'Your data could not be read just now. Try again in a minute.' });
            }
        }
        return render(req, res, { counts, message: flash?.message || null, error: flash?.error || null, deleted: flash?.deleted || null });
    });

    router.get('/privacy/viewer/export', exportLimiter, async (req, res) => {
        const accounts = accountsOf(req);
        if (!accounts.length) return res.redirect('/privacy/viewer');
        try {
            const g = await gather(accounts);
            const payload = {
                generated_at: new Date(now()).toISOString(),
                accounts: accounts.map(({ platform, id, login }) => ({ platform, id, login })),
                about: 'Stream bot data CertiFried holds about these Twitch, Kick and YouTube accounts, in every streamer\'s channel. ' + g.note,
                tables: g.tables,
            };
            logger.info(`${LOG} export`, { platforms: accounts.map((a) => a.platform), tables: Object.keys(g.tables).length });
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="certifried-viewer-data-${new Date(now()).toISOString().slice(0, 10)}.json"`);
            return res.send(JSON.stringify(payload, null, 1));
        } catch (err) {
            logger.error(`${LOG} export failed`, { error: err?.message });
            return render(req, res, { error: 'The export could not be made just now. Try again in a minute.' });
        }
    });

    router.post('/privacy/viewer/delete', deleteLimiter, form, async (req, res) => {
        const accounts = accountsOf(req);
        if (!accounts.length) return res.redirect('/privacy/viewer');
        if (String(req.body?.confirm || '').trim() !== 'DELETE') {
            req.session.privacyViewerFlash = { error: MESSAGES.confirm };
            return res.redirect(303, '/privacy/viewer');
        }
        try {
            const { deleted } = await privacy.deleteForAccounts(plain(accounts));
            const twitchIds = accounts.filter((a) => a.platform === 'twitch').map((a) => a.id);
            if (follows && twitchIds.length) {
                const n = await follows.followsDelete(twitchIds);
                if (n) deleted.twitch_user_follows = (deleted.twitch_user_follows || 0) + n;
            }
            logger.info(`${LOG} delete`, { platforms: accounts.map((a) => a.platform), rows: Object.values(deleted).reduce((s, n) => s + n, 0) });
            req.session.privacyViewerFlash = { message: MESSAGES.deleted, deleted: Object.entries(deleted).map(([table, n]) => ({ table, n })) };
            return res.redirect(303, '/privacy/viewer');
        } catch (err) {
            logger.error(`${LOG} delete failed`, { error: err?.message });
            req.session.privacyViewerFlash = { error: 'The delete did not finish. Nothing more was removed; try again, or email support@certifriedmultitool.com.' };
            return res.redirect(303, '/privacy/viewer');
        }
    });

    router.post('/privacy/viewer/sign-out', form, (req, res) => {
        if (req.session) delete req.session.privacyViewer;
        return res.redirect(303, '/privacy/viewer');
    });

    router.get('/privacy/viewer/:provider', startLimiter, (req, res) => {
        const provider = String(req.params.provider);
        if (!PROVIDERS.has(provider)) return res.status(404).send('Not found');
        try {
            const s = signIn.start(provider);
            req.session.privacyViewerAuth = { provider, state: s.state, verifier: s.verifier, at: now() };
            return res.redirect(s.url);
        } catch (err) {
            req.session.privacyViewerFlash = { error: MESSAGES[err instanceof ViewerSignInError ? err.reason : 'provider'] || MESSAGES.provider };
            return res.redirect(303, '/privacy/viewer');
        }
    });

    router.get('/privacy/viewer/:provider/callback', startLimiter, async (req, res) => {
        const provider = String(req.params.provider);
        if (!PROVIDERS.has(provider)) return res.status(404).send('Not found');
        const saved = req.session?.privacyViewerAuth || null;
        if (req.session) delete req.session.privacyViewerAuth;
        try {
            const who = await signIn.finish(provider, { code: req.query.code, error: req.query.error, state: req.query.state }, saved);
            const others = sessionAccounts(req.session, now()).filter((a) => a.platform !== who.platform);
            req.session.privacyViewer = { accounts: [...others, { ...who, at: now() }] };
            logger.info(`${LOG} signed in`, { platform: who.platform });
            return res.redirect(303, '/privacy/viewer');
        } catch (err) {
            const reason = err instanceof ViewerSignInError ? err.reason : 'provider';
            if (!(err instanceof ViewerSignInError)) logger.warn(`${LOG} sign-in failed`, { provider, error: err?.message });
            req.session.privacyViewerFlash = { error: MESSAGES[reason] || MESSAGES.provider };
            return res.redirect(303, '/privacy/viewer');
        }
    });

    return router;
}

/** The live router: real sign-in credentials, the stream bot tables and twitch_user_follows. */
export async function createLiveRouter() {
    const [{ default: pool }, { createStreamBotPrivacy }, { createStore }, archive] = await Promise.all([
        import('../../utils/db.js'), import('../../core/stream-bot/privacy.js'), import('../../core/stream-bot/store.js'),
        import('../../core/twitch-follows-archive.js'),
    ]);
    const signIn = createViewerSignIn({
        baseUrl: (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, ''),
        creds: {
            twitch: { clientId: process.env.TWITCH_CLIENT_ID, clientSecret: process.env.TWITCH_CLIENT_SECRET },
            kick: { clientId: process.env.KICK_BOT_CLIENT_ID || process.env.KICK_CLIENT_ID, clientSecret: process.env.KICK_BOT_CLIENT_SECRET || process.env.KICK_CLIENT_SECRET },
            // YouTube (H-741): the stream bot's Google client; off while it is not set or STREAM_BOT_YOUTUBE is '0'.
            youtube: process.env.STREAM_BOT_YOUTUBE === '0' ? {} : { clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET },
        },
        logger,
    });
    const privacy = createStreamBotPrivacy({ store: createStore({ db: pool }), db: pool, rowLimit: 1000 });
    const follows = { followsExport: (ids) => archive.followsExport(pool, ids), followsDelete: (ids) => archive.followsDelete(pool, ids) };
    return createPrivacyViewerRouter({ signIn, privacy, follows });
}

/** Mounted by dashboard/server.js: builds the live router on the first /privacy/viewer request. */
const lazy = express.Router();
let live = null;
lazy.use((req, res, next) => {
    if (req.path !== '/privacy/viewer' && !req.path.startsWith('/privacy/viewer/')) return next();
    if (!live) live = createLiveRouter().catch((err) => { live = null; throw err; });
    live.then((r) => r(req, res, next)).catch((err) => {
        logger.error(`${LOG} could not start`, { error: err?.message });
        next(err);
    });
});

export default lazy;
