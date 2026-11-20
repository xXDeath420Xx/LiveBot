/*
 * Stream bot: what CertiFried Studio sends besides acks (Phase 2). realtime.js calls these through hub.use().
 *
 *   sanitiseState(raw)       the app's `state` frame → a capped, plain copy (or null)
 *   createStudioServices({ store, engine, ingest, sounds, logger, now?, runWaitMs? })
 *     .onState(conn, state)              keep it on the connection; persist to settings.studio (throttled)
 *     .onEvent(conn, event)              an OBS event → normalised, stored, live feed, automations
 *     .onRequest(conn, method, params)   'automations.list' | 'automations.run' | 'sounds.list' | 'docks.key' | 'voice.phrases'
 *       automations.list  also says `songRequests`: whether an enabled automation runs a song request command (Studio 0.2.6
 *                         keeps OBS VOD-safe for music only then)
 *                                        → result (throws RequestError)
 *       docks.key       a new OBS dock key for this Studio (core/stream-bot/dock.js); the previous one is revoked. 5 per 10 min.
 *       voice.phrases   the phrases of enabled 'voice.phrase' automations: [{ text, automationId, automationName }]
 *
 *   studioMusicStatus(hub, profileId)   { vodSafe, reason, deviceId } from the newest connected Studio's `music` report
 *                                        (vodSafe false when no Studio is connected or it has not reported yet)
 *
 * Limits per device: 30 OBS events a minute, 10 automation runs in 10 s. State is written to the database
 * when it changed and at most once every 30 s per profile (the newest state wins at the next write).
 *
 * Tested in tests/stream-bot-studio.test.js.
 */
import { normaliseStudio } from './events.js';
import { createDockKeys } from './dock.js';
import { normalisePhrase } from './conditions.js';
import { sanitiseDevices } from './devices/state.js';

export const STATE_LIMITS = Object.freeze({ scenes: 200, perScene: 200, inputs: 500, filterSources: 100, perSource: 50, sounds: 500, name: 200, bytes: 60 * 1024 });
export const STUDIO_LIMITS = Object.freeze({ eventsPerMinute: 30, runsPer10s: 10, stateWriteMs: 30_000, runWaitMs: 10_000, dockKeysPer10min: 5, voicePhrases: 500 });

export class RequestError extends Error {
    constructor(code, message) { super(message || code); this.code = code; }
}

const name = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\u0000-\u001f]/g, '').slice(0, STATE_LIMITS.name) : '');
const names = (list, max) => [...new Set((Array.isArray(list) ? list : []).map(name).filter(Boolean))].slice(0, max);

const track = (v) => (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 6 ? Number(v) : null);

/** Studio's VOD-safe music report: which OBS audio track the VOD records and whether music is kept off it. */
export function sanitiseMusic(m) {
    if (!m || typeof m !== 'object') return null;
    const at = Number(m.checkedAt);
    return {
        vodSafe: m.vodSafe === true,
        reason: m.reason == null ? null : String(m.reason).replace(/[\u0000-\u001f]/g, ' ').slice(0, 200) || null,
        vodTrack: track(m.vodTrack),
        liveTrack: track(m.liveTrack),
        sourceReady: m.sourceReady === true,
        live: m.live === true,
        checkedAt: Number.isFinite(at) && at > 0 ? Math.round(at) : null,
    };
}

/** The newest connected Studio's music report: { vodSafe, reason, deviceId }. */
export function studioMusicStatus(hub, profileId) {
    const list = (hub?.connected?.(profileId) || []).filter((c) => c.kind === 'studio').sort((a, b) => new Date(b.connectedAt) - new Date(a.connectedAt));
    const c = list[0];
    if (!c) return { vodSafe: false, reason: 'CertiFried Studio is not connected.', deviceId: null };
    const m = c.state?.music;
    if (!m) return { vodSafe: false, reason: 'CertiFried Studio has not checked the VOD audio track yet.', deviceId: c.deviceId };
    return { vodSafe: !!m.vodSafe, reason: m.vodSafe ? null : (m.reason || 'Music is not VOD-safe yet.'), deviceId: c.deviceId };
}

/** A Studio state report, cleaned and capped. Returns null when it is not an object. */
export function sanitiseState(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw.obs && typeof raw.obs === 'object' ? raw.obs : {};
    const scenes = names(o.scenes, STATE_LIMITS.scenes);
    const sources = {};
    if (o.sources && typeof o.sources === 'object') {
        for (const scene of scenes) {
            const items = names(o.sources[scene], STATE_LIMITS.perScene);
            if (items.length) sources[scene] = items;
        }
    }
    const inputs = [];
    const seen = new Set();
    for (const i of Array.isArray(o.inputs) ? o.inputs : []) {
        const n = name(i?.name);
        if (!n || seen.has(n)) continue;
        seen.add(n);
        inputs.push({ name: n, kind: String(i?.kind ?? '').replace(/[^a-z0-9_]/gi, '').slice(0, 60) });
        if (inputs.length >= STATE_LIMITS.inputs) break;
    }
    const filters = {};
    if (o.filters && typeof o.filters === 'object') {
        for (const key of Object.keys(o.filters).slice(0, STATE_LIMITS.filterSources)) {
            const k = name(key);
            const list = names(o.filters[key], STATE_LIMITS.perSource);
            if (k && list.length) filters[k] = list;
        }
    }
    const state = {
        obs: {
            connected: !!o.connected,
            version: o.version ? name(o.version).slice(0, 40) : null,
            studioMode: !!o.studioMode,
            currentScene: o.currentScene ? name(o.currentScene) : null,
            scenes, sources, inputs, filters,
        },
        sounds: names(raw.sounds, STATE_LIMITS.sounds),
        music: sanitiseMusic(raw.music),
        // Phase 5: lights, Voicemeeter and the Stream Deck bridge on the PC (no network addresses; core/stream-bot/devices/state.js).
        devices: sanitiseDevices(raw.devices),
    };
    // A last guard on size: give up the least useful parts first until it fits.
    const cuts = [
        () => { state.obs.filters = {}; },
        () => { for (const l of state.devices?.lights || []) { l.caps.scenes = []; l.caps.effects = []; } },
        () => { state.obs.sources = {}; },
        () => { state.sounds = state.sounds.slice(0, 100); },
        () => { state.obs.inputs = state.obs.inputs.slice(0, 100); },
        () => { state.obs.scenes = state.obs.scenes.slice(0, 50); state.sounds = state.sounds.slice(0, 20); },
        () => { state.obs.inputs = []; state.sounds = []; },
    ];
    for (const cut of cuts) {
        if (Buffer.byteLength(JSON.stringify(state)) <= STATE_LIMITS.bytes) break;
        cut();
    }
    return state;
}

const sameState = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Whether a step list (nested random / if branches included) has a step of this type. */
export function usesStep(list, type, depth = 0) {
    if (!Array.isArray(list) || depth > 5) return false;
    return list.some((s) => s?.type === type || usesStep(s?.then, type, depth + 1) || usesStep(s?.else, type, depth + 1)
        || (Array.isArray(s?.branches) && s.branches.some((b) => usesStep(b?.actions, type, depth + 1))));
}

export function createStudioServices({ store, engine, ingest, sounds = null, logger = null, now = () => Date.now(), limits = {}, dockKeys = null } = {}) {
    const docks = dockKeys || createDockKeys({ store });
    const L = { ...STUDIO_LIMITS, ...limits };
    const log = (level, msg, meta) => { try { logger?.[level]?.(`[StreamBotStudio] ${msg}`, meta); } catch { /* ignore */ } };
    const written = new Map();   // profileId -> { at, json, timer }

    function persist(profileId, record) {
        const w = written.get(profileId) || { at: 0, json: null, timer: null };
        written.set(profileId, w);
        const body = JSON.stringify({ obs: record.obs, sounds: record.sounds, music: record.music, devices: record.devices, deviceId: record.deviceId });
        w.pending = record;
        if (!w.timer && body === w.json) return;
        const write = () => {
            w.timer = null;
            w.at = now();
            w.json = JSON.stringify({ obs: w.pending.obs, sounds: w.pending.sounds, music: w.pending.music, devices: w.pending.devices, deviceId: w.pending.deviceId });
            const rec = w.pending;
            store.setSettingsKey(profileId, 'studio', rec).catch((e) => log('warn', 'state write failed', { error: e.message }));
        };
        const wait = w.at + L.stateWriteMs - now();
        if (wait <= 0) write();
        else if (!w.timer) { w.timer = setTimeout(write, wait); w.timer.unref?.(); }
    }

    function within(conn, key, max, windowMs) {
        const t = now();
        conn[key] = (conn[key] || []).filter((x) => t - x < windowMs);
        if (conn[key].length >= max) return false;
        conn[key].push(t);
        return true;
    }

    async function profileOf(conn) {
        const p = await store.getProfile(conn.profileId);
        if (!p || !p.enabled) throw new RequestError('profile_off', 'The stream bot is turned off for this profile');
        return p;
    }

    const lastConnect = new Map();   // deviceId -> ms; a reconnect within a minute (a network blip) is not a new event
    return {
        /** Studio connected (after welcome): raise studio.connected. Overlays do not count. */
        async onConnect(conn) {
            if (conn?.kind !== 'studio' || !ingest?.internal) return false;
            if (now() - (lastConnect.get(conn.deviceId) || 0) < 60_000) return false;
            lastConnect.set(conn.deviceId, now());
            if (lastConnect.size > 5000) lastConnect.clear();
            const version = String(conn.client || '').match(/^certifried-studio\s+(\S+)/)?.[1] || null;
            await ingest.internal(conn.profileId, {
                platform: 'studio', type: 'studio.connected', channelId: null, user: null, amount: null, currency: null, message: null,
                metadata: { device: conn.name ? String(conn.name).slice(0, 100) : null, version: version ? version.slice(0, 20) : null },
                raw: null, occurredAt: new Date(now()), dedupeKey: null,
            });
            return true;
        },
        onState(conn, raw) {
            const state = sanitiseState(raw);
            if (!state) return false;
            if (!sameState(state, conn.state)) {
                conn.state = state;
                persist(conn.profileId, { ...state, deviceId: conn.deviceId, deviceName: conn.name || null, reportedAt: new Date(now()).toISOString() });
            }
            return true;
        },

        /** Returns 'ok' | 'unknown' | 'rate'. */
        async onEvent(conn, raw) {
            const ev = normaliseStudio(raw);
            if (!ev) return 'unknown';
            if (!within(conn, '_events', L.eventsPerMinute, 60_000)) return 'rate';
            await ingest.studio(conn.profileId, ev);
            return 'ok';
        },

        async onRequest(conn, method, params = {}) {
            switch (method) {
                case 'automations.list': {
                    const list = await store.listAutomations(conn.profileId);
                    // songRequests (0.2.6): Studio keeps OBS VOD-safe for music only while an enabled automation runs a song request command.
                    return { automations: list.map((a) => ({ id: a.id, name: a.name, enabled: a.enabled, trigger_type: a.trigger_type })), songRequests: list.some((a) => a.enabled && usesStep(a.actions, 'music.command')) };
                }
                case 'automations.run': {
                    const id = Number(params?.automationId);
                    if (!Number.isInteger(id) || id <= 0) throw new RequestError('bad_params', 'automationId is required');
                    if (!within(conn, '_runs', L.runsPer10s, 10_000)) throw new RequestError('rate', 'Too many runs; wait a few seconds');
                    const profile = await profileOf(conn);
                    const a = await store.getAutomation(profile.id, id);
                    if (!a) throw new RequestError('not_found', 'That automation does not exist');
                    if (!a.enabled) throw new RequestError('disabled', 'That automation is turned off');
                    const ev = { platform: 'studio', type: a.trigger_type, channelId: null, user: null, amount: null, currency: null, message: null,
                        metadata: { via: 'studio', device: conn.name || null }, raw: null, occurredAt: new Date(now()), dedupeKey: null };
                    const running = engine.runAutomation(profile, a, ev, { source: 'studio', manual: true });
                    running.catch((e) => log('warn', 'studio run failed', { error: e?.message }));
                    let timer;
                    const r = await Promise.race([running, new Promise((res) => { timer = setTimeout(() => res(null), L.runWaitMs); timer.unref?.(); })]);
                    clearTimeout(timer);
                    return r ? { runId: r.runId ?? null, status: r.status } : { runId: null, status: 'running' };
                }
                case 'sounds.list': {
                    const list = sounds ? await sounds.list(conn.profileId) : [];
                    return { sounds: list.map((s) => ({ id: s.id, name: s.name, size: s.size, sha256: s.sha256, mime: s.mime, url: `/stream/bot/api/device/sounds/${s.id}` })) };
                }
                case 'docks.key': {
                    if (conn.kind !== 'studio') throw new RequestError('bad_params', 'Only CertiFried Studio can ask for dock keys');
                    if (!within(conn, '_dockKeys', L.dockKeysPer10min, 10 * 60_000)) throw new RequestError('rate', 'Too many new dock keys; wait a few minutes');
                    const profile = await profileOf(conn);
                    const r = await docks.issue(profile.id, { id: conn.deviceId, name: conn.name });
                    log('info', 'dock key issued', { profileId: profile.id, deviceId: r.deviceId, replaced: r.replaced });
                    return { key: r.key, deviceId: r.deviceId, urls: r.urls };
                }
                case 'voice.phrases': {
                    const list = await store.enabledAutomationsFor(conn.profileId, 'voice.phrase');
                    const seen = new Set();
                    const phrases = [];
                    for (const a of list) {
                        for (const t of Array.isArray(a.trigger_config?.phrases) ? a.trigger_config.phrases : []) {
                            const k = normalisePhrase(t);
                            if (!k || seen.has(k) || phrases.length >= L.voicePhrases) continue;
                            seen.add(k);
                            phrases.push({ text: String(t).slice(0, 100), automationId: a.id, automationName: a.name });
                        }
                    }
                    return { phrases };
                }
                default:
                    throw new RequestError('unknown_method', 'Unknown method');
            }
        },
        _written: written,
    };
}

export default { createStudioServices, sanitiseState, sanitiseMusic, studioMusicStatus, usesStep, RequestError, STATE_LIMITS, STUDIO_LIMITS };
