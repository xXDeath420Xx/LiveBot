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
import { overlayType, typesFor, alertKeyFor, alertAmount, pickVariation, sampleFor, goalIncrement, withDefaults, ALERT_KINDS, LIMITS, FONTS } from './config.js';
import { visibleFor } from './chat.js';
import { describeEvent, publicEvent } from '../events.js';
import { TEXT_SIZES, MEDIA_SIZES } from './actions.js';

export const SERVICE_LIMITS = Object.freeze({
    clientsPerOverlay: 6, chatRing: 60, ttsPending: 6, ttsCache: 40, ttsTtlMs: 10 * 60_000, ttsWaitMs: 20_000, channelCacheMs: 60_000,
    goalWriteMs: 2_000, counterRefreshMs: 30_000, nowPlayingMs: 5_000, goalCacheMs: 60_000,
});
const GOAL_TYPES = new Set(['follow', 'sub', 'resub', 'gift_sub', 'cheer', 'bits.used', 'tip']);

export function createOverlayService({
    store, ostore, sounds = null, media = null, render = null, nowPlaying = () => null, synthesize = null, images = null,
    logger = null, now = () => Date.now(), baseUrl = 'https://certifriedmultitool.com', limits = {}, timers = true,
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
                default: return {};
            }
        } catch (err) {
            log('warn', 'initial state failed', { overlayId: o.id, error: err?.message });
            return {};
        }
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
        item.promise = Promise.resolve().then(() => synthesize(text, o.config.general.ttsVoice || null)).then((buf) => {
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
    const anyChat = () => [...entries.values()].some((e) => e.overlay.type === 'chat' && e.clients.size);

    async function onChat(platform, r) {
        if (!r || !anyChat()) return 0;
        let n = 0;
        for (const pid of await profilesFor(platform, r.channelId)) {
            const open = forProfile(pid).filter((e) => e.overlay.type === 'chat');
            if (!open.length) continue;
            let ring = chatRing.get(pid) || [];
            if (r.kind === 'message') {
                ring.push(r.message);
                if (ring.length > L.chatRing) ring = ring.slice(-L.chatRing);
                for (const e of open) if (visibleFor(r.message, e.overlay.config)) { sendAll(e, 'chat', r.message); n++; }
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
    const staleGoals = (pid) => { const hit = goals.get(Number(pid)); if (hit) hit.at = 0; };
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
            if (t - counterAt >= L.counterRefreshMs) {
                counterAt = t;
                for (const e of entries.values()) if (e.clients.size && e.overlay.type === 'counter') counterValue(e.overlay).then((value) => sendAll(e, 'counter', { value })).catch(() => {});
            }
        }, L.nowPlayingMs);
        ticker.unref?.();
    }

    return {
        attach, isConnected, dispatch, report, onEvent, onChat, testAlert, changeGoal, invalidate, onStudioRequest, ttsAudio, status,
        pageConfig, buildAlert, images,
        close() { if (ticker) clearInterval(ticker); for (const t of goalWrites.values()) clearTimeout(t); goalWrites.clear(); for (const e of entries.values()) for (const c of e.clients) { try { c.close(); } catch { /* gone */ } } entries.clear(); },
        _state: { entries, chatRing, tts, goals },
    };
}

/** Config a stored overlay row would have after a save (exported for the dashboard's preview of unsaved settings). */
export const effectiveConfig = (type, config) => withDefaults(type, config);

export default { createOverlayService, SERVICE_LIMITS };
