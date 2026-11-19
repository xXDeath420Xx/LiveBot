/*
 * Stream bot song requests (docs/superpowers/specs/2026-11-19-stream-bot-design.md §7; core/stream-bot/music).
 *
 *   Page  GET  /stream/bot/music                              VOD protection, now playing, queue (approve / deny / remove),
 *                                                             settings and replies, bans, playlists, commands, history
 *   API   (session, the signed-in user's own profile only; CSRF on writes)
 *         GET  /stream/bot/api/music/state                    status, now playing, queue (the page refreshes with it)
 *         POST /stream/bot/api/music/settings                 the settings form
 *         POST /stream/bot/api/music/control                  { action: start|stop|pause|resume|skip|back|restart }
 *         POST /stream/bot/api/music/requests                 { input } the streamer adds a song (no gate, limits or approval)
 *         POST /stream/bot/api/music/requests/:id/:action     approve | deny | remove
 *         POST /stream/bot/api/music/bans                     { input, kind: track|artist };  DELETE /bans/:id
 *         POST /stream/bot/api/music/playlists                { url, name? } import a Spotify / YouTube / SoundCloud playlist
 *         POST /stream/bot/api/music/playlists/new            { name } an empty playlist;  DELETE /playlists/:id
 *         GET  /stream/bot/api/music/playlists/:id/items;     DELETE /stream/bot/api/music/playlist-items/:id
 *         POST /stream/bot/api/music/overlay-key              a new player link (the old one stops working)
 *         POST /stream/bot/api/music/commands                 { enabled } create the chat commands as automations
 *         GET  /stream/bot/api/music/history?before=          request history
 *   Overlay (no session: the per-profile key in the path; CSRF-exempt by prefix in server.js; rate limited per IP)
 *         GET  /stream/bot/overlay/music/:key                 the player page for OBS ("CertiFried Music" browser source)
 *         GET  /stream/bot/overlay/music/:key/events          SSE: hello, play, pause, resume, seek, volume, card, idle, stop
 *         POST /stream/bot/overlay/music/:key/report          { playId, event, positionMs, durationMs, error } for the current play only
 *         GET  /stream/bot/overlay/music/:key/audio/:playId   the song's audio through this server (signed link, Range kept)
 *
 * Literal paths come before /:param paths.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import logger from '../../utils/logger.js';
import { getStreamBot } from '../../core/stream-bot/index.js';
import { COMMANDS, DEFAULT_MESSAGES, MESSAGE_VARS, formatLength } from '../../core/stream-bot/music/text.js';
import { APPROVAL_MODES, SOURCES, SOURCE_LABEL, OWNER_PRESET, LIMITS } from '../../core/stream-bot/music/settings.js';
import { seedCommands, NAME_PREFIX } from '../../core/stream-bot/music/seed.js';
import { proxyAudio, isKeyShape } from '../../core/stream-bot/music/audio.js';

const router = express.Router();
const LOG = '[StreamBotMusic]';
const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '');
const OWNER_ID = String(process.env.BOT_OWNER_ID || '');
const signedIn = (req) => !!(req.isAuthenticated?.() && req.user?.id);

function needPage(req, res, next) {
    if (signedIn(req)) return next();
    return res.redirect('/auth/discord?returnTo=' + encodeURIComponent('/stream/bot/music'));
}
function needApi(req, res, next) {
    if (signedIn(req)) return next();
    return res.status(401).json({ ok: false, error: 'You are signed out. Sign in again and retry.' });
}
const pageRoute = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
        logger.error(`${LOG} page failed`, { path: req.path, error: err?.message });
        if (!res.headersSent) res.status(500).render('error-tailwind', { user: req.user, error: 'The Music page could not be loaded. Try again in a minute.' });
    }
};
const apiRoute = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
        logger.error(`${LOG} api failed`, { path: req.path, method: req.method, error: err?.message });
        if (!res.headersSent) res.status(500).json({ ok: false, error: 'Something went wrong. Try again.' });
    }
};

async function load(req) {
    const sb = await getStreamBot();
    const profile = await sb.store.ensureProfile(req.user.id, req.user.global_name || req.user.username || null);
    if (!sb.music) { const e = new Error('song requests are not running yet'); e.notReady = true; throw e; }
    return { sb, profile, music: sb.music.service, mstore: sb.music.mstore };
}
const notReady = (res) => res.status(503).json({ ok: false, error: 'Song requests start after the next CertiFried restart.' });
const idOf = (v) => (/^\d{1,15}$/.test(String(v ?? '')) ? Number(v) : null);
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const by = (req) => str(req.user?.global_name || req.user?.username || 'dashboard', 100);

/** A request row for the page (no viewer ids). */
export function requestView(r) {
    return {
        id: r.id, status: r.status, title: r.title, artist: r.artist, url: r.url, source: r.source, viewer: r.viewerName || (r.platform === 'dashboard' ? 'You' : 'A viewer'),
        platform: r.platform, length: r.durationMs ? formatLength(r.durationMs) : '', explicit: r.explicit, playlist: r.playlistName || null,
        reason: r.reason || null, decidedBy: r.decidedBy || null, createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    };
}

/** Plain words for the VOD gate. */
export function vodView(status) {
    const g = status.vod || {};
    const on = g.vodSafe === true;
    return {
        on,
        line: on ? `VOD protection: on (music kept off Twitch VOD track ${g.vodTrack || '?'})` : `VOD protection: off. ${g.reason || 'CertiFried Studio has not confirmed it yet.'}`,
        overlay: status.overlays > 0,
        held: status.held || null,
        studio: !!status.studioOnline,
    };
}

async function spotifyLinked(userId) {
    try { const m = await import('../../core/spotify-connect-manager.js'); return !!(await m.isLinked(userId)); } catch { return false; }
}

async function stateFor(music, mstore, profileId) {
    const status = await music.status(profileId);
    const active = await mstore.activeRequests(profileId);
    const np = status.current;
    return {
        vod: vodView(status), running: status.running, overlays: status.overlays,
        now: np ? { title: np.item.title, artist: np.item.artist, url: np.item.url, requester: np.requester, playlist: np.playlist, paused: np.paused,
            position: formatLength(np.positionMs), length: np.item.durationMs ? formatLength(np.item.durationMs) : '' } : null,
        pending: active.filter((r) => r.status === 'pending').map(requestView),
        queued: active.filter((r) => r.status === 'queued').map(requestView),
    };
}

// ── page ───────────────────────────────────────────────────────────────────────────────────

router.get('/stream/bot/music', needPage, pageRoute(async (req, res) => {
    const sb = await getStreamBot();
    const profile = await sb.store.ensureProfile(req.user.id, req.user.global_name || req.user.username || null);
    if (!sb.music) {
        return res.render('stream-bot/music', { user: req.user, ready: false, profile, state: null, settings: null, bans: [], playlists: [], history: [], plays: [], overlayUrl: null,
            commands: COMMANDS, commandsMade: 0, defaults: DEFAULT_MESSAGES, messageVars: MESSAGE_VARS, approvalModes: APPROVAL_MODES, sources: SOURCES, sourceLabels: SOURCE_LABEL,
            limits: LIMITS, spotifyLinked: false, spotify: null, musicData: '{}' });
    }
    const music = sb.music.service, mstore = sb.music.mstore;
    const [state, settings, bans, playlists, history, plays, autos, key, linked, spotify] = await Promise.all([
        stateFor(music, mstore, profile.id), music.settingsOf(profile.id), mstore.listBans(profile.id), mstore.listPlaylists(profile.id),
        mstore.history(profile.id, { limit: 50 }), mstore.recentPlays(profile.id, 20), sb.store.listAutomations(profile.id), music.overlayKey(profile.id),
        spotifyLinked(req.user.id), music.spotifyStatus(profile),
    ]);
    const commandsMade = autos.filter((a) => a.name.startsWith(NAME_PREFIX)).length;
    res.render('stream-bot/music', {
        user: req.user, ready: true, profile, state, settings, bans, playlists, history: history.map(requestView), plays, overlayUrl: `${DASHBOARD_URL}/stream/bot/overlay/music/${key}`,
        commands: COMMANDS, commandsMade, defaults: DEFAULT_MESSAGES, messageVars: MESSAGE_VARS, approvalModes: APPROVAL_MODES, sources: SOURCES, sourceLabels: SOURCE_LABEL,
        limits: LIMITS, spotifyLinked: linked, spotify,
        musicData: JSON.stringify({ state }).replace(/</g, '\\u003c'),
    });
}));

// ── API (literal paths first) ──────────────────────────────────────────────────────────────

router.get('/stream/bot/api/music/state', needApi, apiRoute(async (req, res) => {
    const { music, mstore, profile } = await load(req).catch((e) => (e.notReady ? {} : Promise.reject(e)));
    if (!music) return notReady(res);
    res.json({ ok: true, ...(await stateFor(music, mstore, profile.id)) });
}));

router.get('/stream/bot/api/music/history', needApi, apiRoute(async (req, res) => {
    const { mstore, profile } = await load(req).catch((e) => (e.notReady ? {} : Promise.reject(e)));
    if (!mstore) return notReady(res);
    const rows = await mstore.history(profile.id, { before: idOf(req.query.before), limit: 50, status: /^[a-z]{1,12}$/.test(String(req.query.status || '')) ? req.query.status : '' });
    res.json({ ok: true, requests: rows.map(requestView) });
}));

router.post('/stream/bot/api/music/settings', needApi, apiRoute(async (req, res) => {
    const { music, profile } = await load(req).catch((e) => (e.notReady ? {} : Promise.reject(e)));
    if (!music) return notReady(res);
    const b = req.body || {};
    const input = {
        open: b.open, approval: b.approval, approvalBypass: b.approvalBypass, allowExplicit: b.allowExplicit, maxPerUser: b.maxPerUser, maxQueue: b.maxQueue,
        maxDurationSec: b.maxDurationSec, allowDuplicates: b.allowDuplicates, limitBypass: b.limitBypass, voteSkip: b.voteSkip, skipOwn: b.skipOwn,
        removeOwn: b.removeOwn, sources: b.sources, volume: b.volume, fallbackPlaylistId: b.fallbackPlaylistId, defaultPlaylistId: b.defaultPlaylistId,
        card: b.card, mention: b.mention, spotifyDirect: b.spotifyDirect, messages: b.messages && typeof b.messages === 'object' ? b.messages : {},
    };
    const r = await music.saveSettings(profile.id, input);
    if (!r.ok) return res.status(400).json({ ok: false, error: r.errors.join(' ') });
    res.json({ ok: true });
}));

router.post('/stream/bot/api/music/control', needApi, apiRoute(async (req, res) => {
    const { music, profile } = await load(req).catch((e) => (e.notReady ? {} : Promise.reject(e)));
    if (!music) return notReady(res);
    const p = music.player;
    const act = String(req.body?.action || '');
    const map = { start: () => p.resume(profile.id), stop: () => p.stop(profile.id), pause: () => p.pause(profile.id), resume: () => p.resume(profile.id),
        skip: () => p.skip(profile.id, 'dashboard'), back: () => p.back(profile.id), restart: () => p.restart(profile.id) };
    if (!map[act]) return res.status(400).json({ ok: false, error: 'Unknown action.' });
    const r = await map[act]();
    res.json({ ok: true, result: typeof r === 'string' ? r : r ? 'ok' : 'nothing' });
}));

router.post('/stream/bot/api/music/requests', needApi, apiRoute(async (req, res) => {
    const { music, profile } = await load(req).catch((e) => (e.notReady ? {} : Promise.reject(e)));
    if (!music) return notReady(res);
    const input = str(req.body?.input, 400);
    if (!input) return res.status(400).json({ ok: false, error: 'Enter a song name or link.' });
    const r = await music.submit(profile, { input, viewer: { platform: 'dashboard', name: by(req) }, roles: ['broadcaster'], via: 'dashboard' });
    const text = await music.replyText(profile.id, r.key, r.vars);
    res.status(r.outcome === 'refused' ? 400 : 200).json({ ok: r.outcome !== 'refused', message: text, error: r.outcome === 'refused' ? text : undefined });
}));

router.post('/stream/bot/api/music/bans', needApi, apiRoute(async (req, res) => {
    const { music, profile } = await load(req).catch((e) => (e.notReady ? {} : Promise.reject(e)));
    if (!music) return notReady(res);
    const r = await music.banLink(profile.id, { input: str(req.body?.input, 400), kind: req.body?.kind === 'artist' ? 'artist' : 'track', by: by(req) });
    res.status(r.ok ? 200 : 400).json(r.ok ? { ok: true } : { ok: false, error: r.error });
}));

router.post('/stream/bot/api/music/playlists', needApi, apiRoute(async (req, res) => {
    const { music, profile } = await load(req).catch((e) => (e.notReady ? {} : Promise.reject(e)));
    if (!music) return notReady(res);
    const r = await music.importPlaylist(profile.id, { url: str(req.body?.url, 600), name: str(req.body?.name, 100), by: by(req) });
    res.status(r.ok ? 200 : 400).json(r.ok ? { ok: true, id: r.id, name: r.name, added: r.added, full: r.full } : { ok: false, error: r.error });
}));

router.post('/stream/bot/api/music/playlists/new', needApi, apiRoute(async (req, res) => {
    const { mstore, profile } = await load(req).catch((e) => (e.notReady ? {} : Promise.reject(e)));
    if (!mstore) return notReady(res);
    const name = str(req.body?.name, 100);
    if (!name) return res.status(400).json({ ok: false, error: 'Name the playlist.' });
    const r = await mstore.createPlaylist(profile.id, { name, kind: 'custom' });
    res.status(r.ok ? 200 : 400).json(r.ok ? { ok: true, id: r.id } : { ok: false, error: r.error === 'exists' ? 'You already have a playlist with that name.' : 'You have the most playlists allowed (50).' });
}));

const linkLimiter = rateLimit({ windowMs: 10 * 60_000, max: 6, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `u:${req.user?.id || req.ip}`, message: { ok: false, error: 'Too many tries. Wait a few minutes.' } });

/** Link Spotify for Spotify-direct: the Discord bot's own flow (startLink / finishLink in core/spotify-connect-manager.js). */
router.post('/stream/bot/api/music/spotify/link', needApi, linkLimiter, apiRoute(async (req, res) => {
    const m = await import('../../core/spotify-connect-manager.js');
    try {
        const url = await m.startLink(req.user.id);
        if (!/^https:\/\/accounts\.spotify\.com\//.test(String(url || ''))) return res.status(502).json({ ok: false, error: 'Spotify linking could not start. Try again in a minute.' });
        res.json({ ok: true, url });
    } catch (err) {
        logger.warn(`${LOG} spotify link start failed`, { error: err?.message });
        res.status(502).json({ ok: false, error: 'Spotify linking could not start. Try again in a minute.' });
    }
}));

router.post('/stream/bot/api/music/spotify/link/finish', needApi, linkLimiter, apiRoute(async (req, res) => {
    const m = await import('../../core/spotify-connect-manager.js');
    try {
        const r = await m.finishLink(req.user.id, str(req.body?.redirectUrl, 2000));
        res.json({ ok: true, account: r?.username || null });
    } catch (err) {
        res.status(400).json({ ok: false, error: String(err?.message || 'Linking did not finish.').replace(/`/g, '').slice(0, 200) });
    }
}));

router.post('/stream/bot/api/music/overlay-key', needApi, apiRoute(async (req, res) => {
    const { music, profile } = await load(req).catch((e) => (e.notReady ? {} : Promise.reject(e)));
    if (!music) return notReady(res);
    const key = await music.overlayKey(profile.id, { rotate: true });
    res.json({ ok: true, url: `${DASHBOARD_URL}/stream/bot/overlay/music/${key}` });
}));

router.post('/stream/bot/api/music/commands', needApi, apiRoute(async (req, res) => {
    const { sb, music, profile } = await load(req).catch((e) => (e.notReady ? {} : Promise.reject(e)));
    if (!music) return notReady(res);
    const owner = OWNER_ID && String(req.user.id) === OWNER_ID;
    // The owner's come switched off and answer to every Streamer.bot name, with the owner's settings (Streamer.bot still answers chat).
    const r = await seedCommands(sb.store, profile.id, { aliases: owner, enabled: owner ? false : req.body?.enabled === true });
    if (owner && r.created) await music.applyPreset(profile.id, OWNER_PRESET);
    res.json({ ok: true, created: r.created, existing: r.existing });
}));

router.post('/stream/bot/api/music/requests/:id/:action', needApi, apiRoute(async (req, res) => {
    const { music, profile } = await load(req).catch((e) => (e.notReady ? {} : Promise.reject(e)));
    if (!music) return notReady(res);
    const id = idOf(req.params.id);
    if (!id || !['approve', 'deny', 'remove'].includes(req.params.action)) return res.status(404).json({ ok: false, error: 'Not found.' });
    const r = await music.decideById(profile.id, id, req.params.action, by(req));
    if (!r.ok) return res.status(r.error === 'not_found' ? 404 : 409).json({ ok: false, error: r.error === 'not_pending' ? 'That request is no longer waiting.' : 'That request is gone.' });
    res.json({ ok: true });
}));

router.delete('/stream/bot/api/music/bans/:id', needApi, apiRoute(async (req, res) => {
    const { mstore, profile } = await load(req).catch((e) => (e.notReady ? {} : Promise.reject(e)));
    if (!mstore) return notReady(res);
    const ok = await mstore.removeBan(profile.id, idOf(req.params.id) || 0);
    res.status(ok ? 200 : 404).json({ ok });
}));

router.get('/stream/bot/api/music/playlists/:id/items', needApi, apiRoute(async (req, res) => {
    const { mstore, profile } = await load(req).catch((e) => (e.notReady ? {} : Promise.reject(e)));
    if (!mstore) return notReady(res);
    const p = await mstore.getPlaylist(profile.id, idOf(req.params.id) || 0);
    if (!p) return res.status(404).json({ ok: false, error: 'Not found.' });
    const items = await mstore.playlistItems(profile.id, p.id, { limit: 500 });
    res.json({ ok: true, playlist: p, items: items.map((i) => ({ id: i.id, title: i.title, artist: i.artist, url: i.url, length: i.durationMs ? formatLength(i.durationMs) : '' })) });
}));

router.delete('/stream/bot/api/music/playlists/:id', needApi, apiRoute(async (req, res) => {
    const { mstore, profile } = await load(req).catch((e) => (e.notReady ? {} : Promise.reject(e)));
    if (!mstore) return notReady(res);
    const ok = await mstore.deletePlaylist(profile.id, idOf(req.params.id) || 0);
    res.status(ok ? 200 : 404).json({ ok });
}));

router.delete('/stream/bot/api/music/playlist-items/:id', needApi, apiRoute(async (req, res) => {
    const { mstore, profile } = await load(req).catch((e) => (e.notReady ? {} : Promise.reject(e)));
    if (!mstore) return notReady(res);
    const ok = await mstore.removePlaylistItem(profile.id, idOf(req.params.id) || 0);
    res.status(ok ? 200 : 404).json({ ok });
}));

// ── the OBS browser source ────────────────────────────────────────────────────────────────

const overlayPageLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Too many requests.' } });
const overlayEventsLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Too many requests.' } });
const overlayReportLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Too many requests.' } });
const overlayAudioLimiter = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Too many requests.' } });

async function overlayProfile(key) {
    if (!isKeyShape(key)) return null;
    const sb = await getStreamBot();
    if (!sb.music) return null;
    const hit = await sb.music.service.profileForKey(key);
    return hit ? { ...hit, sb, music: sb.music.service } : null;
}

router.get('/stream/bot/overlay/music/:key', overlayPageLimiter, async (req, res) => {
    try {
        const hit = await overlayProfile(req.params.key);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.status(hit ? 200 : 404).render('stream-bot/music-overlay', { key: hit ? req.params.key : null });
    } catch (err) {
        logger.error(`${LOG} overlay page failed`, { error: err?.message });
        res.status(500).type('text/plain').send('Not available');
    }
});

router.get('/stream/bot/overlay/music/:key/events', overlayEventsLimiter, async (req, res) => {
    let hit;
    try { hit = await overlayProfile(req.params.key); } catch { hit = null; }
    if (!hit) return res.status(404).json({ ok: false, error: 'This player link is not valid any more.' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const client = {
        send: (event, data) => { res.write(`event: ${event}\ndata: ${JSON.stringify({ ...data, key: undefined })}\n\n`); },
        close: () => { try { res.end(); } catch { /* gone */ } },
    };
    const detach = hit.music.player.attachOverlay(hit.profileId, hit.keyHash, client);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20_000);
    ping.unref?.();
    req.on('close', () => { clearInterval(ping); detach(); });
});

router.post('/stream/bot/overlay/music/:key/report', overlayReportLimiter, async (req, res) => {
    try {
        const hit = await overlayProfile(req.params.key);
        if (!hit) return res.status(404).json({ ok: false });
        const b = req.body || {};
        const event = ['ready', 'started', 'progress', 'paused', 'resumed', 'ended', 'error'].includes(b.event) ? b.event : null;
        if (!event) return res.status(400).json({ ok: false });
        const r = await hit.music.player.report(hit.profileId, { playId: String(b.playId || '').slice(0, 40), event, positionMs: Number(b.positionMs), durationMs: Number(b.durationMs),
            error: b.error ? String(b.error).slice(0, 120) : null });
        res.json({ ok: true, result: r });
    } catch (err) {
        logger.warn(`${LOG} overlay report failed`, { error: err?.message });
        res.status(500).json({ ok: false });
    }
});

router.get('/stream/bot/overlay/music/:key/audio/:playId', overlayAudioLimiter, async (req, res) => {
    try {
        const hit = await overlayProfile(req.params.key);
        if (!hit) return res.status(404).json({ ok: false });
        const playId = String(req.params.playId || '').slice(0, 40);
        if (!hit.music.signer.verify({ profileId: hit.profileId, keyHash: hit.keyHash, playId, exp: req.query.exp, sig: req.query.sig })) return res.status(403).json({ ok: false, error: 'expired' });
        // Spotify-direct: a live MP3 from the streamer's go-librespot session (one player at a time, no Range).
        const live = hit.music.player.liveFor(hit.profileId, playId);
        if (live) { await live.attach(req, res); return; }
        const upstream = hit.music.player.upstreamFor(hit.profileId, playId);
        if (!upstream) return res.status(410).json({ ok: false, error: 'gone' });
        await proxyAudio(req, res, upstream);
    } catch (err) {
        logger.warn(`${LOG} audio failed`, { error: err?.message });
        if (!res.headersSent) res.status(502).json({ ok: false });
    }
});

export default router;
