'use strict';
/*
 * The OBS connection (obs-websocket v5 through obs-websocket-js).
 *
 *   const obs = createObs({ OBSWebSocket?, EventSubscription?, logger, getPassword, now })
 *   obs.configure({ enabled, host, port })   (re)connects when something changed
 *   obs.reconnect() / obs.stop()
 *   obs.status      'off' | 'connecting' | 'connected' | 'unreachable' | 'auth_failed' | 'too_old'
 *   obs.connected   true when requests can be made
 *   obs.call(type, data)        throws code obs_not_connected when it is not
 *   obs.snapshot()  { connected, version, studioMode, currentScene, scenes[], sources{}, inputs[], filters{} }
 *   events: 'status' (status, detail), 'state' (snapshot), 'event' ({ type, metadata }), 'obs-event' (raw name, data) for a fixed list
 *
 * Forwarded events (to the engine, so automations can trigger on them): obs.scene_changed, obs.stream_started,
 * obs.stream_stopped, obs.recording_started, obs.recording_stopped, obs.recording_paused, obs.recording_resumed,
 * obs.replay_saved, obs.virtualcam_started, obs.virtualcam_stopped.
 *
 * Unreachable OBS (not running yet) is retried every 2 to 30 seconds. A wrong password is not retried until the
 * settings change, so OBS's own log is not filled with failed logins.
 */
const { EventEmitter } = require('node:events');
const path = require('node:path');

const CAPS = { scenes: 200, itemsPerScene: 200, inputs: 500, filterSources: 100, filtersPerSource: 50, name: 200 };
const REFRESH_ON = new Set([
    'SceneListChanged', 'SceneCreated', 'SceneRemoved', 'SceneNameChanged', 'InputCreated', 'InputRemoved', 'InputNameChanged',
    'SceneItemCreated', 'SceneItemRemoved', 'SourceFilterCreated', 'SourceFilterRemoved', 'SourceFilterNameChanged',
    'StudioModeStateChanged', 'CurrentProgramSceneChanged',
]);
const OUTPUT_EVENTS = {
    StreamStateChanged: { OBS_WEBSOCKET_OUTPUT_STARTED: 'obs.stream_started', OBS_WEBSOCKET_OUTPUT_STOPPED: 'obs.stream_stopped' },
    RecordStateChanged: {
        OBS_WEBSOCKET_OUTPUT_STARTED: 'obs.recording_started', OBS_WEBSOCKET_OUTPUT_STOPPED: 'obs.recording_stopped',
        OBS_WEBSOCKET_OUTPUT_PAUSED: 'obs.recording_paused', OBS_WEBSOCKET_OUTPUT_RESUMED: 'obs.recording_resumed',
    },
    VirtualcamStateChanged: { OBS_WEBSOCKET_OUTPUT_STARTED: 'obs.virtualcam_started', OBS_WEBSOCKET_OUTPUT_STOPPED: 'obs.virtualcam_stopped' },
};

const clip = (s) => String(s ?? '').slice(0, CAPS.name);

function createObs({ OBSWebSocket, EventSubscription, logger = null, getPassword = () => null, retry = { min: 2000, max: 30000 } } = {}) {
    if (!OBSWebSocket) ({ OBSWebSocket, EventSubscription } = require('obs-websocket-js/json'));
    const em = new EventEmitter();
    let cfg = { enabled: false, host: '127.0.0.1', port: 4455 };
    let client = null;
    let status = 'off';
    let detail = null;
    let attempt = 0;
    let retryTimer = null;
    let refreshTimer = null;
    let generation = 0;
    let snap = emptySnap();
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[obs] ${m}`, meta); } catch { /* ignore */ } };

    function emptySnap() {
        return { connected: false, version: null, studioMode: false, currentScene: null, scenes: [], sources: {}, inputs: [], filters: {}, streaming: false, recording: false };
    }
    function setStatus(s, d = null) {
        if (s === status && JSON.stringify(d) === JSON.stringify(detail)) return;
        status = s; detail = d;
        em.emit('status', s, d);
    }

    function teardown() {
        clearTimeout(retryTimer); retryTimer = null;
        clearTimeout(refreshTimer); refreshTimer = null;
        generation++;
        const c = client;
        client = null;
        if (c) {
            try { c.removeAllListeners(); } catch { /* ignore */ }
            c.disconnect().catch(() => {});
        }
        if (snap.connected) { snap = emptySnap(); em.emit('state', snapshot()); }
    }

    function scheduleRetry() {
        if (!cfg.enabled) return;
        const delay = Math.min(retry.max, retry.min * 2 ** Math.min(attempt, 5));
        attempt++;
        retryTimer = setTimeout(connect, delay);
        retryTimer.unref?.();
    }

    async function connect() {
        teardown();
        if (!cfg.enabled) { setStatus('off'); return; }
        const gen = generation;
        const c = new OBSWebSocket();
        client = c;
        setStatus('connecting', { host: cfg.host, port: cfg.port });
        let live = false;   // a failed connect() also closes; only a connection that was up is handled here
        c.on('ConnectionClosed', (e) => {
            if (gen !== generation || !live) return;
            log('info', 'OBS connection closed', { code: e?.code });
            client = null;
            snap = emptySnap();
            em.emit('state', snapshot());
            if (e?.code === 4009) { setStatus('auth_failed'); return; }
            setStatus('unreachable', { host: cfg.host, port: cfg.port });
            scheduleRetry();
        });
        wireEvents(c, gen);
        try {
            const password = getPassword() || undefined;
            await c.connect(`ws://${cfg.host}:${cfg.port}`, password, { rpcVersion: 1, eventSubscriptions: EventSubscription?.All });
        } catch (e) {
            if (gen !== generation) return;
            const code = Number(e?.code);
            log('debug', 'connect failed', { code: e?.code, error: e?.message });
            client = null;
            if (code === 4009) { log('warn', 'OBS refused the password'); setStatus('auth_failed'); return; }
            if (code === 4010) { setStatus('too_old'); return; }
            setStatus('unreachable', { host: cfg.host, port: cfg.port });
            scheduleRetry();
            return;
        }
        if (gen !== generation) return;
        live = true;
        attempt = 0;
        snap.connected = true;
        try {
            const v = await c.call('GetVersion');
            snap.version = v?.obsVersion ? `OBS ${v.obsVersion}, WebSocket ${v.obsWebSocketVersion}` : null;
        } catch { /* keep going */ }
        setStatus('connected', { host: cfg.host, port: cfg.port, version: snap.version });
        log('info', 'OBS connected', { host: cfg.host, port: cfg.port, version: snap.version });
        await refresh(gen);
    }

    function wireEvents(c, gen) {
        c.on('CurrentProgramSceneChanged', (d) => {
            if (gen !== generation) return;
            const previous = snap.currentScene;
            snap.currentScene = clip(d?.sceneName);
            em.emit('event', { type: 'obs.scene_changed', metadata: { scene: snap.currentScene, previous: previous || null } });
            em.emit('state', snapshot());
        });
        for (const [evName, map] of Object.entries(OUTPUT_EVENTS)) {
            c.on(evName, (d) => {
                if (gen !== generation) return;
                const type = map[d?.outputState];
                if (!type) return;
                if (evName === 'StreamStateChanged') snap.streaming = type === 'obs.stream_started';
                if (evName === 'RecordStateChanged') snap.recording = type !== 'obs.recording_stopped';
                em.emit('event', { type, metadata: {} });
            });
        }
        c.on('ReplayBufferSaved', (d) => {
            if (gen !== generation) return;
            em.emit('event', { type: 'obs.replay_saved', metadata: { file: d?.savedReplayPath ? path.basename(String(d.savedReplayPath)).slice(0, 200) : null } });
        });
        c.on('StudioModeStateChanged', (d) => { if (gen === generation) snap.studioMode = !!d?.studioModeEnabled; });
        for (const evName of REFRESH_ON) {
            if (evName === 'CurrentProgramSceneChanged') continue;
            c.on(evName, () => { if (gen === generation) refreshSoon(); });
        }
        c.on('ExitStarted', () => { if (gen === generation) log('info', 'OBS is closing'); });
        // Raw events for VOD-safe music (src/main/vod-safe.js), which re-checks its tracks on these.
        for (const evName of ['CurrentSceneCollectionChanged', 'CurrentProfileChanged', 'InputCreated', 'InputRemoved', 'InputNameChanged', 'SceneListChanged', 'SceneCreated', 'InputAudioTracksChanged', 'InputSettingsChanged', 'StreamStateChanged', 'RecordStateChanged']) {
            c.on(evName, (d) => { if (gen === generation) em.emit('obs-event', evName, d || {}); });
        }
    }

    function refreshSoon() {
        clearTimeout(refreshTimer);
        const gen = generation;
        refreshTimer = setTimeout(() => refresh(gen).catch(() => {}), 600);
        refreshTimer.unref?.();
    }

    /** Read scenes, their items, inputs and filters (capped) into the snapshot. */
    async function refresh(gen = generation) {
        const c = client;
        if (!c || gen !== generation) return;
        try {
            const [scenes, inputs, studio, stream, record] = await Promise.all([
                c.call('GetSceneList'), c.call('GetInputList'), c.call('GetStudioModeEnabled').catch(() => ({})),
                c.call('GetStreamStatus').catch(() => ({})), c.call('GetRecordStatus').catch(() => ({})),
            ]);
            if (gen !== generation) return;
            const sceneNames = (scenes?.scenes || []).slice().sort((a, b) => (b.sceneIndex ?? 0) - (a.sceneIndex ?? 0)).map((s) => clip(s.sceneName)).slice(0, CAPS.scenes);
            const items = sceneNames.length
                ? await c.callBatch(sceneNames.map((sceneName) => ({ requestType: 'GetSceneItemList', requestData: { sceneName } })), { haltOnFailure: false })
                : [];
            const sources = {};
            sceneNames.forEach((s, i) => {
                sources[s] = (items[i]?.responseData?.sceneItems || []).map((it) => clip(it.sourceName)).slice(0, CAPS.itemsPerScene);
            });
            const inputList = (inputs?.inputs || []).slice(0, CAPS.inputs).map((i) => ({ name: clip(i.inputName), kind: clip(i.unversionedInputKind || i.inputKind) }));
            const filterSources = [...sceneNames, ...inputList.map((i) => i.name)].slice(0, CAPS.filterSources);
            const fl = filterSources.length
                ? await c.callBatch(filterSources.map((sourceName) => ({ requestType: 'GetSourceFilterList', requestData: { sourceName } })), { haltOnFailure: false })
                : [];
            const filters = {};
            filterSources.forEach((s, i) => {
                const names = (fl[i]?.responseData?.filters || []).map((f) => clip(f.filterName)).slice(0, CAPS.filtersPerSource);
                if (names.length) filters[s] = names;
            });
            if (gen !== generation) return;
            Object.assign(snap, {
                connected: true, studioMode: !!studio?.studioModeEnabled,
                currentScene: clip(scenes?.currentProgramSceneName || scenes?.sceneName) || null,
                scenes: sceneNames, sources, inputs: inputList, filters,
                streaming: !!stream?.outputActive, recording: !!record?.outputActive,
            });
            em.emit('state', snapshot());
        } catch (e) {
            log('warn', 'could not read the OBS scene list', { error: e.message });
        }
    }

    function snapshot() { return JSON.parse(JSON.stringify(snap)); }

    return Object.defineProperties(em, Object.getOwnPropertyDescriptors({
        configure(next) {
            const n = { enabled: next?.enabled !== false, host: String(next?.host || '127.0.0.1').trim(), port: Number(next?.port) || 4455 };
            const changed = n.enabled !== cfg.enabled || n.host !== cfg.host || n.port !== cfg.port;
            cfg = n;
            if (changed || status === 'auth_failed' || status === 'off') { attempt = 0; connect(); }
        },
        reconnect() { attempt = 0; connect(); },
        stop() { cfg = { ...cfg, enabled: false }; teardown(); setStatus('off'); },
        async call(type, data) {
            if (!client || status !== 'connected') { const e = new Error('OBS is not connected'); e.code = 'obs_not_connected'; throw e; }
            return client.call(type, data);
        },
        refresh: () => refresh(),
        snapshot,
        get status() { return status; },
        get detail() { return detail; },
        get connected() { return status === 'connected' && !!client; },
    }));
}

module.exports = { createObs, CAPS };
