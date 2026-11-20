'use strict';
/*
 * VOD-safe music only for streamers who use song requests (0.2.6): src/main/vod-safe.js with enforcement off and on, against the
 * mock obs-websocket server through the real client. Off: nothing in OBS is created or changed (no music source, no profile
 * write, no track change), even on OBS events, while the music-sounding sources and the Desktop Audio warning are still listed.
 * Turned on: enforcement starts at once. Turned off later: the source stays until the person removes it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMockObs } = require('./mock-obs');
const { createObs } = require('../src/main/obs');
const { createVodSafe, REASONS } = require('../src/main/vod-safe');
const { backupProfileIni } = require('../src/main/obs-docks');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(25); } }

async function setup({ profile = {}, enforced = false } = {}) {
    const mock = await startMockObs();
    Object.assign(mock.state.profile, profile);
    const all = () => ({ 1: true, 2: true, 3: true, 4: true, 5: true, 6: true });
    mock.state.inputs['BGM-START'] = { kind: 'ffmpeg_source', muted: false, mul: 1, settings: {}, uuid: 'uuid-bgm', tracks: all(), monitor: 'OBS_MONITORING_TYPE_NONE' };
    mock.state.inputs['Desktop Audio'] = { kind: 'wasapi_output_capture', muted: false, mul: 1, settings: {}, uuid: 'uuid-desk', tracks: all(), monitor: 'OBS_MONITORING_TYPE_NONE' };
    const obs = createObs({ retry: { min: 50, max: 100 } });
    obs.configure({ enabled: true, host: '127.0.0.1', port: mock.port });
    await until(() => obs.connected);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-obsdir-'));
    const prof = path.join(dir, 'basic', 'profiles', 'Untitled');
    fs.mkdirSync(prof, { recursive: true });
    fs.writeFileSync(path.join(prof, 'basic.ini'), '[General]\nName=Default\n\n[Output]\nMode=Advanced\n\n[AdvOut]\nTrackIndex=1\n');
    let settings = { sourceUuid: null, recordWithoutMusic: false, prevRecTracks: null };
    let backups = 0;
    const vod = createVodSafe({
        obs, enforced, getSettings: () => settings, saveSettings: (p) => { settings = { ...settings, ...p }; },
        backupProfile: async () => { backups++; return backupProfileIni({ dir, profileName: (await obs.call('GetProfileList')).currentProfileName }); },
        getMusicUrl: async () => 'https://certifriedmultitool.com/stream/bot/overlay/music/k_test',
    });
    obs.on('obs-event', (n, d) => vod.onObsEvent(n, d));
    const snapshot = () => JSON.stringify({ inputs: mock.state.inputs, scenes: mock.state.scenes, profile: mock.state.profile, writes: mock.state.profileWrites });
    const close = async () => { obs.stop(); await mock.close(); fs.rmSync(dir, { recursive: true, force: true }); };
    return { mock, obs, vod, settings: () => settings, backups: () => backups, snapshot, close };
}
const musicOf = (mock) => Object.entries(mock.state.inputs).find(([, i]) => i.kind === 'browser_source' && i.settings.reroute_audio === true);

test('song requests off: OBS is only read; warnings are still listed; songs are refused', async () => {
    const h = await setup({ profile: { 'AdvOut.VodTrackEnabled': 'true', 'AdvOut.VodTrackIndex': '2', 'AdvOut.TrackIndex': '1' } });
    try {
        const before = h.snapshot();
        const s = await h.vod.ensure('test');
        assert.equal(s.enforced, false);
        assert.equal(s.vodSafe, false);
        assert.equal(s.reason, REASONS.not_used);
        assert.equal(s.sourceExists, false);
        assert.deepEqual(s.warnings.map((w) => w.name), ['BGM-START'], 'music-sounding sources on the VOD track are still listed');
        assert.equal(s.desktopWarning, true, 'the Desktop Audio warning is still shown');
        assert.equal(h.snapshot(), before, 'nothing in OBS changed');
        assert.equal(musicOf(h.mock), undefined, 'no CertiFried Music source');
        assert.equal(h.backups(), 0, 'no profile backup (nothing to change)');
        await assert.rejects(h.vod.prepare(), (e) => e.code === 'vod_unsafe');
        // OBS events do not start enforcement either.
        h.mock.emit('SceneCreated', { sceneName: 'New', isGroup: false });
        h.mock.emit('StreamStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
        await sleep(700);
        assert.equal(h.snapshot(), before, 'still nothing changed after OBS events');
    } finally { await h.close(); }
});

test('song requests off with the VOD track off: the VOD track is left off', async () => {
    const h = await setup({ profile: { 'AdvOut.VodTrackEnabled': 'false' } });
    try {
        const s = await h.vod.ensure('test');
        assert.equal(s.vodTrack, null);
        assert.deepEqual(s.warnings, [], 'no VOD track, so nothing to warn about');
        assert.equal(h.mock.state.profile['AdvOut.VodTrackEnabled'], 'false');
        assert.deepEqual(h.mock.state.profileWrites, []);
    } finally { await h.close(); }
});

test('turned on: enforcement starts at once; turned off later: the source stays until the person removes it', async () => {
    const h = await setup({ profile: { 'AdvOut.VodTrackEnabled': 'false' } });
    try {
        await h.vod.ensure('start');
        assert.equal(musicOf(h.mock), undefined);
        assert.equal(h.vod.setEnforced(true), true);
        assert.equal(h.vod.setEnforced(true), false, 'no change, no new run');
        const on = await until(async () => { const s = h.vod.status(); return s.vodSafe ? s : null; });
        assert.equal(on.enforced, true);
        assert.equal(on.vodTrack, 2);
        assert.equal(h.mock.state.profile['AdvOut.VodTrackEnabled'], 'true', 'VOD track turned on');
        const [name, input] = musicOf(h.mock);
        assert.equal(name, 'CertiFried Music');
        assert.equal(input.tracks['2'], false, 'music kept off the VOD track');
        await assert.rejects(h.vod.removeSource(), (e) => e.code === 'in_use', 'cannot remove it while song requests are on');

        h.vod.setEnforced(false);
        const off = await until(async () => { const s = h.vod.status(); return !s.enforced && s.reason === REASONS.not_used ? s : null; });
        assert.equal(off.sourceExists, true, 'the source made earlier is reported');
        assert.equal(off.vodSafe, false);
        const before = h.snapshot();
        h.mock.emit('InputCreated', { inputName: 'x', inputUuid: 'u', inputKind: 'ffmpeg_source' });
        await h.vod.ensure('again');
        await sleep(700);
        assert.equal(h.snapshot(), before, 'turned off: nothing is re-applied');
        assert.ok(musicOf(h.mock), 'never removed automatically');

        const after = await h.vod.removeSource();
        assert.equal(musicOf(h.mock), undefined, 'removed on the person\'s click');
        assert.deepEqual(h.mock.state.removed, ['CertiFried Music']);
        assert.equal(after.sourceExists, false);
        assert.equal(h.settings().sourceUuid, null);

        h.vod.setEnforced(true);
        await until(async () => h.vod.status().vodSafe);
        assert.ok(musicOf(h.mock), 'turned on again: made again');
    } finally { await h.close(); }
});

test('turned on while live with no VOD protection: fails closed', async () => {
    const h = await setup({ profile: { 'AdvOut.VodTrackEnabled': 'false' } });
    try {
        h.mock.state.stream = true;
        await h.vod.ensure('start');
        h.vod.setEnforced(true);
        const s = await until(async () => { const x = h.vod.status(); return x.enforced && x.reason === REASONS.live_unprotected ? x : null; });
        assert.equal(s.vodSafe, false);
        await assert.rejects(h.vod.prepare(), (e) => e.code === 'vod_unsafe');
        assert.deepEqual(h.mock.state.profileWrites, [], 'a live profile is never changed');
    } finally { await h.close(); }
});
