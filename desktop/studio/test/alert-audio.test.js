'use strict';
/*
 * Sound Alerts and Blerp audio (src/main/alert-audio.js, 0.2.10) against the mock obs-websocket server through the real
 * client: which sources match, "Control audio via OBS" + monitoring + every track but the VOD track, the old settings
 * recorded before the first change and put back by undo, refusal while live and without a VOD track, and the
 * obs.alert_audio action with its 'alertaudio' capability.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startMockObs } = require('./mock-obs');
const { createObs } = require('../src/main/obs');
const { createAlertAudio, kindOf } = require('../src/main/alert-audio');
const { createRouter } = require('../src/main/router');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(25); } }
const all = () => ({ 1: true, 2: true, 3: true, 4: true, 5: true, 6: true });

async function setup({ vodTrack = 2 } = {}) {
    const mock = await startMockObs();
    const add = (name, url, extra = {}) => { mock.state.inputs[name] = { kind: 'browser_source', muted: false, mul: 1, settings: { url, ...(extra.settings || {}) }, uuid: `uuid-${name}`, tracks: all(), monitor: 'OBS_MONITORING_TYPE_NONE', ...extra.input }; };
    add('SoundAlerts', 'https://source.soundalerts.com/alert/abc?layout=1');
    add('Blerp Beats', 'https://blerp.com/x/stream/overlay/123');
    add('My sound alerts copy', 'https://example.com/not-soundalerts');
    add('CertiFried Alerts', 'https://certifriedmultitool.com/stream/bot/overlay/alerts/k');
    add('Sound Alerts (local)', '');
    const obs = createObs({ retry: { min: 50, max: 100 } });
    obs.configure({ enabled: true, host: '127.0.0.1', port: mock.port });
    await until(() => obs.connected);
    let saved = { managed: false, at: null, sources: [] };
    const writes = [];
    const aa = createAlertAudio({ obs, getVod: async () => ({ vodTrack }), getSaved: () => saved, save: (v) => { saved = JSON.parse(JSON.stringify(v)); writes.push(saved); } });
    return { mock, obs, aa, get saved() { return saved; }, writes, close: async () => { obs.stop(); await mock.close(); } };
}

test('kindOf: the address decides; the name only when there is no address', () => {
    assert.equal(kindOf('anything', 'https://source.soundalerts.com/alert/x'), 'soundalerts');
    assert.equal(kindOf('anything', 'https://www.blerp.com/x'), 'blerp');
    assert.equal(kindOf('Sound Alerts', 'https://example.com/a'), null, 'another site, whatever it is called');
    assert.equal(kindOf('SoundAlerts', ''), 'soundalerts');
    assert.equal(kindOf('blerp', undefined), 'blerp');
    assert.equal(kindOf('CertiFried Alerts', 'https://certifriedmultitool.com/x'), null);
    assert.equal(kindOf('notsoundalerts.com.evil', 'https://soundalerts.com.evil.example/x'), null);
});

test('apply: reroute, monitor and every track but the VOD track; old values recorded first; undo puts them back', async () => {
    const t = await setup();
    try {
        const S = t.mock.state.inputs;
        S.SoundAlerts.tracks = { 1: true, 2: true, 3: false, 4: false, 5: false, 6: false };
        S.SoundAlerts.monitor = 'OBS_MONITORING_TYPE_MONITOR_ONLY';
        const found = await t.aa.find();
        assert.deepEqual(found.map((x) => x.name).sort(), ['Blerp Beats', 'Sound Alerts (local)', 'SoundAlerts']);
        const r = await t.aa.apply();
        assert.deepEqual(r.applied.sort(), ['Blerp Beats', 'Sound Alerts (local)', 'SoundAlerts']);
        assert.equal(r.vodTrack, 2);
        for (const n of r.applied) {
            assert.equal(S[n].settings.reroute_audio, true, `${n} reroute`);
            assert.equal(S[n].monitor, 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT', `${n} monitor`);
            assert.deepEqual(S[n].tracks, { 1: true, 2: false, 3: true, 4: true, 5: true, 6: true }, `${n} tracks`);
        }
        assert.equal(S['My sound alerts copy'].settings.reroute_audio, undefined, 'not touched');
        assert.equal(S['CertiFried Alerts'].settings.reroute_audio, undefined, 'not touched');
        assert.equal(t.writes[0].sources.length, 1, 'the first source was recorded before anything changed');
        assert.equal(t.saved.managed, true);
        const rec = t.saved.sources.find((x) => x.name === 'SoundAlerts');
        assert.deepEqual(rec.prev, { reroute_audio: false, monitorType: 'OBS_MONITORING_TYPE_MONITOR_ONLY', tracks: { 1: true, 2: true, 3: false, 4: false, 5: false, 6: false } });

        await t.aa.apply();
        assert.deepEqual(t.saved.sources.find((x) => x.name === 'SoundAlerts').prev, rec.prev, 'a second apply keeps the first record');

        const u = await t.aa.undo();
        assert.equal(u.restored.length, 3);
        assert.equal(S.SoundAlerts.settings.reroute_audio, false);
        assert.equal(S.SoundAlerts.monitor, 'OBS_MONITORING_TYPE_MONITOR_ONLY');
        assert.deepEqual(S.SoundAlerts.tracks, { 1: true, 2: true, 3: false, 4: false, 5: false, 6: false });
        assert.deepEqual(S['Blerp Beats'].tracks, all());
        assert.deepEqual(t.aa.status(), { managed: false, at: null, sources: [] });
    } finally { await t.close(); }
});

test('refused while streaming or recording, and without a VOD track; nothing changes', async () => {
    const t = await setup();
    try {
        t.mock.state.stream = true;
        await assert.rejects(() => t.aa.apply(), (e) => e.code === 'live');
        assert.equal(t.mock.state.inputs.SoundAlerts.settings.reroute_audio, undefined);
        t.mock.state.stream = false;
        t.mock.state.record = true;
        await assert.rejects(() => t.aa.apply(), (e) => e.code === 'live');
    } finally { await t.close(); }
    const t2 = await setup({ vodTrack: null });
    try {
        await assert.rejects(() => t2.aa.apply(), (e) => e.code === 'no_vod_track');
        assert.equal(t2.saved.managed, false);
    } finally { await t2.close(); }
});

test('obs.alert_audio through the router; the capability is announced', async () => {
    const t = await setup();
    try {
        const router = createRouter({ obs: t.obs, sound: {}, library: {}, keys: {}, extra: { 'obs.alert_audio': (p) => (p.undo ? t.aa.undo() : t.aa.apply()) } });
        assert.ok(router.capabilities().includes('alertaudio'));
        const r = await router.run('obs.alert_audio', {});
        assert.equal(r.ok, true);
        assert.equal(r.result.applied.length, 3);
        const u = await router.run('obs.alert_audio', { undo: true });
        assert.equal(u.ok, true);
        assert.equal(u.result.restored.length, 3);
        t.mock.state.stream = true;
        const live = await router.run('obs.alert_audio', {});
        assert.equal(live.ok, false);
        assert.match(live.error, /^live/);
    } finally { await t.close(); }
});
