/*
 * Stream bot Community (/stream/bot/community; Wave 2 group B, design §15; core/stream-bot/community, migration 475):
 * chat games on points, the loyalty store, quotes, media share and text to speech.
 *
 *   Pages  GET /stream/bot/community                      what is on, with links to the four pages
 *          GET /stream/bot/community/games                slots, duels, heists, raffle and line-up settings; the live raffle and line-up
 *          GET /stream/bot/community/store                store items, recent redemptions (refund)
 *          GET /stream/bot/community/quotes               quotes: search, add, edit, delete, turn on imported ones
 *          GET /stream/bot/community/media                media share settings and queue, text to speech, the OBS page address
 *   API    (session, the signed-in user's own profile only; CSRF on writes, global middleware)
 *          POST   /stream/bot/api/community/commands               { group } add that group's chat commands (switched off)
 *          POST   /stream/bot/api/community/games                  save the games settings
 *          GET    /stream/bot/api/community/live                   the line-up, the raffle and a heist being planned
 *          POST   /stream/bot/api/community/lineup                 { action: open|close|next|clear|remove, index }
 *          POST   /stream/bot/api/community/raffle                 { action: open|draw|cancel, cost, winners, maxTickets, autoDrawSec }
 *          POST   /stream/bot/api/community/store/items            add an item;   PUT / DELETE …/store/items/:id
 *          POST   /stream/bot/api/community/store/redemptions/:id/refund
 *          POST   /stream/bot/api/community/quotes                 add;  PUT / DELETE …/quotes/:id;  POST …/quotes/enable-imported
 *          POST   /stream/bot/api/community/media                  save media share settings
 *          POST   /stream/bot/api/community/tts                    save text to speech settings
 *          POST   /stream/bot/api/community/tts/test               { text } read it on the Media Share page
 *          POST   /stream/bot/api/community/media/key              a new page address (the old one stops at once)
 *          GET    /stream/bot/api/community/media/queue            the queue and the last requests
 *          POST   /stream/bot/api/community/media/requests         { url } add a video as the streamer (no approval, no limits)
 *          POST   /stream/bot/api/community/media/requests/:id/:action   approve | deny | remove
 *   OBS    (no session: the key in the path is the credential; GET only, so no CSRF exemption; rate limited per IP)
 *          GET  /stream/bot/overlay/mediashare/:key            the "CertiFried Media Share" page
 *          GET  /stream/bot/overlay/mediashare/:key/events     SSE: hello, video, sync, stop, speak, gone
 *          GET  /stream/bot/overlay/mediashare/:key/tts/:id    a message read aloud (WAV)
 *
 * Literal paths come before /:param paths. Until migration 475 has run the pages say so and the API answers 503.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import logger from '../../utils/logger.js';
import { getStreamBot } from '../../core/stream-bot/index.js';
import { gamesWithDefaults, validateGames, validateMedia, validateTts, HEIST_TARGETS, HEIST_LABEL, APPROVAL, APPROVAL_LABEL, LIMITS } from '../../core/stream-bot/community/settings.js';
import { validateItem, LIMIT_WINDOWS, LIMIT_WINDOW_LABEL } from '../../core/stream-bot/community/shop.js';
import { commandDrafts, seedCommands, GROUPS } from '../../core/stream-bot/community/seed.js';
import { isMediaKeyShape } from '../../core/stream-bot/community/media.js';
import { ttsVoices, BUILT_IN_COUNT } from '../../core/stream-bot/community/speech.js';
import { formatQuote } from '../../core/stream-bot/community/quotes.js';
import { setOverlayHeaders, openSse } from '../../core/stream-bot/overlays/http.js';

const router = express.Router();
const LOG = '[StreamBotCommunity]';
const signedIn = (req) => !!(req.isAuthenticated?.() && req.user?.id);
const json = express.json({ limit: '32kb' });

function needPage(req, res, next) {
    if (signedIn(req)) return next();
    const back = /^\/stream\/bot\/community(\/(games|store|quotes|media))?$/.test(req.path) ? req.path : '/stream/bot/community';
    return res.redirect('/auth/discord?returnTo=' + encodeURIComponent(back));
}
function needApi(req, res, next) {
    if (signedIn(req)) return next();
    return res.status(401).json({ ok: false, error: 'You are signed out. Sign in again and retry.' });
}
const pageRoute = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
        logger.error(`${LOG} page failed`, { path: req.path, error: err?.message });
        if (!res.headersSent) res.status(500).render('error-tailwind', { user: req.user, error: 'The Community page could not be loaded. Try again in a minute.' });
    }
};
const apiRoute = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
        logger.error(`${LOG} api failed`, { path: req.path, method: req.method, error: err?.message });
        if (!res.headersSent) res.status(500).json({ ok: false, error: 'Something went wrong. Try again.' });
    }
};
const idOf = (v) => (/^\d{1,15}$/.test(String(v ?? '')) ? Number(v) : null);
const byName = (req) => String(req.user?.global_name || req.user?.username || 'the streamer').slice(0, 100);

async function load(req) {
    const sb = await getStreamBot();
    const profile = await sb.store.ensureProfile(req.user.id, req.user.global_name || req.user.username || null);
    const c = sb.community || null;
    const ready = !!(c && await c.cstore.available());
    return { sb, profile, c, ready };
}
const notReady = (res) => res.status(503).json({ ok: false, error: 'This starts after the next CertiFried update.' });

/** The seeded commands of a group and whether each exists and is on. */
async function commandState(sb, profile, group) {
    const names = new Map((await sb.store.listAutomations(profile.id)).map((a) => [a.name, a]));
    return commandDrafts(group).map((d) => {
        const a = names.get(d.name);
        return { name: d.name, command: d.trigger_config.match.text.trim(), id: a?.id || null, enabled: !!a?.enabled };
    });
}
async function currencyOf(sb, profile) {
    try { return (await sb.viewers?.service?.settingsFor(profile.id))?.currency || 'points'; } catch { return 'points'; }
}

// ── pages ──

router.get('/stream/bot/community', needPage, pageRoute(async (req, res) => {
    const { sb, profile, c, ready } = await load(req);
    const games = gamesWithDefaults(await sb.store.getSettingsKey(profile.id, 'games'));
    const media = c ? await c.media.settingsOf(profile.id) : null;
    const counts = ready ? { items: (await c.cstore.listItems(profile.id)).length, quotes: await c.cstore.countQuotes(profile.id), media: (await c.cstore.activeMedia(profile.id)).length } : null;
    res.render('stream-bot/community', {
        user: req.user, active: 'community', section: 'overview', ready, counts, currency: await currencyOf(sb, profile),
        gamesOn: ['slots', 'duel', 'heist'].filter((k) => games[k].enabled), mediaOpen: !!media?.open,
    });
}));

router.get('/stream/bot/community/games', needPage, pageRoute(async (req, res) => {
    const { sb, profile, c, ready } = await load(req);
    const settings = c ? await c.games.settingsOf(profile.id) : gamesWithDefaults(null);
    res.render('stream-bot/community-games', {
        user: req.user, active: 'community', section: 'games', ready: !!c, pointsReady: !!(sb.viewers && await sb.viewers.vstore.available()),
        settings, heistTargets: HEIST_TARGETS.map((k) => ({ value: k, label: HEIST_LABEL[k] })), limits: LIMITS, currency: await currencyOf(sb, profile),
        commands: await commandState(sb, profile, 'games'), live: c ? await liveState(c, profile) : null,
        tablesReady: ready,
    });
}));

router.get('/stream/bot/community/store', needPage, pageRoute(async (req, res) => {
    const { sb, profile, c, ready } = await load(req);
    const automations = (await sb.store.listAutomations(profile.id)).map((a) => ({ id: a.id, name: a.name, enabled: !!a.enabled }));
    res.render('stream-bot/community-store', {
        user: req.user, active: 'community', section: 'store', ready, currency: await currencyOf(sb, profile),
        items: ready ? await c.cstore.listItems(profile.id) : [], redemptions: ready ? await c.cstore.listRedemptions(profile.id, 50) : [],
        automations, windows: LIMIT_WINDOWS.map((k) => ({ value: k, label: LIMIT_WINDOW_LABEL[k] })), commands: await commandState(sb, profile, 'store'),
    });
}));

router.get('/stream/bot/community/quotes', needPage, pageRoute(async (req, res) => {
    const { sb, profile, c, ready } = await load(req);
    const q = String(req.query.q || '').trim().slice(0, 100);
    const list = ready ? await c.cstore.listQuotes(profile.id, { search: q, limit: 500 }) : [];
    res.render('stream-bot/community-quotes', {
        user: req.user, active: 'community', section: 'quotes', ready, q,
        quotes: list.map((x) => ({ ...x, line: formatQuote(x) })), counts: ready ? await c.cstore.countQuotes(profile.id) : { total: 0, off: 0 },
        commands: await commandState(sb, profile, 'quotes'),
    });
}));

router.get('/stream/bot/community/media', needPage, pageRoute(async (req, res) => {
    const { sb, profile, c, ready } = await load(req);
    const voices = await ttsVoices(profile.ownerDiscordId);
    const key = c ? await c.media.pageKey(profile.id) : null;
    res.render('stream-bot/community-media', {
        user: req.user, active: 'community', section: 'media', ready, running: !!c,
        media: c ? await c.media.settingsOf(profile.id) : null, tts: c ? await c.media.ttsSettingsOf(profile.id) : null,
        approval: APPROVAL.map((k) => ({ value: k, label: APPROVAL_LABEL[k] })), voices, builtIn: BUILT_IN_COUNT, limits: LIMITS,
        pageUrl: key ? c.media.pageUrl(key) : null, status: c ? c.media.status(profile.id) : null, musicRunning: !!sb.music,
        queue: ready ? await c.media.queue(profile.id) : [], history: ready ? await c.media.history(profile.id, 30) : [],
        commands: await commandState(sb, profile, 'media'), ttsCommands: await commandState(sb, profile, 'tts'), currency: await currencyOf(sb, profile),
    });
}));

// ── API: commands, games, live state ──

router.post('/stream/bot/api/community/commands', needApi, json, apiRoute(async (req, res) => {
    const { sb, profile } = await load(req);
    const group = String(req.body?.group || '');
    if (!GROUPS.includes(group)) return res.status(400).json({ ok: false, error: 'Pick which commands to add.' });
    const r = await seedCommands(sb.store, profile.id, group);
    res.json({ ok: true, ...r, commands: await commandState(sb, profile, group) });
}));

router.post('/stream/bot/api/community/games', needApi, json, apiRoute(async (req, res) => {
    const { profile, c } = await load(req);
    if (!c) return notReady(res);
    const v = validateGames(req.body || {});
    if (!v.ok) return res.status(400).json({ ok: false, errors: v.errors });
    await c.games.saveSettings(profile.id, v.value);
    res.json({ ok: true, settings: await c.games.settingsOf(profile.id) });
}));

async function liveState(c, profile) {
    const lineup = await c.games.lineup.state(profile.id);
    return { lineup: { open: lineup.open, list: lineup.list.map((e) => ({ name: e.name, platform: e.platform, sub: !!e.sub, at: e.at })) }, raffle: c.games.raffle.status(profile.id), heist: c.games.heistStatus(profile.id) };
}
router.get('/stream/bot/api/community/live', needApi, apiRoute(async (req, res) => {
    const { profile, c } = await load(req);
    if (!c) return notReady(res);
    res.json({ ok: true, ...(await liveState(c, profile)) });
}));

router.post('/stream/bot/api/community/lineup', needApi, json, apiRoute(async (req, res) => {
    const { profile, c } = await load(req);
    if (!c) return notReady(res);
    const a = String(req.body?.action || '');
    const L = c.games.lineup;
    let note = '';
    if (a === 'open' || a === 'close') await L.setOpen(profile, a === 'open');
    else if (a === 'clear') await L.clear(profile);
    else if (a === 'next') { const r = await L.next(profile, 1); note = r.taken.length ? `Up next: ${r.taken.map((e) => e.name).join(', ')}` : 'Nobody is in the line-up.'; }
    else if (a === 'remove') { if (!(await L.remove(profile, Number(req.body?.index)))) return res.status(400).json({ ok: false, error: 'That person is no longer in the line-up.' }); }
    else return res.status(400).json({ ok: false, error: 'Unknown action.' });
    res.json({ ok: true, note, ...(await liveState(c, profile)) });
}));

router.post('/stream/bot/api/community/raffle', needApi, json, apiRoute(async (req, res) => {
    const { profile, c } = await load(req);
    if (!c) return notReady(res);
    const a = String(req.body?.action || '');
    const R = c.games.raffle;
    let r;
    if (a === 'open') {
        r = await R.open(profile, { cost: req.body?.cost, winners: req.body?.winners, maxTickets: req.body?.maxTickets, autoDrawSec: req.body?.autoDrawSec }, byName(req));
        if (r.ok) await c.games.announce(profile.id, new Set(['twitch', 'kick']), r.text);
    } else if (a === 'draw') r = await R.draw(profile, byName(req));
    else if (a === 'cancel') { r = await R.cancel(profile); if (r.ok) await c.games.announce(profile.id, new Set(['twitch', 'kick']), r.text); }
    else return res.status(400).json({ ok: false, error: 'Unknown action.' });
    if (!r.ok) return res.status(409).json({ ok: false, error: r.error });
    res.json({ ok: true, note: r.text || '', ...(await liveState(c, profile)) });
}));

// ── API: the loyalty store ──

async function automationIds(sb, profile) { return new Set((await sb.store.listAutomations(profile.id)).map((a) => a.id)); }
router.post('/stream/bot/api/community/store/items', needApi, json, apiRoute(async (req, res) => {
    const { sb, profile, c, ready } = await load(req);
    if (!ready) return notReady(res);
    const v = validateItem(req.body || {}, { automationIds: await automationIds(sb, profile) });
    if (!v.ok) return res.status(400).json({ ok: false, errors: v.errors });
    const r = await c.cstore.saveItem(profile.id, null, v.value);
    if (!r.ok) return res.status(409).json({ ok: false, error: r.error === 'name_taken' ? 'You already have an item with that name.' : 'You have the most items allowed (50).' });
    res.json({ ok: true, item: await c.cstore.getItem(profile.id, r.id) });
}));
router.put('/stream/bot/api/community/store/items/:id', needApi, json, apiRoute(async (req, res) => {
    const { sb, profile, c, ready } = await load(req);
    if (!ready) return notReady(res);
    const id = idOf(req.params.id);
    if (!id) return res.status(404).json({ ok: false, error: 'That item does not exist.' });
    const v = validateItem(req.body || {}, { automationIds: await automationIds(sb, profile) });
    if (!v.ok) return res.status(400).json({ ok: false, errors: v.errors });
    const r = await c.cstore.saveItem(profile.id, id, v.value);
    if (!r.ok) return res.status(r.error === 'not_found' ? 404 : 409).json({ ok: false, error: r.error === 'name_taken' ? 'You already have an item with that name.' : 'That item does not exist.' });
    res.json({ ok: true, item: await c.cstore.getItem(profile.id, id) });
}));
router.delete('/stream/bot/api/community/store/items/:id', needApi, apiRoute(async (req, res) => {
    const { profile, c, ready } = await load(req);
    if (!ready) return notReady(res);
    const id = idOf(req.params.id);
    if (!id || !(await c.cstore.deleteItem(profile.id, id))) return res.status(404).json({ ok: false, error: 'That item does not exist.' });
    res.json({ ok: true });
}));
router.post('/stream/bot/api/community/store/redemptions/:id/refund', needApi, apiRoute(async (req, res) => {
    const { profile, c, ready } = await load(req);
    if (!ready) return notReady(res);
    const id = idOf(req.params.id);
    const r = id ? await c.shop.refund(profile, id, byName(req)) : { ok: false, error: 'That redemption does not exist.' };
    if (!r.ok) return res.status(409).json({ ok: false, error: r.error });
    res.json({ ok: true, note: r.note || '' });
}));

// ── API: quotes ──

const quoteBody = (b = {}) => ({ text: String(b.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500), game: String(b.game ?? '').trim().slice(0, 100) || null, saidBy: String(b.saidBy ?? '').trim().slice(0, 100) || null });
router.post('/stream/bot/api/community/quotes/enable-imported', needApi, apiRoute(async (req, res) => {
    const { profile, c, ready } = await load(req);
    if (!ready) return notReady(res);
    res.json({ ok: true, enabled: await c.cstore.enableImportedQuotes(profile.id) });
}));
router.post('/stream/bot/api/community/quotes', needApi, json, apiRoute(async (req, res) => {
    const { profile, c, ready } = await load(req);
    if (!ready) return notReady(res);
    const b = quoteBody(req.body);
    if (b.text.length < 2) return res.status(400).json({ ok: false, errors: ['Enter the quote.'] });
    const r = await c.cstore.addQuote(profile.id, { ...b, addedBy: byName(req) });
    if (!r.ok) return res.status(409).json({ ok: false, error: r.error === 'full' ? 'You have the most quotes allowed (5,000).' : 'Not saved. Try again.' });
    res.json({ ok: true, id: r.id, number: r.number });
}));
router.put('/stream/bot/api/community/quotes/:id', needApi, json, apiRoute(async (req, res) => {
    const { profile, c, ready } = await load(req);
    if (!ready) return notReady(res);
    const id = idOf(req.params.id);
    const b = quoteBody(req.body);
    if (b.text.length < 2) return res.status(400).json({ ok: false, errors: ['Enter the quote.'] });
    const enabled = req.body?.enabled === undefined ? undefined : req.body.enabled === true;
    if (!id || !(await c.cstore.updateQuote(profile.id, id, { ...b, enabled }))) return res.status(404).json({ ok: false, error: 'That quote does not exist.' });
    res.json({ ok: true });
}));
router.delete('/stream/bot/api/community/quotes/:id', needApi, apiRoute(async (req, res) => {
    const { profile, c, ready } = await load(req);
    if (!ready) return notReady(res);
    const id = idOf(req.params.id);
    if (!id || !(await c.cstore.deleteQuote(profile.id, id))) return res.status(404).json({ ok: false, error: 'That quote does not exist.' });
    res.json({ ok: true });
}));

// ── API: media share and text to speech ──

router.post('/stream/bot/api/community/media', needApi, json, apiRoute(async (req, res) => {
    const { profile, c } = await load(req);
    if (!c) return notReady(res);
    const v = validateMedia(req.body || {});
    if (!v.ok) return res.status(400).json({ ok: false, errors: v.errors });
    await c.media.saveSettings(profile.id, v.value);
    res.json({ ok: true, settings: await c.media.settingsOf(profile.id) });
}));
router.post('/stream/bot/api/community/tts/test', needApi, json, apiRoute(async (req, res) => {
    const { profile, c } = await load(req);
    if (!c) return notReady(res);
    const text = String(req.body?.text || '').slice(0, 400).trim() || 'This is how messages will sound on stream.';
    const r = await c.media.say(profile, { text });
    res.status(r.ok ? 200 : 409).json({ ok: r.ok, status: r.status, note: r.detail, error: r.ok ? undefined : r.detail });
}));
router.post('/stream/bot/api/community/tts', needApi, json, apiRoute(async (req, res) => {
    const { profile, c } = await load(req);
    if (!c) return notReady(res);
    const voices = (await ttsVoices(profile.ownerDiscordId)).map((v) => v.value);
    const v = validateTts(req.body || {}, { voices: voices.length ? voices : null });
    if (!v.ok) return res.status(400).json({ ok: false, errors: v.errors });
    await c.media.saveTtsSettings(profile.id, v.value);
    res.json({ ok: true, settings: await c.media.ttsSettingsOf(profile.id) });
}));
router.post('/stream/bot/api/community/media/key', needApi, apiRoute(async (req, res) => {
    const { profile, c } = await load(req);
    if (!c) return notReady(res);
    const key = await c.media.pageKey(profile.id, { rotate: true });
    res.json({ ok: true, url: c.media.pageUrl(key) });
}));
router.get('/stream/bot/api/community/media/queue', needApi, apiRoute(async (req, res) => {
    const { profile, c, ready } = await load(req);
    if (!ready) return notReady(res);
    res.json({ ok: true, queue: await c.media.queue(profile.id), history: await c.media.history(profile.id, 30), status: c.media.status(profile.id) });
}));
router.post('/stream/bot/api/community/media/requests', needApi, json, apiRoute(async (req, res) => {
    const { profile, c, ready } = await load(req);
    if (!ready) return notReady(res);
    const r = await c.media.request(profile, { input: String(req.body?.url || '').slice(0, 400), via: 'dashboard' });
    if (!r.ok) return res.status(400).json({ ok: false, error: r.reply || r.detail || 'Not added.' });
    res.json({ ok: true, note: r.reply });
}));
router.post('/stream/bot/api/community/media/requests/:id/:action', needApi, apiRoute(async (req, res) => {
    const { profile, c, ready } = await load(req);
    if (!ready) return notReady(res);
    const id = idOf(req.params.id);
    const action = String(req.params.action || '');
    if (!id || !['approve', 'deny', 'remove'].includes(action)) return res.status(404).json({ ok: false, error: 'Not found.' });
    const r = await c.media.decide(profile, id, action, byName(req));
    if (!r.ok) return res.status(409).json({ ok: false, error: r.error });
    res.json({ ok: true });
}));

// ── the OBS page ──

const limiter = (max) => rateLimit({ windowMs: 60_000, max, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => req.headers['cf-connecting-ip'] || req.ip,
    handler: (req, res) => { setOverlayHeaders(res); res.status(429).type('text/plain').send('Too many requests'); } });
const pageLimiter = limiter(30);
const eventsLimiter = limiter(30);
const ttsLimiter = limiter(60);
async function pageProfile(req, res) {
    setOverlayHeaders(res);
    const key = String(req.params.key || '');
    if (!isMediaKeyShape(key)) return null;
    const sb = await getStreamBot();
    if (!sb.community) return null;
    const pid = await sb.community.media.profileForKey(key);
    return pid ? { sb, pid, key } : null;
}
const gone = (res) => res.status(404).type('text/plain').send('This media share address is not in use. Copy the current one from Community, Media and speech.');

router.get('/stream/bot/overlay/mediashare/:key', pageLimiter, async (req, res) => {
    try {
        const hit = await pageProfile(req, res);
        if (!hit) return gone(res);
        res.render('stream-bot/mediashare-overlay', { preview: req.query.preview === '1' });
    } catch (err) {
        logger.warn(`${LOG} media page failed`, { error: err?.message });
        if (!res.headersSent) res.status(500).type('text/plain').send('Try again in a minute.');
    }
});
router.get('/stream/bot/overlay/mediashare/:key/events', eventsLimiter, async (req, res) => {
    try {
        const hit = await pageProfile(req, res);
        if (!hit) return res.status(404).type('text/plain').send('gone');
        let detach = () => {};
        const client = openSse(req, res, { onClose: () => detach() });
        detach = await hit.sb.community.media.attach(hit.pid, client, { preview: req.query.preview === '1' });
    } catch (err) {
        logger.warn(`${LOG} media events failed`, { error: err?.message });
        if (!res.headersSent) res.status(503).type('text/plain').send('unavailable');
    }
});
router.get('/stream/bot/overlay/mediashare/:key/tts/:id', ttsLimiter, async (req, res) => {
    try {
        const hit = await pageProfile(req, res);
        if (!hit) return res.status(404).end();
        const buf = await hit.sb.community.media.ttsAudio(hit.pid, String(req.params.id || '').slice(0, 20));
        if (!buf) return res.status(404).end();
        res.type('audio/wav').send(buf);
    } catch (err) {
        logger.warn(`${LOG} media tts failed`, { error: err?.message });
        if (!res.headersSent) res.status(500).end();
    }
});

export default router;
