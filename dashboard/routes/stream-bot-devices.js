/*
 * Stream bot devices (Phase 5; docs/superpowers/specs/2026-11-19-stream-bot-design.md §10; core/stream-bot/devices): the JSON API
 * behind the Lights, Audio and Stream Deck sections of the Devices page and the automation editor's device lists. The page
 * itself stays GET /stream/bot/devices (dashboard/routes/stream-bot.js), which renders those sections from service.pageData().
 *
 *   API (session, the signed-in user's own profile only; CSRF on writes)
 *     GET    /stream/bot/api/devices/choices              lights (Studio's and cloud), presets, Voicemeeter strips/buses/files
 *     GET    /stream/bot/api/devices/hardware             the page data again (refresh without a reload)
 *     POST   /stream/bot/api/devices/check                ask CertiFried Studio to look for lights and Voicemeeter again
 *     GET    /stream/bot/api/lights/scenes?device=        scene names for a light (cloud: asked from the service; Studio's: reported)
 *     POST   /stream/bot/api/lights/test                  { device } a short flash in CertiFried green
 *     POST   /stream/bot/api/lights/cloud                 { provider: govee|lifx, key } save the key (encrypted) and list the lights
 *     POST   /stream/bot/api/lights/cloud/:provider/refresh   list the lights again
 *     DELETE /stream/bot/api/lights/cloud/:provider       remove the key
 *     POST   /stream/bot/api/lights/presets               { id?, name, lights[] } add or change a preset
 *     POST   /stream/bot/api/lights/presets/:id/apply     apply it now
 *     DELETE /stream/bot/api/lights/presets/:id
 *
 * Keys are never sent back (only the last 4 characters) and never logged. Rate limits per user: key saves 10 a minute,
 * tests and checks 30 a minute. Literal paths come before /:param paths.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import logger from '../../utils/logger.js';
import { getStreamBot } from '../../core/stream-bot/index.js';
import { CLOUD_PROVIDERS, DEVICE_ID, isCloudDevice } from '../../core/stream-bot/devices/catalog.js';

const router = express.Router();
const LOG = '[StreamBotDevices]';
const signedIn = (req) => !!(req.isAuthenticated?.() && req.user?.id);
function needApi(req, res, next) {
    if (signedIn(req)) return next();
    return res.status(401).json({ ok: false, error: 'You are signed out. Sign in again and retry.' });
}
const apiRoute = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
        logger.error(`${LOG} api failed`, { path: req.path, method: req.method, error: err?.message });
        if (!res.headersSent) res.status(500).json({ ok: false, error: 'Something went wrong. Try again.' });
    }
};
const userKey = (req) => `u:${String(req.user?.id || 'anon')}`;   // after needApi: always a signed-in user
const keyLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: userKey,
    message: { ok: false, error: 'Too many tries. Wait a minute.' } });
const testLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: userKey,
    message: { ok: false, error: 'Too many tests. Wait a minute.' } });

async function load(req) {
    const sb = await getStreamBot();
    if (!sb.devices) { const e = new Error('devices not loaded'); e.status = 503; throw e; }
    const profile = await sb.store.ensureProfile(req.user.id, req.user.global_name || req.user.username || null);
    return { sb, profile, dev: sb.devices };
}
const notReady = (res) => res.status(503).json({ ok: false, error: 'Lights and devices are not running on this server yet. Try again after the next update.' });
const wrap = (fn) => apiRoute(async (req, res) => {
    let ctx;
    try { ctx = await load(req); } catch (err) { if (err.status === 503) return notReady(res); throw err; }
    return fn(req, res, ctx);
});

router.get('/stream/bot/api/devices/choices', needApi, wrap(async (req, res, { profile, dev }) => {
    res.json({ ok: true, ...(await dev.service.choices(profile.id)) });
}));

router.get('/stream/bot/api/devices/hardware', needApi, wrap(async (req, res, { profile, dev }) => {
    res.json({ ok: true, hardware: await dev.service.pageData(profile.id) });
}));

router.post('/stream/bot/api/devices/check', needApi, testLimiter, wrap(async (req, res, { profile, dev }) => {
    const r = await dev.service.checkStudio(profile.id);
    if (!r.ok) return res.status(409).json({ ok: false, error: r.message });
    res.json({ ok: true, result: r.result, hardware: await dev.service.pageData(profile.id) });
}));

router.get('/stream/bot/api/lights/scenes', needApi, wrap(async (req, res, { profile, dev }) => {
    const device = String(req.query.device || '').slice(0, 160);
    if (!DEVICE_ID.test(device) || device === 'all') return res.status(400).json({ ok: false, error: 'Pick a light.' });
    if (isCloudDevice(device)) {
        try { return res.json({ ok: true, scenes: await dev.cloud.scenes(profile.id, device) }); } catch (err) {
            return res.status(409).json({ ok: false, error: err.message || 'The light service did not answer.' });
        }
    }
    const local = await dev.service.localDevices(profile.id);
    const l = (local.lights || []).find((x) => x.id === device);
    res.json({ ok: true, scenes: l ? [...(l.caps?.scenes || []), ...(l.caps?.effects || [])] : [] });
}));

router.post('/stream/bot/api/lights/test', needApi, testLimiter, wrap(async (req, res, { profile, dev }) => {
    const device = String(req.body?.device || '').slice(0, 160);
    if (!DEVICE_ID.test(device) || device === 'all') return res.status(400).json({ ok: false, error: 'Pick a light.' });
    const r = await dev.service.test(profile.id, device);
    if (!r.ok) return res.status(409).json({ ok: false, error: r.message });
    res.json({ ok: true, message: r.message });
}));

router.post('/stream/bot/api/lights/cloud', needApi, keyLimiter, wrap(async (req, res, { profile, dev }) => {
    const provider = String(req.body?.provider || '');
    const key = String(req.body?.key || '').trim();
    if (!CLOUD_PROVIDERS.includes(provider)) return res.status(400).json({ ok: false, error: 'Pick Govee or LIFX.' });
    if (!/^[A-Za-z0-9._-]{16,200}$/.test(key)) return res.status(400).json({ ok: false, error: provider === 'govee' ? 'Paste the API key Govee emailed you (letters, numbers and dashes).' : 'Paste the personal access token from cloud.lifx.com.' });
    await dev.accounts.save(profile.id, provider, key);
    const r = await dev.cloud.check(profile.id, provider);
    logger.info(`${LOG} cloud key saved`, { profileId: profile.id, provider, ok: r.ok, devices: r.devices?.length || 0 });
    if (!r.ok) return res.status(409).json({ ok: false, error: r.error, saved: true, hardware: await dev.service.pageData(profile.id) });
    res.json({ ok: true, devices: r.devices.length, hardware: await dev.service.pageData(profile.id) });
}));

router.post('/stream/bot/api/lights/cloud/:provider/refresh', needApi, testLimiter, wrap(async (req, res, { profile, dev }) => {
    const provider = String(req.params.provider);
    if (!CLOUD_PROVIDERS.includes(provider)) return res.status(404).json({ ok: false, error: 'Not found.' });
    const r = await dev.cloud.check(profile.id, provider);
    if (!r.ok) return res.status(409).json({ ok: false, error: r.error, hardware: await dev.service.pageData(profile.id) });
    res.json({ ok: true, devices: r.devices.length, hardware: await dev.service.pageData(profile.id) });
}));

router.delete('/stream/bot/api/lights/cloud/:provider', needApi, wrap(async (req, res, { profile, dev }) => {
    const provider = String(req.params.provider);
    if (!CLOUD_PROVIDERS.includes(provider)) return res.status(404).json({ ok: false, error: 'Not found.' });
    const removed = await dev.accounts.remove(profile.id, provider);
    res.json({ ok: true, removed, hardware: await dev.service.pageData(profile.id) });
}));

router.post('/stream/bot/api/lights/presets', needApi, wrap(async (req, res, { profile, dev }) => {
    const r = await dev.service.savePreset(profile.id, req.body?.preset || {});
    if (!r.ok) return res.status(400).json({ ok: false, error: r.errors.join(' ') });
    res.json({ ok: true, preset: r.value });
}));

router.post('/stream/bot/api/lights/presets/:id/apply', needApi, testLimiter, wrap(async (req, res, { profile, dev }) => {
    const id = String(req.params.id);
    if (!/^p_[a-z0-9]{6,16}$/.test(id)) return res.status(404).json({ ok: false, error: 'Not found.' });
    const r = await dev.service.applyPreset(profile.id, id);
    if (r.status === 'failed') return res.status(409).json({ ok: false, error: r.detail });
    if (r.status === 'queued' || r.status === 'none') return res.status(409).json({ ok: false, error: 'CertiFried Studio is not connected, so the lights on your PC\'s network were not changed.' });
    res.json({ ok: true, message: r.status === 'done' ? 'Applied.' : 'Sent to CertiFried Studio.' });
}));

router.delete('/stream/bot/api/lights/presets/:id', needApi, wrap(async (req, res, { profile, dev }) => {
    const ok = await dev.service.deletePreset(profile.id, String(req.params.id));
    if (!ok) return res.status(404).json({ ok: false, error: 'That preset was already deleted.' });
    res.json({ ok: true });
}));

export default router;
