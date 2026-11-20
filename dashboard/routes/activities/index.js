/**
 * CertiFried's Discord Activities (docs/activities.md), mounted at /activity before the site's session, rate limiter
 * and CSRF check: the Activity runs in Discord's frame on <app id>.discordsays.com, Discord's proxy sends everything
 * under the URL mapping "/" here (so /foo in the Activity is /activity/foo on this server), there are no cookies, and
 * every visitor arrives from Discord's proxy addresses (one shared IP for the site's per-IP limiter).
 *
 *   GET  /activity/                      the Activity page (launcher, Watch Together, Greenhouse)  views/activity.ejs
 *   GET  /activity/assets/<file>         its built files (frontend/activities, `node frontend/activities/build.mjs`)
 *   GET  /activity/greenhouse/           Greenhouse Tycoon in a frame (frontend/greenhouse --activity build)
 *   GET  /activity/greenhouse/assets/*   its files
 *   GET  /activity/greenhouse/session/discord   a 60-second Discord assertion for the game, like the website's
 *   POST /activity/api/token             { code, instanceId } -> our session (core/activities/discord-auth.js)
 *   GET  /activity/api/me                what this person can open here
 *   GET  /activity/api/watch/...         library, title, seasons, episodes, state
 *   GET  /activity/api/watch/events      the live channel (Server-Sent Events; no new WebSocket path for LiteSpeed)
 *   POST /activity/api/watch/play|control|next|report
 *   GET  /activity/media/<session>/<gen>/index.m3u8 | <signed name> | sub-<n>.vtt   the video, through this server
 *   GET  /activity/media/img/<item>/<tag>/<sig>   posters
 *
 * The Jellyfin API key, the client secret and the bot token never leave this process. Video links are signed per
 * session and title (core/activities/watch/media-links.js); playlists are rewritten so no Jellyfin address reaches
 * the browser.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import jwt from 'jsonwebtoken';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { activityConfig, activityProblem } from '../../../core/activities/config.js';
import { exchangeCode, fetchUser, checkInstance, signSession, requireActivitySession, ActivityAuthError } from '../../../core/activities/discord-auth.js';
import { takeIntent } from '../../../core/activities/intents.js';
import { createJellyfinMedia, JellyfinError, isJellyfinId } from '../../../core/activities/watch/jellyfin-media.js';
import { createWatchSessions, WatchError } from '../../../core/activities/watch/sessions.js';
import { createSegmentCache } from '../../../core/activities/watch/segment-cache.js';
import { createWatchStore } from '../../../core/activities/watch/store.js';
import { mediaKey, verifyRef, rewritePlaylist, allowedUpstreamPath } from '../../../core/activities/watch/media-links.js';
import { loadWatchConfig, watchAvailability, memberRights, guildClientFor } from '../../../core/activities/watch/guild-config.js';
import { setWatchSessions } from '../../../core/activities/watch/registry.js';
import { cleanDiag, diagLine } from '../../../core/activities/watch/diagnostics.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
export const ACTIVITY_DIST = path.join(ROOT, 'frontend/activities/dist');
export const GREENHOUSE_ACTIVITY_DIST = path.join(ROOT, 'frontend/greenhouse/dist/activity');

/** CSP for pages inside the Activity. No frame-ancestors: Discord frames them (discord.com, its apps, discordsays.com). */
export function activityCsp() {
    return [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "font-src 'self'",
        "img-src 'self' data: https://cdn.discordapp.com",
        "media-src 'self' blob:",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "frame-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
    ].join('; ');
}

function pageHeaders(res) {
    res.removeHeader('X-Frame-Options'); // the site's helmet says SAMEORIGIN; Discord must be able to frame these pages
    res.set('Content-Security-Policy', activityCsp());
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
}

function readManifest(dir) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return null; }
}

/** Small token buckets (memory, one process). */
function bucket({ burst, perSec, maxKeys = 50_000 }) {
    const m = new Map();
    return (key) => {
        const t = Date.now();
        let b = m.get(key);
        if (!b) {
            if (m.size >= maxKeys) m.clear();
            b = { tokens: burst, at: t };
            m.set(key, b);
        }
        b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * perSec);
        b.at = t;
        if (b.tokens < 1) return false;
        b.tokens -= 1;
        return true;
    };
}

const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });
const sendError = (res, e) => {
    if (e instanceof WatchError || e instanceof JellyfinError || e instanceof ActivityAuthError) return fail(res, e.status, e.code, e.message);
    logger.error(`[activity] ${e?.stack || e}`);
    return fail(res, 500, 'SERVER', 'Something went wrong. Try again.');
};

export default function activitiesRouter({
    getCfg = () => activityConfig(),
    db = pool,
    fetchImpl = fetch,
    media = null,
    sessions = null,
    store = undefined,
    clock = () => Date.now(),
    startTicker = true,
} = {}) {
    const router = express.Router();
    let cfg = getCfg();
    const jf = media || createJellyfinMedia({ cfg, fetchImpl });
    const cache = createSegmentCache({ maxBytes: cfg.watch.cacheMb * 1024 * 1024 });
    const images = createSegmentCache({ maxBytes: 32 * 1024 * 1024 });
    const watchStore = store === undefined ? createWatchStore({ pool: db }) : store;
    const watch = sessions || createWatchSessions({
        cfg, media: jf, cache, store: watchStore, logger, now: clock,
        onAdvance: async (s, index) => {
            const next = s.queue[index];
            const conf = await loadWatchConfig(db, s.guildId);
            const item = await jf.getItem(next.itemId, conf?.libraryId || null);
            await watch.play(s, { item, audioIndex: null, keepQueue: true, queueIndex: index });
        },
    });
    if (!sessions) {
        setWatchSessions(watch);
        watch.restore().then((n) => { if (n) logger.info(`[activity] restored ${n} Watch Together session(s)`); })
            .catch((e) => logger.warn(`[activity] could not restore Watch Together sessions: ${e.message}`));
    }
    if (startTicker) setInterval(() => { watch.tick().catch(() => {}); }, 2000).unref();

    const tokenLimit = bucket({ burst: 60, perSec: 2 });   // shared: everyone arrives from Discord's proxy
    const userLimit = bucket({ burst: 60, perSec: 10 });
    const diagLimit = bucket({ burst: 6, perSec: 1 / 20 });   // per viewer: two reports per title
    const mediaLimit = bucket({ burst: 400, perSec: 60 });  // per session: every viewer's segments
    const requireSession = requireActivitySession(() => cfg);
    const imgSig = (itemId, tag) => crypto.createHmac('sha256', cfg.sessionSecret).update(`img:${itemId}:${tag}`).digest('base64url').slice(0, 22);
    const imageUrl = (itemId, tag) => (tag ? `media/img/${itemId}/${tag}/${imgSig(itemId, tag)}` : null);

    // ── member rights, cached a minute ──
    const memberCache = new Map();
    // Read through the main bot, or the server's custom bot when the main one is not in it. No bot, or the member
    // cannot be read: no rights (never fails open).
    async function rightsFor(req, conf) {
        const { guildId, userId } = req.activity;
        const client = guildClientFor(req.app?.locals?.client, guildId);
        const k = `${guildId}:${userId}`;
        const hit = memberCache.get(k);
        if (hit && Date.now() - hit.at < 60_000) return hit.v;
        let member = null;
        try { member = await client?.guilds?.cache?.get(guildId)?.members?.fetch(userId); } catch { member = null; }
        let hostRoleId = null;
        try {
            const { getConfig } = await import('../../../core/feature-config.js');
            const party = await getConfig('jellyfin', guildId);
            hostRoleId = party?.host_role_id ? String(party.host_role_id) : null;
        } catch { hostRoleId = null; }
        const v = memberRights(member, { config: conf, hostRoleId });
        if (memberCache.size > 20_000) memberCache.clear();
        memberCache.set(k, { v, at: Date.now() });
        return v;
    }

    async function watchContext(req) {
        const { guildId } = req.activity;
        const conf = guildId ? await loadWatchConfig(db, guildId) : null;
        const botInGuild = !!guildClientFor(req.app?.locals?.client, guildId);
        const avail = watchAvailability({ activityEnabled: cfg.enabled, guildId, botInGuild, config: conf });
        return { conf, avail };
    }

    async function requireWatch(req, res) {
        const ctx = await watchContext(req);
        if (!ctx.avail.ok) { fail(res, 403, 'WATCH_OFF', ctx.avail.reason); return null; }
        return ctx;
    }

    const isController = (s, req, rights) => s.hostId === req.activity.userId || rights.control;

    router.use((req, res, next) => {
        cfg = getCfg();
        res.removeHeader('X-Frame-Options');
        next();
    });

    // ── pages ───────────────────────────────────────────────────────────────────────────────

    router.get(['/', '/index.html'], (req, res) => {
        pageHeaders(res);
        const man = readManifest(ACTIVITY_DIST);
        if (!man) return res.status(503).type('text/plain').send('The Activity is not built yet.');
        res.render('activity', { appId: cfg.appId, assetBase: 'assets', js: man.js, css: man.css, demoJson: null, problem: activityProblem(cfg) });
    });
    router.use('/assets', express.static(path.join(ACTIVITY_DIST, 'assets'), { index: false, redirect: false, dotfiles: 'deny', immutable: true, maxAge: '365d', fallthrough: false }));

    router.get(['/greenhouse', '/greenhouse/'], (req, res) => {
        pageHeaders(res);
        fs.readFile(path.join(GREENHOUSE_ACTIVITY_DIST, 'index.html'), 'utf8', (err, html) => {
            if (err) return res.status(503).type('text/plain').send('Greenhouse Tycoon is not built for the Activity yet.');
            res.type('html').send(html);
        });
    });
    router.use('/greenhouse/assets', express.static(path.join(GREENHOUSE_ACTIVITY_DIST, 'assets'), { index: false, redirect: false, dotfiles: 'deny', immutable: true, maxAge: '365d', fallthrough: false }));

    // Greenhouse's Discord sign-in, as the website's /greenhouse/session/discord but for the Activity's session
    // (the game frame sends it as a bearer token; see frontend/greenhouse/src/activity-host.js).
    router.get('/greenhouse/session/discord', requireSession, (req, res) => {
        res.set('Cache-Control', 'no-store');
        const secret = process.env.CFX2_DASHBOARD_SECRET || '';
        if (secret.length < 32) return fail(res, 503, 'SIGNIN_UNAVAILABLE', 'Discord sign-in is not set up yet.');
        const now = Math.floor(Date.now() / 1000);
        const assertion = jwt.sign(
            { name: req.activity.name.slice(0, 64) || undefined, iat: now, exp: now + 60, jti: crypto.randomBytes(18).toString('base64url') },
            secret,
            { algorithm: 'HS256', issuer: 'certifried-dashboard', audience: 'cfx2-discord', subject: req.activity.userId });
        res.json({ assertion, exchangeUrl: '/gh-api/api/v2/auth/discord' });
    });

    // ── sign-in ─────────────────────────────────────────────────────────────────────────────

    const api = express.Router();
    api.use(express.json({ limit: '8kb', strict: true }));
    api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

    api.post('/token', async (req, res) => {
        if (!tokenLimit('token')) return fail(res, 429, 'RATE_LIMITED', 'A lot of people are opening the Activity. Try again in a few seconds.');
        const problem = activityProblem(cfg);
        if (problem) return fail(res, 503, 'NOT_ENABLED', 'This Activity is not switched on yet.');
        try {
            const { code, instanceId } = req.body || {};
            const { accessToken } = await exchangeCode({ code, cfg, fetchImpl });
            const user = await fetchUser({ accessToken, fetchImpl });
            const instance = await checkInstance({ instanceId, userId: user.id, cfg, fetchImpl });
            if (!instance) return fail(res, 404, 'NO_INSTANCE', 'This Activity has ended. Open it again from the voice channel.');
            if (!instance.member) return fail(res, 403, 'NOT_IN_INSTANCE', 'Discord does not list you in this Activity. Close it and open it again.');
            const session = signSession({ user, instance, cfg });
            const intent = instance.guildId ? takeIntent(instance.guildId, user.id) : null;
            res.json({
                access_token: accessToken,
                session,
                user: { id: user.id, name: user.name, avatar: user.avatar },
                where: { guildId: instance.guildId, channelId: instance.channelId },
                intent,
            });
        } catch (e) {
            sendError(res, e);
        }
    });

    api.use((req, res, next) => (req.path === '/token' ? next() : requireSession(req, res, next)));
    api.use((req, res, next) => (userLimit(req.activity.userId) ? next() : fail(res, 429, 'RATE_LIMITED', 'Slow down a little.')));

    api.get('/me', async (req, res) => {
        try {
            const { avail } = await watchContext(req);
            const s = req.activity.guildId ? watch.get(req.activity.instanceId) : null;
            res.json({
                user: { id: req.activity.userId, name: req.activity.name, avatar: req.activity.avatar },
                watch: { available: avail.ok, reason: avail.reason, active: !!s?.media },
                greenhouse: { available: true },
            });
        } catch (e) { sendError(res, e); }
    });

    // ── Watch Together: the library ─────────────────────────────────────────────────────────

    const withPoster = (x) => ({ ...x, image: imageUrl(x.id, x.image) });

    api.get('/watch/library', async (req, res) => {
        try {
            const ctx = await requireWatch(req, res); if (!ctx) return;
            const kind = ['movies', 'shows'].includes(req.query.kind) ? req.query.kind : 'all';
            const r = await jf.browse({ libraryId: ctx.conf.libraryId, kind, search: String(req.query.search || ''), page: Number(req.query.page) || 0 });
            res.json({ ...r, items: r.items.map(withPoster) });
        } catch (e) { sendError(res, e); }
    });

    api.get('/watch/item/:id', async (req, res) => {
        try {
            const ctx = await requireWatch(req, res); if (!ctx) return;
            const item = await jf.getItem(req.params.id, ctx.conf.libraryId);
            const out = withPoster(item);
            delete out.mediaSourceId;
            if (item.type === 'Series') out.seasons = await jf.seasons(item.id);
            res.json({ item: out });
        } catch (e) { sendError(res, e); }
    });

    api.get('/watch/show/:id/episodes', async (req, res) => {
        try {
            const ctx = await requireWatch(req, res); if (!ctx) return;
            await jf.getItem(req.params.id, ctx.conf.libraryId); // the show must be in this server's library
            const season = isJellyfinId(String(req.query.season || '')) ? String(req.query.season) : null;
            const eps = await jf.episodes(req.params.id, season);
            res.json({ episodes: eps.map(withPoster) });
        } catch (e) { sendError(res, e); }
    });

    // ── Watch Together: the session ─────────────────────────────────────────────────────────

    function sessionFor(req, { create = false } = {}) {
        const a = req.activity;
        const s = watch.get(a.instanceId);
        if (s || !create) return s;
        return watch.open({ instanceId: a.instanceId, guildId: a.guildId, channelId: a.channelId, user: { id: a.userId, name: a.name, avatar: a.avatar } });
    }

    api.get('/watch/state', async (req, res) => {
        try {
            const ctx = await requireWatch(req, res); if (!ctx) return;
            const s = sessionFor(req);
            const rights = await rightsFor(req, ctx.conf);
            res.json({ state: s ? watch.view(s) : null, serverNow: clock(), you: { id: req.activity.userId, canStart: rights.start, canControl: s ? isController(s, req, rights) : rights.start } });
        } catch (e) { sendError(res, e); }
    });

    api.get('/watch/events', async (req, res) => {
        let ctx;
        try { ctx = await requireWatch(req, res); } catch (e) { return sendError(res, e); }
        if (!ctx) return;
        const rights = await rightsFor(req, ctx.conf);
        const s = sessionFor(req, { create: true });
        res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
        res.flushHeaders?.();
        res.write('retry: 3000\n\n');
        let open = true;
        const send = (type, data) => { if (open) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
        let leave = () => {};
        try {
            leave = watch.join(s, { id: req.activity.userId, name: req.activity.name, avatar: req.activity.avatar }, send, { controller: rights.control });
        } catch (e) {
            send('error', { code: e.code || 'SERVER', message: e.message });
            open = false;
            return res.end();
        }
        const beat = setInterval(() => send('ping', { serverNow: clock() }), 15_000);
        const close = () => {
            if (!open) return;
            open = false;
            clearInterval(beat);
            leave();
        };
        req.on('close', close);
        res.on('error', close);
        // A session token expires: end the stream then, the page signs in again.
        const ttl = Math.max(5_000, req.activity.exp * 1000 - Date.now());
        setTimeout(() => { if (open) { send('reauth', {}); close(); res.end(); } }, Math.min(ttl, 2 ** 31 - 1)).unref();
    });

    api.post('/watch/play', async (req, res) => {
        try {
            const ctx = await requireWatch(req, res); if (!ctx) return;
            const rights = await rightsFor(req, ctx.conf);
            // Picking a title needs the server's watch party host role when one is set (as /movie), and, while
            // someone else hosts, control of this session. Nobody hosting and nothing playing: the picker becomes host.
            if (!rights.start) return fail(res, 403, 'NOT_ALLOWED', 'Only members with this server\'s watch party host role can pick a film.');
            const s = sessionFor(req, { create: true });
            if (!isController(s, req, rights)) {
                if (s.media || connectedHost(s)) return fail(res, 403, 'NOT_HOST', 'Only the host can pick what plays.');
                s.hostId = req.activity.userId;
            }
            const b = req.body || {};
            const item = await jf.getItem(String(b.itemId || ''), ctx.conf.libraryId);
            if (!['Movie', 'Episode', 'Video', 'MusicVideo'].includes(item.type)) return fail(res, 400, 'NOT_PLAYABLE', 'Pick a film or an episode.');
            let queue = null;
            let queueIndex = 0;
            if (Array.isArray(b.queue)) {
                // From /movie's picker ("play the whole season", "play from here"); each is checked against the library as it starts.
                const list = b.queue.slice(0, 200).filter((q) => q && isJellyfinId(String(q.itemId || '')))
                    .map((q) => ({ itemId: String(q.itemId), label: String(q.label || 'Episode').slice(0, 200) }));
                const at = list.findIndex((q) => q.itemId === item.id);
                if (list.length > 1 && at >= 0) { queue = list; queueIndex = at; }
            } else if (b.queue === 'season' || b.queue === 'show') {
                if (item.type === 'Episode' && item.seriesId) {
                    const eps = await jf.episodes(item.seriesId, null);
                    const ordered = eps.filter((e) => e.season > 0).sort((x, y) => x.season - y.season || x.episode - y.episode);
                    const at = ordered.findIndex((e) => e.id === item.id);
                    const sameSeason = (e) => b.queue === 'show' || e.season === item.season;
                    const from = ordered.slice(Math.max(0, at)).filter(sameSeason);
                    if (at >= 0 && from.length) queue = from.map((e) => ({ itemId: e.id, label: `${item.seriesName || ''} · S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')} · ${e.name}`.trim() }));
                }
            }
            const audioIndex = Number.isInteger(b.audioIndex) ? b.audioIndex : null;
            const burn = Number.isInteger(b.burnSubtitleIndex) ? b.burnSubtitleIndex : null;
            const view = await watch.play(s, { item, audioIndex, burnSubtitleIndex: burn, queue, queueIndex });
            res.json({ state: view });
        } catch (e) { sendError(res, e); }
    });

    function connectedHost(s) {
        return watch.view(s).viewers.some((v) => v.id === s.hostId);
    }

    api.post('/watch/control', async (req, res) => {
        try {
            const ctx = await requireWatch(req, res); if (!ctx) return;
            const s = sessionFor(req);
            if (!s) return fail(res, 409, 'NOTHING_PLAYING', 'Nothing is playing.');
            const rights = await rightsFor(req, ctx.conf);
            if (!isController(s, req, rights)) return fail(res, 403, 'NOT_HOST', 'Only the host can control playback.');
            const action = String(req.body?.action || '');
            if (!['play', 'pause', 'seek', 'stop'].includes(action)) return fail(res, 400, 'BAD_ACTION', 'Unknown control.');
            res.json({ state: await watch.control(s, { action, position: req.body?.position }) });
        } catch (e) { sendError(res, e); }
    });

    api.post('/watch/next', async (req, res) => {
        try {
            const ctx = await requireWatch(req, res); if (!ctx) return;
            const s = sessionFor(req);
            if (!s?.media) return fail(res, 409, 'NOTHING_PLAYING', 'Nothing is playing.');
            const rights = await rightsFor(req, ctx.conf);
            if (!isController(s, req, rights)) return fail(res, 403, 'NOT_HOST', 'Only the host can skip.');
            const index = Number.isInteger(req.body?.index) ? req.body.index : s.queueIndex + 1;
            if (index < 0 || index >= s.queue.length) return fail(res, 409, 'QUEUE_END', 'Nothing is queued after this.');
            const item = await jf.getItem(s.queue[index].itemId, ctx.conf.libraryId);
            res.json({ state: await watch.play(s, { item, keepQueue: true, queueIndex: index }) });
        } catch (e) { sendError(res, e); }
    });

    api.post('/watch/report', (req, res) => {
        const s = watch.get(req.activity.instanceId);
        if (s) watch.report(s, req.activity.userId, { buffering: !!req.body?.buffering });
        res.json({ ok: true, serverNow: clock() });
    });

    // Playback diagnostics (core/activities/watch/diagnostics.js): one [WatchDiag] log line per report.
    api.post('/watch/diag', (req, res) => {
        const diag = cleanDiag(req.body);
        if (!diag) return fail(res, 400, 'BAD_REPORT', 'Not a playback report.');
        if (diagLimit(req.activity.userId)) {
            const s = req.activity.instanceId ? watch.get(req.activity.instanceId) : null;
            logger.info(diagLine({ userId: req.activity.userId, session: s || { id: req.activity.instanceId, guildId: req.activity.guildId, channelId: req.activity.channelId }, diag }));
        }
        res.json({ ok: true });
    });

    api.use((req, res) => fail(res, 404, 'NOT_FOUND', 'Not found.'));
    router.use('/api', api);

    // ── media: posters ──────────────────────────────────────────────────────────────────────

    router.get('/media/img/:item/:tag/:sig', async (req, res) => {
        const { item, tag, sig } = req.params;
        const want = imgSig(item, tag);
        if (!isJellyfinId(item) || typeof sig !== 'string' || sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) {
            return res.status(404).end();
        }
        try {
            const r = await images.get(`img:${item}:${tag}`, async () => {
                const im = await jf.image(item, tag);
                return im ? { status: 200, type: im.type, body: im.body } : { status: 404 };
            });
            if (r.status !== 200) return res.status(404).end();
            res.set({ 'Content-Type': r.type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
            res.end(r.body);
        } catch {
            res.status(502).end();
        }
    });

    // ── media: the stream ───────────────────────────────────────────────────────────────────

    const restartedAt = new Map();
    async function upstreamText(s, rel) {
        const r = await jf.fetchUpstream(rel, { deviceId: s.media.deviceId, timeoutMs: 45_000 });
        const text = r.ok ? await r.text() : null;
        return { ok: r.ok, status: r.status, text };
    }
    function maybeRestart(s) {
        const last = restartedAt.get(s.id) || 0;
        if (Date.now() - last < 20_000 || Date.now() - (s.media?.startedAt || 0) < 15_000) return Promise.resolve(false);
        restartedAt.set(s.id, Date.now());
        return watch.restartStream(s);
    }

    router.get('/media/:sid/:gen/:name', async (req, res) => {
        const { sid, gen, name } = req.params;
        const s = /^[A-Za-z0-9_-]{24}$/.test(sid) ? watch.getById(sid) : null;
        if (!s?.media || String(s.media.gen) !== gen) return res.status(410).type('text/plain').send('gone');
        if (!mediaLimit(sid)) return res.status(429).set('Retry-After', '1').end();
        const m = s.media;
        const key = mediaKey(cfg.sessionSecret, s.id, m.gen);
        res.set({ 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
        try {
            if (name === 'index.m3u8') {
                let up = await upstreamText(s, m.path);
                if (!up.ok && await maybeRestart(s)) up = await upstreamText(s, s.media.path);
                if (!up.ok) return res.status(503).set('Retry-After', '2').end();
                res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
                return res.send(rewritePlaylist(up.text, s.media.path, { key, itemId: m.itemId }));
            }
            const sub = name.match(/^sub-(\d{1,4})\.vtt$/);
            if (sub) {
                const index = Number(sub[1]);
                if (!m.subtitles.some((t) => t.index === index)) return res.status(404).end();
                const rel = jf.subtitlePath({ id: m.itemId, mediaSourceId: m.mediaSourceId }, index);
                const r = await cache.get(`${s.id}:${m.gen}:${rel}`, async () => {
                    const up = await jf.fetchUpstream(rel, { deviceId: m.deviceId, timeoutMs: 30_000 });
                    return up.ok ? { status: 200, type: 'text/vtt; charset=utf-8', body: Buffer.from(await up.arrayBuffer()) } : { status: up.status };
                });
                if (r.status !== 200) return res.status(404).end();
                res.set({ 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, max-age=3600' });
                return res.end(r.body);
            }
            const rel = verifyRef(key, name);
            if (!rel || !allowedUpstreamPath(rel, m.itemId)) return res.status(404).end();
            const isPlaylist = /\.m3u8$/i.test(rel.split('?')[0]);
            const r = await cache.get(`${s.id}:${m.gen}:${rel}`, async () => {
                const up = await jf.fetchUpstream(rel, { deviceId: m.deviceId, timeoutMs: isPlaylist ? 45_000 : 90_000 });
                if (!up.ok) return { status: up.status };
                if (isPlaylist) return { status: 200, type: 'application/vnd.apple.mpegurl', body: Buffer.from(rewritePlaylist(await up.text(), rel, { key, itemId: m.itemId })) };
                const type = String(up.headers.get('content-type') || 'video/mp2t');
                return { status: 200, type: /^(video|audio)\/[\w.+-]+$/.test(type) ? type : 'video/mp2t', body: Buffer.from(await up.arrayBuffer()) };
            });
            if (r.status !== 200) {
                if ([400, 404, 500].includes(r.status)) maybeRestart(s).catch(() => {});
                return res.status(503).set('Retry-After', '2').end();
            }
            res.set({ 'Content-Type': r.type, 'Cache-Control': isPlaylist ? 'no-store' : 'private, max-age=21600, immutable' });
            return res.end(r.body);
        } catch (e) {
            logger.warn(`[activity] media request failed (${name.slice(0, 12)}): ${e.code || e.message}`);
            if (!res.headersSent) res.status(502).end();
        }
    });

    router.locals = { watch, cache };
    return router;
}
