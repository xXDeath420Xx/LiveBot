'use strict';
/*
 * VOD-safe music (src/main/vod-safe.js) against the mock obs-websocket server, through the real client: idle fixes
 * with a profile backup, fail-closed while live, track collisions, re-application on OBS events, a renamed music
 * source, a scene collection switch, new scenes, Simple output, no backup, the person's own "Keep out of VOD" and
 * "Record without music", and the music.prepare action. A throwaway OBS profile folder stands in for the real one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMockObs } = require('./mock-obs');
const { createObs } = require('../src/main/obs');
const { createVodSafe } = require('../src/main/vod-safe');
const { backupProfileIni, findProfileIni } = require('../src/main/obs-docks');
const { createRouter } = require('../src/main/router');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(25); } }

function fakeObsDir(profileName = 'Default') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-obsdir-'));
    const prof = path.join(dir, 'basic', 'profiles', 'Untitled');
    fs.mkdirSync(prof, { recursive: true });
    fs.writeFileSync(path.join(prof, 'basic.ini'), `[General]\nName=${profileName}\n\n[Output]\nMode=Advanced\n\n[AdvOut]\nTrackIndex=1\n`);
    return dir;
}

async function setup({ profile = {}, live = false, profileName = 'Default' } = {}) {
    const mock = await startMockObs();
    Object.assign(mock.state.profile, profile);
    if (live) mock.state.stream = true;
    mock.state.inputs['BGM-START'] = { kind: 'ffmpeg_source', muted: false, mul: 1, settings: {}, uuid: 'uuid-bgm', tracks: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, monitor: 'OBS_MONITORING_TYPE_NONE' };
    mock.state.inputs['Desktop Audio'] = { kind: 'wasapi_output_capture', muted: false, mul: 1, settings: {}, uuid: 'uuid-desk', tracks: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, monitor: 'OBS_MONITORING_TYPE_NONE' };
    const obs = createObs({ retry: { min: 50, max: 100 } });
    obs.configure({ enabled: true, host: '127.0.0.1', port: mock.port });
    await until(() => obs.connected);
    const dir = fakeObsDir(profileName);
    let settings = { sourceUuid: null, recordWithoutMusic: false, prevRecTracks: null };
    const vod = createVodSafe({
        obs, getSettings: () => settings, saveSettings: (p) => { settings = { ...settings, ...p }; },
        backupProfile: async () => backupProfileIni({ dir, profileName: (await obs.call('GetProfileList')).currentProfileName }),
        getMusicUrl: async () => 'https://certifriedmultitool.com/stream/bot/overlay/music/k_test',
    });
    obs.on('obs-event', (n, d) => vod.onObsEvent(n, d));
    const close = async () => { obs.stop(); await mock.close(); fs.rmSync(dir, { recursive: true, force: true }); };
    return { mock, obs, vod, dir, settings: () => settings, close };
}

const musicOf = (mock) => Object.entries(mock.state.inputs).find(([, i]) => i.kind === 'browser_source' && i.settings.reroute_audio === true);

test('idle with the VOD track off: profile backed up, VOD track turned on, music source made safe in every scene', async () => {
    const h = await setup({ profile: { 'AdvOut.VodTrackEnabled': 'false' } });
    try {
        const s = await h.vod.ensure('test');
        assert.equal(s.vodSafe, true, s.reason);
        assert.deepEqual([s.vodTrack, s.liveTrack, s.mode], [2, 1, 'Advanced']);
        assert.equal(h.mock.state.profile['AdvOut.VodTrackEnabled'], 'true');
        const backups = fs.readdirSync(path.dirname(findProfileIni(h.dir, 'Default'))).filter((f) => f.includes('certifried-backup'));
        assert.equal(backups.length, 1, 'basic.ini backed up before the change');
        const [name, music] = musicOf(h.mock);
        assert.equal(name, 'CertiFried Music');
        assert.equal(music.settings.url, 'https://certifriedmultitool.com/stream/bot/overlay/music/k_test');
        assert.equal(music.monitor, 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT');
        assert.deepEqual(music.tracks, { 1: true, 2: false, 3: true, 4: true, 5: true, 6: true }, 'every track except the VOD track');
        for (const items of Object.values(h.mock.state.scenes)) assert.ok(items.some((it) => it.source === 'CertiFried Music'), 'in every scene');
        assert.equal(h.settings().sourceUuid, music.uuid, 'remembered by UUID');
        assert.deepEqual(s.warnings.map((w) => w.name), ['BGM-START'], 'music-looking sources on the VOD track are reported');
        assert.equal(s.desktopWarning, true);
        assert.equal(h.mock.state.inputs['BGM-START'].tracks[2], true, 'reported, not changed');
        assert.deepEqual(await h.vod.prepare(), { vodSafe: true, vodTrack: 2, source: 'CertiFried Music' });
    } finally { await h.close(); }
});

test('live without protection: fail closed, nothing changed, songs refused', async () => {
    const h = await setup({ profile: { 'AdvOut.VodTrackEnabled': 'false' }, live: true });
    try {
        const s = await h.vod.ensure('test');
        assert.equal(s.vodSafe, false);
        assert.match(s.reason, /turns on at the next stream start/);
        assert.equal(h.mock.state.profileWrites.length, 0, 'the profile is never changed while live');
        assert.equal(musicOf(h.mock), undefined);
        await assert.rejects(h.vod.prepare(), { code: 'vod_unsafe' });
        const router = createRouter({ obs: h.obs, extra: { 'music.prepare': () => h.vod.prepare() } });
        const r = await router.run('music.prepare', {});
        assert.equal(r.ok, false);
        assert.match(r.error, /^vod_unsafe/);
        // the stream ends: protection is turned on while idle
        h.mock.state.stream = false;
        h.mock.emit('StreamStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' });
        await until(() => h.vod.status().vodSafe);
        assert.equal(h.mock.state.profile['AdvOut.VodTrackEnabled'], 'true');
    } finally { await h.close(); }
});

test('live but already protected: music is safe (tracks set without touching the profile)', async () => {
    const h = await setup({ live: true });
    try {
        const s = await h.vod.ensure('test');
        assert.equal(s.vodSafe, true);
        assert.equal(h.mock.state.profileWrites.length, 0);
        assert.equal(musicOf(h.mock)[1].tracks[2], false);
    } finally { await h.close(); }
});

test('VOD track on the same track as the live audio: moved to another track while idle', async () => {
    const h = await setup({ profile: { 'AdvOut.TrackIndex': '2', 'AdvOut.VodTrackIndex': '2' } });
    try {
        const s = await h.vod.ensure('test');
        assert.equal(s.vodSafe, true);
        assert.deepEqual([s.liveTrack, s.vodTrack], [2, 3]);
        assert.equal(h.mock.state.profile['AdvOut.VodTrackIndex'], '3');
        assert.deepEqual(musicOf(h.mock)[1].tracks, { 1: true, 2: true, 3: false, 4: true, 5: true, 6: true });
    } finally { await h.close(); }
});

test('re-applied: tracks changed by hand, a renamed source, a new scene, a scene collection switch, stream start', async () => {
    const h = await setup();
    try {
        await h.vod.ensure('test');
        const [name] = musicOf(h.mock);
        // someone ticks the VOD track again in Advanced Audio Properties
        h.mock.state.inputs[name].tracks[2] = true;
        h.mock.emit('InputAudioTracksChanged', { inputName: name, inputAudioTracks: { ...h.mock.state.inputs[name].tracks } });
        await until(() => h.mock.state.inputs[name].tracks[2] === false);
        // renamed: found again by UUID, not duplicated
        h.mock.rename(name, 'Song player');
        await sleep(800);
        assert.equal(Object.values(h.mock.state.inputs).filter((i) => i.kind === 'browser_source' && i.settings.reroute_audio).length, 1);
        assert.equal(h.vod.status().sourceName, 'Song player');
        // a new scene gets the music source too
        h.mock.state.scenes['Just Chatting'] = [];
        h.mock.emit('SceneCreated', { sceneName: 'Just Chatting' });
        await until(() => h.mock.state.scenes['Just Chatting'].some((it) => it.source === 'Song player'));
        // another scene collection: no music source there, so it is made again
        for (const k of Object.keys(h.mock.state.inputs)) if (h.mock.state.inputs[k].kind === 'browser_source' && h.mock.state.inputs[k].settings.reroute_audio) delete h.mock.state.inputs[k];
        h.mock.state.scenes = { Gaming: [] };
        h.mock.state.program = 'Gaming';
        h.mock.emit('CurrentSceneCollectionChanged', { sceneCollectionName: 'Second' });
        await until(() => musicOf(h.mock) && h.mock.state.scenes.Gaming.some((it) => it.source === musicOf(h.mock)[0]));
        assert.equal(musicOf(h.mock)[1].tracks[2], false);
        // stream start: checked again straight away
        const before = h.vod.status().checkedAt;
        h.mock.state.stream = true;
        h.mock.emit('StreamStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
        await until(() => h.vod.status().checkedAt > before);
        assert.equal(h.vod.status().vodSafe, true);
    } finally { await h.close(); }
});

test('Simple output, or no profile to back up: music paused and nothing written', async () => {
    const simple = await setup({ profile: { 'Output.Mode': 'Simple' } });
    try {
        const s = await simple.vod.ensure('test');
        assert.equal(s.vodSafe, false);
        assert.match(s.reason, /Simple output/);
        assert.equal(simple.mock.state.profileWrites.length, 0);
    } finally { await simple.close(); }
    const nobackup = await setup({ profile: { 'AdvOut.VodTrackEnabled': 'false' }, profileName: 'Another profile' });
    try {
        const s = await nobackup.vod.ensure('test');
        assert.equal(s.vodSafe, false);
        assert.match(s.reason, /could not back up/);
        assert.equal(nobackup.mock.state.profileWrites.length, 0, 'no backup, no change');
    } finally { await nobackup.close(); }
});

test('the person\'s own clicks: Keep out of VOD, Record without music (with backup, idle only)', async () => {
    const h = await setup();
    try {
        await h.vod.ensure('test');
        const s = await h.vod.keepOutOfVod('BGM-START');
        assert.equal(h.mock.state.inputs['BGM-START'].tracks[2], false);
        assert.equal(h.mock.state.inputs['BGM-START'].tracks[1], true, 'only the VOD track is unticked');
        assert.equal(s.warnings.length, 0);
        await h.vod.setRecordWithoutMusic(true);
        assert.equal(h.mock.state.profile['AdvOut.RecTracks'], '2', 'recordings use only track 2');
        assert.equal(h.settings().prevRecTracks, '1');
        await h.vod.setRecordWithoutMusic(false);
        assert.equal(h.mock.state.profile['AdvOut.RecTracks'], '1', 'put back as it was');
        h.mock.state.record = true;
        await assert.rejects(h.vod.setRecordWithoutMusic(true), { code: 'recording' });
        const backups = fs.readdirSync(path.dirname(findProfileIni(h.dir, 'Default'))).filter((f) => f.includes('certifried-backup'));
        assert.ok(backups.length >= 1);
    } finally { await h.close(); }
});

test('OBS not connected: not safe', async () => {
    const obs = createObs({});
    const vod = createVodSafe({ obs });
    const s = await vod.ensure('test');
    assert.equal(s.vodSafe, false);
    assert.match(s.reason, /not connected to OBS/);
});
