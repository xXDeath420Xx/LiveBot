/*
 * Stream bot live tools for the signed-in owner (audit 2026-11-20 items 10 to 12): the Overview page's title and category
 * editor and Redemptions queue, and the per-dock-key switches on the Devices page. The same tools the OBS docks use
 * (core/stream-bot/live-tools.js), acting only on this user's own profile and linked channels.
 *
 *   API (session; 401 JSON without one; CSRF on writes through the site's csrf middleware and /js/csrf.js)
 *     GET  /stream/bot/api/channel/info                  title and category of the linked Twitch and Kick channels
 *     GET  /stream/bot/api/channel/categories            ?platform=twitch|kick&q=   category autocomplete (2+ characters)
 *     POST /stream/bot/api/channel/update                { platform, title?, category? }
 *     GET  /stream/bot/api/redemptions                   recent channel point redemptions and whether each is still waiting
 *     POST /stream/bot/api/redemptions/update            { rewardId, redemptionId, action: 'fulfil' | 'refund' }
 *     POST /stream/bot/api/devices/dock-access           { id, chat, channel }  switch the chat and title/category capabilities of one dock key
 *
 * No profile or channel id is read from a request. A redemption can only be acted on when it is one this channel's own
 * event log holds. Twitch only lets CertiFried change rewards that CertiFried created: for any other reward the page says
 * so and links to "Recreate under CertiFried" on the Import page. Rate limits per user: edits 20 a minute, redemption
 * actions 30 a minute, reads 60 a minute. All paths are literal (no /:param), and there is no router.use.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import logger from '../../utils/logger.js';
import { getStreamBot } from '../../core/stream-bot/index.js';
import { createLiveTools, ToolError } from '../../core/stream-bot/live-tools.js';
import { DOCK_CHAT, DOCK_CHANNEL } from '../../core/stream-bot/dock.js';

const LOG = '[StreamBotLive]';
const signedIn = (req) => !!(req.isAuthenticated?.() && req.user?.id);
function needApi(req, res, next) {
    if (signedIn(req)) return next();
    return res.status(401).json({ ok: false, error: 'You are signed out. Sign in again and retry.' });
}

export function createLiveRouter({ getSb = getStreamBot, limits = {} } = {}) {
    const router = express.Router();
    const lim = { read: 60, edit: 20, redeem: 30, ...limits };
    const userKey = (req) => `u:${String(req.user?.id || 'anon')}`;
    const limiter = (max, message) => rateLimit({ windowMs: 60_000, max, standardHeaders: true, legacyHeaders: false, keyGenerator: userKey, message: { ok: false, error: 'rate_limited', message } });
    const readLimiter = limiter(lim.read, 'Too many requests. Wait a minute.');
    const editLimiter = limiter(lim.edit, 'Too many changes. Wait a minute.');
    const redeemLimiter = limiter(lim.redeem, 'Too many redemption actions. Wait a minute.');

    const route = (fn) => async (req, res) => {
        try {
            const sb = await getSb();
            const profile = await sb.store.ensureProfile(req.user.id, req.user.global_name || req.user.username || null);
            const tools = createLiveTools({ store: sb.store, helix: sb.helix, kick: sb.kick, streamInfo: sb.streamInfo, sendChat: (m) => sb.io.sendChat(m) });
            await fn(req, res, { sb, profile, tools });
        } catch (err) {
            if (err instanceof ToolError) {
                return res.status(err.status).json({ ok: false, error: err.code, message: err.message, ...(err.applied ? { applied: err.applied } : {}), ...(err.importUrl ? { importUrl: err.importUrl } : {}) });
            }
            logger.error(`${LOG} failed`, { path: req.path, method: req.method, error: err?.message });
            if (!res.headersSent) res.status(500).json({ ok: false, error: 'server_error', message: 'Something went wrong. Try again.' });
        }
        return undefined;
    };

    router.get('/stream/bot/api/channel/info', needApi, readLimiter, route(async (req, res, { profile, tools }) => {
        res.json({ ok: true, channels: await tools.channelInfo(profile) });
    }));

    router.get('/stream/bot/api/channel/categories', needApi, readLimiter, route(async (req, res, { profile, tools }) => {
        res.json({ ok: true, categories: await tools.categories(profile, { platform: String(req.query.platform || ''), q: String(req.query.q || '') }) });
    }));

    router.post('/stream/bot/api/channel/update', needApi, editLimiter, express.json({ limit: '2kb' }), route(async (req, res, { profile, tools }) => {
        const b = req.body || {};
        const out = await tools.channelUpdate(profile, { platform: String(b.platform || ''), title: b.title, category: b.category });
        res.json({ ok: true, ...out });
    }));

    router.get('/stream/bot/api/redemptions', needApi, readLimiter, route(async (req, res, { profile, tools }) => {
        res.json({ ok: true, ...(await tools.redemptions(profile)) });
    }));

    router.post('/stream/bot/api/redemptions/update', needApi, redeemLimiter, express.json({ limit: '2kb' }), route(async (req, res, { profile, tools }) => {
        const b = req.body || {};
        const out = await tools.redeem(profile, { rewardId: b.rewardId, redemptionId: b.redemptionId, action: String(b.action || '') });
        res.json({ ok: true, ...out });
    }));

    router.post('/stream/bot/api/devices/dock-access', needApi, editLimiter, express.json({ limit: '2kb' }), route(async (req, res, { sb, profile }) => {
        const b = req.body || {};
        const id = /^\d{1,15}$/.test(String(b.id ?? '')) ? Number(b.id) : null;
        const device = id ? await sb.store.getDevice(profile.id, id) : null;
        if (!device || device.revokedAt) return res.status(404).json({ ok: false, error: 'not_found', message: 'That dock key does not exist.' });
        if (device.kind !== 'dock') return res.status(400).json({ ok: false, error: 'not_dock', message: 'Only OBS dock keys have these switches.' });
        const keep = (device.capabilities || []).filter((c) => c !== DOCK_CHAT && c !== DOCK_CHANNEL);
        const next = [...keep, ...(b.chat === true ? [DOCK_CHAT] : []), ...(b.channel === true ? [DOCK_CHANNEL] : [])];
        await sb.store.setDeviceCapabilities(profile.id, id, next);
        logger.info(`${LOG} dock key access changed`, { profileId: profile.id, deviceId: id, chat: b.chat === true, channel: b.channel === true });
        return res.json({ ok: true, chat: next.includes(DOCK_CHAT), channel: next.includes(DOCK_CHANNEL) });
    }));

    return router;
}

export default createLiveRouter();
