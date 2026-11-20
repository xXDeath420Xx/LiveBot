/*
 * Stream bot overlays and alerts (docs/superpowers/specs/2026-11-19-stream-bot-design.md §9; core/stream-bot/overlays).
 *
 *   Pages  GET /stream/bot/overlays                          your overlays (state, URL, preview), add one, media library
 *          GET /stream/bot/overlays/:id                      one overlay's settings, its URL, a live preview, Test buttons
 *   API    (session, the signed-in user's own profile only; CSRF on writes)
 *          GET    /stream/bot/api/overlays                   list with online state
 *          GET    /stream/bot/api/overlays/choices           overlays and media names for the automation editor
 *          POST   /stream/bot/api/overlays                   { type, name } a new overlay (20 at most)
 *          POST   /stream/bot/api/overlays/media?name=       upload an image or video (the file is the body)
 *          GET    /stream/bot/api/overlays/media/:fileId/file  the file, for the dashboard
 *          DELETE /stream/bot/api/overlays/media/:fileId
 *          PUT    /stream/bot/api/overlays/:id               { name, config } (open pages restyle at once)
 *          POST   /stream/bot/api/overlays/:id/key           a new URL; the old one stops at once
 *          POST   /stream/bot/api/overlays/:id/test          { alert, amount } an alert box Test button
 *          POST   /stream/bot/api/overlays/:id/goal          { mode: add|set, value } a goal's progress
 *          DELETE /stream/bot/api/overlays/:id
 *   Overlay (no session: the overlay key in the path is the credential; CSRF-exempt per type in server.js; rate limited per IP)
 *          GET  /stream/bot/overlay/:type/:key               the page for OBS (?preview=1 on the dashboard)
 *          GET  /stream/bot/overlay/:type/:key/events        SSE: hello, config, alert, action, chat, chat_remove, event,
 *                                                            goal, counter, nowplaying, gone
 *          POST /stream/bot/overlay/:type/:key/report        { dispatchId, ok, error } acknowledges an overlay action
 *          GET  /stream/bot/overlay/:type/:key/sound/:id     a sound from the stream bot sound library
 *          GET  /stream/bot/overlay/:type/:key/media/:id     an image or video from the overlay media
 *          GET  /stream/bot/overlay/:type/:key/tts/:id       a message read aloud (WAV)
 *          GET  /stream/bot/overlay/chat/:key/img/:kind/:a/:b?  an emote or badge, through this server
 *
 * /stream/bot/overlay/music/<key> belongs to dashboard/routes/stream-bot-music.js: these routes pass any type that is not
 * an overlay type on with next(). Literal paths come before /:param paths.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import logger from '../../utils/logger.js';
import { getStreamBot } from '../../core/stream-bot/index.js';
import {
    OVERLAY_TYPES, ALERT_KINDS, ALERT_KEYS, POSITIONS, POSITION_LABEL, FONTS, LAYOUTS, LAYOUT_LABEL, ANIMATIONS, ANIMATION_LABEL, PLATES, PLATE_LABEL,
    GOAL_METRICS, GOAL_LABEL, EVENT_LIST_TYPES, LIMITS, overlayType, isOverlayType, validateConfig,
    TITLE_STYLES, TITLE_STYLE_LABEL, GLOW_STYLES, GLOW_STYLE_LABEL, SCENE_LIMITS, NOWPLAYING_BACKGROUNDS, NOWPLAYING_BACKGROUND_LABEL,
} from '../../core/stream-bot/overlays/config.js';
import { isOverlayKeyShape, keyHash, setOverlayHeaders, openSse } from '../../core/stream-bot/overlays/http.js';
import { MEDIA_LIMITS } from '../../core/stream-bot/overlays/media.js';
import { eventType } from '../../core/stream-bot/events.js';
import { youtubeBotConfig } from '../../core/stream-bot/youtube/config.js';

const router = express.Router();
const LOG = '[StreamBotOverlays]';
const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '');
const signedIn = (req) => !!(req.isAuthenticated?.() && req.user?.id);

function needPage(req, res, next) {
    if (signedIn(req)) return next();
    const back = /^\/stream\/bot\/overlays(\/\d{1,15})?$/.test(req.path) ? req.path : '/stream/bot/overlays';
    return res.redirect('/auth/discord?returnTo=' + encodeURIComponent(back));
}
function needApi(req, res, next) {
    if (signedIn(req)) return next();
    return res.status(401).json({ ok: false, error: 'You are signed out. Sign in again and retry.' });
}
const pageRoute = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
        logger.error(`${LOG} page failed`, { path: req.path, error: err?.message });
        if (!res.headersSent) res.status(500).render('error-tailwind', { user: req.user, error: 'The Overlays page could not be loaded. Try again in a minute.' });
    }
};
const apiRoute = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
        logger.error(`${LOG} api failed`, { path: req.path, method: req.method, error: err?.message });
        if (!res.headersSent) res.status(500).json({ ok: false, error: 'Something went wrong. Try again.' });
    }
};
const idOf = (v) => (/^\d{1,15}$/.test(String(v ?? '')) ? Number(v) : null);
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const notReady = (res) => res.status(503).json({ ok: false, error: 'Overlays start after the next CertiFried restart.' });

async function load(req) {
    const sb = await getStreamBot();
    const profile = await sb.store.ensureProfile(req.user.id, req.user.global_name || req.user.username || null);
    return { sb, profile, ov: sb.overlays || null };
}

export const overlayUrl = (type, key) => `${DASHBOARD_URL}/stream/bot/overlay/${type}/${key}`;

/** An overlay row for the pages (no key). */
export function overlayView(o, status = {}) {
    const t = overlayType(o.type);
    return {
        id: o.id, type: o.type, typeLabel: t?.label || o.type, name: o.name, sourceName: t?.sourceName || 'CertiFried Overlay', keyHint: o.keyHint,
        online: status[o.id]?.online || 0, lastSeenAt: o.lastSeenAt ? new Date(o.lastSeenAt).toISOString() : null,
        summary: summaryOf(o),
    };
}
function summaryOf(o) {
    const c = o.config || {};
    switch (o.type) {
        case 'alerts': return `${ALERT_KEYS.filter((k) => c.alerts?.[k]?.enabled).length} of ${ALERT_KEYS.length} alerts on`;
        case 'chat': return `${(c.platforms || []).map((p) => (p === 'kick' ? 'Kick' : 'Twitch')).join(' and ')}, up to ${c.maxMessages} lines`;
        case 'events': return `The last ${c.max} events`;
        case 'goal': return `${c.title}: ${Number(o.state?.current) || 0} of ${c.target}`;
        case 'counter': return `${c.label || c.key} ({sdb:get:${c.key}})`;
        case 'nowplaying': return 'The song request playing now';
        case 'scene': return [c.title, c.countdown?.enabled ? `a ${c.countdown.minutes}-minute countdown` : '', c.background ? 'your artwork' : ''].filter(Boolean).join(', ') || 'A full-screen scene';
        default: return 'Text and images from automations';
    }
}
export const mediaView = (m) => ({ id: m.id, name: m.name, kind: m.kind, mime: m.mime, size: m.size, createdAt: m.createdAt ? new Date(m.createdAt).toISOString() : null });

/** What the settings forms offer (static lists). */
export const FORM = Object.freeze({
    types: OVERLAY_TYPES.map((t) => ({ type: t.type, label: t.label, description: t.description, sourceName: t.sourceName })),
    alertKinds: ALERT_KEYS.map((k) => ({ key: k, ...ALERT_KINDS[k] })),
    positions: POSITIONS.map((p) => ({ value: p, label: POSITION_LABEL[p] })),
    fonts: Object.entries(FONTS).map(([value, f]) => ({ value, label: f.label })),
    layouts: LAYOUTS.map((v) => ({ value: v, label: LAYOUT_LABEL[v] })),
    animations: ANIMATIONS.map((v) => ({ value: v, label: ANIMATION_LABEL[v] })),
    plates: PLATES.map((v) => ({ value: v, label: PLATE_LABEL[v] })),
    goalMetrics: GOAL_METRICS.map((v) => ({ value: v, label: GOAL_LABEL[v] })),
    eventTypes: EVENT_LIST_TYPES.map((t) => ({ value: t, label: eventType(t)?.label || t })),
    titleStyles: TITLE_STYLES.map((v) => ({ value: v, label: TITLE_STYLE_LABEL[v] })),
    glowStyles: GLOW_STYLES.map((v) => ({ value: v, label: GLOW_STYLE_LABEL[v] })),
    npBackgrounds: NOWPLAYING_BACKGROUNDS.map((v) => ({ value: v, label: NOWPLAYING_BACKGROUND_LABEL[v] })),
    limits: LIMITS,
    sceneLimits: SCENE_LIMITS,
});

/** FORM for this server: the YouTube alerts and the YouTube chat choice only once YouTube is set up (§13.1, §13.10). */
export function formFor(env = process.env) {
    const youtube = youtubeBotConfig(env).enabled;
    return { ...FORM, youtube, alertKinds: youtube ? FORM.alertKinds : FORM.alertKinds.filter((k) => k.platform !== 'youtube') };
}

/** The English Piper voices installed on this server (the ones the read-aloud option offers). */
async function ttsVoices() {
    try {
        const m = await import('../../utils/piper-tts.js');
        const groups = (m.getVoiceOptions?.() || []).filter((g) => g?.engine === 'piper' && /English/.test(String(g.label)));
        return groups.flatMap((g) => (g.voices || []).map((v) => ({ value: String(v.value), label: `${v.label} · ${String(g.label).replace(/^Piper · /, '')}` })))
            .filter((v) => /^[a-z0-9_-]{1,50}$/i.test(v.value)).slice(0, 60);
    } catch { return []; }
}

// ── pages ──────────────────────────────────────────────────────────────────────────────────

router.get('/stream/bot/overlays', needPage, pageRoute(async (req, res) => {
    const { sb, profile, ov } = await load(req);
    if (!ov) return res.render('stream-bot/overlays', { user: req.user, ready: false, profile, overlays: [], media: [], form: formFor(), mediaLimits: MEDIA_LIMITS, usedBytes: 0 });
    const [list, mediaList] = await Promise.all([ov.ostore.list(profile.id), ov.media.list(profile.id)]);
    const status = ov.service.status(profile.id);
    res.render('stream-bot/overlays', {
        user: req.user, ready: true, profile, overlays: list.map((o) => overlayView(o, status)), media: mediaList.map(mediaView), form: formFor(),
        mediaLimits: MEDIA_LIMITS, usedBytes: mediaList.reduce((n, m) => n + (Number(m.size) || 0), 0), studioOnline: sb.hub.connected(profile.id).some((d) => d.kind === 'studio'),
    });
}));

router.get('/stream/bot/overlays/:id', needPage, pageRoute(async (req, res) => {
    const { sb, profile, ov } = await load(req);
    const id = idOf(req.params.id);
    if (!ov) return res.redirect('/stream/bot/overlays');
    const o = id ? await ov.ostore.get(profile.id, id) : null;
    if (!o) return res.status(404).render('error-tailwind', { user: req.user, error: 'That overlay does not exist. It may have been deleted.' });
    const [key, mediaList, soundList, voices] = await Promise.all([ov.ostore.keyOf(profile.id, o.id), ov.media.list(profile.id), sb.sounds.list(profile.id).catch(() => []), o.type === 'alerts' ? ttsVoices() : []]);
    const status = ov.service.status(profile.id);
    res.render('stream-bot/overlay-edit', {
        user: req.user, profile, overlay: overlayView(o, status), config: o.config, state: o.state || {}, url: key ? overlayUrl(o.type, key) : null, form: formFor(),
        media: mediaList.map(mediaView), sounds: soundList.map((s) => ({ id: s.id, name: s.name })), voices,
        editData: JSON.stringify({ id: o.id, type: o.type, config: o.config }).replace(/</g, '\\u003c'),
    });
}));

// ── API (literal paths first) ──────────────────────────────────────────────────────────────

router.get('/stream/bot/api/overlays', needApi, apiRoute(async (req, res) => {
    const { profile, ov } = await load(req);
    if (!ov) return notReady(res);
    const status = ov.service.status(profile.id);
    res.json({ ok: true, overlays: (await ov.ostore.list(profile.id)).map((o) => overlayView(o, status)) });
}));

router.get('/stream/bot/api/overlays/choices', needApi, apiRoute(async (req, res) => {
    const { profile, ov } = await load(req);
    if (!ov) return res.json({ ok: true, overlays: [], media: [] });
    const [list, mediaList] = await Promise.all([ov.ostore.list(profile.id), ov.media.list(profile.id)]);
    res.json({ ok: true, overlays: list.map((o) => ({ id: o.id, name: o.name, type: o.type, typeLabel: overlayType(o.type)?.label || o.type })), media: mediaList.map((m) => m.name) });
}));

router.post('/stream/bot/api/overlays', needApi, apiRoute(async (req, res) => {
    const { profile, ov } = await load(req);
    if (!ov) return notReady(res);
    const type = String(req.body?.type || '');
    if (!isOverlayType(type)) return res.status(400).json({ ok: false, error: 'Pick what kind of overlay to add.' });
    if ((await ov.ostore.count(profile.id)) >= LIMITS.overlays) return res.status(400).json({ ok: false, error: `You have ${LIMITS.overlays} overlays, the most a profile can have. Delete one first.` });
    const name = str(req.body?.name, LIMITS.name) || overlayType(type).label;
    const { overlay, key } = await ov.ostore.create(profile.id, { type, name });
    logger.info(`${LOG} overlay added`, { profileId: profile.id, overlayId: overlay.id, type });
    res.json({ ok: true, id: overlay.id, url: overlayUrl(type, key) });
}));

const mediaBody = express.raw({ type: () => true, limit: MEDIA_LIMITS.fileBytes + 1024 });
router.post('/stream/bot/api/overlays/media', needApi, (req, res, next) => mediaBody(req, res, (err) => {
    if (err?.type === 'entity.too.large' || err?.status === 413) return res.status(413).json({ ok: false, error: `A file can be at most ${MEDIA_LIMITS.fileBytes / 1048576} MB.` });
    if (err) return res.status(400).json({ ok: false, error: 'The upload could not be read. Try again.' });
    return next();
}), apiRoute(async (req, res) => {
    const { profile, ov } = await load(req);
    if (!ov) return notReady(res);
    const r = await ov.media.add(profile.id, { name: str(req.query.name, 200), buffer: Buffer.isBuffer(req.body) ? req.body : null });
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
    logger.info(`${LOG} media added`, { profileId: profile.id, size: r.media.size, kind: r.media.kind });
    res.json({ ok: true, media: mediaView(r.media) });
}));

router.get('/stream/bot/api/overlays/media/:fileId/file', needApi, apiRoute(async (req, res) => {
    const { profile, ov } = await load(req);
    if (!ov) return notReady(res);
    const m = await ov.media.get(profile.id, String(req.params.fileId || ''));
    const p = m ? ov.media.filePath(profile.id, m) : null;
    if (!p) return res.status(404).json({ ok: false, error: 'That file does not exist.' });
    res.sendFile(p, { headers: { 'Content-Type': m.mime, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' }, dotfiles: 'deny' }, (err) => {
        if (err && !res.headersSent) res.status(404).json({ ok: false, error: 'That file is missing.' });
    });
}));

router.delete('/stream/bot/api/overlays/media/:fileId', needApi, apiRoute(async (req, res) => {
    const { profile, ov } = await load(req);
    if (!ov) return notReady(res);
    const ok = await ov.media.remove(profile.id, String(req.params.fileId || ''));
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { ok: false, error: 'That file does not exist.' });
}));

router.put('/stream/bot/api/overlays/:id', needApi, apiRoute(async (req, res) => {
    const { sb, profile, ov } = await load(req);
    if (!ov) return notReady(res);
    const o = await ov.ostore.get(profile.id, idOf(req.params.id) || 0);
    if (!o) return res.status(404).json({ ok: false, error: 'That overlay does not exist.' });
    const name = req.body?.name === undefined ? undefined : str(req.body.name, LIMITS.name);
    if (name !== undefined && !name) return res.status(400).json({ ok: false, error: 'Give the overlay a name.' });
    let config;
    if (req.body?.config !== undefined) {
        const [mediaList, soundList] = await Promise.all([ov.media.list(profile.id), sb.sounds.list(profile.id).catch(() => [])]);
        const v = validateConfig(o.type, req.body.config, { mediaIds: new Set(mediaList.map((m) => m.id)), soundIds: new Set(soundList.map((s) => s.id)) });
        if (!v.ok) return res.status(400).json({ ok: false, error: v.errors.join(' ') });
        config = v.value;
    }
    await ov.ostore.update(profile.id, o.id, { name, config });
    keyCacheDrop(o.id);
    await ov.service.invalidate(o.id, { profileId: profile.id });
    res.json({ ok: true });
}));

router.post('/stream/bot/api/overlays/:id/key', needApi, apiRoute(async (req, res) => {
    const { profile, ov } = await load(req);
    if (!ov) return notReady(res);
    const o = await ov.ostore.get(profile.id, idOf(req.params.id) || 0);
    if (!o) return res.status(404).json({ ok: false, error: 'That overlay does not exist.' });
    const key = await ov.ostore.rotateKey(profile.id, o.id);
    keyCacheDrop(o.id);
    await ov.service.invalidate(o.id, { closeAll: true });
    logger.info(`${LOG} overlay key replaced`, { profileId: profile.id, overlayId: o.id });
    res.json({ ok: true, url: overlayUrl(o.type, key) });
}));

router.post('/stream/bot/api/overlays/:id/test', needApi, apiRoute(async (req, res) => {
    const { profile, ov } = await load(req);
    if (!ov) return notReady(res);
    const o = await ov.ostore.get(profile.id, idOf(req.params.id) || 0);
    if (!o || o.type !== 'alerts') return res.status(404).json({ ok: false, error: 'That alert box does not exist.' });
    const key = String(req.body?.alert || '');
    if (!ALERT_KINDS[key]) return res.status(400).json({ ok: false, error: 'Unknown alert.' });
    const amount = req.body?.amount === '' || req.body?.amount == null ? null : Number(req.body.amount);
    const r = await ov.service.testAlert(profile.id, o.id, key, Number.isFinite(amount) ? amount : null);
    res.json({ ok: true, sent: r.sent, message: r.sent ? 'Sent to the open overlay.' : 'Nothing is showing this overlay right now. Open it in OBS or open the preview, then test again.' });
}));

router.post('/stream/bot/api/overlays/:id/goal', needApi, apiRoute(async (req, res) => {
    const { profile, ov } = await load(req);
    if (!ov) return notReady(res);
    const o = await ov.ostore.get(profile.id, idOf(req.params.id) || 0);
    if (!o || o.type !== 'goal') return res.status(404).json({ ok: false, error: 'That goal does not exist.' });
    const n = Number(String(req.body?.value ?? '').replace(/,/g, ''));
    if (!Number.isFinite(n) || (n < 0 && req.body?.mode !== 'add')) return res.status(400).json({ ok: false, error: 'Enter a number of 0 or more.' });
    const r = await ov.service.changeGoal(profile.id, o.id, req.body?.mode === 'add' ? 'add' : 'set', n);
    res.status(r.ok ? 200 : 400).json(r.ok ? { ok: true, current: r.current, target: r.target } : { ok: false, error: r.error });
}));

router.delete('/stream/bot/api/overlays/:id', needApi, apiRoute(async (req, res) => {
    const { profile, ov } = await load(req);
    if (!ov) return notReady(res);
    const id = idOf(req.params.id) || 0;
    const ok = await ov.ostore.remove(profile.id, id);
    if (ok) { keyCacheDrop(id); await ov.service.invalidate(id, { closeAll: true }); }
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { ok: false, error: 'That overlay does not exist.' });
}));

// ── the OBS browser sources ─────────────────────────────────────────────────────────────────

const limiter = (max) => rateLimit({ windowMs: 60_000, max, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Too many requests.' } });
const pageLimiter = limiter(30);
const eventsLimiter = limiter(30);
const reportLimiter = limiter(240);
const fileLimiter = limiter(300);
const ttsLimiter = limiter(60);
const imgLimiter = limiter(1200);

// Key → overlay, cached briefly: chat emotes and alert files can ask many times a minute.
const keyCache = new Map();   // keyHash -> { at, overlay }
const KEY_CACHE_MS = 30_000;
function keyCacheDrop(overlayId) { for (const [k, v] of keyCache) if (v.overlay?.id === overlayId) keyCache.delete(k); }

/** The overlay behind /stream/bot/overlay/:type/:key, or null. `fresh` skips the cache (pages and feeds). */
async function overlayFor(req, { fresh = false } = {}) {
    const { type, key } = req.params;
    if (!isOverlayType(type) || !isOverlayKeyShape(key)) return null;
    const sb = await getStreamBot();
    if (!sb.overlays) return null;
    const h = keyHash(key);
    const hit = keyCache.get(h);
    let overlay = !fresh && hit && Date.now() - hit.at < KEY_CACHE_MS ? hit.overlay : null;
    if (!overlay) {
        overlay = await sb.overlays.ostore.byKeyHash(h);
        if (keyCache.size > 2000) keyCache.clear();
        keyCache.set(h, { at: Date.now(), overlay });
    }
    if (!overlay || overlay.type !== type) return null;
    return { sb, ov: sb.overlays, overlay };
}
const skipOther = (req, res, next) => (isOverlayType(req.params.type) ? next() : next('route'));

router.get('/stream/bot/overlay/:type/:key', skipOther, pageLimiter, async (req, res) => {
    try {
        const hit = await overlayFor(req, { fresh: true });
        setOverlayHeaders(res);
        res.status(hit ? 200 : 404).render('stream-bot/overlay', {
            ok: !!hit, type: req.params.type,
            pageData: hit ? JSON.stringify({ type: hit.overlay.type, base: `/stream/bot/overlay/${hit.overlay.type}/${req.params.key}`, preview: req.query.preview === '1', sound: req.query.preview !== '1' || req.query.sound === '1' }).replace(/</g, '\\u003c') : null,
        });
    } catch (err) {
        logger.error(`${LOG} overlay page failed`, { error: err?.message });
        res.status(500).type('text/plain').send('Not available');
    }
});

router.get('/stream/bot/overlay/:type/:key/events', skipOther, eventsLimiter, async (req, res) => {
    let hit;
    try { hit = await overlayFor(req, { fresh: true }); } catch { hit = null; }
    if (!hit) return res.status(404).json({ ok: false, error: 'This overlay link is not valid any more.' });
    let detach = null;
    const client = openSse(req, res, { onClose: () => { try { detach?.(); } catch { /* gone */ } } });
    try {
        detach = await hit.ov.service.attach(hit.overlay, client, { preview: req.query.preview === '1' });
        if (client.closed) detach();
    } catch (err) {
        logger.warn(`${LOG} overlay attach failed`, { error: err?.message });
        client.close();
    }
});

router.post('/stream/bot/overlay/:type/:key/report', skipOther, reportLimiter, async (req, res) => {
    try {
        const hit = await overlayFor(req);
        if (!hit) return res.status(404).json({ ok: false });
        const r = await hit.ov.service.report(hit.overlay, { dispatchId: String(req.body?.dispatchId || '').slice(0, 40), ok: req.body?.ok !== false, error: req.body?.error ? String(req.body.error).slice(0, 120) : null });
        res.json({ ok: true, result: r });
    } catch (err) {
        logger.warn(`${LOG} overlay report failed`, { error: err?.message });
        res.status(500).json({ ok: false });
    }
});

function sendStored(res, file, mime) {
    res.sendFile(file, { headers: { 'Content-Type': mime, 'Cache-Control': 'private, max-age=3600', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }, dotfiles: 'deny' }, (err) => {
        if (err && !res.headersSent) res.status(404).json({ ok: false });
    });
}

router.get('/stream/bot/overlay/:type/:key/sound/:id', skipOther, fileLimiter, async (req, res) => {
    try {
        const hit = await overlayFor(req);
        if (!hit) return res.status(404).json({ ok: false });
        const s = await hit.sb.sounds.get(hit.overlay.profileId, String(req.params.id || ''));
        const p = s ? hit.sb.sounds.filePath(hit.overlay.profileId, s) : null;
        if (!p) return res.status(404).json({ ok: false });
        sendStored(res, p, s.mime || 'audio/mpeg');
    } catch (err) {
        logger.warn(`${LOG} overlay sound failed`, { error: err?.message });
        if (!res.headersSent) res.status(500).json({ ok: false });
    }
});

router.get('/stream/bot/overlay/:type/:key/media/:id', skipOther, fileLimiter, async (req, res) => {
    try {
        const hit = await overlayFor(req);
        if (!hit) return res.status(404).json({ ok: false });
        const m = await hit.ov.media.get(hit.overlay.profileId, String(req.params.id || ''));
        const p = m ? hit.ov.media.filePath(hit.overlay.profileId, m) : null;
        if (!p) return res.status(404).json({ ok: false });
        sendStored(res, p, m.mime);
    } catch (err) {
        logger.warn(`${LOG} overlay media failed`, { error: err?.message });
        if (!res.headersSent) res.status(500).json({ ok: false });
    }
});

router.get('/stream/bot/overlay/:type/:key/tts/:id', skipOther, ttsLimiter, async (req, res) => {
    try {
        const hit = await overlayFor(req);
        if (!hit) return res.status(404).json({ ok: false });
        const buf = await hit.ov.service.ttsAudio(hit.overlay, String(req.params.id || '').slice(0, 20));
        if (!buf) return res.status(404).json({ ok: false });
        setOverlayHeaders(res);
        res.type('audio/wav').send(buf);
    } catch (err) {
        logger.warn(`${LOG} overlay tts failed`, { error: err?.message });
        if (!res.headersSent) res.status(500).json({ ok: false });
    }
});

router.get('/stream/bot/overlay/:type/:key/img/:kind/:a/:b?', skipOther, imgLimiter, async (req, res) => {
    try {
        if (req.params.type !== 'chat') return res.status(404).end();
        const hit = await overlayFor(req);
        if (!hit) return res.status(404).end();
        let channelId = null;
        if (req.params.kind === 'tw-badge') {
            const ch = (await hit.sb.store.listChannels(hit.overlay.profileId)).find((c) => c.platform === 'twitch');
            channelId = ch ? String(ch.platform_user_id) : null;
        }
        const img = await hit.ov.images.get(String(req.params.kind), [req.params.a, req.params.b].filter((x) => x != null).map(String), { twitchChannelId: channelId });
        if (!img) return res.status(404).end();
        res.setHeader('Content-Type', img.type);
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.end(img.body);
    } catch (err) {
        logger.debug?.(`${LOG} overlay image failed`, { error: err?.message });
        if (!res.headersSent) res.status(502).end();
    }
});

export default router;
