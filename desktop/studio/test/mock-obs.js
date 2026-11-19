'use strict';
/*
 * A mock obs-websocket v5 server for tests: the real handshake (Hello / Identify with the SHA-256 challenge /
 * Identified), Request → RequestResponse with OBS status codes, RequestBatch, and Events, over the
 * 'obswebsocket.json' subprotocol. It keeps a small fake OBS state so write actions can be checked.
 *
 *   const m = await startMockObs({ password })   → { port, state, requests[], emit(type, data), close() }
 */
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const OK = 100;
const NOT_FOUND = 600;
const STUDIO_OFF = 506;
const OUTPUT_NOT_RUNNING = 501;

function sha(s) { return crypto.createHash('sha256').update(s).digest('base64'); }

function freshState() {
    return {
        program: 'Main', preview: 'Main', studioMode: false, transition: 'Fade', transitionDuration: 300, transitions: ['Fade', 'Cut', 'Stinger'],
        scenes: {
            Main: [{ id: 1, source: 'Webcam', enabled: true }, { id: 2, source: 'Alert Box', enabled: true }, { id: 3, source: 'Now Playing', enabled: false }],
            BRB: [{ id: 1, source: 'BRB Text', enabled: true }],
            'Starting Soon': [{ id: 1, source: 'Countdown', enabled: true }],
        },
        inputs: {
            Mic: { kind: 'wasapi_input_capture', muted: false, mul: 1, settings: {} },
            Desktop: { kind: 'wasapi_output_capture', muted: false, mul: 1, settings: {} },
            Webcam: { kind: 'dshow_input', muted: false, mul: 1, settings: {} },
            'Alert Box': { kind: 'browser_source', muted: false, mul: 1, settings: { url: 'https://example.com/a' }, refreshed: 0 },
            'Now Playing': { kind: 'text_gdiplus_v3', muted: false, mul: 1, settings: { text: '' } },
            'BRB Text': { kind: 'text_gdiplus_v3', muted: false, mul: 1, settings: { text: 'Back soon' } },
            Countdown: { kind: 'text_gdiplus_v3', muted: false, mul: 1, settings: { text: '5:00' } },
        },
        filters: { Mic: { 'Noise Suppression': true, Compressor: false }, Webcam: { 'Color Correction': true } },
        stream: false, record: false, recordPaused: false, replay: false, vcam: false,
        replaySaves: 0, hotkeys: ['OBSBasic.StartStreaming', 'OBSBasic.Screenshot'], hotkeysPressed: [], screenshots: [],
        profileName: 'Default',
        profile: { 'Output.Mode': 'Advanced', 'AdvOut.TrackIndex': '1', 'AdvOut.VodTrackEnabled': 'true', 'AdvOut.VodTrackIndex': '2', 'AdvOut.RecTracks': '1' },
        profileWrites: [],
        uuidSeq: 0,
    };
}

async function startMockObs({ password = null, rpcVersion = 1 } = {}) {
    const state = freshState();
    const requests = [];
    const sockets = new Set();
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: (protocols) => (protocols.has('obswebsocket.json') ? 'obswebsocket.json' : false) });
    await new Promise((r) => wss.once('listening', r));
    const port = wss.address().port;

    const allTracks = () => ({ 1: true, 2: true, 3: true, 4: true, 5: true, 6: true });
    for (const i of Object.values(state.inputs)) { i.uuid = i.uuid || `uuid-${++state.uuidSeq}`; i.tracks = i.tracks || allTracks(); i.monitor = i.monitor || 'OBS_MONITORING_TYPE_NONE'; }
    const inputByName = (n) => state.inputs[n];
    const nameOf = (data) => data.inputName ?? Object.keys(state.inputs).find((k) => state.inputs[k].uuid === data.inputUuid);
    function emit(eventType, eventData = {}) {
        for (const ws of sockets) if (ws.identified) ws.send(JSON.stringify({ op: 5, d: { eventType, eventIntent: 1, eventData } }));
    }

    function handle(type, data = {}) {
        const res = (responseData = {}, code = OK, comment) => ({ code, comment, responseData });
        const nf = (what) => res(undefined, NOT_FOUND, `No ${what} was found.`);
        const scene = (n) => state.scenes[n];
        const outputSet = (key, on, eventName) => {
            if (state[key] === on) return res(undefined, on ? 500 : OUTPUT_NOT_RUNNING, 'state');
            state[key] = on;
            if (eventName) emit(eventName, { outputActive: on, outputState: on ? 'OBS_WEBSOCKET_OUTPUT_STARTED' : 'OBS_WEBSOCKET_OUTPUT_STOPPED' });
            return res({});
        };
        switch (type) {
            case 'GetVersion': return res({ obsVersion: '31.0.0', obsWebSocketVersion: '5.5.0', rpcVersion: 1 });
            case 'GetSceneList': return res({ currentProgramSceneName: state.program, currentPreviewSceneName: state.preview, scenes: Object.keys(state.scenes).map((s, i, a) => ({ sceneName: s, sceneIndex: a.length - 1 - i })) });
            case 'GetCurrentProgramScene': return res({ currentProgramSceneName: state.program, sceneName: state.program });
            case 'SetCurrentProgramScene': {
                if (!scene(data.sceneName)) return nf('scene');
                state.program = data.sceneName;
                emit('CurrentProgramSceneChanged', { sceneName: data.sceneName });
                return res({});
            }
            case 'GetStudioModeEnabled': return res({ studioModeEnabled: state.studioMode });
            case 'SetCurrentPreviewScene':
                if (!state.studioMode) return res(undefined, STUDIO_OFF, 'Studio mode is not enabled.');
                if (!scene(data.sceneName)) return nf('scene');
                state.preview = data.sceneName; return res({});
            case 'GetCurrentSceneTransition': return res({ transitionName: state.transition, transitionDuration: state.transitionDuration });
            case 'SetCurrentSceneTransition':
                if (!state.transitions.includes(data.transitionName)) return nf('transition');
                state.transition = data.transitionName; return res({});
            case 'SetCurrentSceneTransitionDuration': state.transitionDuration = data.transitionDuration; return res({});
            case 'TriggerStudioModeTransition': {
                if (!state.studioMode) return res(undefined, STUDIO_OFF, 'Studio mode is not enabled.');
                const p = state.program; state.program = state.preview; state.preview = p;
                state.lastTransition = state.transition;
                emit('CurrentProgramSceneChanged', { sceneName: state.program });
                return res({});
            }
            case 'GetSceneItemList': {
                const s = scene(data.sceneName); if (!s) return nf('scene');
                return res({ sceneItems: s.map((it) => ({ sourceName: it.source, sourceUuid: state.inputs[it.source]?.uuid, sceneItemId: it.id, sceneItemEnabled: it.enabled, inputKind: state.inputs[it.source]?.kind })) });
            }
            case 'GetSceneItemId': {
                const s = scene(data.sceneName); if (!s) return nf('scene');
                const it = s.find((x) => x.source === data.sourceName); if (!it) return nf('scene item');
                return res({ sceneItemId: it.id });
            }
            case 'GetSceneItemEnabled': case 'SetSceneItemEnabled': {
                const it = scene(data.sceneName)?.find((x) => x.id === data.sceneItemId); if (!it) return nf('scene item');
                if (type === 'SetSceneItemEnabled') it.enabled = !!data.sceneItemEnabled;
                return res(type === 'GetSceneItemEnabled' ? { sceneItemEnabled: it.enabled } : {});
            }
            case 'GetInputList': return res({ inputs: Object.entries(state.inputs).map(([inputName, i]) => ({ inputName, inputUuid: i.uuid, inputKind: i.kind, unversionedInputKind: i.kind.replace(/_v\d+$/, '') })) });
            case 'GetProfileList': return res({ currentProfileName: state.profileName, profiles: [state.profileName] });
            case 'GetProfileParameter': {
                const k = `${data.parameterCategory}.${data.parameterName}`;
                return res({ parameterValue: k in state.profile ? state.profile[k] : null, defaultParameterValue: null });
            }
            case 'SetProfileParameter': {
                state.profile[`${data.parameterCategory}.${data.parameterName}`] = String(data.parameterValue);
                state.profileWrites.push({ ...data });
                return res({});
            }
            case 'GetInputAudioTracks': { const i = inputByName(nameOf(data)); if (!i) return nf('input'); return res({ inputAudioTracks: { ...i.tracks } }); }
            case 'SetInputAudioTracks': {
                const n = nameOf(data); const i = inputByName(n); if (!i) return nf('input');
                for (const [k, v] of Object.entries(data.inputAudioTracks || {})) i.tracks[k] = !!v;
                emit('InputAudioTracksChanged', { inputName: n, inputUuid: i.uuid, inputAudioTracks: { ...i.tracks } });
                return res({});
            }
            case 'GetInputAudioMonitorType': { const i = inputByName(nameOf(data)); if (!i) return nf('input'); return res({ monitorType: i.monitor }); }
            case 'SetInputAudioMonitorType': { const i = inputByName(nameOf(data)); if (!i) return nf('input'); i.monitor = data.monitorType; return res({}); }
            case 'CreateScene': {
                if (state.scenes[data.sceneName]) return res(undefined, 601, 'A scene by that name already exists.');
                state.scenes[data.sceneName] = []; emit('SceneCreated', { sceneName: data.sceneName, isGroup: false }); return res({ sceneUuid: `scene-${++state.uuidSeq}` });
            }
            case 'CreateInput': {
                const s = scene(data.sceneName); if (!s) return nf('scene');
                if (state.inputs[data.inputName]) return res(undefined, 601, 'An input by that name already exists.');
                const uuid = `uuid-${++state.uuidSeq}`;
                state.inputs[data.inputName] = { kind: data.inputKind, muted: false, mul: 1, settings: { ...(data.inputSettings || {}) }, uuid, tracks: allTracks(), monitor: 'OBS_MONITORING_TYPE_NONE', refreshed: 0 };
                const id = s.reduce((m, x) => Math.max(m, x.id), 0) + 1;
                s.push({ id, source: data.inputName, enabled: data.sceneItemEnabled !== false });
                emit('InputCreated', { inputName: data.inputName, inputUuid: uuid, inputKind: data.inputKind });
                return res({ inputUuid: uuid, sceneItemId: id });
            }
            case 'CreateSceneItem': {
                const s = scene(data.sceneName); if (!s) return nf('scene');
                if (!state.inputs[data.sourceName] && !state.scenes[data.sourceName]) return nf('source');
                const id = s.reduce((m, x) => Math.max(m, x.id), 0) + 1;
                s.push({ id, source: data.sourceName, enabled: data.sceneItemEnabled !== false });
                return res({ sceneItemId: id });
            }
            case 'SetInputMute': case 'ToggleInputMute': {
                const i = state.inputs[data.inputName]; if (!i) return nf('input');
                i.muted = type === 'ToggleInputMute' ? !i.muted : !!data.inputMuted;
                return res(type === 'ToggleInputMute' ? { inputMuted: i.muted } : {});
            }
            case 'SetInputVolume': { const i = state.inputs[data.inputName]; if (!i) return nf('input'); i.mul = data.inputVolumeMul; return res({}); }
            case 'GetInputSettings': { const i = state.inputs[data.inputName]; if (!i) return nf('input'); return res({ inputKind: i.kind, inputSettings: i.settings }); }
            case 'SetInputSettings': { const i = state.inputs[data.inputName]; if (!i) return nf('input'); i.settings = data.overlay === false ? data.inputSettings : { ...i.settings, ...data.inputSettings }; return res({}); }
            case 'PressInputPropertiesButton': { const i = state.inputs[data.inputName]; if (!i) return nf('input'); if (data.propertyName === 'refreshnocache') i.refreshed++; return res({}); }
            case 'GetSourceFilterList': return res({ filters: Object.entries(state.filters[data.sourceName] || {}).map(([filterName, filterEnabled]) => ({ filterName, filterEnabled })) });
            case 'GetSourceFilter': { const f = state.filters[data.sourceName]; if (!f || !(data.filterName in f)) return nf('filter'); return res({ filterEnabled: f[data.filterName] }); }
            case 'SetSourceFilterEnabled': { const f = state.filters[data.sourceName]; if (!f || !(data.filterName in f)) return nf('filter'); f[data.filterName] = !!data.filterEnabled; return res({}); }
            case 'GetStreamStatus': return res({ outputActive: state.stream });
            case 'StartStream': return outputSet('stream', true, 'StreamStateChanged');
            case 'StopStream': return outputSet('stream', false, 'StreamStateChanged');
            case 'GetRecordStatus': return res({ outputActive: state.record, outputPaused: state.recordPaused });
            case 'StartRecord': return outputSet('record', true, 'RecordStateChanged');
            case 'StopRecord': state.recordPaused = false; return outputSet('record', false, 'RecordStateChanged');
            case 'PauseRecord': if (!state.record) return res(undefined, OUTPUT_NOT_RUNNING); state.recordPaused = true; emit('RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_PAUSED' }); return res({});
            case 'ResumeRecord': if (!state.record) return res(undefined, OUTPUT_NOT_RUNNING); state.recordPaused = false; emit('RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_RESUMED' }); return res({});
            case 'GetReplayBufferStatus': return res({ outputActive: state.replay });
            case 'StartReplayBuffer': return outputSet('replay', true, 'ReplayBufferStateChanged');
            case 'StopReplayBuffer': return outputSet('replay', false, 'ReplayBufferStateChanged');
            case 'SaveReplayBuffer':
                if (!state.replay) return res(undefined, OUTPUT_NOT_RUNNING);
                state.replaySaves++; emit('ReplayBufferSaved', { savedReplayPath: 'C:\\Videos\\Replay 2026-11-19.mkv' }); return res({});
            case 'GetVirtualCamStatus': return res({ outputActive: state.vcam });
            case 'StartVirtualCam': return outputSet('vcam', true, 'VirtualcamStateChanged');
            case 'StopVirtualCam': return outputSet('vcam', false, 'VirtualcamStateChanged');
            case 'SaveSourceScreenshot':
                if (!scene(data.sourceName) && !state.inputs[data.sourceName]) return nf('source');
                state.screenshots.push(data); return res({});
            case 'TriggerHotkeyByName':
                if (!state.hotkeys.includes(data.hotkeyName)) return nf('hotkey');
                state.hotkeysPressed.push(data.hotkeyName); return res({});
            default: return res(undefined, 204, `Unknown request ${type}`);
        }
    }

    wss.on('connection', (ws) => {
        sockets.add(ws);
        ws.on('close', () => sockets.delete(ws));
        const challenge = crypto.randomBytes(16).toString('base64');
        const salt = crypto.randomBytes(16).toString('base64');
        ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.5.0', rpcVersion, ...(password ? { authentication: { challenge, salt } } : {}) } }));
        ws.on('message', (raw) => {
            const msg = JSON.parse(String(raw));
            if (msg.op === 1) {
                if (password) {
                    const expect = sha(sha(password + salt) + challenge);
                    if (msg.d.authentication !== expect) { ws.close(4009, 'Authentication failed.'); return; }
                }
                ws.identified = true;
                ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
                return;
            }
            if (!ws.identified) { ws.close(4007, 'Not identified'); return; }
            if (msg.op === 6) {
                const { requestType, requestId, requestData } = msg.d;
                requests.push({ requestType, requestData });
                const r = handle(requestType, requestData);
                ws.send(JSON.stringify({ op: 7, d: { requestType, requestId, requestStatus: { result: r.code === OK, code: r.code, ...(r.comment && r.code !== OK ? { comment: r.comment } : {}) }, ...(r.responseData ? { responseData: r.responseData } : {}) } }));
            } else if (msg.op === 8) {
                const { requestId, requests: list } = msg.d;
                const results = list.map((q) => {
                    requests.push({ requestType: q.requestType, requestData: q.requestData });
                    const r = handle(q.requestType, q.requestData);
                    return { requestType: q.requestType, requestStatus: { result: r.code === OK, code: r.code }, responseData: r.responseData };
                });
                ws.send(JSON.stringify({ op: 9, d: { requestId, results } }));
            }
        });
    });

    /** Test helper: rename an input as a person would in OBS. */
    function rename(oldName, newName) {
        state.inputs[newName] = state.inputs[oldName];
        delete state.inputs[oldName];
        for (const s of Object.values(state.scenes)) for (const it of s) if (it.source === oldName) it.source = newName;
        emit('InputNameChanged', { oldInputName: oldName, inputName: newName, inputUuid: state.inputs[newName].uuid });
    }
    return {
        port, state, requests, emit, rename,
        dropClients() { for (const ws of sockets) ws.terminate(); },
        close: () => new Promise((r) => { for (const ws of sockets) ws.terminate(); wss.close(() => r()); }),
    };
}

module.exports = { startMockObs };
