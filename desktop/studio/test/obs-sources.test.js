'use strict';
/*
 * Studio 0.2.7 OBS actions (src/main/obs-sources.js) against the mock obs-websocket v5 server (never a real OBS):
 * a CertiFried overlay added as a hidden browser source next to the source it replaces, in several scenes, with the
 * replaced source's transform; refused while live; another program's source of that name left alone; the scene on air
 * never changed; reading scene items (with what a CertiFried source replaces); showing and hiding for the switchover;
 * and closing only Firebot / Streamer.bot by name.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startMockObs } = require('./mock-obs');
const { createObs } = require('../src/main/obs');
const { createRouter } = require('../src/main/router');
const { sourceHandlers, addBrowserSource, setSceneItems, sceneItems, closeApps, cleanTransform, outputStatus } = require('../src/main/obs-sources');

const URL_A = `https://certifriedmultitool.com/stream/bot/overlay/alerts/sbo_${'A'.repeat(32)}`;
const resolveOverlay = async (id) => (id === 2 ? { id: 2, type: 'alerts', url: URL_A, sourceName: 'CertiFried Alerts' } : null);

async function connected() {
    const mock = await startMockObs();
    const obs = createObs({});
    obs.configure({ enabled: true, host: '127.0.0.1', port: mock.port });
    for (let i = 0; i < 100 && !obs.connected; i++) await new Promise((r) => setTimeout(r, 30));
    assert.ok(obs.connected);
    return { mock, obs, done: async () => { obs.stop(); await mock.close(); } };
}

const T_INNER = { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, alignment: 5, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 2560, boundsHeight: 1440, boundsAlignment: 0 };
const T_CROP = { positionX: 2119, positionY: 266, scaleX: 0.9628821, scaleY: 0.962963, alignment: 5, cropLeft: 178, cropTop: 233, cropRight: 164, cropBottom: 205, boundsType: 'OBS_BOUNDS_NONE' };

test('transforms are checked: bounds only with a bounds type, numbers in range, unknown bounds types refused', () => {
    const t = cleanTransform(T_CROP);
    assert.equal(t.boundsWidth, undefined, 'no bounds sent without a bounds type (OBS refuses 0)');
    assert.deepEqual([t.cropLeft, t.cropTop, t.cropRight, t.cropBottom], [178, 233, 164, 205]);
    assert.equal(cleanTransform(T_INNER).boundsWidth, 2560);
    assert.throws(() => cleanTransform({ boundsType: 'OBS_BOUNDS_WOBBLE' }), /unknown boundsType/);
    assert.throws(() => cleanTransform({ scaleX: 'big' }), /scaleX/);
    assert.throws(() => cleanTransform({ boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 0, boundsHeight: 5 }), /boundsWidth/);
});

test('a CertiFried overlay goes in hidden, above the source it replaces, in every scene, with its transform; the scene on air stays', async () => {
    const { mock, obs, done } = await connected();
    try {
        mock.state.scenes.BRB.push({ id: 2, source: 'Alert Box', enabled: true });
        const before = JSON.stringify(mock.state.inputs['Alert Box']);
        const r = await addBrowserSource(obs, {
            name: 'CertiFried Alerts', overlayId: 2, width: 800, height: 600, replaces: 'Alert Box', monitor: 'both',
            placements: [{ scene: 'Main', nextTo: 'Alert Box', transform: T_CROP }, { scene: 'BRB', nextTo: 'Alert Box', transform: T_INNER }],
        }, { resolveOverlay });
        assert.equal(r.created, true);
        assert.equal(r.sceneOnAirUnchanged, true);
        assert.equal(mock.state.program, 'Main');
        const inp = mock.state.inputs['CertiFried Alerts'];
        assert.equal(inp.kind, 'browser_source');
        assert.deepEqual([inp.settings.url, inp.settings.width, inp.settings.height, inp.settings.reroute_audio], [URL_A, 800, 600, true]);
        assert.deepEqual([inp.settings.certifried_overlay, inp.settings.certifried_replaces], [2, 'Alert Box'], 'it remembers what it replaces');
        assert.equal(inp.monitor, 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT');
        for (const scene of ['Main', 'BRB']) {
            const items = mock.state.scenes[scene];
            const i = items.findIndex((x) => x.source === 'CertiFried Alerts');
            const ref = items.findIndex((x) => x.source === 'Alert Box');
            assert.equal(i, ref + 1, `${scene}: directly above the source it replaces`);
            assert.equal(items[i].enabled, false, `${scene}: hidden`);
        }
        assert.equal(mock.state.scenes.Main.find((x) => x.source === 'CertiFried Alerts').transform.cropLeft, 178);
        assert.equal(mock.state.scenes.BRB.find((x) => x.source === 'CertiFried Alerts').transform.boundsType, 'OBS_BOUNDS_SCALE_INNER');
        assert.equal(JSON.stringify(mock.state.inputs['Alert Box']), before, 'the old source is not touched');
        assert.ok(!mock.requests.some((q) => q.requestType === 'SetCurrentProgramScene'), 'never switches scenes');
        assert.ok(!mock.requests.some((q) => ['RemoveInput', 'SetInputAudioTracks'].includes(q.requestType)));

        // Again: nothing doubled, still hidden.
        const again = await addBrowserSource(obs, { name: 'CertiFried Alerts', overlayId: 2, placements: [{ scene: 'Main', nextTo: 'Alert Box', transform: T_CROP }] }, { resolveOverlay });
        assert.equal(again.created, false);
        assert.equal(mock.state.scenes.Main.filter((x) => x.source === 'CertiFried Alerts').length, 1);
        assert.equal(mock.state.scenes.Main.find((x) => x.source === 'CertiFried Alerts').enabled, false);

        // Reading back: the CertiFried source says what it replaces.
        const read = await sceneItems(obs, { scenes: ['Main', 'Nope'] });
        assert.deepEqual(read.scenes.Main.find((x) => x.source === 'CertiFried Alerts').certifried, { overlayId: 2, replaces: 'Alert Box' });
        assert.equal(read.scenes.Main.find((x) => x.source === 'Webcam').certifried, undefined);
        assert.equal(read.scenes.Nope, null, 'a missing scene is reported, not thrown');
    } finally { await done(); }
});

test('refused while streaming or recording, for a name that is someone else\'s, and for an overlay the server does not list', async () => {
    const { mock, obs, done } = await connected();
    try {
        const add = (p) => addBrowserSource(obs, { name: 'CertiFried Alerts', overlayId: 2, placements: [{ scene: 'Main', transform: {} }], ...p }, { resolveOverlay });
        mock.state.stream = true;
        await assert.rejects(add({}), (e) => e.code === 'obs_live');
        mock.state.stream = false; mock.state.record = true;
        await assert.rejects(add({}), (e) => e.code === 'obs_live');
        mock.state.record = false;
        assert.equal(mock.state.inputs['CertiFried Alerts'], undefined, 'nothing was added while live');
        mock.state.inputs['CertiFried Alerts'] = { kind: 'browser_source', settings: { url: 'https://example.com/mine' }, uuid: 'x', tracks: {}, monitor: 'OBS_MONITORING_TYPE_NONE' };
        await assert.rejects(add({}), (e) => e.code === 'name_taken');
        assert.equal(mock.state.inputs['CertiFried Alerts'].settings.url, 'https://example.com/mine', 'their source is left alone');
        await assert.rejects(add({ name: 'CertiFried Other', overlayId: 99 }), (e) => e.code === 'overlay_not_found');
        await assert.rejects(add({ name: 'Alerts' }), (e) => e.code === 'bad_params', 'only CertiFried names');
        await assert.rejects(add({ name: 'CertiFried X', placements: [] }), (e) => e.code === 'bad_params');
        assert.deepEqual(await outputStatus(obs), { streaming: false, recording: false, currentScene: 'Main', studioMode: false });
    } finally { await done(); }
});

test('show and hide for the switchover: previous states come back for the undo; a missing source is reported per change', async () => {
    const { mock, obs, done } = await connected();
    try {
        const r = await setSceneItems(obs, { changes: [
            { scene: 'Main', source: 'Alert Box', enabled: false }, { scene: 'Main', source: 'Now Playing', enabled: true },
            { scene: 'Main', source: 'Gone', enabled: true }, { scene: 'Nope', source: 'X', enabled: true },
        ] });
        assert.deepEqual(r.changes.map((c) => [c.source, c.ok, c.previous, c.error || null]), [
            ['Alert Box', true, true, null], ['Now Playing', true, false, null], ['Gone', false, undefined, 'source_not_found'], ['X', false, undefined, 'scene_not_found'],
        ]);
        assert.equal(mock.state.scenes.Main.find((x) => x.source === 'Alert Box').enabled, false);
        const undo = await setSceneItems(obs, { changes: r.changes.filter((c) => c.ok).map((c) => ({ scene: c.scene, source: c.source, enabled: c.previous })) });
        assert.ok(undo.changes.every((c) => c.ok));
        assert.equal(mock.state.scenes.Main.find((x) => x.source === 'Alert Box').enabled, true);
        assert.equal(mock.state.scenes.Main.find((x) => x.source === 'Now Playing').enabled, false);
        mock.state.stream = true;
        await assert.rejects(setSceneItems(obs, { idleOnly: true, changes: [{ scene: 'Main', source: 'Alert Box', enabled: false }] }), (e) => e.code === 'obs_live');
        await assert.rejects(setSceneItems(obs, { changes: [] }), (e) => e.code === 'bad_params');
    } finally { await done(); }
});

test('closing apps: only Firebot and Streamer.bot, by exact name, gently (no /F); never anything else', async () => {
    const calls = [];
    let up = { 'Firebot v5.exe': true, 'Streamer.bot.exe': true };
    const execFileSync = (cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd === 'tasklist') { const img = args[1].replace('IMAGENAME eq ', ''); return up[img] ? `"${img}","123","Console","1","100 K"\r\n` : 'INFO: No tasks are running which match the specified criteria.\r\n'; }
        if (cmd === 'taskkill') { if (args[1] === 'Firebot v5.exe') up[args[1]] = false; return ''; }
        throw new Error('unexpected');
    };
    const r = await closeApps({ apps: ['firebot', 'streamerbot', 'firebot'] }, { execFileSync, platform: 'win32', wait: async () => {}, settleMs: 0 });
    assert.deepEqual(r.apps.map((a) => [a.app, a.wasRunning, a.closed, a.stillRunning]), [['firebot', true, true, false], ['streamerbot', true, false, true]]);
    assert.ok(calls.filter((c) => c[0] === 'taskkill').every((c) => !c.includes('/F') && !c.includes('/T')), 'never forced');
    assert.deepEqual(calls.filter((c) => c[0] === 'taskkill').map((c) => c[2]), ['Firebot v5.exe', 'Streamer.bot.exe']);
    await assert.rejects(closeApps({ apps: ['obs'] }, { execFileSync, platform: 'win32' }), (e) => e.code === 'bad_params');
    await assert.rejects(closeApps({ apps: ['firebot', 'obs64'] }, { execFileSync, platform: 'win32' }), (e) => e.code === 'bad_params');
    await assert.rejects(closeApps({ apps: ['firebot'] }, { execFileSync, platform: 'linux' }), (e) => e.code === 'not_windows');
    up = {};
    const none = await closeApps({ apps: ['streamerbot'] }, { execFileSync, platform: 'win32', wait: async () => {}, settleMs: 0 });
    assert.deepEqual(none.apps[0], { app: 'streamerbot', image: 'Streamer.bot.exe', wasRunning: false, closed: false, stillRunning: false });
});

test('the router carries the new actions and announces the apps capability', async () => {
    const { mock, obs, done } = await connected();
    try {
        const router = createRouter({ obs, sound: {}, library: {}, keys: {}, extra: sourceHandlers(obs, { resolveOverlay }) });
        assert.ok(router.capabilities().includes('apps'));
        for (const a of ['obs.output_status', 'obs.scene_items', 'obs.add_browser_source', 'obs.set_scene_items', 'studio.close_apps']) assert.ok(router.handles(a), a);
        const st = await router.run('obs.output_status', {});
        assert.deepEqual(st, { ok: true, result: { streaming: false, recording: false, currentScene: 'Main', studioMode: false } });
        mock.state.record = true;
        const live = await router.run('obs.add_browser_source', { name: 'CertiFried Alerts', overlayId: 2, placements: [{ scene: 'Main', transform: {} }] });
        assert.equal(live.ok, false);
        assert.match(live.error, /^obs_live/);
    } finally { await done(); }
});

test('scene screens are CertiFried overlays too (Set up OBS and obs.add_browser_source keep their addresses)', () => {
    const { cleanOverlays } = require('../src/main/obs-overlays');
    const list = cleanOverlays([{ id: 5, type: 'scene', name: 'Starting soon', sourceName: 'CertiFried Scene', url: `https://certifriedmultitool.com/stream/bot/overlay/scene/sbo_${'S'.repeat(32)}` }]);
    assert.equal(list.length, 1);
    assert.equal(list[0].type, 'scene');
    assert.equal(list[0].sourceName, 'CertiFried Scene');
});
