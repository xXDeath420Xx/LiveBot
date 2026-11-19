/*
 * "Sign in with CertiFried" for CertiFried Studio (core/stream-bot/link.js, design §5.9).
 *
 *   POST /stream/bot/api/link/request   Studio, no session (CSRF-exempt in server.js): { name, capabilities[] }
 *                                       → { request, secret, check, expiresAt, url, pollMs }. 10 a minute per IP.
 *   POST /stream/bot/api/link/poll      Studio, no session (CSRF-exempt): { request, secret }
 *                                       → { status: 'pending' | 'cancelled' } or { status: 'approved', token, deviceId,
 *                                       kind, proto } once; 404 { status: 'expired' } for unknown, expired or a wrong
 *                                       secret (all the same answer). 60 a minute per IP.
 *   GET  /stream/bot/devices/link       the signed-in person's approval page (?request=<id>)
 *   POST /stream/bot/devices/link       Approve or Cancel: a normal form with the CSRF token (not exempt)
 *
 * The device token is only ever in the poll response body, never in a URL, and is minted with the existing device store
 * (the same as POST /stream/bot/api/pair). Codes, secrets and tokens are never logged.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import logger from '../../utils/logger.js';
import { getStreamBot } from '../../core/stream-bot/index.js';
import { createLinkRequests, isLinkId } from '../../core/stream-bot/link.js';
import { newDeviceToken, hashSecret, tokenHint } from '../../core/stream-bot/pairing.js';

const LOG = '[StreamBotLink]';
const PUBLIC_URL = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '');

const clientIp = (req) => req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
const signedIn = (req) => !!(req.isAuthenticated?.() && req.user?.id);

/**
 * @param {object} o
 * @param {object} [o.links]        createLinkRequests() instance
 * @param {Function} [o.getSb]      resolves to { store } (tests pass throwaway tables)
 * @param {object} [o.limits]       { request: per minute, poll: per minute }
 */
export function createLinkRouter({ links = createLinkRequests(), getSb = getStreamBot, publicUrl = PUBLIC_URL, limits = { request: 10, poll: 60 } } = {}) {
    const router = express.Router();
    const json = express.json({ limit: '4kb' });
    const form = express.urlencoded({ extended: false, limit: '4kb' });

    const requestLimiter = rateLimit({ windowMs: 60_000, max: limits.request, standardHeaders: true, legacyHeaders: false, keyGenerator: clientIp,
        message: { error: 'rate_limited', message: 'Too many sign-in requests. Wait a minute.' } });
    const pollLimiter = rateLimit({ windowMs: 60_000, max: limits.poll, standardHeaders: true, legacyHeaders: false, keyGenerator: clientIp,
        message: { error: 'rate_limited', message: 'Checking too often. Wait a minute.' } });

    function needPage(req, res, next) {
        if (signedIn(req)) return next();
        const back = /^\/stream\/bot\/devices\/link(\?|$)/.test(req.originalUrl || '') ? req.originalUrl.slice(0, 300) : '/stream/bot/devices';
        return res.redirect('/auth/discord?returnTo=' + encodeURIComponent(back));
    }

    router.post('/stream/bot/api/link/request', requestLimiter, json, (req, res) => {
        try {
            const r = links.create({ name: req.body?.name, capabilities: req.body?.capabilities, ip: clientIp(req) });
            res.set('Cache-Control', 'no-store');
            return res.json({ request: r.id, secret: r.secret, check: r.check, expiresAt: r.expiresAt.toISOString(),
                url: `${publicUrl}/stream/bot/devices/link?request=${encodeURIComponent(r.id)}`, pollMs: 2000 });
        } catch (err) {
            if (err.code === 'busy') return res.status(503).json({ error: 'busy', message: 'Sign-in is busy. Try again in a minute, or use a pairing code.' });
            logger.error(`${LOG} request failed`, { error: err?.message });
            return res.status(500).json({ error: 'server_error' });
        }
    });

    router.post('/stream/bot/api/link/poll', pollLimiter, json, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const id = String(req.body?.request || '');
        const p = links.poll(id, req.body?.secret);
        if (!p) return res.status(404).json({ status: 'expired' });
        if (p.status !== 'approved') return res.json({ status: p.status });
        try {
            const sb = await getSb();
            const token = newDeviceToken();
            const deviceId = await sb.store.createDevice(p.profileId, { kind: 'studio', name: p.name, tokenHash: hashSecret(token), tokenHint: tokenHint(token), capabilities: p.capabilities });
            links.finish(id);
            logger.info(`${LOG} device paired by browser sign-in`, { profileId: p.profileId, deviceId });
            return res.json({ status: 'approved', token, deviceId, kind: 'studio', proto: 1 });
        } catch (err) {
            links.release(id);
            logger.error(`${LOG} could not create the device`, { error: err?.message });
            return res.status(500).json({ status: 'error', error: 'server_error' });
        }
    });

    function page(req, res, { request = null, outcome = null, status = 200 } = {}) {
        const view = request ? links.view(request) : null;
        res.status(status).render('stream-bot/link', {
            user: req.user, active: 'devices', sbPage: 'link', pageTitle: 'Connect CertiFried Studio',
            link: view ? { id: view.id, name: view.name, check: view.check, status: view.status, otherNetwork: !!(view.ip && view.ip !== String(clientIp(req) || '')) } : null,
            outcome,
        });
    }

    router.get('/stream/bot/devices/link', needPage, (req, res) => {
        const id = String(req.query.request || '');
        page(req, res, { request: isLinkId(id) ? id : null });
    });

    router.post('/stream/bot/devices/link', needPage, form, async (req, res) => {
        const id = String(req.body?.request || '');
        const decision = req.body?.decision === 'approve' ? 'approve' : req.body?.decision === 'cancel' ? 'cancel' : null;
        if (!isLinkId(id) || !decision) return page(req, res, { status: 400 });
        try {
            if (decision === 'cancel') {
                const ok = links.cancel(id);
                return page(req, res, { outcome: ok ? 'cancelled' : 'gone', status: ok ? 200 : 410 });
            }
            const sb = await getSb();
            const profile = await sb.store.ensureProfile(req.user.id, req.user.global_name || req.user.username || null);
            const ok = links.approve(id, profile.id);
            if (ok) logger.info(`${LOG} sign-in approved`, { profileId: profile.id });
            return page(req, res, { outcome: ok ? 'approved' : 'gone', status: ok ? 200 : 410 });
        } catch (err) {
            logger.error(`${LOG} approve failed`, { error: err?.message });
            return page(req, res, { outcome: 'error', status: 500 });
        }
    });

    const sweeper = setInterval(() => links.sweep(), 60_000);
    sweeper.unref?.();
    router.links = links;
    return router;
}

export default createLinkRouter();
