'use strict';
/*
 * CertiFried overlays in Set up OBS (0.2.5): the server's overlays.list cleaned (only CertiFried overlay addresses), what each
 * click will do, and adding browser sources against the mock obs-websocket server (never a real OBS). Also: the alert box's
 * source name is one the VOD-safe check lists, so the streamer can keep alert sounds out of the VOD.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanOverlays, planOverlay, addOverlay, browserInputs } = require('../src/main/obs-overlays');
const { MUSICY } = require('../src/main/vod-safe');
const { startMockObs } = require('./mock-obs');
const { createObs } = require('../src/main/obs');

const KEY = (c) => `sbo_${c.repeat(32)}`;
const ITEM = (type, c, extra = {}) => ({ id: c.charCodeAt(0), type, label: type, name: `My ${type}`, sourceName: `CertiFried ${type === 'alerts' ? 'Alerts' : 'Chat'}`, audio: type === 'alerts',
    url: `https://certifriedmultitool.com/stream/bot/overlay/${type}/${KEY(c)}`, width: 1920, height: 1080, ...extra });

test('only CertiFried overlay addresses are kept, and several of one kind get their own source names', () => {
    const list = cleanOverlays([
        ITEM('alerts', 'A'),
        ITEM('chat', 'B'),
        ITEM('alerts', 'C', { name: 'Second scene' }),
        { ...ITEM('chat', 'D'), url: 'http://certifriedmultitool.com/stream/bot/overlay/chat/' + KEY('D') },
        { ...ITEM('chat', 'E'), url: 'https://evil.example/stream/bot/overlay/chat/' + KEY('E') },
        { ...ITEM('chat', 'F'), url: 'https://certifriedmultitool.com/stream/bot/overlay/music/sbm_' + 'F'.repeat(32) },
        { ...ITEM('chat', 'G'), url: `https://certifriedmultitool.com/stream/bot/overlay/chat/${KEY('G')}?x=1` },
        { ...ITEM('chat', 'H'), sourceName: 'Evil <b>name</b>' },
        null,
    ], { origin: 'https://certifriedmultitool.com' });
    assert.deepEqual(list.map((o) => o.sourceName), ['CertiFried Alerts - My alerts', 'CertiFried Chat', 'CertiFried Alerts - Second scene', 'CertiFried Overlay']);
    assert.ok(list.every((o) => o.width === 1920 && o.height === 1080));
    const local = cleanOverlays([{ ...ITEM('goal', 'Z'), url: `http://127.0.0.1:3001/stream/bot/overlay/goal/${KEY('Z')}` }], { origin: 'http://127.0.0.1:3001' });
    assert.equal(local.length, 1, 'a server set in Settings (tests, demos) works');
    assert.equal(cleanOverlays([ITEM('alerts', 'A')])[0].sourceName, 'CertiFried Alerts', 'one of a kind keeps the plain name');
});

test('the plan says what a click will do before it is clicked', () => {
    const [o] = cleanOverlays([ITEM('alerts', 'A')]);
    const snap = { currentScene: 'Game', sources: { Game: ['Webcam', 'CertiFried Alerts'] } };
    assert.equal(planOverlay(snap, o, []).action, 'add');
    assert.match(planOverlay(snap, o, []).text, /Adds a browser source "CertiFried Alerts" \(1920 × 1080\) to Game\. Its sounds go through OBS/);
    assert.equal(planOverlay(snap, o, [{ inputName: 'CertiFried Alerts', url: o.url }]).action, 'there');
    assert.equal(planOverlay({ currentScene: 'BRB', sources: { BRB: [] } }, o, [{ inputName: 'CertiFried Alerts', url: o.url }]).action, 'scene');
    assert.equal(planOverlay(snap, o, [{ inputName: 'CertiFried Alerts', url: `https://certifriedmultitool.com/stream/bot/overlay/alerts/${KEY('Q')}` }]).action, 'update');
    const own = planOverlay(snap, o, [{ inputName: 'CertiFried Alerts', url: 'https://streamlabs.com/alert-box/v3/xyz' }]);
    assert.deepEqual([own.action, own.sourceName], ['add', 'CertiFried Alerts 2'], 'a source of the person own with that name is left alone');
    assert.equal(planOverlay({}, o, []).action, 'none');
});

test('adding against the mock OBS: one browser source in the scene on air, audio through OBS, never twice; a new key updates it', async () => {
    const mock = await startMockObs();
    const obs = createObs({});
    obs.configure({ enabled: true, host: '127.0.0.1', port: mock.port });
    for (let i = 0; i < 100 && !obs.connected; i++) await new Promise((r) => setTimeout(r, 30));
    try {
        const [alerts, chat] = cleanOverlays([ITEM('alerts', 'A'), ITEM('chat', 'B')]);
        const before = JSON.stringify({ ...mock.state.inputs, 'Alert Box': mock.state.inputs['Alert Box'] });
        const r = await addOverlay(obs, alerts);
        assert.deepEqual(r, { scene: 'Main', sourceName: 'CertiFried Alerts', action: 'add' });
        const inp = mock.state.inputs['CertiFried Alerts'];
        assert.equal(inp.kind, 'browser_source');
        assert.deepEqual([inp.settings.url, inp.settings.width, inp.settings.height, inp.settings.reroute_audio], [alerts.url, 1920, 1080, true]);
        assert.equal(inp.monitor, 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT', 'the streamer hears alerts');
        assert.ok(mock.state.scenes.Main.some((s) => s.source === 'CertiFried Alerts'));
        assert.equal(JSON.stringify(mock.state.inputs['Alert Box']), JSON.stringify(JSON.parse(before)['Alert Box']), 'their old alert box is untouched');
        assert.equal((await addOverlay(obs, alerts)).action, 'there');
        assert.equal(mock.state.scenes.Main.filter((s) => s.source === 'CertiFried Alerts').length, 1, 'not added twice');
        await addOverlay(obs, chat);
        assert.equal(mock.state.inputs['CertiFried Chat'].monitor, 'OBS_MONITORING_TYPE_NONE', 'no monitoring for a silent overlay');
        // Regenerated on the dashboard: same source, new address.
        const [fresh] = cleanOverlays([ITEM('alerts', 'N')]);
        assert.equal((await addOverlay(obs, fresh)).action, 'update');
        assert.equal(mock.state.inputs['CertiFried Alerts'].settings.url, fresh.url);
        // Another scene on air: the same source is put into it, not made again.
        mock.state.program = 'BRB';
        assert.deepEqual(await addOverlay(obs, fresh), { scene: 'BRB', sourceName: 'CertiFried Alerts', action: 'scene' });
        assert.ok(mock.state.scenes.BRB.some((s) => s.source === 'CertiFried Alerts'));
        const inputs = await browserInputs(obs);
        assert.ok(inputs.some((i) => i.inputName === 'Alert Box' && i.url === 'https://example.com/a'));
        const off = createObs({});
        await assert.rejects(addOverlay(off, alerts), { code: 'obs_not_connected' });
    } finally { obs.stop(); await mock.close(); }
});

test('the VOD-safe check lists the alert box and the media overlay by name, not the silent ones', () => {
    assert.ok(MUSICY.test('CertiFried Alerts'));
    assert.ok(MUSICY.test('CertiFried Alerts - Second scene'));
    assert.ok(MUSICY.test('CertiFried Canvas'));
    assert.equal(MUSICY.test('CertiFried Chat'), false);
    assert.equal(MUSICY.test('CertiFried Goal'), false);
    assert.ok(MUSICY.test('Sound Alerts'), 'the old ones still match');
});
