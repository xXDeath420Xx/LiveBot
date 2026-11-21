/*
 * "Switch over from Firebot / Streamer.bot" (design §12; core/stream-bot/switchover.js, migration 466). For the signed-in
 * user's own stream bot profile only.
 *
 *   Page  GET  /stream/bot/import/switchover        what it will do (filled by /js/stream-bot-switchover.js), the tick-boxes,
 *                                                   Switch over, Undo and past switchovers
 *   API   GET  /stream/bot/api/switchover/preview   the plan: imported automations, channel commands, timers and song request
 *                                                   automations with what happens to each, and the OBS show/hide pairs Studio
 *                                                   reports (asks Studio live, up to 20 s)
 *         POST /stream/bot/api/switchover/apply     { include: ['a:<id>', 'c:<id>', 't:<id>'], obs: bool, closeApps: bool, voiceThreshold: bool }
 *         POST /stream/bot/api/switchover/fixed     { id, phrase }: an imported automation was fixed here through the automation PUT; keeps it in the plan
 *         POST /stream/bot/api/switchover/undo      the last switchover, put back exactly
 *
 * Session and CSRF like every stream bot API; apply and undo 6 a minute per user, the preview 20 a minute.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { getStreamBot } from '../../core/stream-bot/index.js';
import { createImportStore } from '../../core/stream-bot/import/apply.js';
import { createSwitchover } from '../../core/stream-bot/switchover.js';
import { invalidateChannelCache } from '../../services/certifried-bot/command-registry.js';

const router = express.Router();
const LOG = '[StreamBotSwitchover]';
const signedIn = (req) => !!(req.isAuthenticated?.() && req.user?.id);

function needPage(req, res, next) {
    if (signedIn(req)) return next();
    return res.redirect('/auth/discord?returnTo=' + encodeURIComponent('/stream/bot/import/switchover'));
}
function needApi(req, res, next) {
    if (signedIn(req)) return next();
    return res.status(401).json({ ok: false, error: 'You are signed out. Sign in again and retry.' });
}
const pageRoute = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
        logger.error(`${LOG} page failed`, { path: req.path, error: err?.message });
        if (!res.headersSent) res.status(500).render('error-tailwind', { user: req.user, error: 'The switchover page could not be loaded. Try again in a minute.' });
    }
};
const apiRoute = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
        logger.error(`${LOG} api failed`, { path: req.path, method: req.method, error: err?.message });
        if (!res.headersSent) res.status(500).json({ ok: false, error: 'Something went wrong. Nothing more was changed; try again.' });
    }
};
const limiter = (max) => rateLimit({
    windowMs: 60_000, max, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => `sbsw:${req.user?.id || req.ip}`,
    handler: (req, res) => res.status(429).json({ ok: false, error: 'Too many tries. Wait a minute.' }),
});
const actLimiter = limiter(6);
const fixLimiter = limiter(60);
const previewLimiter = limiter(20);

let cached = null;
async function load(req) {
    const sb = await getStreamBot();
    const profile = await sb.store.ensureProfile(req.user.id, req.user.global_name || req.user.username || null);
    if (!cached || cached.sb !== sb) {
        const importStore = createImportStore({ db: pool, prefix: sb.store.prefix });
        cached = { sb, sw: createSwitchover({ db: pool, store: sb.store, importStore, hub: sb.hub, media: sb.overlays?.media || null, sounds: sb.sounds || null, prefix: sb.store.prefix, logger, invalidateChannel: invalidateChannelCache }) };
    }
    return { sb, profile, sw: cached.sw };
}

/** History rows for the page (no ids of other profiles, nothing secret). */
export const historyView = (h) => ({
    id: h.id, status: h.status, createdAt: h.createdAt ? new Date(h.createdAt).toISOString() : null, undoneAt: h.undoneAt ? new Date(h.undoneAt).toISOString() : null,
    automations: Number(h.result?.automations) || 0, commands: Number(h.result?.commands) || 0, timers: Number(h.result?.timers) || 0, channels: Number(h.result?.channels) || 0,
    obs: (h.result?.obs?.changes || []).filter((c) => c.ok).length, apps: (h.result?.apps?.apps || []).map((a) => ({ app: a.app, closed: !!a.closed, stillRunning: !!a.stillRunning })),
});

router.get('/stream/bot/import/switchover', needPage, pageRoute(async (req, res) => {
    const { sb, profile, sw } = await load(req);
    const studio = (sb.hub.connected(profile.id) || []).find((d) => d.kind === 'studio') || null;
    const history = (await sw.history(profile.id, 10)).map(historyView);
    res.render('stream-bot/switchover', {
        user: req.user, active: 'import', pageTitle: 'Switch over', profile, history,
        studio: { connected: !!studio, version: studio?.client?.version || null, canClose: !!studio?.capabilities?.includes('apps'), canVoice: !!studio?.capabilities?.includes('voice') },
        canUndo: history.some((h) => h.status === 'applied' || h.status === 'partial' || h.status === 'applying'),
    });
}));

router.get('/stream/bot/api/switchover/preview', needApi, previewLimiter, apiRoute(async (req, res) => {
    const { profile, sw } = await load(req);
    res.json({ ok: true, plan: await sw.preview(profile.id) });
}));

router.post('/stream/bot/api/switchover/apply', needApi, actLimiter, apiRoute(async (req, res) => {
    const { profile, sw } = await load(req);
    const include = Array.isArray(req.body?.include) ? req.body.include.map(String).filter((k) => /^[act]:\d{1,15}$/.test(k)).slice(0, 500) : [];
    const r = await sw.apply(profile.id, { include, obs: req.body?.obs !== false, closeApps: req.body?.closeApps === true, voiceThreshold: req.body?.voiceThreshold === true });
    logger.info(`${LOG} applied`, { profileId: profile.id, status: r.status, id: r.id });
    res.json({ ok: true, ...r });
}));

router.post('/stream/bot/api/switchover/fixed', needApi, fixLimiter, apiRoute(async (req, res) => {
    const { profile, sw } = await load(req);
    const id = Number(req.body?.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: 'Pick an automation.' });
    const r = await sw.markFixed(profile.id, id, { phrase: req.body?.phrase === true });
    res.status(r.ok ? 200 : 404).json(r);
}));

router.post('/stream/bot/api/switchover/undo', needApi, actLimiter, apiRoute(async (req, res) => {
    const { profile, sw } = await load(req);
    const r = await sw.undo(profile.id);
    res.status(r.ok || r.status === 'partial' ? 200 : 400).json(r.ok ? { ok: true, ...r } : { ok: false, ...r });
}));

export default router;
