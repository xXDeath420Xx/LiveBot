'use strict';
/*
 * Every obs.* action against a mock obs-websocket v5 server (test/mock-obs.js), through the real obs-websocket-js
 * client and src/main/obs.js: the password handshake, the scene/source snapshot, forwarded events, and each write.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMockObs } = require('./mock-obs');
const { createObs } = require('../src/main/obs');
const { runObsAction, OBS_ACTIONS } = require('../src/main/obs-actions');
const { createRouter } = require('../src/main/router');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(20); }
}

let mock, obs, events, shots;
const PASSWORD = 'test-only-pw';

test.before(async () => {
    mock = await startMockObs({ password: PASSWORD });
    shots = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-shots-'));
    events = [];
    obs = createObs({ getPassword: () => PASSWORD, retry: { min: 100, max: 200 } });
    obs.on('event', (e) => events.push(e));
    obs.configure({ enabled: true, host: '127.0.0.1', port: mock.port });
    await until(() => obs.connected && obs.snapshot().scenes.length);
});
test.after(async () => { obs.stop(); await mock.close(); fs.rmSync(shots, { recursive: true, force: true }); });

const run = (type, params) => runObsAction(obs, type, params, { screenshotDir: shots, setTimer: (fn, ms) => setTimeout(fn, 30) });
const code = async (p) => { try { await p; return 'ok'; } catch (e) { return e.code; } };

test('connects with the password and reads scenes, items, inputs and filters', () => {
    const s = obs.snapshot();
    assert.equal(s.connected, true);
    assert.match(s.version, /OBS 31/);
    assert.deepEqual(s.scenes, ['Main', 'BRB', 'Starting Soon']);
    assert.deepEqual(s.sources.Main, ['Webcam', 'Alert Box', 'Now Playing']);
    assert.ok(s.inputs.some((i) => i.name === 'Mic' && i.kind === 'wasapi_input_capture'));
    assert.deepEqual(s.filters.Mic, ['Noise Suppression', 'Compressor']);
    assert.equal(s.currentScene, 'Main');
});

test('a wrong password is reported once and not retried', async () => {
    const bad = createObs({ getPassword: () => 'wrong', retry: { min: 50, max: 50 } });
    const statuses = [];
    bad.on('status', (s) => statuses.push(s));
    bad.configure({ enabled: true, host: '127.0.0.1', port: mock.port });
    await until(() => bad.status === 'auth_failed');
    await sleep(200);
    assert.equal(statuses.filter((s) => s === 'connecting').length, 1, 'no retry loop on a bad password');
    bad.stop();
});

test('nothing listening: unreachable, then retried', async () => {
    const o = createObs({ retry: { min: 50, max: 50 } });
    let tries = 0;
    o.on('status', (s) => { if (s === 'connecting') tries++; });
    o.configure({ enabled: true, host: '127.0.0.1', port: 1 });
    await until(() => tries >= 2, 4000);
    o.stop();
    assert.equal(o.status, 'off');
});

test('obs.scene switches and forwards obs.scene_changed; unknown scene fails', async () => {
    events.length = 0;
    assert.deepEqual(await run('obs.scene', { scene: 'BRB' }), { scene: 'BRB' });
    assert.equal(mock.state.program, 'BRB');
    await until(() => events.find((e) => e.type === 'obs.scene_changed'));
    assert.deepEqual(events.find((e) => e.type === 'obs.scene_changed').metadata, { scene: 'BRB', previous: 'Main' });
    assert.equal(await code(run('obs.scene', { scene: 'Nope' })), 'scene_not_found');
    assert.equal(await code(run('obs.scene', {})), 'bad_params');
    await run('obs.scene', { scene: 'Main' });
});

test('obs.preview and obs.transition need Studio Mode; transition restores the person\'s own transition', async () => {
    assert.equal(await code(run('obs.preview', { scene: 'BRB' })), 'studio_mode_off');
    assert.equal(await code(run('obs.transition', {})), 'studio_mode_off');
    mock.state.studioMode = true;
    await run('obs.preview', { scene: 'BRB' });
    assert.equal(mock.state.preview, 'BRB');
    const r = await run('obs.transition', { transition: 'Cut', durationMs: 500 });
    assert.equal(r.transitioned, true);
    assert.equal(mock.state.program, 'BRB');
    assert.equal(mock.state.lastTransition, 'Cut');
    await until(() => mock.state.transition === 'Fade' && mock.state.transitionDuration === 300);
    assert.equal(await code(run('obs.transition', { transition: 'Swirl' })), 'transition_not_found');
    mock.state.studioMode = false;
    await run('obs.scene', { scene: 'Main' });
});

test('obs.source show, hide, toggle; current scene by default; missing source', async () => {
    const item = () => mock.state.scenes.Main.find((i) => i.source === 'Now Playing');
    assert.deepEqual(await run('obs.source', { source: 'Now Playing', visible: 'show' }), { scene: 'Main', source: 'Now Playing', visible: true });
    assert.equal(item().enabled, true);
    await run('obs.source', { scene: 'Main', source: 'Now Playing', visible: 'hide' });
    assert.equal(item().enabled, false);
    await run('obs.source', { source: 'Now Playing', visible: 'toggle' });
    assert.equal(item().enabled, true);
    await run('obs.source', { source: 'Now Playing' });
    assert.equal(item().enabled, false);
    assert.equal(await code(run('obs.source', { source: 'Ghost' })), 'source_not_found');
});

test('obs.mute and obs.volume', async () => {
    await run('obs.mute', { input: 'Mic', state: 'mute' });
    assert.equal(mock.state.inputs.Mic.muted, true);
    await run('obs.mute', { input: 'Mic', state: 'unmute' });
    assert.equal(mock.state.inputs.Mic.muted, false);
    assert.deepEqual(await run('obs.mute', { input: 'Mic' }), { input: 'Mic', muted: true });
    assert.equal(await code(run('obs.mute', { input: 'Nope' })), 'input_not_found');
    await run('obs.volume', { input: 'Desktop', volume: 40 });
    assert.equal(mock.state.inputs.Desktop.mul, 0.4);
    assert.equal(await code(run('obs.volume', { input: 'Desktop', volume: 140 })), 'bad_params');
});

test('obs.filter enable, disable, toggle', async () => {
    await run('obs.filter', { source: 'Mic', filter: 'Compressor', state: 'enable' });
    assert.equal(mock.state.filters.Mic.Compressor, true);
    await run('obs.filter', { source: 'Mic', filter: 'Compressor', state: 'disable' });
    assert.equal(mock.state.filters.Mic.Compressor, false);
    assert.deepEqual(await run('obs.filter', { source: 'Mic', filter: 'Compressor' }), { source: 'Mic', filter: 'Compressor', enabled: true });
    assert.equal(await code(run('obs.filter', { source: 'Mic', filter: 'Reverb' })), 'filter_not_found');
});

test('obs.stream start/stop/toggle, idempotent, with forwarded events', async () => {
    events.length = 0;
    assert.deepEqual(await run('obs.stream', { state: 'start' }), { streaming: true, changed: true });
    assert.deepEqual(await run('obs.stream', { state: 'start' }), { streaming: true, changed: false });
    await until(() => events.some((e) => e.type === 'obs.stream_started'));
    assert.deepEqual(await run('obs.stream', { state: 'toggle' }), { streaming: false, changed: true });
    await until(() => events.some((e) => e.type === 'obs.stream_stopped'));
    assert.equal(mock.state.stream, false);
});

test('obs.record start, pause, resume, toggle_pause, stop', async () => {
    events.length = 0;
    assert.equal(await code(run('obs.record', { state: 'pause' })), 'not_recording');
    await run('obs.record', { state: 'start' });
    assert.equal(mock.state.record, true);
    await run('obs.record', { state: 'pause' });
    assert.equal(mock.state.recordPaused, true);
    await run('obs.record', { state: 'resume' });
    assert.equal(mock.state.recordPaused, false);
    await run('obs.record', { state: 'toggle_pause' });
    assert.equal(mock.state.recordPaused, true);
    await run('obs.record', { state: 'stop' });
    assert.equal(mock.state.record, false);
    await until(() => ['obs.recording_started', 'obs.recording_paused', 'obs.recording_resumed', 'obs.recording_stopped'].every((t) => events.some((e) => e.type === t)));
});

test('obs.replay: save needs the buffer running; start, save, stop', async () => {
    events.length = 0;
    assert.equal(await code(run('obs.replay', {})), 'replay_buffer_off');
    await run('obs.replay', { state: 'start' });
    assert.deepEqual(await run('obs.replay', {}), { saved: true });
    assert.equal(mock.state.replaySaves, 1);
    await until(() => events.find((e) => e.type === 'obs.replay_saved'));
    assert.equal(events.find((e) => e.type === 'obs.replay_saved').metadata.file, 'Replay 2026-11-19.mkv', 'file name only, no folder');
    await run('obs.replay', { state: 'stop' });
    assert.equal(mock.state.replay, false);
});

test('obs.virtualcam', async () => {
    await run('obs.virtualcam', { state: 'start' });
    assert.equal(mock.state.vcam, true);
    await run('obs.virtualcam', {});
    assert.equal(mock.state.vcam, false);
});

test('obs.screenshot of a source or of what is on air, saved in the app folder', async () => {
    const r = await run('obs.screenshot', { source: 'Webcam' });
    assert.match(r.file, /^Webcam .+\.png$/);
    const last = mock.state.screenshots.at(-1);
    assert.equal(last.sourceName, 'Webcam');
    assert.equal(path.dirname(last.imageFilePath), shots);
    assert.equal(last.imageFormat, 'png');
    const r2 = await run('obs.screenshot', {});
    assert.equal(r2.source, 'Main');
    assert.equal(await code(run('obs.screenshot', { source: 'Nope' })), 'source_not_found');
});

test('obs.text only on text sources', async () => {
    await run('obs.text', { source: 'Now Playing', text: 'Lofi beats' });
    assert.equal(mock.state.inputs['Now Playing'].settings.text, 'Lofi beats');
    assert.equal(await code(run('obs.text', { source: 'Mic', text: 'x' })), 'not_a_text_source');
    assert.equal(await code(run('obs.text', { source: 'Nope', text: 'x' })), 'source_not_found');
});

test('obs.browser_url and obs.browser_refresh only on browser sources', async () => {
    await run('obs.browser_url', { source: 'Alert Box', url: 'https://certifriedmultitool.com/overlay/x' });
    assert.equal(mock.state.inputs['Alert Box'].settings.url, 'https://certifriedmultitool.com/overlay/x');
    assert.equal(await code(run('obs.browser_url', { source: 'Alert Box', url: 'file:///C:/x.html' })), 'bad_params');
    assert.equal(await code(run('obs.browser_url', { source: 'Now Playing', url: 'https://a.example' })), 'not_a_browser_source');
    await run('obs.browser_refresh', { source: 'Alert Box' });
    assert.equal(mock.state.inputs['Alert Box'].refreshed, 1);
    assert.equal(await code(run('obs.browser_refresh', { source: 'Webcam' })), 'not_a_browser_source');
});

test('obs.hotkey by name', async () => {
    await run('obs.hotkey', { name: 'OBSBasic.Screenshot' });
    assert.deepEqual(mock.state.hotkeysPressed, ['OBSBasic.Screenshot']);
    assert.equal(await code(run('obs.hotkey', { name: 'Nope.Nothing' })), 'hotkey_not_found');
});

test('the router acks every obs action; OBS gone → obs_not_connected; unknown → unsupported_action', async () => {
    const router = createRouter({ obs, sound: null, library: null, keys: null, screenshotDir: shots });
    for (const t of OBS_ACTIONS) assert.ok(router.handles(t), t);
    const ok = await router.run('obs.scene', { scene: 'BRB' });
    assert.deepEqual(ok, { ok: true, result: { scene: 'BRB' } });
    const bad = await router.run('obs.scene', { scene: 'Nope' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /^scene_not_found/);
    assert.deepEqual(await router.run('light.set', {}), { ok: false, error: 'not_supported_yet' });
    assert.deepEqual(await router.run('obs.teleport', {}), { ok: false, error: 'unsupported_action' });
    await router.run('obs.scene', { scene: 'Main' });
    const offline = createObs({});
    const r2 = createRouter({ obs: offline, screenshotDir: shots });
    assert.deepEqual(await r2.run('obs.scene', { scene: 'Main' }), { ok: false, error: 'obs_not_connected: OBS is not connected' });
});

test('scene list changes refresh the snapshot; a dropped connection is retried', async () => {
    mock.state.scenes.Intermission = [];
    mock.emit('SceneListChanged', {});
    await until(() => obs.snapshot().scenes.includes('Intermission'));
    mock.dropClients();
    await until(() => obs.status === 'unreachable' || obs.status === 'connecting');
    await until(() => obs.connected, 4000);
});
