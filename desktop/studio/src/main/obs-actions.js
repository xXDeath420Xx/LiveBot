'use strict';
/*
 * obs.* actions → obs-websocket v5 requests.
 *
 *   OBS_ACTIONS                     the action types handled here
 *   runObsAction(obs, type, params, { screenshotDir, now, setTimer })
 *       obs = { call(requestType, data) }  (an obs-websocket-js instance, or the wrapper in obs.js)
 *       → result object (sent back in the ack), or throws an Error whose .code is a short reason
 *
 * Reasons: obs_not_connected, bad_params, scene_not_found, source_not_found, input_not_found, filter_not_found,
 * hotkey_not_found, studio_mode_off, not_recording, not_a_text_source, not_a_browser_source, replay_buffer_off,
 * obs_error. Start/stop actions check the current state first, so "start" while already running answers ok with
 * changed: false instead of an error.
 */
const path = require('node:path');

const OBS_ACTIONS = Object.freeze([
    'obs.scene', 'obs.preview', 'obs.transition', 'obs.source', 'obs.mute', 'obs.volume', 'obs.filter', 'obs.stream',
    'obs.record', 'obs.replay', 'obs.virtualcam', 'obs.screenshot', 'obs.text', 'obs.browser_url', 'obs.browser_refresh',
    'obs.hotkey',
]);

// obs-websocket v5 RequestStatus codes used below
const RS = { notFound: 600, outputRunning: 500, outputNotRunning: 501, outputPaused: 502, outputNotPaused: 503, outputDisabled: 504, studioModeActive: 505, studioModeNotActive: 506 };

function fail(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
}

function name(v, field, { optional = false, max = 256 } = {}) {
    const s = v == null ? '' : String(v).trim();
    if (!s) { if (optional) return ''; throw fail('bad_params', `missing ${field}`); }
    if (s.length > max) throw fail('bad_params', `${field} is too long`);
    return s;
}

function pick(v, allowed, dflt) {
    const s = String(v ?? '').toLowerCase();
    return allowed.includes(s) ? s : dflt;
}

/** Call OBS, turning its error codes into our reasons. */
async function call(obs, type, data, notFound = 'not_found') {
    try {
        return (await obs.call(type, data)) || {};
    } catch (e) {
        const code = Number(e?.code);
        if (code === RS.notFound) throw fail(notFound, e.message);
        if (code === RS.studioModeNotActive) throw fail('studio_mode_off', 'Turn on Studio Mode in OBS first');
        if (e?.code === 'obs_not_connected') throw e;
        throw fail('obs_error', String(e?.message || 'OBS refused the request').slice(0, 200));
    }
}

async function currentScene(obs) {
    const r = await call(obs, 'GetCurrentProgramScene');
    return r.sceneName || r.currentProgramSceneName;
}

async function setOutput(obs, kind, wanted) {
    const spec = {
        stream: { status: 'GetStreamStatus', start: 'StartStream', stop: 'StopStream' },
        record: { status: 'GetRecordStatus', start: 'StartRecord', stop: 'StopRecord' },
        virtualcam: { status: 'GetVirtualCamStatus', start: 'StartVirtualCam', stop: 'StopVirtualCam' },
        replay: { status: 'GetReplayBufferStatus', start: 'StartReplayBuffer', stop: 'StopReplayBuffer' },
    }[kind];
    const st = await call(obs, spec.status);
    const active = !!st.outputActive;
    const target = wanted === 'toggle' ? !active : wanted === 'start';
    if (target === active) return { active, changed: false };
    await call(obs, target ? spec.start : spec.stop);
    return { active: target, changed: true };
}

function safeFileName(s) {
    return String(s).replace(/[^A-Za-z0-9 _.-]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'source';
}

function stamp(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function runObsAction(obs, type, params = {}, ctx = {}) {
    if (!obs || !obs.connected) throw fail('obs_not_connected', 'OBS is not connected');
    const p = params || {};
    switch (type) {
        case 'obs.scene': {
            const scene = name(p.scene, 'scene');
            await call(obs, 'SetCurrentProgramScene', { sceneName: scene }, 'scene_not_found');
            return { scene };
        }
        case 'obs.preview': {
            const scene = name(p.scene, 'scene');
            const sm = await call(obs, 'GetStudioModeEnabled');
            if (!sm.studioModeEnabled) throw fail('studio_mode_off', 'Turn on Studio Mode in OBS first');
            await call(obs, 'SetCurrentPreviewScene', { sceneName: scene }, 'scene_not_found');
            return { preview: scene };
        }
        case 'obs.transition': {
            const sm = await call(obs, 'GetStudioModeEnabled');
            if (!sm.studioModeEnabled) throw fail('studio_mode_off', 'Turn on Studio Mode in OBS first');
            const transition = name(p.transition, 'transition', { optional: true });
            const duration = p.durationMs === '' || p.durationMs == null ? null : Number(p.durationMs);
            if (duration != null && (!Number.isFinite(duration) || duration < 50 || duration > 20000)) throw fail('bad_params', 'durationMs must be 50 to 20000');
            let restore = null;
            if (transition || duration != null) {
                const cur = await call(obs, 'GetCurrentSceneTransition');
                restore = { name: cur.transitionName, duration: cur.transitionDuration };
                if (transition) await call(obs, 'SetCurrentSceneTransition', { transitionName: transition }, 'transition_not_found');
                if (duration != null) await call(obs, 'SetCurrentSceneTransitionDuration', { transitionDuration: duration }).catch(() => {});
            }
            await call(obs, 'TriggerStudioModeTransition');
            if (restore) {
                // Put the person's own transition back once this one has played.
                const wait = (duration ?? restore.duration ?? 300) + 500;
                const later = async () => {
                    try {
                        if (transition && restore.name) await obs.call('SetCurrentSceneTransition', { transitionName: restore.name });
                        if (duration != null && restore.duration) await obs.call('SetCurrentSceneTransitionDuration', { transitionDuration: restore.duration });
                    } catch { /* OBS went away; nothing to restore */ }
                };
                (ctx.setTimer || setTimeout)(later, wait);
            }
            return { transitioned: true, transition: transition || null };
        }
        case 'obs.source': {
            const source = name(p.source, 'source');
            const scene = name(p.scene, 'scene', { optional: true }) || await currentScene(obs);
            const mode = pick(p.visible, ['show', 'hide', 'toggle'], 'toggle');
            const { sceneItemId } = await call(obs, 'GetSceneItemId', { sceneName: scene, sourceName: source }, 'source_not_found');
            let enabled = mode === 'show';
            if (mode === 'toggle') {
                const cur = await call(obs, 'GetSceneItemEnabled', { sceneName: scene, sceneItemId }, 'source_not_found');
                enabled = !cur.sceneItemEnabled;
            }
            await call(obs, 'SetSceneItemEnabled', { sceneName: scene, sceneItemId, sceneItemEnabled: enabled }, 'source_not_found');
            return { scene, source, visible: enabled };
        }
        case 'obs.mute': {
            const input = name(p.input, 'input');
            const mode = pick(p.state, ['mute', 'unmute', 'toggle'], 'toggle');
            if (mode === 'toggle') {
                const r = await call(obs, 'ToggleInputMute', { inputName: input }, 'input_not_found');
                return { input, muted: !!r.inputMuted };
            }
            await call(obs, 'SetInputMute', { inputName: input, inputMuted: mode === 'mute' }, 'input_not_found');
            return { input, muted: mode === 'mute' };
        }
        case 'obs.volume': {
            const input = name(p.input, 'input');
            const v = Number(p.volume);
            if (!Number.isFinite(v) || v < 0 || v > 100) throw fail('bad_params', 'volume must be 0 to 100');
            await call(obs, 'SetInputVolume', { inputName: input, inputVolumeMul: Math.round(v) / 100 }, 'input_not_found');
            return { input, volume: Math.round(v) };
        }
        case 'obs.filter': {
            const source = name(p.source, 'source');
            const filter = name(p.filter, 'filter');
            const mode = pick(p.state, ['enable', 'disable', 'toggle'], 'toggle');
            let enabled = mode === 'enable';
            if (mode === 'toggle') {
                const cur = await call(obs, 'GetSourceFilter', { sourceName: source, filterName: filter }, 'filter_not_found');
                enabled = !cur.filterEnabled;
            }
            await call(obs, 'SetSourceFilterEnabled', { sourceName: source, filterName: filter, filterEnabled: enabled }, 'filter_not_found');
            return { source, filter, enabled };
        }
        case 'obs.stream': {
            const r = await setOutput(obs, 'stream', pick(p.state, ['start', 'stop', 'toggle'], 'toggle'));
            return { streaming: r.active, changed: r.changed };
        }
        case 'obs.record': {
            const mode = pick(p.state, ['start', 'stop', 'toggle', 'pause', 'resume', 'toggle_pause'], 'toggle');
            if (['start', 'stop', 'toggle'].includes(mode)) {
                const r = await setOutput(obs, 'record', mode);
                return { recording: r.active, changed: r.changed };
            }
            const st = await call(obs, 'GetRecordStatus');
            if (!st.outputActive) throw fail('not_recording', 'OBS is not recording');
            const pause = mode === 'toggle_pause' ? !st.outputPaused : mode === 'pause';
            if (pause === !!st.outputPaused) return { recording: true, paused: pause, changed: false };
            await call(obs, pause ? 'PauseRecord' : 'ResumeRecord');
            return { recording: true, paused: pause, changed: true };
        }
        case 'obs.replay': {
            const mode = pick(p.state, ['save', 'start', 'stop'], 'save');
            if (mode === 'save') {
                const st = await call(obs, 'GetReplayBufferStatus');
                if (!st.outputActive) throw fail('replay_buffer_off', 'Start the replay buffer in OBS first');
                await call(obs, 'SaveReplayBuffer');
                return { saved: true };
            }
            const r = await setOutput(obs, 'replay', mode);
            return { replayBuffer: r.active, changed: r.changed };
        }
        case 'obs.virtualcam': {
            const r = await setOutput(obs, 'virtualcam', pick(p.state, ['start', 'stop', 'toggle'], 'toggle'));
            return { virtualCam: r.active, changed: r.changed };
        }
        case 'obs.screenshot': {
            if (!ctx.screenshotDir) throw fail('bad_params', 'no screenshot folder');
            const source = name(p.source, 'source', { optional: true }) || await currentScene(obs);
            const file = path.join(ctx.screenshotDir, `${safeFileName(source)} ${stamp(new Date((ctx.now || Date.now)()))}.png`);
            await call(obs, 'SaveSourceScreenshot', { sourceName: source, imageFormat: 'png', imageFilePath: file, imageCompressionQuality: -1 }, 'source_not_found');
            return { source, file: path.basename(file) };
        }
        case 'obs.text': {
            const source = name(p.source, 'source');
            const text = String(p.text ?? '').slice(0, 4000);
            const cur = await call(obs, 'GetInputSettings', { inputName: source }, 'source_not_found');
            if (!/^text_/.test(String(cur.inputKind || ''))) throw fail('not_a_text_source', `${source} is not a text source`);
            await call(obs, 'SetInputSettings', { inputName: source, inputSettings: { text }, overlay: true }, 'source_not_found');
            return { source, length: text.length };
        }
        case 'obs.browser_url': {
            const source = name(p.source, 'source');
            const url = name(p.url, 'url', { max: 2000 });
            let u;
            try { u = new URL(url); } catch { throw fail('bad_params', 'url is not a valid address'); }
            if (!['http:', 'https:'].includes(u.protocol)) throw fail('bad_params', 'url must start with http:// or https://');
            const cur = await call(obs, 'GetInputSettings', { inputName: source }, 'source_not_found');
            if (cur.inputKind !== 'browser_source') throw fail('not_a_browser_source', `${source} is not a browser source`);
            await call(obs, 'SetInputSettings', { inputName: source, inputSettings: { url: u.href }, overlay: true }, 'source_not_found');
            return { source, url: u.href };
        }
        case 'obs.browser_refresh': {
            const source = name(p.source, 'source');
            const cur = await call(obs, 'GetInputSettings', { inputName: source }, 'source_not_found');
            if (cur.inputKind !== 'browser_source') throw fail('not_a_browser_source', `${source} is not a browser source`);
            await call(obs, 'PressInputPropertiesButton', { inputName: source, propertyName: 'refreshnocache' }, 'source_not_found');
            return { source, refreshed: true };
        }
        case 'obs.hotkey': {
            const hotkey = name(p.name ?? p.hotkey, 'name');
            await call(obs, 'TriggerHotkeyByName', { hotkeyName: hotkey }, 'hotkey_not_found');
            return { hotkey };
        }
        default:
            throw fail('unknown_action', `unknown action ${String(type).slice(0, 40)}`);
    }
}

module.exports = { OBS_ACTIONS, runObsAction, RS };
