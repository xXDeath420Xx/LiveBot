// Greenhouse Tycoon (cfx v2): /api/v2/auth - sign-in. No session needed; these routes are rate limited per
// client address (http/security.js 'auth' bucket) and do not need an Idempotency-Key (signing in twice is
// harmless: the same identity finds the same account).
//
//   POST /auth/twitch-ext        { token }          Twitch panel (extension JWT)
//   GET  /auth/twitch/start                         website: redirect to Twitch
//   GET  /auth/twitch/callback                      website: back from Twitch (HTML page with a ticket)
//   GET  /auth/kick/start, /auth/kick/callback      the same for Kick
//   POST /auth/ticket            { ticket }         website: exchange the one-time ticket for tokens
//   POST /auth/discord           { assertion }      Discord, through the dashboard's signed assertion
//   POST /auth/refresh           { refreshToken }   next session token + refresh token
//   POST /auth/logout            { refreshToken }   revoke that refresh family
//   POST /auth/dev               { userId, name? }  CFX2_ALLOW_DEV_SIGNIN=1 and a direct loopback call only
//   POST /auth/review            { token }          phase 4: the Twitch review save (store/review.js)
//
// Every sign-in answers { token, expiresAt, refreshToken, refreshExpiresAt, accountId, identityId,
// platform, createdAccount, starterGranted, notice }.
import crypto from 'node:crypto';
import { Router } from 'express';
import { v } from '../../lib/validate.js';
import { gameError, isGameError } from '../../lib/errors.js';
import { body, handler } from '../middleware.js';
import { isDirectLoopback } from '../security.js';
import { GAME_TITLE } from '../../config/copy.js';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The small page the OAuth popup (or tab) lands on. Inline script and style carry a per-response nonce. */
function landingPage(res, { publicOrigin, gamePath, ticket = null, errorCode = null, message }) {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.set('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    res.set('Cache-Control', 'no-store');
    res.type('html');
    const data = JSON.stringify(ticket ? { type: 'gh_auth', ticket } : { type: 'gh_auth_error', code: errorCode }).replace(/</g, '\\u003c');
    const target = JSON.stringify(publicOrigin).replace(/</g, '\\u003c');
    const back = JSON.stringify(ticket ? `${gamePath}#gh_ticket=${ticket}` : gamePath).replace(/</g, '\\u003c');
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(GAME_TITLE)}</title>
<style nonce="${nonce}">
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0e0f11; color: #e8e9ec; font: 15px/1.5 system-ui, sans-serif; text-align: center; }
p { color: #8a8c95; margin: 8px 0 0; }
a { color: #b4e04f; }
</style>
</head>
<body>
<main><h1>${escapeHtml(ticket ? 'Signed in' : 'Sign-in did not work')}</h1><p id="msg">${escapeHtml(message)}</p><p><a href="${escapeHtml(gamePath)}">Back to the game</a></p></main>
<script nonce="${nonce}">
(function () {
  var data = ${data};
  var back = ${back};
  if (window.opener) {
    try { window.opener.postMessage(data, ${target}); } catch (e) {}
    setTimeout(function () { window.close(); }, 600);
  } else if (data.type === 'gh_auth') {
    location.replace(back);
  }
})();
</script>
</body>
</html>`);
}

export function authRouter({ store, auth, oauth, verifyTwitchExt, verifyDiscord, config, allowDevPlatform = false, logger = console }) {
    const r = Router();
    const publicOrigin = config?.publicOrigin || 'https://certifriedmultitool.com';
    const gamePath = config?.gamePath || '/greenhouse';

    async function respond(res, signed, status = 200) {
        const tokens = await auth.issue({ accountId: signed.accountId, identityId: signed.identityId });
        res.status(status).json({
            ...tokens,
            accountId: signed.accountId,
            identityId: signed.identityId,
            platform: signed.platform,
            createdAccount: !!signed.createdAccount,
            starterGranted: !!signed.starterGranted,
            notice: signed.notice || null
        });
    }

    r.post('/auth/twitch-ext', body({ token: v.str({ min: 20, max: 4096, trim: false }) }), handler(async (req, res) => {
        const ext = verifyTwitchExt(req.body.token);
        const signed = await store.accounts.signInTwitchPanel({ opaqueId: ext.opaqueId, userId: ext.userId });
        await respond(res, signed);
    }));

    for (const provider of ['twitch', 'kick']) {
        r.get(`/auth/${provider}/start`, (req, res) => {
            try {
                res.redirect(302, oauth.start(provider));
            } catch (err) {
                res.status(isGameError(err) ? err.status : 500);
                landingPage(res, { publicOrigin, gamePath, errorCode: isGameError(err) ? err.code : 'INTERNAL', message: isGameError(err) ? err.message : 'Something went wrong on our side.' });
            }
        });
        r.get(`/auth/${provider}/callback`, async (req, res) => {
            const q = req.query;
            const str = (x) => (typeof x === 'string' ? x : undefined);
            try {
                const who = await oauth.finish(provider, { code: str(q.code), state: str(q.state), error: str(q.error) });
                const signed = await store.accounts.signIn(who);
                const ticket = oauth.issueTicket({ accountId: signed.accountId, identityId: signed.identityId, platform: who.platform, createdAccount: signed.createdAccount, starterGranted: signed.starterGranted });
                landingPage(res, { publicOrigin, gamePath, ticket, message: 'Taking you back to the game.' });
            } catch (err) {
                if (!isGameError(err)) logger.error?.('[cfx2] oauth callback failed', { provider, error: err?.message });
                const code = isGameError(err) ? err.code : 'SIGNIN_FAILED';
                res.status(isGameError(err) ? err.status : 500);
                landingPage(res, { publicOrigin, gamePath, errorCode: code, message: isGameError(err) ? err.message : 'Sign-in did not work. Please try again.' });
            }
        });
    }

    r.post('/auth/ticket', body({ ticket: v.str({ min: 32, max: 32, trim: false, pattern: /^[A-Za-z0-9_-]{32}$/ }) }), handler(async (req, res) => {
        const s = oauth.redeemTicket(req.body.ticket);
        const current = await store.accounts.resolveIdentity(s.identityId);
        if (!current || current.accountId !== s.accountId) throw gameError('SESSION_STALE');
        await respond(res, s);
    }));

    r.post('/auth/discord', body({ assertion: v.str({ min: 20, max: 2048, trim: false }) }), handler(async (req, res) => {
        const who = verifyDiscord(req.body.assertion);
        const signed = await store.accounts.signIn({ platform: 'discord', platformUserId: who.platformUserId, displayName: who.displayName });
        await respond(res, { ...signed, platform: 'discord' });
    }));

    // Phase 4: the Twitch review save. A valid panel token for this extension, while the owner has the review
    // switch on (and the channel is allowed), gets a session on the shared, sandboxed review account. No refresh
    // token: the panel exchanges the newest Twitch token again, and "Back to my save" signs in normally.
    r.post('/auth/review', body({ token: v.str({ min: 20, max: 4096, trim: false }) }), handler(async (req, res) => {
        const ext = verifyTwitchExt(req.body.token);
        await store.review.assertAllowed(ext.channelId);
        const who = await store.review.signIn();
        if (!who) throw gameError('REVIEW_UNAVAILABLE');
        res.json({
            token: auth.sign({ accountId: who.accountId, identityId: who.identityId }),
            expiresAt: Date.now() + auth.ttlSec * 1000,
            refreshToken: null,
            refreshExpiresAt: null,
            accountId: who.accountId,
            identityId: who.identityId,
            platform: 'review',
            createdAccount: false,
            starterGranted: false,
            notice: null,
            review: true
        });
    }));

    r.post('/auth/refresh', body({ refreshToken: v.str({ min: 1, max: 128, trim: false }) }), handler(async (req, res) => {
        const next = await store.sessions.rotate(req.body.refreshToken, (id) => store.accounts.resolveIdentity(id));
        res.json({
            token: auth.sign({ accountId: next.accountId, identityId: next.identityId }),
            expiresAt: Date.now() + auth.ttlSec * 1000,
            refreshToken: next.refreshToken,
            refreshExpiresAt: next.refreshExpiresAt,
            accountId: next.accountId,
            identityId: next.identityId
        });
    }));

    r.post('/auth/logout', body({ refreshToken: v.str({ min: 1, max: 128, trim: false }) }), handler(async (req, res) => {
        await store.sessions.revoke(req.body.refreshToken);
        res.json({ ok: true });
    }));

    r.post('/auth/dev', body({ userId: v.str({ min: 1, max: 40, pattern: /^[A-Za-z0-9_-]+$/ }), name: v.optional(v.str({ max: 64 })) }), handler(async (req, res) => {
        if (!allowDevPlatform || !isDirectLoopback(req)) throw gameError('PLATFORM_NOT_ALLOWED');
        const signed = await store.accounts.signIn({ platform: 'dev', platformUserId: req.body.userId, displayName: req.body.name });
        await respond(res, { ...signed, platform: 'dev' });
    }));

    return r;
}
