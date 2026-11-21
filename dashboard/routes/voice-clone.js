/*
 * Your voice (own-voice feature, invite-only; core/voice-clone, migration 476).
 *
 *   Person (session; the signed-in user's own voice only; CSRF on writes through the global middleware)
 *     GET    /stream/bot/voice                        the page (consent, live check, recording, training, test, use, delete)
 *     GET    /stream/bot/api/voice/state
 *     POST   /stream/bot/api/voice/consent            { typedName, state, agree, ageAttested, ownVoice, keepSamples, textVersion }
 *     POST   /stream/bot/api/voice/challenge          start the live check → { sentences, expiresInMs }
 *     POST   /stream/bot/api/voice/challenge/:index   body: the recording (audio/webm, ogg, mp4 or wav from MediaRecorder)
 *     GET    /stream/bot/api/voice/prompt             the next script sentence
 *     POST   /stream/bot/api/voice/takes?prompt=N     body: the recording
 *     DELETE /stream/bot/api/voice/takes/:id          redo a take
 *     POST   /stream/bot/api/voice/train  ·  /train/cancel  ·  /approve  ·  /settings  ·  /delete { confirm: 'delete' }
 *     POST   /stream/bot/api/voice/preview            { text } → audio/wav (review or active voice; watermarked)
 *   Owner console (super-admin)
 *     GET    /super-admin/voice                       invites, voices, jobs, events, the watermark detection tool
 *     GET    /api/super-admin/voice
 *     POST   /api/super-admin/voice/invites           { userId, note }   ·   POST /api/super-admin/voice/invites/:userId/revoke
 *     POST   /api/super-admin/voice/voices/:id/:action   approve | allow-training | suspend | unsuspend | delete
 *     POST   /api/super-admin/voice/detect            body: an audio file (at most 10 MB) → made by CertiFried? which voice?
 *   Public
 *     GET    /legal/voice                             notice, retention schedule, Consumer Health Data Privacy Policy, credits
 *
 * Nothing here is public apart from /legal/voice: there is no public detection endpoint (owner decision, invite-only).
 * Literal paths come before /:param paths.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import logger from '../../utils/logger.js';
import { checkAuth, checkSuperAdmin, apiCheckSuperAdmin } from '../middleware/auth.js';
import { getVoiceClone } from '../../core/voice-clone/index.js';
import { CONSENT_SECTIONS, CONSENT_VERSION, CONSENT_SHA256 } from '../../core/voice-clone/consent-text.js';
import { US_STATES, BLOCKED_STATES, LIMITS, GPU_WINDOW, BASE_MODEL } from '../../core/voice-clone/constants.js';
import { TUNING_CHOICES } from '../../core/voice-clone/service.js';
import { loadThresholds } from '../../core/voice-clone/scoring.js';

const router = express.Router();
const LOG = '[VoiceCloneRoutes]';
const signedIn = (req) => !!(req.isAuthenticated?.() && req.user?.id);
const json = express.json({ limit: '16kb' });
const audioBody = express.raw({ type: () => true, limit: `${Math.ceil(LIMITS.clipMaxBytes / 1024)}kb` });
const detectBody = express.raw({ type: () => true, limit: '10mb' });
const heavyLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `vc:${req.user?.id || 'anon'}` });
const previewLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `vcp:${req.user?.id || 'anon'}` });

function needPage(req, res, next) {
    if (signedIn(req)) return next();
    return res.redirect(`/auth/discord?returnTo=${encodeURIComponent('/stream/bot/voice')}`);
}
function needApi(req, res, next) {
    if (signedIn(req)) return next();
    return res.status(401).json({ ok: false, error: 'You are signed out. Sign in again and retry.' });
}
async function vcOr503(res) {
    const vc = await getVoiceClone().catch(() => null);
    if (!vc) { res.status(503).json({ ok: false, error: 'Your voice starts after the next CertiFried update.' }); return null; }
    return vc;
}
const api = (fn) => async (req, res) => {
    try {
        const vc = await vcOr503(res);
        if (!vc) return;
        const out = await fn(vc, req, res);
        if (!res.headersSent) res.set('Cache-Control', 'no-store').json({ ok: true, ...(out || {}) });
    } catch (err) {
        if (err?.status && err.status < 500) return res.status(err.status).json({ ok: false, error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.lockedUntil ? { lockedUntil: err.lockedUntil } : {}) });
        logger.error(`${LOG} api failed`, { path: req.path, method: req.method, error: err?.message });
        if (!res.headersSent) res.status(err?.status || 500).json({ ok: false, error: err?.status ? err.message : 'Something went wrong. Try again.' });
    }
};
const cfOf = (req) => ({
    cfCountry: String(req.get('cf-ipcountry') || '').slice(0, 2) || null,
    cfRegion: String(req.get('cf-region-code') || '').slice(0, 8) || null,
    ip: String(req.get('cf-connecting-ip') || req.ip || ''),
});

// ── the person's page ──

router.get('/stream/bot/voice', needPage, async (req, res) => {
    try {
        const vc = await getVoiceClone().catch(() => null);
        const state = vc ? await vc.service.state(req.user) : null;
        res.set('Cache-Control', 'no-store');
        res.render('stream-bot/voice', {
            user: req.user, active: 'voice', pageTitle: 'Your voice', ready: !!vc, state,
            consent: { sections: CONSENT_SECTIONS, version: CONSENT_VERSION, sha: CONSENT_SHA256 },
            states: US_STATES.map(([code, name]) => ({ code, name, blocked: BLOCKED_STATES.includes(code) })),
            limits: { minMinutes: LIMITS.minTrainingMinutes, maxMinutes: LIMITS.maxTrainingMinutes, chars: LIMITS.utteranceChars },
            tuningChoices: TUNING_CHOICES,
        });
    } catch (err) {
        logger.error(`${LOG} page failed`, { error: err?.message });
        res.status(500).render('error-tailwind', { user: req.user, error: 'The Your voice page could not be loaded. Try again in a minute.' });
    }
});

router.get('/stream/bot/api/voice/state', needApi, api(async (vc, req) => ({ state: await vc.service.state(req.user) })));
router.post('/stream/bot/api/voice/consent', needApi, json, api(async (vc, req) => vc.service.signConsent(req.user, req.body || {}, cfOf(req))));
router.post('/stream/bot/api/voice/challenge', needApi, heavyLimit, api(async (vc, req) => vc.service.startChallenge(req.user)));
router.post('/stream/bot/api/voice/challenge/:index', needApi, heavyLimit, audioBody, api(async (vc, req) => vc.service.submitChallengeClip(req.user, Number(req.params.index), req.body)));
router.get('/stream/bot/api/voice/prompt', needApi, api(async (vc, req) => ({ prompt: await vc.service.nextPrompt(req.user) })));
router.post('/stream/bot/api/voice/takes', needApi, heavyLimit, audioBody, api(async (vc, req) => vc.service.addTake(req.user, Number(req.query.prompt), req.body)));
router.delete('/stream/bot/api/voice/takes/:id', needApi, api(async (vc, req) => vc.service.removeTake(req.user, Number(req.params.id))));
router.post('/stream/bot/api/voice/train/cancel', needApi, api(async (vc, req) => vc.service.cancelTraining(req.user)));
router.post('/stream/bot/api/voice/train', needApi, api(async (vc, req) => vc.service.startTraining(req.user)));
router.post('/stream/bot/api/voice/approve', needApi, api(async (vc, req) => vc.service.approve(req.user)));
router.post('/stream/bot/api/voice/settings', needApi, json, api(async (vc, req) => vc.service.saveSettings(req.user, req.body || {})));
router.post('/stream/bot/api/voice/delete', needApi, json, api(async (vc, req) => ({ result: await vc.service.deleteOwn(req.user, req.body || {}) })));
router.post('/stream/bot/api/voice/preview', needApi, previewLimit, json, async (req, res) => {
    try {
        const vc = await vcOr503(res);
        if (!vc) return;
        const r = await vc.synth.synthesize(String(req.user.id), String(req.body?.text || ''), { feature: 'preview', profileOwnerId: String(req.user.id) });
        res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'Content-Length': r.wav.length }).end(r.wav);
    } catch (err) {
        const status = err?.status || 500;
        if (status >= 500) logger.warn(`${LOG} preview failed`, { error: err?.message });
        res.status(status).json({ ok: false, error: err?.status ? err.message : 'Your voice could not speak. Try again.' });
    }
});

// ── owner console ──

router.get('/super-admin/voice', checkAuth, checkSuperAdmin, (req, res) => {
    res.set('Cache-Control', 'no-store').render('super-admin-voice', { user: req.user, limits: LIMITS, gpu: GPU_WINDOW });
});
router.get('/api/super-admin/voice', apiCheckSuperAdmin, api(async (vc) => ({ ...(await vc.service.adminOverview()), sidecar: await vc.sidecar.health() })));
router.post('/api/super-admin/voice/invites', apiCheckSuperAdmin, json, api(async (vc, req) => vc.service.invite(req.user.id, String(req.body?.userId || '').trim(), req.body?.note || null)));
router.post('/api/super-admin/voice/invites/:userId/revoke', apiCheckSuperAdmin, api(async (vc, req) => vc.service.revokeInvite(req.user.id, req.params.userId)));
router.post('/api/super-admin/voice/detect', apiCheckSuperAdmin, detectBody, api(async (vc, req) => ({ result: await vc.service.detectClip(req.body) })));
// pre-existing voices (core/voice-clone/legacy.js): written consent on file, attestation, existing recordings, A/B, opt-ins
const pendingOnnx = new Map();   // voiceId -> { buf, at }   an owner-supplied .onnx waiting for its .onnx.json
router.post('/api/super-admin/voice/legacy', apiCheckSuperAdmin, json, api(async (vc, req) => vc.legacy.createLegacyVoice(req.user.id, req.body || {})));
router.post('/api/super-admin/voice/voices/:id/consent', apiCheckSuperAdmin, json, api(async (vc, req) => vc.legacy.recordWrittenConsent(req.user.id, req.params.id, req.body || {})));
router.post('/api/super-admin/voice/voices/:id/evidence', apiCheckSuperAdmin, detectBody, api(async (vc, req) => vc.legacy.addEvidence(req.user.id, req.params.id, String(req.query.name || 'evidence'), req.body)));
router.post('/api/super-admin/voice/voices/:id/attest', apiCheckSuperAdmin, json, api(async (vc, req) => vc.legacy.attestLegacy(req.user.id, req.params.id, req.body || {})));
router.post('/api/super-admin/voice/voices/:id/reader-guilds', apiCheckSuperAdmin, json, api(async (vc, req) => vc.legacy.setReaderGuilds(req.user.id, req.params.id, req.body?.guildIds || [])));
router.post('/api/super-admin/voice/voices/:id/queue', apiCheckSuperAdmin, api(async (vc, req) => vc.legacy.queueLegacyTraining(req.user.id, req.params.id)));
router.post('/api/super-admin/voice/voices/:id/optin', apiCheckSuperAdmin, json, api(async (vc, req) => vc.legacy.setOptIn({ userId: String(req.user.id), role: 'admin' }, req.params.id, String(req.body?.which), req.body?.on === true)));
router.post('/api/super-admin/voice/voices/:id/model/onnx', apiCheckSuperAdmin, express.raw({ type: () => true, limit: '200mb' }), api(async (vc, req) => {
    if (!Buffer.isBuffer(req.body) || req.body.length < 1_000_000) throw Object.assign(new Error('Upload the .onnx file.'), { status: 400 });
    pendingOnnx.set(req.params.id, { buf: req.body, at: Date.now() });
    return { waiting: 'json' };
}));
router.post('/api/super-admin/voice/voices/:id/model/json', apiCheckSuperAdmin, express.raw({ type: () => true, limit: '2mb' }), api(async (vc, req) => {
    const p = pendingOnnx.get(req.params.id);
    if (!p || Date.now() - p.at > 30 * 60_000) throw Object.assign(new Error('Upload the .onnx first.'), { status: 409 });
    pendingOnnx.delete(req.params.id);
    return vc.legacy.uploadOwnerModel(req.user.id, req.params.id, { onnx: p.buf, json: req.body, attestation: { baseModel: req.query.baseModel, baseSha256: req.query.baseSha256, licence: req.query.licence, tool: req.query.tool } });
}));
router.get('/api/super-admin/voice/voices/:id/sample', apiCheckSuperAdmin, async (req, res) => {
    try {
        const vc = await vcOr503(res);
        if (!vc) return;
        const wav = await vc.legacy.adminSample(req.params.id, req.query.which === 'new' ? 'new' : 'current', String(req.query.text || ''));
        res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' }).end(wav);
    } catch (err) { res.status(err?.status || 500).json({ ok: false, error: err?.status ? err.message : 'Could not render.' }); }
});
router.post('/api/super-admin/voice/voices/:id/:action', apiCheckSuperAdmin, json, api(async (vc, req) => {
    const id = String(req.params.id);
    switch (req.params.action) {
        case 'approve': return vc.service.adminApprove(req.user.id, id);
        case 'allow-training': return vc.service.adminAllowTraining(req.user.id, id);
        case 'suspend': return vc.service.suspend(req.user.id, id, req.body?.note || null);
        case 'unsuspend': return vc.service.unsuspend(req.user.id, id);
        case 'delete': return { result: await vc.service.deleteVoice(id, { actor: 'admin', reason: 'owner_deleted', byUserId: req.user.id }) };
        default: throw Object.assign(new Error('Unknown action.'), { status: 404 });
    }
}));

// ── public notice ──

router.get('/legal/voice', (req, res) => {
    const th = loadThresholds();
    res.render('legal-voice', {
        user: req.user || null, consent: { sections: CONSENT_SECTIONS, version: CONSENT_VERSION, sha: CONSENT_SHA256 },
        limits: LIMITS, gpu: GPU_WINDOW, base: BASE_MODEL, thresholdVersion: th.version,
    });
});

export default router;
