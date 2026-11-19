/**
 * The opt-in "Stream bot" Twitch grant (docs/superpowers/specs/2026-11-19-stream-bot-design.md §2.1).
 *
 *   GET  /auth/twitch/streambot             start (signed in): Twitch consent with STREAM_BOT_SCOPES, force_verify
 *   GET  /auth/twitch/streambot/callback    exchange the code, check the token, store it encrypted per CertiFried
 *                                           user (stream_bot_twitch_grants), link the channel, create EventSub subs
 *   POST /auth/twitch/streambot/disconnect  revoke at Twitch and forget the grant (CSRF-protected)
 *
 * Owner rule: never request user:read:follows or any revenue scope (core/stream-bot/scopes.js FORBIDDEN_SCOPES;
 * the callback refuses a token that carries one). Unlike the server analytics and write grants this one is not
 * bound to a Discord server. Redirect URL registered on the Twitch app:
 *   https://certifriedmultitool.com/auth/twitch/streambot/callback
 */
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import logger from '../../utils/logger.js';
import { STREAM_BOT_SCOPES, FORBIDDEN_SCOPES } from '../../core/stream-bot/scopes.js';
import { getStreamBot } from '../../core/stream-bot/index.js';

const router = express.Router();
const LOG = '[StreamBotGrant]';
const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '');
export const REDIRECT_URI = `${DASHBOARD_URL}/auth/twitch/streambot/callback`;
const BACK = '/stream/bot/connections';

function signedIn(req, res, next) {
    if (req.isAuthenticated?.() && req.user?.id) return next();
    return res.redirect('/auth/discord?returnTo=' + encodeURIComponent(BACK));
}

router.get('/auth/twitch/streambot/callback', signedIn, async (req, res) => {
    const expected = req.session.streamBotTwitchState;
    delete req.session.streamBotTwitchState;
    if (req.query.error) {
        logger.info(`${LOG} consent declined`, { userId: req.user.id, error: String(req.query.error).slice(0, 60) });
        return res.redirect(`${BACK}?error=twitch_declined`);
    }
    if (!expected || !req.query.state || req.query.state !== expected || !req.query.code) {
        logger.warn(`${LOG} state check failed`, { userId: req.user.id, hasCode: !!req.query.code, hasState: !!expected });
        return res.redirect(`${BACK}?error=twitch_state`);
    }
    try {
        const tok = await axios.post('https://id.twitch.tv/oauth2/token', null, {
            params: { client_id: process.env.TWITCH_CLIENT_ID, client_secret: process.env.TWITCH_CLIENT_SECRET, code: String(req.query.code), grant_type: 'authorization_code', redirect_uri: REDIRECT_URI },
            timeout: 15000,
        });
        const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn } = tok.data || {};
        const v = await axios.get('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${accessToken}` }, timeout: 15000 });
        const scopes = Array.isArray(v.data?.scopes) ? v.data.scopes : [];
        if (scopes.some((s) => FORBIDDEN_SCOPES.includes(s))) {
            // Cannot happen with our consent URL; refuse rather than store a token the owner's rule forbids.
            await axios.post('https://id.twitch.tv/oauth2/revoke', null, { params: { client_id: process.env.TWITCH_CLIENT_ID, token: accessToken }, timeout: 15000 }).catch(() => {});
            logger.warn(`${LOG} token carried a forbidden scope; revoked`, { userId: req.user.id });
            return res.redirect(`${BACK}?error=twitch_scopes`);
        }
        const twitchUserId = String(v.data?.user_id || '');
        const login = String(v.data?.login || '').toLowerCase();
        if (!/^\d+$/.test(twitchUserId)) throw new Error('validate returned no user id');

        const sb = await getStreamBot();
        const profile = await sb.store.ensureProfile(req.user.id, req.user.global_name || req.user.username || null);
        await sb.store.saveTwitchGrant(profile.id, {
            twitchUserId, twitchLogin: login, accessToken, refreshToken: refreshToken || null,
            expiresAt: expiresIn ? new Date(Date.now() + Number(expiresIn) * 1000) : null, scopes: scopes.join(' '),
        });
        const linked = await sb.store.linkChannel(profile.id, { platform: 'twitch', platformUserId: twitchUserId, login, displayName: login, verifiedVia: 'stream_bot_grant' });
        sb.ingest.invalidate(profile.id);
        sb.io.invalidate(profile.id);
        logger.info(`${LOG} granted`, { userId: req.user.id, twitchUserId, scopes: scopes.length, linked: linked.ok });

        // EventSub subscriptions for everything the new scopes unlock (reconcile would catch up within 30 minutes).
        import('../../core/twitch-eventsub-manager.js')
            .then((m) => m.subscribeBroadcaster(twitchUserId, login))
            .catch((err) => logger.warn(`${LOG} subscribe after grant failed`, { error: err.message }));

        return res.redirect(`${BACK}?ok=twitch_grant${linked.ok ? '' : '&warn=channel_taken'}`);
    } catch (err) {
        logger.error(`${LOG} callback failed`, { userId: req.user.id, error: err.response?.status || err.message });
        return res.redirect(`${BACK}?error=twitch_failed`);
    }
});

router.get('/auth/twitch/streambot', signedIn, (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.streamBotTwitchState = state;
    const params = new URLSearchParams({
        client_id: process.env.TWITCH_CLIENT_ID || '', redirect_uri: REDIRECT_URI, response_type: 'code',
        scope: STREAM_BOT_SCOPES.join(' '), state, force_verify: 'true',
    });
    res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
});

router.post('/auth/twitch/streambot/disconnect', signedIn, async (req, res) => {
    try {
        const sb = await getStreamBot();
        const profile = await sb.store.getProfileByOwner(req.user.id);
        if (profile) {
            const token = await sb.store.getTwitchGrantToken(profile.id);
            if (token) {
                await axios.post('https://id.twitch.tv/oauth2/revoke', null, { params: { client_id: process.env.TWITCH_CLIENT_ID, token }, timeout: 15000 }).catch(() => {});
            }
            await sb.store.deleteTwitchGrant(profile.id);
            sb.ingest.invalidate(profile.id);
            sb.io.invalidate(profile.id);
        }
        if (req.accepts(['json', 'html']) === 'json') return res.json({ ok: true });
        return res.redirect(`${BACK}?ok=twitch_grant_removed`);
    } catch (err) {
        logger.error(`${LOG} disconnect failed`, { userId: req.user.id, error: err.message });
        if (req.accepts(['json', 'html']) === 'json') return res.status(500).json({ error: 'Could not remove the grant' });
        return res.redirect(`${BACK}?error=twitch_failed`);
    }
});

export default router;
