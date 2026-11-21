/*
 * Stream bot media share and text to speech on stream (W2.15, W2.7; design §15): the OBS page "CertiFried Media Share"
 * (/stream/bot/overlay/mediashare/<key>) and what feeds it.
 *
 *   createMediaShare({ store, db, cstore, musicRef, viewersRef, encryption, synthesize, logger, now, timers, baseUrl })
 *     Settings     settingsOf(profileId) / saveSettings(profileId, value)        (profile settings key `mediashare`)
 *                  ttsSettingsOf(profileId) / saveTtsSettings(profileId, value)  (key `tts`)
 *     Page         pageKey(profileId, { rotate }) → key   profileForKey(key) → profileId | null   pageUrl(key)
 *                  attach(profileId, client) → detach     ttsAudio(profileId, id) → Buffer | null   status(profileId)
 *     Speech       say(profile, { text, voice, volume, maxChars }) → { ok, status, detail }   the "Speak text on stream" step
 *                  voice "myvoice" (core/voice-clone, invite-only): the profile owner's own cloned voice, for fixed text the
 *                  owner typed only (register.js and core/voice-clone/policy.js refuse variables); watermarked; when the
 *                  voice is not active the stock default voice reads it instead. `ownVoice` ({ available, synthesize })
 *                  defaults to core/voice-clone; tests pass a fake.
 *     Media share  request(profile, { input, viewer, roles, via }) → { ok, reply, id }        !media <YouTube link>
 *                  decide(profile, id, 'approve' | 'deny' | 'remove', by) → { ok, error }
 *                  run(profile, command, { ev, input }) → { reply, detail }               !media, !mediaqueue, !mediaapprove …
 *                  queue(profileId) / history(profileId)
 *
 * VOD safety (owner rule for music, memory project_certifried_stream_bot): a viewer's video carries music, so its sound
 * never plays on the Media Share page. An approved video is handed to the song request queue (core/stream-bot/music) as a
 * YouTube request: its sound plays only in the "CertiFried Music" browser source, behind the same VOD gate as songs (Studio
 * confirms the source is off the Twitch VOD track before every play, and the queue holds while it is not). The Media Share
 * page shows the video muted, kept in step with the music player's position. Nothing about a video plays while the VOD
 * is not protected, because the music player is what moves the queue.
 *
 * Speech is spoken text, not music: it plays on the Media Share page itself. Text goes through prepareSpeech() (links read
 * as "a link", the profanity mask, a length cap) before Piper (utils/piper-tts.js, offline on this server) reads it. A
 * custom voice trained from a real person is only offered to that person (speech.js).
 *
 * Points: an optional cost per video, taken when the request is made (strict, never below 0) and given back when it is
 * denied, removed before it plays, or fails. Points are a free channel tally; no money is involved.
 */
import crypto from 'node:crypto';
import { mediaWithDefaults, ttsWithDefaults, youtubeVideoId } from './settings.js';
import { prepareSpeech, voiceAllowed } from './speech.js';
import { formatPoints } from '../viewers/settings.js';
import { parseRequestInput, trackKeyOf } from '../music/text.js';
import { OWN_VOICE_ID } from '../../voice-clone/constants.js';
import { hasTemplateVars } from '../../voice-clone/policy.js';
import { noRewards, YT_POINTS_REPLY } from '../youtube/policy.js';

export const MEDIA_KEY_SHAPE = /^sbs_[A-Za-z0-9_-]{32}$/;
export const newMediaKey = () => `sbs_${crypto.randomBytes(24).toString('base64url')}`;
export const isMediaKeyShape = (k) => MEDIA_KEY_SHAPE.test(String(k || ''));
export const mediaKeyHash = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');

export const MEDIA_COMMANDS = Object.freeze([
    { key: 'request', label: 'Request a video (!media <YouTube link>)' },
    { key: 'queue', label: 'The video queue (!mediaqueue)' },
    { key: 'approve', label: 'Moderators: approve a video (!mediaapprove, !mediaapprove 2)' },
    { key: 'deny', label: 'Moderators: deny a video (!mediadeny, !mediadeny 2, !mediadeny all)' },
    { key: 'skip', label: 'Moderators: skip the video playing (!mediaskip)' },
]);
export const MEDIA_COMMAND_KEYS = Object.freeze(MEDIA_COMMANDS.map((c) => c.key));
export const PAGE_LIMITS = Object.freeze({ clients: 4, ttsPending: 6, ttsCache: 40, ttsTtlMs: 5 * 60_000, syncMs: 2_000, resyncMs: 10_000, sweepMs: 15_000, keyCacheMs: 60_000 });
const MUSIC_TO_MEDIA = Object.freeze({ queued: 'queued', playing: 'playing', played: 'played', skipped: 'skipped', removed: 'removed', failed: 'failed', denied: 'denied', pending: 'queued' });
const FINAL = new Set(['played', 'skipped', 'removed', 'failed', 'denied']);
const isMod = (roles) => (roles || []).some((r) => r === 'broadcaster' || r === 'moderator');

export function createMediaShare({
    store, db = null, cstore, musicRef = null, viewersRef = null, encryption = null, synthesize = null, logger = null, now = () => Date.now(), timers = true,
    baseUrl = 'https://certifriedmultitool.com', limits = {}, ownVoice = null,
} = {}) {
    const L = { ...PAGE_LIMITS, ...limits };
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[StreamBotMedia] ${msg}`, meta); } catch { /* ignore */ } };
    const pages = new Map();     // profileId -> Set(client)
    const tts = new Map();       // id -> { profileId, at, buffer, promise, volume }
    const pending = new Map();   // profileId -> [{ id, at, volume }]   speech waiting for a page
    const shown = new Map();     // profileId -> { sig, at, frame }
    const keyCache = new Map();
    const base = String(baseUrl || '').replace(/\/+$/, '');
    const music = () => musicRef?.current || null;

    // ── settings ──
    async function settingsOf(pid) { return mediaWithDefaults(await store.getSettingsKey(pid, 'mediashare').catch(() => null)); }
    async function saveSettings(pid, value) {
        const raw = (await store.getSettingsKey(pid, 'mediashare').catch(() => null)) || {};
        await store.setSettingsKey(pid, 'mediashare', { ...mediaWithDefaults(value), ...(raw.overlay ? { overlay: raw.overlay } : {}) });
    }
    async function ttsSettingsOf(pid) { return ttsWithDefaults(await store.getSettingsKey(pid, 'tts').catch(() => null)); }
    async function saveTtsSettings(pid, value) { await store.setSettingsKey(pid, 'tts', ttsWithDefaults(value)); }

    // ── the page key ──
    async function pageKey(pid, { rotate = false } = {}) {
        const raw = (await store.getSettingsKey(pid, 'mediashare').catch(() => null)) || {};
        if (!rotate && raw.overlay?.keyEnc && encryption) {
            try { const k = encryption.decrypt(JSON.parse(raw.overlay.keyEnc)); if (isMediaKeyShape(k)) return k; } catch { /* make a new one */ }
        }
        const key = newMediaKey();
        const overlay = { keyEnc: encryption ? JSON.stringify(encryption.encrypt(key)) : null, keyHash: mediaKeyHash(key), hint: key.slice(-4), createdAt: new Date(now()).toISOString() };
        if (raw.overlay?.keyHash) keyCache.delete(raw.overlay.keyHash);
        await store.setSettingsKey(pid, 'mediashare', { ...mediaWithDefaults(raw), overlay });
        if (rotate) for (const c of pages.get(Number(pid)) || []) { try { c.send('gone', {}); c.close(); } catch { /* gone */ } }
        if (rotate) pages.delete(Number(pid));
        return key;
    }
    async function profileForKey(key) {
        if (!isMediaKeyShape(key)) return null;
        const kh = mediaKeyHash(key);
        const hit = keyCache.get(kh);
        if (hit && now() - hit.at < L.keyCacheMs) return hit.profileId;
        const [rows] = await db.query(`SELECT id FROM \`${store.prefix}profiles\` WHERE enabled = 1 AND JSON_UNQUOTE(JSON_EXTRACT(settings, '$.mediashare.overlay.keyHash')) = ? LIMIT 1`, [kh]);
        const profileId = rows[0] ? Number(rows[0].id) : null;
        if (keyCache.size > 5000) keyCache.clear();
        keyCache.set(kh, { at: now(), profileId });
        return profileId;
    }
    const pageUrl = (key) => `${base}/stream/bot/overlay/mediashare/${key}`;

    // ── the page ──
    const clientsOf = (pid) => pages.get(Number(pid)) || new Set();
    const live = (pid) => [...clientsOf(pid)].filter((c) => !c.preview);
    const sendAll = (pid, event, data) => { let n = 0; for (const c of clientsOf(pid)) { try { if (c.send(event, data) !== false) n++; } catch { /* closed */ } } return n; };

    async function attach(pid, client, { preview = false } = {}) {
        const id = Number(pid);
        let set = pages.get(id);
        if (!set) { set = new Set(); pages.set(id, set); }
        client.preview = !!preview;
        if (set.size >= L.clients) { const oldest = set.values().next().value; set.delete(oldest); try { oldest.close(); } catch { /* gone */ } }
        set.add(client);
        const s = await settingsOf(id);
        const now1 = await currentFrame(id).catch(() => null);
        client.send('hello', { showCard: s.showCard, video: now1, preview: !!preview });
        if (!preview) flushSpeech(id, client);
        ensureTimers();
        return () => { set.delete(client); if (!set.size && pages.get(id) === set) pages.delete(id); };
    }

    // ── speech ──
    function sweepTts() { const t = now(); for (const [k, v] of tts) if (t - v.at > L.ttsTtlMs) tts.delete(k); for (const [p, list] of pending) { const keep = list.filter((x) => t - x.at < 120_000); if (keep.length) pending.set(p, keep); else pending.delete(p); } }
    function flushSpeech(pid, client) {
        const list = pending.get(pid) || [];
        pending.delete(pid);
        for (const x of list) client.send('speak', { src: `tts/${x.id}`, volume: x.volume });
    }
    async function say(profile, { text, voice = null, volume = null, maxChars = null, fixedText = false } = {}) {
        const pid = Number(profile.id);
        const s = await ttsSettingsOf(pid);
        const words = prepareSpeech(text, { mask: s.mask, words: s.words, maxChars: maxChars || s.maxChars });
        if (!words) return { ok: false, status: 'skipped', detail: 'nothing to read aloud' };
        let v = voice || s.voice;
        let speak = synthesize;
        let note = '';
        if (v === OWN_VOICE_ID) {
            // Own voice (core/voice-clone/policy.js). The owner's fixed step text: always (an automation). Anything else
            // (a rendered template, !tts through the default voice, other people's words): only if the voice's owner
            // allowed their voice for other people's messages (features.viewerText); otherwise the stock voice reads it.
            const own = ownVoice || await ownVoiceDefault();
            const owner = String(profile.ownerDiscordId || '');
            const ownText = fixedText === true && voice === OWN_VOICE_ID && !hasTemplateVars(text);
            const ok = own && owner && (ownText ? await own.available(owner) : await own.allowsViewerText?.(owner));
            if (ok) {
                const feature = ownText ? 'automation' : 'viewer_tts';
                speak = (w) => own.synthesize(owner, w, { feature, profileOwnerId: owner }).then((r) => r.wav);
            } else {
                v = s.voice === OWN_VOICE_ID ? 'ryan' : s.voice;
                note = ownText ? ' (your own voice is not active, so the default voice read it)' : " (your own voice is not allowed for other people's messages, so the default voice read it)";
            }
        }
        if (speak === synthesize && !(await voiceAllowed(v, profile.ownerDiscordId))) return { ok: false, status: 'failed', detail: `the voice "${String(v).slice(0, 40)}" is not available` };
        if (!speak) return { ok: false, status: 'failed', detail: 'text to speech is not available on this server' };
        sweepTts();
        const mine = [...tts.values()].filter((x) => x.profileId === pid && !x.buffer).length;
        if (mine >= L.ttsPending) return { ok: false, status: 'skipped', detail: 'too many messages are waiting to be read' };
        while (tts.size >= L.ttsCache) tts.delete(tts.keys().next().value);
        const id = crypto.randomBytes(9).toString('base64url');
        const vol = Number.isFinite(Number(volume)) && volume !== null && volume !== '' ? Math.max(0, Math.min(100, Math.round(Number(volume)))) : s.volume;
        const item = { profileId: pid, at: now(), buffer: null, promise: null, volume: vol };
        item.promise = Promise.resolve().then(() => speak(words, v)).then((buf) => { item.buffer = Buffer.isBuffer(buf) && buf.length ? buf : null; return item.buffer; })
            .catch((err) => { log('warn', 'speech failed', { error: err?.message }); return null; });
        tts.set(id, item);
        const open = live(pid);
        if (open.length) {
            for (const c of clientsOf(pid)) { try { c.send('speak', { src: `tts/${id}`, volume: vol }); } catch { /* closed */ } }
            return { ok: true, status: 'ok', detail: `reading on the Media Share page${note}: ${words.slice(0, 200)}` };
        }
        const list = pending.get(pid) || [];
        list.push({ id, at: now(), volume: vol });
        pending.set(pid, list.slice(-L.ttsPending));
        return { ok: true, status: 'queued', detail: `waiting up to 2 minutes for the CertiFried Media Share source in OBS${note}: ${words.slice(0, 160)}` };
    }
    async function ownVoiceDefault() {
        try {
            const vc = await (await import('../../voice-clone/index.js')).getVoiceClone();
            return vc?.synth || null;
        } catch { return null; }
    }
    async function ttsAudio(pid, id) {
        const item = tts.get(String(id || ''));
        if (!item || item.profileId !== Number(pid)) return null;
        if (item.buffer) return item.buffer;
        let t;
        const r = await Promise.race([item.promise, new Promise((res) => { t = setTimeout(() => res(null), 20_000); t.unref?.(); })]);
        clearTimeout(t);
        return r;
    }

    // ── what the page shows: the media request the music player is playing now ──
    const mediaByMusic = new Map();   // `${pid}:${musicRequestId}` -> media row | false
    async function mediaFor(pid, musicRequestId) {
        const k = `${pid}:${musicRequestId}`;
        if (mediaByMusic.has(k)) return mediaByMusic.get(k) || null;
        const row = await cstore.mediaByMusicRequest(pid, musicRequestId).catch(() => null);
        if (mediaByMusic.size > 2000) mediaByMusic.clear();
        mediaByMusic.set(k, row || false);
        return row;
    }
    async function currentFrame(pid) {
        const np = music()?.service?.player?.nowPlaying?.(pid) || null;
        if (!np?.requestId) return null;
        const row = await mediaFor(pid, np.requestId);
        if (!row) return null;
        return { requestId: row.id, videoId: row.videoId, title: row.title, channel: row.channel, requester: row.viewerName || null, positionMs: Number(np.positionMs) || 0,
            durationMs: row.durationMs, paused: !!np.paused, playId: np.playId };
    }
    async function syncPages() {
        for (const pid of [...pages.keys()]) {
            if (!clientsOf(pid).size) continue;
            const f = await currentFrame(pid).catch(() => null);
            const sig = f ? `${f.playId}|${f.paused}` : '';
            const prev = shown.get(pid);
            if (!prev || prev.sig !== sig) {
                shown.set(pid, { sig, at: now() });
                if (f) sendAll(pid, 'video', f); else if (prev?.sig) sendAll(pid, 'stop', {});
                if (f) await cstore.setMediaStatus(pid, f.requestId, 'playing').catch(() => {});
            } else if (f && now() - prev.at >= L.resyncMs) {
                prev.at = now();
                sendAll(pid, 'sync', { positionMs: f.positionMs, paused: f.paused });
            }
        }
    }
    /** Media handed to the song queue: follow the song request's status (played, skipped, removed, failed), refund when it never played. */
    async function sweepStatuses() {
        if (!(await cstore.available())) return;
        const m = music();
        if (!m?.mstore) return;
        for (const pid of await cstore.profilesWithQueuedMedia()) {
            for (const row of (await cstore.activeMedia(pid)).filter((r) => r.musicRequestId)) {
                const req = await m.mstore.getRequest(pid, row.musicRequestId).catch(() => null);
                const next = req ? MUSIC_TO_MEDIA[req.status] : 'removed';
                if (!next || next === row.status) continue;
                await cstore.setMediaStatus(pid, row.id, next, { finished: FINAL.has(next) });
                if (['removed', 'failed', 'denied'].includes(next) && row.status === 'queued') await refundMedia(pid, row, 'Video did not play');
            }
        }
    }
    let syncTimer = null;
    let sweepTimer = null;
    function ensureTimers() {
        if (!timers || syncTimer) return;
        syncTimer = setInterval(() => { syncPages().catch((err) => log('warn', 'sync failed', { error: err?.message })); }, L.syncMs);
        sweepTimer = setInterval(() => { sweepStatuses().catch((err) => log('warn', 'status sweep failed', { error: err?.message })); }, L.sweepMs);
        syncTimer.unref?.(); sweepTimer.unref?.();
    }

    // ── requests ──
    const svc = () => viewersRef?.current?.service || null;
    async function refundMedia(pid, row, note) {
        if (!row.pointsPaid || !row.viewerId || !['twitch', 'kick', 'youtube'].includes(row.platform)) return;
        const v = await viewersRef?.current?.vstore?.byAccount(pid, row.platform, row.viewerId).catch(() => null);
        if (v) await svc()?.changePoints(pid, v.id, row.pointsPaid, { kind: 'media', note: `${note}: refund`, actor: 'media share' }).catch(() => null);
    }
    async function handToMusic(profile, row, by) {
        const m = music();
        if (!m?.mstore) return { ok: false, error: 'Song requests are not running, so videos cannot play yet.' };
        const musicId = await m.mstore.insertRequest(profile.id, {
            platform: ['twitch', 'kick', 'youtube'].includes(row.platform) ? row.platform : 'dashboard', viewerId: row.viewerId, viewerLogin: row.viewerLogin, viewerName: row.viewerName,
            source: 'youtube', input: `Media share: ${row.url}`.slice(0, 300), title: row.title || 'Video', artist: row.channel || '', url: row.url, trackKey: trackKeyOf(row.url),
            durationMs: row.durationMs, explicit: null, thumbnail: row.thumbnail, playlistName: null, status: 'queued',
        });
        await cstore.setMediaStatus(profile.id, row.id, 'queued', { musicRequestId: musicId, decidedBy: by || undefined, decided: true });
        m.service?.player?.nudge?.(profile.id)?.catch?.(() => {});
        ensureTimers();   // follow its status (played, skipped, removed) even while no Media Share page is open
        return { ok: true, musicId };
    }

    async function request(profile, { input, viewer = {}, roles = [], via = 'chat' } = {}) {
        const pid = profile.id;
        if (!(await cstore.available())) return { ok: false, reply: null, detail: 'media share starts after the next CertiFried update' };
        const s = await settingsOf(pid);
        const streamer = via === 'dashboard';
        // Media share is Twitch and Kick only: getting a video played is a reward, which YouTube's API policy forbids (III.F.3.c).
        if (!streamer && noRewards(viewer.platform)) return { ok: false, reply: YT_POINTS_REPLY, detail: 'media share is Twitch and Kick only' };
        if (!s.open && !streamer) return { ok: false, reply: 'Media share is closed right now.' };
        const videoId = youtubeVideoId(String(input || '').trim().split(/\s+/)[0]);
        if (!videoId) return { ok: false, reply: 'Send a YouTube video link, like this: !media https://youtu.be/…' };
        const m = music();
        if (!m?.service?.resolver) return { ok: false, reply: 'Media share is not running yet.' };
        const active = await cstore.activeMedia(pid);
        if (!streamer) {
            if (viewer.id && active.filter((r) => r.platform === viewer.platform && r.viewerId === String(viewer.id)).length >= s.maxPerUser) return { ok: false, reply: `You can have ${s.maxPerUser} video${s.maxPerUser === 1 ? '' : 's'} waiting at a time.` };
            if (active.length >= s.maxQueue) return { ok: false, reply: `The video queue is full (${s.maxQueue}).` };
            if (active.some((r) => r.videoId === videoId)) return { ok: false, reply: 'That video is already in the queue.' };
        }
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        let found;
        try { found = await m.service.resolver.lookup(parseRequestInput(url), { max: 1 }); } catch (err) { log('warn', 'lookup failed', { error: err?.message }); found = { ok: false }; }
        const item = found?.ok ? found.items?.[0] : null;
        if (!item) return { ok: false, reply: 'That video could not be found. Check that it is public.' };
        if (!item.durationMs) return { ok: false, reply: 'Live streams and premieres cannot be shared.' };
        if (!streamer && item.durationMs > s.maxSeconds * 1000) return { ok: false, reply: `That video is too long: the longest allowed is ${s.maxSeconds >= 120 ? `${Math.round(s.maxSeconds / 60)} min` : `${s.maxSeconds} seconds`}.` };
        let paid = 0;
        if (s.cost && !streamer && viewer.id) {
            const vs = svc();
            const row = vs ? await vs.ensureViewer(pid, { platform: viewer.platform, user: { id: viewer.id, login: viewer.login, name: viewer.name, roles } }) : null;
            if (!row) return { ok: false, reply: 'Points are not running yet, so videos cannot be requested.' };
            const r = await vs.changePoints(pid, row.id, -s.cost, { strict: true, kind: 'media', note: `Media share: ${item.title}`.slice(0, 200), actor: `chat:${viewer.login || ''}` });
            if (!r.ok) {
                const cur = (await vs.settingsFor(pid).catch(() => null))?.currency || 'points';
                return { ok: false, reply: `A video costs ${formatPoints(s.cost)} ${cur} and you have ${formatPoints(r.balance ?? 0)}.` };
            }
            paid = s.cost;
        }
        const needs = !streamer && (s.approval === 'all' || (s.approval === 'mods_skip' && !roles.some((r) => r === 'broadcaster' || r === 'moderator' || r === 'vip')));
        const id = await cstore.addMedia(pid, {
            platform: viewer.platform || (streamer ? 'dashboard' : 'unknown'), viewerId: viewer.id || null, viewerLogin: viewer.login || null, viewerName: viewer.name || (streamer ? 'the streamer' : null),
            videoId, url, title: item.title, channel: item.artist, durationMs: item.durationMs, thumbnail: item.thumbnail, status: 'pending', pointsPaid: paid,
        });
        const row = await cstore.getMedia(pid, id);
        if (needs) {
            const n = (await cstore.activeMedia(pid)).filter((r) => r.status === 'pending').length;
            return { ok: true, id, pending: true, reply: `"${item.title.slice(0, 80)}" is waiting for a moderator (${n} waiting).` };
        }
        const h = await handToMusic(profile, row, streamer ? 'the streamer' : 'no approval needed');
        if (!h.ok) { await cstore.setMediaStatus(pid, id, 'failed', { reason: h.error, finished: true }); await refundMedia(pid, row, 'Video could not be queued'); return { ok: false, reply: h.error }; }
        return { ok: true, id, reply: `"${item.title.slice(0, 80)}" is in the queue. Its sound plays with the song requests.` };
    }

    async function decide(profile, id, action, by = 'the streamer') {
        const pid = profile.id;
        const row = await cstore.getMedia(pid, id);
        if (!row) return { ok: false, error: 'That video is not in the queue.' };
        if (action === 'approve') {
            if (row.status !== 'pending') return { ok: false, error: 'That video is not waiting for approval.' };
            const h = await handToMusic(profile, row, by);
            return h.ok ? { ok: true } : { ok: false, error: h.error };
        }
        if (action === 'deny') {
            if (row.status !== 'pending') return { ok: false, error: 'That video is not waiting for approval.' };
            await cstore.setMediaStatus(pid, id, 'denied', { decidedBy: by, decided: true, finished: true });
            await refundMedia(pid, row, 'Video denied');
            return { ok: true };
        }
        if (action === 'remove') {
            if (!['pending', 'queued', 'playing'].includes(row.status)) return { ok: false, error: 'That video already finished.' };
            if (row.musicRequestId && music()?.service?.decideById) await music().service.decideById(pid, row.musicRequestId, 'remove', by).catch(() => null);
            await cstore.setMediaStatus(pid, id, 'removed', { decidedBy: by, finished: true });
            if (row.status !== 'playing') await refundMedia(pid, row, 'Video removed');
            return { ok: true };
        }
        return { ok: false, error: 'Unknown action.' };
    }

    async function run(profile, command, { ev, input = '' } = {}) {
        const pid = profile.id;
        if (!(await cstore.available())) return { reply: null, detail: 'media share starts after the next CertiFried update' };
        const roles = ev?.user?.roles || [];
        const by = ev?.user?.name || 'a moderator';
        const arg = String(input || '').trim();
        if (command === 'request') {
            if (!ev?.user?.id) return { reply: null, detail: 'no viewer for this event' };
            const r = await request(profile, { input: arg, viewer: { platform: ev.platform, id: String(ev.user.id), login: ev.user.login, name: ev.user.name }, roles });
            return { reply: r.reply ? `${ev.user.name || ev.user.login}, ${r.reply.charAt(0).toLowerCase()}${r.reply.slice(1)}` : null, detail: r.detail };
        }
        const active = await cstore.activeMedia(pid);
        if (command === 'queue') {
            const playing = active.find((r) => r.status === 'playing');
            const queued = active.filter((r) => r.status === 'queued');
            const waiting = active.filter((r) => r.status === 'pending').length;
            if (!playing && !queued.length && !waiting) return { reply: 'No videos are queued.' };
            const parts = [];
            if (playing) parts.push(`Playing: ${playing.title.slice(0, 60)}`);
            if (queued.length) parts.push(`next: ${queued.slice(0, 3).map((r) => r.title.slice(0, 40)).join('; ')}`);
            if (waiting) parts.push(`${waiting} waiting for approval`);
            return { reply: `${parts.join(', ')}.`.slice(0, 480) };
        }
        if (!isMod(roles)) return { reply: null, detail: 'moderators only' };
        if (command === 'skip') {
            const playing = active.find((r) => r.status === 'playing');
            if (!playing) return { reply: 'No video is playing.' };
            await decide(profile, playing.id, 'remove', by);
            return { reply: `Skipped "${playing.title.slice(0, 60)}".` };
        }
        const waiting = active.filter((r) => r.status === 'pending');
        if (!waiting.length) return { reply: 'No videos are waiting for approval.' };
        if (command === 'deny' && arg.toLowerCase() === 'all') {
            for (const r of waiting) await decide(profile, r.id, 'deny', by);
            return { reply: `Denied ${waiting.length} video${waiting.length === 1 ? '' : 's'}.` };
        }
        const n = arg ? Number(arg) : 1;
        const row = Number.isInteger(n) && n >= 1 ? waiting[n - 1] : null;
        if (!row) return { reply: `Pick a number from 1 to ${waiting.length}.` };
        if (command === 'approve') { const r = await decide(profile, row.id, 'approve', by); return { reply: r.ok ? `Approved "${row.title.slice(0, 60)}" from ${row.viewerName || 'a viewer'}.` : r.error }; }
        if (command === 'deny') { const r = await decide(profile, row.id, 'deny', by); return { reply: r.ok ? `Denied "${row.title.slice(0, 60)}".` : r.error }; }
        return { reply: null, detail: `unknown command ${command}` };
    }

    function status(pid) {
        return { pages: live(pid).length, previews: clientsOf(pid).size - live(pid).length, gate: music()?.service?.gateOf?.(pid) || null };
    }

    return {
        settingsOf, saveSettings, ttsSettingsOf, saveTtsSettings, pageKey, profileForKey, pageUrl, attach, say, ttsAudio, request, decide, run, status,
        queue: (pid) => cstore.activeMedia(pid), history: (pid, n = 30) => cstore.mediaHistory(pid, n), syncPages, sweepStatuses, currentFrame,
        close() { clearInterval(syncTimer); clearInterval(sweepTimer); syncTimer = null; sweepTimer = null; for (const set of pages.values()) for (const c of set) { try { c.close(); } catch { /* gone */ } } pages.clear(); },
        _state: { pages, tts, pending, shown },
    };
}

export default { createMediaShare, MEDIA_COMMANDS, MEDIA_COMMAND_KEYS, isMediaKeyShape, mediaKeyHash, newMediaKey, PAGE_LIMITS };
