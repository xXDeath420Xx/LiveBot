/*
 * Stream bot overlays: the live side (design §9). Overlay pages in OBS connect over SSE
 * (/stream/bot/overlay/<type>/<key>/events) and this service sends them what to show.
 *
 *   createOverlayService({ store, ostore, sounds, media, render, nowPlaying, synthesize, images, logger, now, baseUrl })
 *     attach(overlay, client, { preview }) → detach()   client = { send(event, data), close() } (openSse())
 *     onEvent(profileId, ev)            every event the live feed publishes: alerts, the event list, goals, counters,
 *                                       now playing (core/stream-bot/overlays/index.js taps feed.publish)
 *     onChat(platform, result)          a chat message, deletion, viewer clear or chat clear (chat.js), for Chat overlays
 *     dispatch(d)                       io.dispatch for target 'overlay' (overlay.alert, overlay.text, overlay.media):
 *                                       a dispatch row like Studio's, sent to the chosen overlay's open pages, or queued
 *                                       until one opens (queueSeconds), then acked by the page (report)
 *     report(overlay, body)             the page acknowledges a dispatch
 *     isConnected(profileId, capability?)  an overlay page open in OBS (previews on the dashboard do not count)
 *     testAlert(profileId, overlayId, key, amount) → { sent }   the Overlays tab's Test buttons
 *     changeGoal(profileId, overlayId, mode, n) → { ok, current, target }   the "Change a goal" action and the dashboard
 *     invalidate(overlayId, { closeAll })  settings saved (pages restyle at once) or key regenerated (pages closed)
 *     onStudioRequest(conn, method)     'overlays.list' → { overlays: [{ id, type, name, sourceName, url, width, height, audio }] }
 *     ttsAudio(overlay, id) → Buffer | null   a tip or cheer message read aloud (Piper on this server, see below)
 *     status(profileId) → { [overlayId]: { online, previews } }
 *     testWidget(profileId, overlayId) → { sent }   a widget's Test button (invented frames, nothing stored or counted)
 *     chatPoll(profileId, { action: 'start'|'end', title, options, durationSec }) → { ok, id | error }   starts or ends a chat poll
 *                                       through core/stream-bot/control/chat-polls.js (its poll.* events reach the Poll widget)
 *     labelValues(overlay) / labelText(overlay, key)   stream labels, also as plain text for OBS text sources
 *     onHeart(profileId, view)          Studio 0.2.14: a heart-rate reading (core/stream-bot/heart, at most once a second) to
 *                                       the profile's Heart rate overlays; heartView(profileId) gives a page its first state
 *
 * Widgets (widgets.js holds their rules): train (Twitch hype train bar and a sub train across Twitch, Kick and YouTube),
 * tipjar (a running total kept in the overlay's state like a goal, reset when the stream goes live), credits (this stream's
 * supporters from the event log, plus moderators seen in chat), emotewall (emotes from chat, 7TV / BTTV / FFZ through
 * emotes.js), poll (Twitch polls, predictions and CertiFried chat polls, all from their poll.* / prediction.* events), labels (latest follower, sub, tip, top cheer from the event log) and viewers (stream-info.js, every 30 seconds).
 * A widget whose Twitch part needs a scope the streamer has not granted shows "Reconnect Twitch to enable" there instead.
 *
 * Alerts are queued on the page, one at a time, never overlapping; sounds and read-aloud messages play inside the
 * browser source, so OBS's own audio tracks decide whether they reach the VOD.
 *
 * Read aloud: browser speechSynthesis inside OBS is not used. OBS's browser (CEF) on Windows often lists no voices,
 * and where it speaks, the voice goes straight to the Windows output instead of through the browser source, so it
 * would reach the VOD whatever the streamer set in OBS. The message is synthesised here with CertiFried's Piper voices
 * (utils/piper-tts.js, offline on this server) and played by the page like an alert sound.
 */
import crypto from 'node:crypto';
import { overlayType, typesFor, alertKeyFor, alertAmount, pickVariation, sampleFor, goalIncrement, withDefaults, ALERT_KINDS, LIMITS, FONTS, LABEL_KEYS } from './config.js';
import { visibleFor } from './chat.js';
import { splitEmotes } from './emotes.js';
import {
    jarAmount, trainIncrement, hypeView, twitchPollView, predictionView, chatPollView, creditsFrom, labelLine, labelText as labelTextOf,
    blockedText, sampleFrames, money,
} from './widgets.js';
import { describeEvent, publicEvent } from '../events.js';
import { TEXT_SIZES, MEDIA_SIZES } from './actions.js';

export const SERVICE_LIMITS = Object.freeze({
    clientsPerOverlay: 6, chatRing: 60, ttsPending: 6, ttsCache: 40, ttsTtlMs: 10 * 60_000, ttsWaitMs: 20_000, channelCacheMs: 60_000,
    goalWriteMs: 2_000, counterRefreshMs: 30_000, nowPlayingMs: 5_000, goalCacheMs: 60_000,
    viewersMs: 30_000, labelsCacheMs: 15_000, featuresMs: 5 * 60_000, pollOptions: 6, pollTitle: 120, pollOption: 60, pollSec: [10, 3600], modsSeen: 300,
    creditsLookbackMs: 36 * 3600_000, creditsFallbackMs: 12 * 3600_000,
});
const GOAL_TYPES = new Set(['follow', 'sub', 'resub', 'gift_sub', 'cheer', 'bits.used', 'tip']);
const JAR_TYPES = new Set(['tip', 'cheer', 'bits.used', 'kicks.gifted']);
const LABEL_TYPES = new Set(['follow', 'sub', 'resub', 'gift_sub', 'membership', 'tip', 'cheer', 'stream.online']);
const THIRD_PARTY = /^img\/(7tv|bttv|ffz)-emote\//;

export function createOverlayService({
    store, ostore, sounds = null, media = null, render = null, nowPlaying = () => null, synthesize = null, images = null,
    logger = null, now = () => Date.now(), baseUrl = 'https://certifriedmultitool.com', limits = {}, timers = true,
    twitchFeatures = null, viewerCounts = null, emotes = null, chatPolls = () => null, heartView = null,
} = {}) {
    const L = { ...SERVICE_LIMITS, ...limits };
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[StreamBotOverlay] ${msg}`, meta); } catch { /* ignore */ } };
    const entries = new Map();        // overlayId -> { overlay, clients: Set<client> }
    const chatRing = new Map();       // profileId -> [message]
    const channelCache = new Map();   // 'platform:id' -> { at, profiles: [profileId] }
    const goals = new Map();          // profileId -> { at, list: [{ id, config, state }] }
    const goalWrites = new Map();     // overlayId -> timer
    const tts = new Map();            // ttsId -> { overlayId, at, promise, buffer }
    const lastNow = new Map();        // overlayId -> now playing signature
    const jars = new Map();           // profileId -> { at, list: [{ id, config, total }] }
    const trains = new Map();         // overlayId -> { count, lastAt, last }
    const hype = new Map();           // profileId -> hypeView
    const polls = new Map();          // profileId -> { twitch, prediction, chat } views
    const chatEnds = new Map();       // chat poll id -> when it ends (polls started from the dashboard)
    const labelCache = new Map();     // profileId -> { at, values: { [key]: { name, detail } | null }, scope }
    const mods = new Map();           // profileId -> Map(login -> name), moderators seen in chat since the stream went live
    const features = new Map();       // profileId -> { at, set: Set | null }
    const twitchIds = new Map();      // profileId -> { at, id }
    const lastViewers = new Map();    // overlayId -> signature
    const base = String(baseUrl || '').replace(/\/+$/, '');

    const forProfile = (profileId) => [...entries.values()].filter((e) => e.overlay.profileId === Number(profileId) && e.clients.size);
    const live = (e) => [...e.clients].filter((c) => !c.preview).length;
    const sendAll = (e, event, data) => { let n = 0; for (const c of e.clients) { try { if (c.send(event, data) !== false) n++; } catch { /* closed */ } } return n; };

    // ── what a page needs to draw ──
    function pageConfig(o) {
        const t = overlayType(o.type);
        const fontCss = (k) => FONTS[k]?.css || FONTS.system.css;
        const cfg = JSON.parse(JSON.stringify(o.config || {}));
        if (cfg.general) cfg.general.fontCss = fontCss(cfg.general.font);
        else if (cfg.font) cfg.fontCss = fontCss(cfg.font);
        if (o.type === 'alerts') delete cfg.alerts;   // the page gets each alert's settings with the alert itself
        return { type: o.type, label: t?.label || o.type, config: cfg, textSizes: TEXT_SIZES, mediaSizes: MEDIA_SIZES, canvasFont: fontCss(o.config?.font || o.config?.general?.font) };
    }

    const eventItem = (ev) => ({ id: ev.id ?? null, type: ev.type, platform: ev.platform, name: ev.user?.name || null, text: describeEvent(ev).slice(0, 200), at: ev.occurredAt || new Date(now()).toISOString() });

    async function initialState(o) {
        try {
            switch (o.type) {
                case 'events': {
                    const rows = await store.listEvents(o.profileId, { limit: 60, includeTest: false });
                    return { items: rows.filter((r) => o.config.types.includes(r.type)).slice(0, o.config.max).map((r) => eventItem(publicEvent(r, r.id))) };
                }
                case 'goal': {
                    const g = (await goalsFor(o.profileId)).find((x) => x.id === o.id);
                    return goalView(o, g ? g.current : Number(o.state?.current) || 0);
                }
                case 'counter': return { value: await counterValue(o) };
                case 'nowplaying': return { now: nowCard(o) };
                case 'chat': return { messages: (chatRing.get(o.profileId) || []).filter((m) => visibleFor(m, o.config)).slice(-o.config.maxMessages) };
                case 'scene': return { media: await sceneMedia(o) };
                case 'train': return { hype: hype.get(o.profileId) || null, sub: trainView(o), blocked: await blockedFor(o) };
                case 'tipjar': { const j = (await jarsFor(o.profileId)).find((x) => x.id === o.id); return jarView(o, j ? j.total : Number(o.state?.total) || 0); }
                case 'credits': return { sections: await creditsFor(o), title: o.config.title };
                case 'poll': return { ...pollState(o.profileId), blocked: await blockedFor(o) };
                case 'labels': return { values: await labelValues(o) };
                case 'viewers': return { counts: await countsFor(o.profileId) };
                case 'heartrate': return { heart: heartOf(o.profileId) };
                default: return {};
            }
        } catch (err) {
            log('warn', 'initial state failed', { overlayId: o.id, error: err?.message });
            return {};
        }
    }

    // ── widgets ──
    const cachedEntry = (map, key, ms) => { const h = map.get(key); return h && now() - h.at < ms ? h : null; };
    async function featuresFor(profileId) {
        if (!twitchFeatures) return null;
        const hit = cachedEntry(features, profileId, L.featuresMs);
        if (hit) return hit.set;
        let set = null;
        try { set = await twitchFeatures(profileId); } catch (err) { log('debug', 'twitch features failed', { error: err?.message }); set = null; }
        features.set(profileId, { at: now(), set });
        return set;
    }
    async function blockedFor(o) { return blockedText(o.type, o.config, await featuresFor(o.profileId)); }
    async function twitchIdOf(profileId) {
        const hit = cachedEntry(twitchIds, profileId, L.featuresMs);
        if (hit) return hit.id;
        let id = null;
        try { id = (await store.listChannels(profileId)).find((c) => c.platform === 'twitch')?.platform_user_id ?? null; } catch { id = null; }
        twitchIds.set(profileId, { at: now(), id: id == null ? null : String(id) });
        return id == null ? null : String(id);
    }

    // sub train (per overlay, its own time window) and hype train (per profile, from Twitch)
    function trainView(o) {
        const t = trains.get(o.id);
        if (!t || !o.config.showSubTrain) return null;
        const endsAt = t.lastAt + o.config.subTrainSec * 1000;
        if (endsAt <= now() || t.count < o.config.subTrainMin) return null;
        return { count: t.count, endsAt: new Date(endsAt).toISOString(), last: t.last };
    }
    function bumpTrain(o, ev, inc) {
        const t = trains.get(o.id);
        const fresh = !t || now() - t.lastAt > o.config.subTrainSec * 1000;
        const next = { count: (fresh ? 0 : t.count) + inc, lastAt: now(), last: ev.user?.name ? String(ev.user.name).slice(0, 40) : (t?.last || null) };
        trains.set(o.id, next);
        return trainView(o);
    }

    // tip jar: a running total per overlay, kept like a goal's progress
    async function jarsFor(profileId) {
        const hit = jars.get(profileId);
        if (hit && now() - hit.at < L.goalCacheMs) return hit.list;
        const pending = new Map((hit?.list || []).filter((g) => goalWrites.has(g.id)).map((g) => [g.id, g.total]));
        const list = (await ostore.list(profileId)).filter((o) => o.type === 'tipjar')
            .map((o) => ({ id: o.id, config: o.config, total: pending.has(o.id) ? pending.get(o.id) : Number(o.state?.total) || 0 }));
        jars.set(profileId, { at: now(), list });
        return list;
    }
    const jarView = (o, total) => ({ total: Math.round(total * 100) / 100, target: o.config.target, title: o.config.title, label: money(total, null, o.config.symbol), targetLabel: money(o.config.target, null, o.config.symbol) });
    function persistState(profileId, id, state) {
        if (goalWrites.has(id)) clearTimeout(goalWrites.get(id));
        const t = setTimeout(() => {
            goalWrites.delete(id);
            ostore.setState(profileId, id, { ...state, updatedAt: new Date(now()).toISOString() }).catch((err) => log('warn', 'state write failed', { error: err?.message }));
        }, L.goalWriteMs);
        t.unref?.();
        goalWrites.set(id, t);
    }
    async function addToJar(profileId, j, amount, ev) {
        j.total = Math.max(0, Math.round((j.total + amount) * 100) / 100);
        persistState(profileId, j.id, { total: j.total });
        const e = entries.get(j.id);
        if (!e) return;
        e.overlay = { ...e.overlay, state: { ...(e.overlay.state || {}), total: j.total } };
        const add = amount > 0 ? { amount, label: money(amount, null, e.overlay.config.symbol), name: ev?.user?.name ? String(ev.user.name).slice(0, 40) : null } : null;
        sendAll(e, 'tipjar', { ...jarView(e.overlay, j.total), add });
    }
    async function resetJar(profileId, overlayId) {
        const j = (await jarsFor(Number(profileId))).find((x) => x.id === Number(overlayId));
        if (!j) return { ok: false, error: 'that tip jar no longer exists' };
        j.total = 0;
        await addToJar(Number(profileId), j, 0, null);
        return { ok: true, total: 0 };
    }

    // credits: this stream's supporters from the event log, and moderators seen in chat
    async function creditsFor(o) {
        const pid = o.profileId;
        const start = await ostore.lastStreamStart(pid, new Date(now() - L.creditsLookbackMs)).catch(() => null);
        const since = start || new Date(now() - L.creditsFallbackMs);
        const rows = await ostore.eventsSince(pid, since, ['follow', 'sub', 'resub', 'gift_sub', 'membership', 'raid', 'cheer', 'bits.used', 'tip', 'kicks.gifted', 'charity']).catch(() => []);
        const modNames = [...(mods.get(pid)?.values() || [])];
        try { for (const n of await ostore.moderatorsSince?.(pid, since) || []) if (!modNames.some((m) => m.toLowerCase() === n.toLowerCase())) modNames.push(n); } catch { /* chat may not be kept */ }
        return creditsFrom(rows, modNames, o.config.sections);
    }

    // polls and predictions (Twitch's own, and CertiFried chat polls from core/stream-bot/control/chat-polls.js)
    function pollState(profileId) {
        const p = polls.get(profileId) || {};
        return { twitch: p.twitch || null, prediction: p.prediction || null, chat: p.chat || null };
    }
    function notePoll(pid, ev) {
        const p = polls.get(pid) || {};
        if (ev.type.startsWith('prediction.')) p.prediction = predictionView(ev);
        else if (ev.metadata?.chat) {
            p.chat = chatPollView(ev, chatEnds.get(ev.metadata.id) || null);
            if (ev.type === 'poll.end') chatEnds.delete(ev.metadata.id);
        } else p.twitch = twitchPollView(ev);
        polls.set(pid, p);
    }
    const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
    async function chatPoll(profileId, { action, title, options, durationSec } = {}) {
        const pid = Number(profileId);
        const cp = chatPolls();
        if (!cp) return { ok: false, error: 'Chat polls start after the next CertiFried restart.' };
        if (action === 'end') {
            const r = await cp.end(pid, 'completed');
            return r.ok ? { ok: true } : { ok: false, error: 'No chat poll is running.' };
        }
        const t = clean(title, L.pollTitle);
        const opts = (Array.isArray(options) ? options : String(options ?? '').split(/\r?\n/)).map((x) => clean(x, L.pollOption)).filter(Boolean);
        if (!t) return { ok: false, error: 'Give the poll a question.' };
        if (opts.length < 2 || opts.length > L.pollOptions) return { ok: false, error: `A chat poll needs 2 to ${L.pollOptions} answers, one per line.` };
        const secs = Math.min(L.pollSec[1], Math.max(L.pollSec[0], Math.round(Number(durationSec) || 60)));
        const r = await cp.start(pid, { title: t, choices: opts, seconds: secs, platforms: ['twitch', 'kick', 'youtube'] });
        if (!r.ok) return { ok: false, error: String(r.error || 'The chat poll did not start.').replace(/^./, (c) => c.toUpperCase()) + (/\.$/.test(r.error || '') ? '' : '.') };
        chatEnds.set(r.id, now() + secs * 1000);
        if (chatEnds.size > 200) chatEnds.delete(chatEnds.keys().next().value);
        const p = polls.get(pid);
        if (p?.chat?.id === r.id && p.chat.status === 'active') p.chat.endsAt = new Date(now() + secs * 1000).toISOString();
        pushPolls(pid);
        return { ok: true, id: r.id };
    }
    function pushPolls(profileId) {
        for (const e of forProfile(profileId)) if (e.overlay.type === 'poll') sendAll(e, 'poll', pollState(profileId));
    }

    // stream labels
    async function labelValues(o) {
        const pid = o.profileId;
        const scope = o.config?.topCheerScope || 'stream';
        const hit = labelCache.get(pid);
        if (hit && hit.scope === scope && now() - hit.at < L.labelsCacheMs) return pick(hit.values, o);
        const start = scope === 'stream' ? (await ostore.lastStreamStart(pid, new Date(now() - L.creditsLookbackMs)).catch(() => null)) || new Date(now() - L.creditsFallbackMs) : null;
        const [f, s, t, c] = await Promise.all([
            ostore.latestEvent(pid, ['follow']).catch(() => null),
            ostore.latestEvent(pid, ['sub', 'resub', 'gift_sub', 'membership'], { where: (e) => !(e.type === 'sub' && e.metadata?.isGift) && !(e.type === 'membership' && (e.platform !== 'youtube' || e.metadata?.kind === 'gift')) }).catch(() => null),
            ostore.latestEvent(pid, ['tip'], { where: (e) => e.metadata?.kind !== 'jewels' }).catch(() => null),
            ostore.biggestEvent(pid, 'cheer', start).catch(() => null),
        ]);
        const values = { latest_follower: labelLine('latest_follower', f), latest_sub: labelLine('latest_sub', s), latest_tip: labelLine('latest_tip', t), top_cheer: labelLine('top_cheer', c) };
        labelCache.set(pid, { at: now(), values, scope });
        return pick(values, o);
    }
    function pick(values, o) {
        const items = o.config?.items || LABEL_KEYS;
        return Object.fromEntries(LABEL_KEYS.filter((k) => items.includes(k)).map((k) => [k, values[k] || null]));
    }
    async function labelText(o, key) {
        if (!LABEL_KEYS.includes(key)) return null;
        const v = await labelValues({ ...o, config: { ...o.config, items: LABEL_KEYS } });
        return labelTextOf(v[key], o.config?.empty || '');
    }

    // viewer count
    async function countsFor(profileId) {
        if (!viewerCounts) return { live: false, total: 0, platforms: {} };
        try { return await viewerCounts(profileId); } catch { return { live: false, total: 0, platforms: {} }; }
    }

    // heart rate (Studio 0.2.14): kept in memory by core/stream-bot/heart, never stored
    const NO_HEART = Object.freeze({ bpm: null, at: null, live: false, source: null, min: null, max: null, avg: null, count: 0, battery: null, history: [] });
    function heartOf(profileId) {
        if (!heartView) return NO_HEART;
        try { return heartView(profileId) || NO_HEART; } catch { return NO_HEART; }
    }
    function onHeart(profileId, view) {
        let n = 0;
        for (const e of forProfile(profileId)) if (e.overlay.type === 'heartrate') n += sendAll(e, 'heart', { heart: view });
        return n;
    }

    // the Test button of a widget: invented frames to its open pages, nothing stored or counted
    async function testWidget(profileId, overlayId) {
        const e = entries.get(Number(overlayId));
        if (!e || e.overlay.profileId !== Number(profileId)) return { sent: 0 };
        let n = 0;
        for (const [name, data] of sampleFrames(e.overlay.type, e.overlay.config, now())) n = Math.max(n, sendAll(e, name, data));
        return { sent: n };
    }
    /** The kinds of a scene screen's media ({ [id]: 'image' | 'video' }), so the page knows what element to draw. */
    async function sceneMedia(o) {
        const out = {};
        for (const id of [o.config?.background, o.config?.inset?.media].filter(Boolean)) {
            const m = media ? await media.get(o.profileId, id).catch(() => null) : null;
            if (m) out[m.id] = m.kind;
        }
        return out;
    }
    const goalView = (o, current) => ({ title: o.config.title, current: Math.round(current * 100) / 100, target: o.config.target, metric: o.config.metric });
    async function counterValue(o) {
        const v = await store.variableStore.get(o.profileId, 'server', o.config.key).catch(() => null);
        return v == null ? '0' : String(v).slice(0, 60);
    }
    function nowCard(o) {
        let np = null;
        try { np = nowPlaying(o.profileId); } catch { np = null; }
        if (!np?.item) return null;
        const it = np.item;
        return {
            title: String(it.title || '').slice(0, 200), artist: String(it.artist || '').slice(0, 200),
            thumbnail: o.config.showArt && /^https:\/\//.test(String(it.thumbnail || '')) ? String(it.thumbnail) : null,
            requester: o.config.showRequester ? (np.requester || null) : null, durationMs: it.durationMs || null, positionMs: np.positionMs || 0, paused: !!np.paused,
        };
    }
    const nowSig = (c) => (c ? `${c.title}|${c.artist}|${c.requester}|${c.paused}` : '');

    // ── connections ──
    async function attach(overlay, client, { preview = false } = {}) {
        let e = entries.get(overlay.id);
        if (!e) { e = { overlay, clients: new Set() }; entries.set(overlay.id, e); }
        e.overlay = overlay;
        client.preview = !!preview;
        if (e.clients.size >= L.clientsPerOverlay) {
            const oldest = e.clients.values().next().value;
            e.clients.delete(oldest);
            try { oldest.close(); } catch { /* gone */ }
        }
        e.clients.add(client);
        client.send('hello', { ...pageConfig(overlay), state: await initialState(overlay), preview: !!preview });
        if (!preview) ostore.touch(overlay.id).catch(() => {});
        if (overlay.type === 'nowplaying') lastNow.set(overlay.id, nowSig(nowCard(overlay)));
        // Queued actions go to a page open in OBS; a dashboard preview does not take them off the queue.
        if (!preview) flushQueued(e, client).catch((err) => log('warn', 'queue flush failed', { error: err?.message }));
        return () => {
            e.clients.delete(client);
            if (!e.clients.size && entries.get(overlay.id) === e) entries.delete(overlay.id);
        };
    }

    function isConnected(profileId, capability = null) {
        const types = capability ? new Set(typesFor(capability)) : null;
        return forProfile(profileId).some((e) => live(e) > 0 && (!types || types.has(e.overlay.type)));
    }

    // ── dispatch (overlay.alert, overlay.text, overlay.media) ──
    /** Which open overlays carry out an action: the chosen one, else Text and media overlays, else the alert box. */
    function targetsFor(profileId, capability, params) {
        const types = new Set(typesFor(capability || 'show'));
        const open = forProfile(profileId).filter((e) => types.has(e.overlay.type));
        const chosen = params?.overlay ? Number(params.overlay) : null;
        if (chosen) return open.filter((e) => e.overlay.id === chosen);
        if (capability === 'alert') return open.filter((e) => e.overlay.type === 'alerts');
        const canvas = open.filter((e) => e.overlay.type === 'canvas');
        return canvas.length ? canvas : open.filter((e) => e.overlay.type === 'alerts');
    }

    async function frameFor(profileId, d) {
        const p = { ...(d.params || {}) };
        if (d.actionType === 'overlay.media') {
            const want = String(p.media || '').trim().toLowerCase();
            const list = media ? await media.list(profileId) : [];
            const m = list.find((x) => x.id === want) || list.find((x) => x.name.toLowerCase() === want);
            if (!m) return { error: `no image or video called "${String(p.media).slice(0, 60)}" in your media` };
            p.media = { kind: m.kind, src: `media/${m.id}` };
        }
        if (d.actionType === 'overlay.alert') {
            p.title = String(p.title || '').slice(0, 300);
            p.message = String(p.message || '').slice(0, 500);
        }
        if (d.actionType === 'overlay.text') p.text = String(p.text || '').slice(0, 500);
        delete p.overlay;
        return { frame: { id: d.id, action: d.actionType, params: p } };
    }

    async function dispatch(d) {
        const id = `d_${crypto.randomBytes(12).toString('hex')}`;
        const ttl = Math.max(0, Number(d.queueSeconds) || 0) * 1000;
        const targets = targetsFor(d.profileId, d.capability, d.params).filter((e) => e.clients.size);
        const record = { id, profileId: d.profileId, runId: d.runId ?? null, target: 'overlay', capability: d.capability || null, actionType: d.actionType, params: d.params || {} };
        // Only a page open in OBS counts; a dashboard preview also shows it, but alone it does not take it off the queue.
        if (!targets.some((e) => live(e) > 0)) {
            if (!ttl) { await store.insertDispatch({ ...record, status: 'expired', expiresAt: new Date(now()) }); return { id, status: 'none', devices: 0 }; }
            await store.insertDispatch({ ...record, status: 'queued', expiresAt: new Date(now() + ttl) });
            return { id, status: 'queued', devices: 0 };
        }
        const built = await frameFor(d.profileId, { ...d, id });
        if (built.error) {
            await store.insertDispatch({ ...record, status: 'failed', expiresAt: new Date(now()) });
            await store.updateDispatch(id, { status: 'failed', error: built.error }).catch(() => {});
            return { id, status: 'none', devices: 0, error: built.error };
        }
        await store.insertDispatch({ ...record, status: 'sent', expiresAt: new Date(now() + Math.max(ttl, 30_000)) });
        let n = 0;
        for (const e of targets) n += sendAll(e, 'action', built.frame) ? 1 : 0;
        await store.updateDispatch(id, { status: 'sent', attempts: 1, sentAt: new Date(now()) }).catch(() => {});
        return { id, status: n ? 'sent' : 'queued', devices: n };
    }

    async function flushQueued(e, client) {
        const rows = await store.queuedDispatches(e.overlay.profileId, 'overlay', new Date(now()));
        const types = overlayType(e.overlay.type)?.capabilities || [];
        for (const r of rows) {
            if (r.capability && !types.includes(r.capability)) continue;
            const t = targetsFor(e.overlay.profileId, r.capability, r.params);
            if (!t.includes(e)) continue;
            const built = await frameFor(e.overlay.profileId, { ...r, id: r.id });
            if (built.error) { await store.updateDispatch(r.id, { status: 'failed', error: built.error }).catch(() => {}); continue; }
            client.send('action', built.frame);
            await store.updateDispatch(r.id, { status: 'sent', attempts: (r.attempts || 0) + 1, sentAt: new Date(now()) }).catch(() => {});
        }
    }

    async function report(overlay, body = {}) {
        const id = String(body.dispatchId || '');
        if (!/^d_[0-9a-f]{24}$/.test(id)) return 'ignored';
        const row = await store.getDispatch(id).catch(() => null);
        if (!row || row.profileId !== overlay.profileId || row.target !== 'overlay' || !['sent', 'queued'].includes(row.status)) return 'ignored';
        await store.updateDispatch(id, body.ok === false
            ? { status: 'failed', ackedAt: new Date(now()), error: String(body.error || 'the overlay could not show it').slice(0, 200) }
            : { status: 'acked', ackedAt: new Date(now()), result: { overlayId: overlay.id }, error: null });
        return 'ok';
    }

    // ── alerts ──
    async function renderText(template, ev, profileId) {
        if (!template) return '';
        try {
            const out = render ? await render(String(template), { ev, profileId, automationId: 0 }) : String(template);
            return String(out || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        } catch (err) {
            log('debug', 'alert text failed', { error: err?.message });
            return String(template).slice(0, 300);
        }
    }
    /** The viewer's own words, as shown under an alert: no cheermotes (Cheer100), no control characters, 300 at most. */
    function viewerMessage(ev) {
        let m = String(ev?.message || '');
        if (ev?.type === 'cheer' || ev?.type === 'bits.used') m = m.replace(/(^|\s)[A-Za-z]+\d+(?=\s|$)/g, ' ');
        return m.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    }
    function speakable(text) {
        return String(text || '').replace(/https?:\/\/\S+/gi, 'a link').replace(/<[^<>]{0,40}>/g, ' ').replace(/[<>{}[\]\\|`~^]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.ttsChars);
    }

    function queueTts(o, text) {
        if (!synthesize || !text) return null;
        const t = now();
        for (const [k, v] of tts) if (t - v.at > L.ttsTtlMs) tts.delete(k);
        const mine = [...tts.values()].filter((v) => v.overlayId === o.id && !v.buffer).length;
        if (mine >= L.ttsPending) return null;
        while (tts.size >= L.ttsCache) tts.delete(tts.keys().next().value);
        const id = crypto.randomBytes(9).toString('base64url');
        const item = { overlayId: o.id, at: t, buffer: null, promise: null };
        // the profile's owner: a voice trained from a real person reads alert messages only in its owner's profile (opt-in)
        item.promise = Promise.resolve().then(async () => synthesize(text, o.config.general.ttsVoice || null,
            { profileOwnerId: (await store?.getProfile?.(o.profileId).catch(() => null))?.ownerDiscordId || null })).then((buf) => {
            item.buffer = Buffer.isBuffer(buf) && buf.length ? buf : null;
            return item.buffer;
        }).catch((err) => { log('warn', 'read aloud failed', { error: err?.message }); return null; });
        tts.set(id, item);
        return id;
    }

    async function ttsAudio(overlay, id) {
        const item = tts.get(String(id || ''));
        if (!item || item.overlayId !== overlay.id) return null;
        if (item.buffer) return item.buffer;
        let timer;
        const r = await Promise.race([item.promise, new Promise((res) => { timer = setTimeout(() => res(null), L.ttsWaitMs); timer.unref?.(); })]);
        clearTimeout(timer);
        return r;
    }

    async function buildAlert(o, key, ev, { test = false } = {}) {
        const a = o.config.alerts?.[key];
        if (!a) return null;
        const amount = alertAmount(key, ev);
        const v = pickVariation(a, amount);
        const g = o.config.general;
        const out = {
            id: crypto.randomBytes(6).toString('hex'), key, label: ALERT_KINDS[key].label, test,
            layout: v.layout, animation: v.animation, durationMs: Number(v.durationMs) || a.durationMs,
            mediaScale: Number(a.mediaScale) || 100, textDelayMs: Number(a.textDelayMs) || 0,
            title: await renderText(v.message, ev, o.profileId), name: ev.user?.name ? String(ev.user.name).slice(0, 60) : null,
            detail: v.detail ? await renderText(v.detail, ev, o.profileId) : '', message: v.showMessage ? viewerMessage(ev) : '',
            media: null, sound: null, tts: null, variation: v.variation,
        };
        if (v.media && media) {
            const m = await media.get(o.profileId, v.media).catch(() => null);
            if (m) out.media = { kind: m.kind, src: `media/${m.id}` };
        }
        if (v.sound && sounds) {
            const s = await sounds.get(o.profileId, v.sound).catch(() => null);
            if (s) out.sound = { src: `sound/${s.id}`, volume: a.volume };
        }
        if (a.tts && amount >= (Number(a.ttsMin) || 0)) {
            const words = speakable(viewerMessage(ev));
            const ttsId = words ? queueTts(o, words) : null;
            if (ttsId) out.tts = { src: `tts/${ttsId}`, volume: g.ttsVolume };
        }
        return out;
    }

    async function alertTo(e, key, ev, opts) {
        const alert = await buildAlert(e.overlay, key, ev, opts);
        return alert ? sendAll(e, 'alert', alert) : 0;
    }

    async function testAlert(profileId, overlayId, key, amount = null) {
        const e = entries.get(Number(overlayId));
        if (!e || e.overlay.profileId !== Number(profileId) || e.overlay.type !== 'alerts' || !ALERT_KINDS[key]) return { sent: 0 };
        const ev = sampleFor(key, amount == null || amount === '' || !Number.isFinite(Number(amount)) ? null : Number(amount));
        return { sent: await alertTo(e, key, ev, { test: true }) };
    }

    // ── goals ──
    async function goalsFor(profileId) {
        const hit = goals.get(profileId);
        if (hit && now() - hit.at < L.goalCacheMs) return hit.list;
        // A progress change still waiting to be written is newer than the stored one: keep it.
        const pending = new Map((hit?.list || []).filter((g) => goalWrites.has(g.id)).map((g) => [g.id, g.current]));
        const list = (await ostore.list(profileId)).filter((o) => o.type === 'goal')
            .map((o) => ({ id: o.id, config: o.config, current: pending.has(o.id) ? pending.get(o.id) : Number(o.state?.current) || 0 }));
        goals.set(profileId, { at: now(), list });
        return list;
    }
    function persistGoal(profileId, g) {
        if (goalWrites.has(g.id)) return;
        const t = setTimeout(() => {
            goalWrites.delete(g.id);
            ostore.setState(profileId, g.id, { current: g.current, updatedAt: new Date(now()).toISOString() }).catch((err) => log('warn', 'goal write failed', { error: err?.message }));
        }, L.goalWriteMs);
        t.unref?.();
        goalWrites.set(g.id, t);
    }
    function pushGoal(g) {
        const e = entries.get(g.id);
        if (e) sendAll(e, 'goal', goalView(e.overlay, g.current));
    }
    async function changeGoal(profileId, overlayId, mode, n) {
        const list = await goalsFor(Number(profileId));
        const g = list.find((x) => x.id === Number(overlayId));
        if (!g) return { ok: false, error: 'that goal overlay no longer exists' };
        g.current = Math.max(0, Math.min(1e12, mode === 'set' ? n : g.current + n));
        g.current = Math.round(g.current * 100) / 100;
        const e = entries.get(g.id);
        if (e) e.overlay = { ...e.overlay, state: { ...(e.overlay.state || {}), current: g.current } };
        persistGoal(Number(profileId), g);
        pushGoal(g);
        return { ok: true, current: g.current, target: g.config.target };
    }

    // ── the live feed ──
    async function onEvent(profileId, ev) {
        if (!ev || typeof ev !== 'object') return;
        const pid = Number(profileId);
        if (GOAL_TYPES.has(ev.type) && !ev.test) {
            try {
                for (const g of await goalsFor(pid)) {
                    if (g.config.metric === 'manual') continue;
                    const inc = goalIncrement(g.config.metric, ev);
                    if (inc) await changeGoal(pid, g.id, 'add', inc);
                }
            } catch (err) { log('warn', 'goal update failed', { error: err?.message }); }
        }
        // Widget state that lives whether or not a page is open: tip jars, the hype train, polls, labels, moderators.
        if (!ev.test) {
            try {
                if (JAR_TYPES.has(ev.type)) for (const j of await jarsFor(pid)) { const amt = jarAmount(j.config, ev); if (amt) await addToJar(pid, j, amt, ev); }
                if (ev.type === 'stream.online') {
                    for (const j of await jarsFor(pid)) if (j.config.resetOnLive && j.total) { j.total = 0; await addToJar(pid, j, 0, null); }
                    mods.delete(pid);
                }
                if (ev.type.startsWith('hype_train.')) hype.set(pid, hypeView(ev));
                if (ev.type.startsWith('poll.') || ev.type.startsWith('prediction.')) notePoll(pid, ev);
                if (LABEL_TYPES.has(ev.type)) labelCache.delete(pid);
            } catch (err) { log('warn', 'widget update failed', { type: ev.type, error: err?.message }); }
        }
        const open = forProfile(pid);
        if (!open.length) return;
        for (const e of open) {
            const o = e.overlay;
            try {
                switch (o.type) {
                    case 'alerts': {
                        const key = alertKeyFor(ev, o.config.general);
                        if (key && o.config.alerts[key]?.enabled) await alertTo(e, key, ev);
                        break;
                    }
                    case 'events':
                        if (!ev.test && o.config.types.includes(ev.type)) sendAll(e, 'event', eventItem(ev));
                        break;
                    case 'counter':
                        if (ev.type === 'variable.changed' && ev.metadata?.scope === 'channel' && String(ev.metadata.key) === o.config.key) {
                            sendAll(e, 'counter', { value: String(ev.metadata.value ?? '').slice(0, 60) });
                        }
                        break;
                    case 'nowplaying':
                        if (ev.type === 'music.song_changed') { const c = nowCard(o); lastNow.set(o.id, nowSig(c)); sendAll(e, 'nowplaying', { now: c }); }
                        break;
                    case 'train': {
                        if (ev.test) break;
                        const inc = o.config.showSubTrain ? trainIncrement(ev) : 0;
                        if (inc) { const sub = bumpTrain(o, ev, inc); if (sub) sendAll(e, 'train', { sub }); }
                        if (o.config.showHype && ev.type.startsWith('hype_train.')) sendAll(e, 'train', { hype: hype.get(pid) });
                        break;
                    }
                    case 'poll':
                        if (!ev.test && (ev.type.startsWith('poll.') || ev.type.startsWith('prediction.'))) sendAll(e, 'poll', pollState(pid));
                        break;
                    case 'labels':
                        if (!ev.test && LABEL_TYPES.has(ev.type)) sendAll(e, 'labels', { values: await labelValues(o) });
                        break;
                    default: break;
                }
            } catch (err) { log('warn', 'overlay event failed', { overlayId: o.id, type: ev.type, error: err?.message }); }
        }
    }

    // ── chat ──
    async function profilesFor(platform, channelId) {
        const k = `${platform}:${channelId}`;
        const hit = channelCache.get(k);
        if (hit && now() - hit.at < L.channelCacheMs) return hit.profiles;
        const profiles = (await store.profilesForChannel(platform, channelId)).map((p) => p.profileId);
        if (channelCache.size > 5000) channelCache.clear();
        channelCache.set(k, { at: now(), profiles });
        return profiles;
    }
    const CHAT_USERS = new Set(['chat', 'emotewall']);
    const anyChat = () => [...entries.values()].some((e) => CHAT_USERS.has(e.overlay.type) && e.clients.size);
    const anyModWatch = () => [...entries.values()].some((e) => e.overlay.type === 'credits');

    async function onChat(platform, r) {
        if (!r || !(anyChat() || (r.kind === 'message' && anyModWatch()))) return 0;
        let n = 0;
        for (const pid of await profilesFor(platform, r.channelId)) {
            if (r.kind === 'message') {
                const m0 = r.message;
                if (m0.badges?.some((b) => b.role === 'moderator' || b.role === 'broadcaster') && m0.name) {
                    const seen = mods.get(pid) || new Map();
                    if (seen.size < L.modsSeen && !m0.badges.some((b) => b.role === 'broadcaster')) seen.set(String(m0.login || m0.name).toLowerCase(), String(m0.name).slice(0, 40));
                    mods.set(pid, seen);
                }
            }
            const open = forProfile(pid).filter((e) => CHAT_USERS.has(e.overlay.type));
            if (!open.length) continue;
            let ring = chatRing.get(pid) || [];
            if (r.kind === 'message') {
                // 7TV, BTTV and FFZ emotes of the profile's Twitch channel, read on this server (emotes.js), on every platform's lines.
                let message = r.message;
                if (emotes && open.some((e) => e.overlay.config.thirdParty !== false)) {
                    try { message = { ...message, parts: splitEmotes(message.parts, await emotes.forChannel(await twitchIdOf(pid))) }; } catch { /* plain text then */ }
                }
                ring.push(message);
                if (ring.length > L.chatRing) ring = ring.slice(-L.chatRing);
                for (const e of open) {
                    const c = e.overlay.config;
                    if (e.overlay.type === 'chat') {
                        if (!visibleFor(message, c)) continue;
                        sendAll(e, 'chat', c.thirdParty === false ? r.message : message);
                        n++;
                    } else if (e.overlay.type === 'emotewall' && c.platforms.includes(message.platform)) {
                        const list = message.parts.filter((p) => p.t === 'emote' && p.src && (c.thirdParty || !THIRD_PARTY.test(p.src))).slice(0, c.perMessage).map((p) => p.src);
                        if (list.length) { sendAll(e, 'emotes', { list }); n++; }
                    }
                }
            } else if (r.kind === 'delete') {
                ring = ring.filter((m) => m.id !== r.id);
                for (const e of open) sendAll(e, 'chat_remove', { id: r.id });
            } else if (r.kind === 'clear_user') {
                ring = ring.filter((m) => !(m.platform === r.platform && m.userId === r.userId));
                for (const e of open) sendAll(e, 'chat_remove', { platform: r.platform, userId: r.userId });
            } else if (r.kind === 'clear') {
                ring = ring.filter((m) => m.platform !== platform);
                for (const e of open) sendAll(e, 'chat_remove', { platform, all: true });
            }
            chatRing.set(pid, ring);
        }
        return n;
    }

    // ── settings changed, key regenerated ──
    const staleGoals = (pid) => { for (const m of [goals, jars]) { const hit = m.get(Number(pid)); if (hit) hit.at = 0; } labelCache.delete(Number(pid)); features.delete(Number(pid)); };
    async function invalidate(overlayId, { closeAll = false, profileId = null } = {}) {
        if (profileId) staleGoals(profileId);
        const e = entries.get(Number(overlayId));
        if (!e) return;
        staleGoals(e.overlay.profileId);
        if (closeAll) {
            for (const c of e.clients) { try { c.send('gone', {}); c.close(); } catch { /* gone */ } }
            entries.delete(Number(overlayId));
            return;
        }
        const fresh = await ostore.get(e.overlay.profileId, e.overlay.id);
        if (!fresh) return invalidate(overlayId, { closeAll: true });
        e.overlay = fresh;
        sendAll(e, 'config', { ...pageConfig(fresh), state: await initialState(fresh) });
    }

    // ── CertiFried Studio ──
    async function onStudioRequest(conn, method) {
        if (method !== 'overlays.list') throw Object.assign(new Error('Unknown method'), { code: 'unknown_method' });
        const list = await ostore.list(conn.profileId);
        const overlays = [];
        for (const o of list) {
            const key = await ostore.keyOf(conn.profileId, o.id);
            if (!key) continue;
            const t = overlayType(o.type);
            overlays.push({ id: o.id, type: o.type, label: t?.label || o.type, name: o.name, sourceName: t?.sourceName || 'CertiFried Overlay', audio: !!t?.audio,
                url: `${base}/stream/bot/overlay/${o.type}/${key}`, width: 1920, height: 1080 });
        }
        return { overlays };
    }

    function status(profileId) {
        const out = {};
        for (const e of forProfile(profileId)) out[e.overlay.id] = { online: live(e), previews: e.clients.size - live(e) };
        return out;
    }

    // ── timers: counters that changed without an event (depth guard), now playing that stopped ──
    let ticker = null;
    let counterAt = 0;
    let viewersAt = 0;
    if (timers) {
        ticker = setInterval(() => {
            const t = now();
            for (const e of entries.values()) {
                if (!e.clients.size) continue;
                if (e.overlay.type === 'nowplaying') {
                    const c = nowCard(e.overlay);
                    const sig = nowSig(c);
                    if (sig !== lastNow.get(e.overlay.id)) { lastNow.set(e.overlay.id, sig); sendAll(e, 'nowplaying', { now: c }); }
                }
            }
            if (t - viewersAt >= L.viewersMs) {
                viewersAt = t;
                const pids = new Set([...entries.values()].filter((e) => e.clients.size && e.overlay.type === 'viewers').map((e) => e.overlay.profileId));
                for (const pid of pids) {
                    countsFor(pid).then((counts) => {
                        for (const e of entries.values()) {
                            if (e.overlay.profileId !== pid || e.overlay.type !== 'viewers' || !e.clients.size) continue;
                            const sig = JSON.stringify(counts);
                            if (sig !== lastViewers.get(e.overlay.id)) { lastViewers.set(e.overlay.id, sig); sendAll(e, 'viewers', { counts }); }
                        }
                    }).catch(() => {});
                }
            }
            if (t - counterAt >= L.counterRefreshMs) {
                counterAt = t;
                for (const e of entries.values()) if (e.clients.size && e.overlay.type === 'counter') counterValue(e.overlay).then((value) => sendAll(e, 'counter', { value })).catch(() => {});
            }
        }, L.nowPlayingMs);
        ticker.unref?.();
    }

    return {
        attach, isConnected, dispatch, report, onEvent, onChat, testAlert, changeGoal, invalidate, onStudioRequest, ttsAudio, status,
        testWidget, chatPoll, resetJar, labelValues, labelText, pollState, onHeart,
        pageConfig, buildAlert, images,
        close() {
            if (ticker) clearInterval(ticker);
            for (const t of goalWrites.values()) clearTimeout(t);
            goalWrites.clear();
            for (const e of entries.values()) for (const c of e.clients) { try { c.close(); } catch { /* gone */ } }
            entries.clear();
        },
        _state: { entries, chatRing, tts, goals, jars, trains, hype, polls, mods },
    };
}

/** Config a stored overlay row would have after a save (exported for the dashboard's preview of unsaved settings). */
export const effectiveConfig = (type, config) => withDefaults(type, config);

export default { createOverlayService, SERVICE_LIMITS };
