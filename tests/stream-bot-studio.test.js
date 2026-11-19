import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import WebSocket from 'ws';
import pool from '../utils/db.js';
import { makeTables, makeProfile } from './fixtures/stream-bot-tables.js';
import { createHub, CLOSE, WS_PATH } from '../core/stream-bot/realtime.js';
import { newDeviceToken, hashSecret, tokenHint } from '../core/stream-bot/pairing.js';
import { createEngine } from '../core/stream-bot/engine.js';
import { createRenderer } from '../core/stream-bot/render.js';
import { createLimiter } from '../core/stream-bot/conditions.js';
import { createIngest } from '../core/stream-bot/ingest.js';
import { createFeed } from '../core/stream-bot/feed.js';
import { createStudioServices, sanitiseState, STATE_LIMITS } from '../core/stream-bot/studio.js';
import { createSoundLibrary, sniffAudio, cleanName } from '../core/stream-bot/sounds.js';
import { createStreamBotPrivacy } from '../core/stream-bot/privacy.js';
import { validateActions, clientParams, ACTION_TYPES, actionType } from '../core/stream-bot/actions.js';
import { normaliseStudio, sampleEvent, STUDIO_EVENT_TYPES, PLATFORMS, eventType } from '../core/stream-bot/events.js';
import { deviceSoundHandler } from '../dashboard/routes/stream-bot.js';
import { createViewEngine } from '../dashboard/services/view-engine.js';
import { studioView, soundView, deviceView } from '../dashboard/services/stream-bot-view.js';
import * as demo from '../scripts/site-shots/demo-data.mjs';

/*
 * Phase 2 server side for CertiFried Studio (design §5) on throwaway tables and a real ws server on 127.0.0.1:
 *   protocol   welcome.features; the state report (caps, kept on the connection, saved to settings.studio, throttled);
 *              OBS events (normalised, stored, live, automations run; unknown types and floods answered, not closed);
 *              requests (automations.list / automations.run with no conditions / sounds.list / unknown); a hub without
 *              Phase 2 handlers behaves exactly as Phase 1 (no features; a state frame closes the socket)
 *   sounds     magic-byte sniffing, size / count / total limits, names, delete, the device-token download
 *   actions    every new action type validates, and Phase 1 steps stay valid
 *   pages      the Sounds page and the Devices page's Studio line in Dark, Light and Sand
 *   privacy    deleting a profile removes its sound files
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let T, store, profile, other, server, hub, port, engine, ingest, studio, sounds, soundDir;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error('condition not met in time');
        await sleep(20);
    }
};

// Minimal real audio headers.
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(200, 1)]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(200, 2)]);
const MP3_ID3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 3)]);
const MP3_FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(200, 4)]);
const M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(200, 5)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 6)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);

async function device(p = profile, kind = 'studio', name = 'Streaming PC') {
    const token = newDeviceToken();
    const id = await store.createDevice(p.id, { kind, name, tokenHash: hashSecret(token), tokenHint: tokenHint(token), capabilities: [] });
    return { token, id };
}

function client(token, port_ = port) {
    const ws = new WebSocket(`ws://127.0.0.1:${port_}${WS_PATH}`);
    const c = { ws, msgs: [] };
    c.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
    ws.on('message', (d) => c.msgs.push(JSON.parse(String(d))));
    c.send = (o) => ws.send(JSON.stringify(o));
    c.next = async (pred, ms = 3000) => {
        const test_ = typeof pred === 'string' ? (m) => m.type === pred : pred;
        const m = await until(() => c.msgs.find((x) => !x._seen && test_(x)), ms);
        m._seen = true;
        return m;
    };
    c.request = async (method, params, id = `r${Math.random().toString(36).slice(2, 10)}`) => {
        c.send({ type: 'request', id, method, params });
        return c.next((m) => m.type === 'response' && m.id === id);
    };
    ws.on('open', () => c.send({ type: 'hello', proto: 1, token, client: { app: 'certifried-studio', version: '0.2.0' }, capabilities: ['obs', 'sound', 'hotkey'] }));
    return c;
}

test.before(async () => {
    T = await makeTables(pool, 's');
    store = T.store;
    profile = await makeProfile(store);
    other = await store.ensureProfile(`sbo${String(Date.now()).slice(-9)}`, 'Elsewhere');
    soundDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbt-sounds-'));
    sounds = createSoundLibrary({ store, dir: soundDir });
    server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    hub = createHub({ store, heartbeatMs: 5000, ackTimeoutMs: 500, sweepMs: 60_000 });
    const io = { channelsFor: (id) => store.listChannels(id), sendChat: async () => ({ ok: true }), postDiscord: async () => ({ ok: true }),
        postWebhook: async () => ({ status: 204 }), dispatch: (d) => hub.dispatch(d) };
    engine = createEngine({ store, render: createRenderer({ variableStore: store.variableStore }), io, limiter: createLimiter() });
    ingest = createIngest({ store, engine, feed: createFeed(), hub });
    studio = createStudioServices({ store, engine, ingest, sounds, limits: { stateWriteMs: 200, runWaitMs: 3000 } });
    hub.use({ onState: studio.onState, onEvent: studio.onEvent, onRequest: studio.onRequest });
    hub.attach(server);
});
test.after(async () => {
    hub?.close();
    server.closeAllConnections?.();
    server.close();
    server.unref();
    await T.drop();
    fs.rmSync(soundDir, { recursive: true, force: true });
    const [rows] = await pool.query('SHOW TABLES LIKE ?', [`${T.prefix}%`]);
    assert.equal(rows.length, 0, 'throwaway tables dropped');
    await pool.end().catch(() => {});
});

test('welcome lists the Phase 2 features; a hub without handlers is Phase 1 exactly', async () => {
    const d = await device();
    const c = client(d.token);
    const w = await c.next('welcome');
    assert.deepEqual(w.features, ['state', 'event', 'request']);
    c.ws.close();
    await c.closed;

    const old = createHub({ store, heartbeatMs: 5000, sweepMs: 60_000 });
    const s2 = http.createServer();
    await new Promise((r) => s2.listen(0, '127.0.0.1', r));
    old.attach(s2);
    const c2 = client(d.token, s2.address().port);
    const w2 = await c2.next('welcome');
    assert.equal(w2.features, undefined, 'no features without handlers');
    c2.send({ type: 'state', obs: {} });
    assert.equal(await c2.closed, CLOSE.bad, 'an unknown frame still closes a Phase 1 hub');
    old.close();
    s2.closeAllConnections?.();
    s2.close();
});

test('state: capped, kept on the connection, saved to settings.studio once, throttled', async () => {
    const d = await device();
    const c = client(d.token);
    await c.next('welcome');
    const long = 'S'.repeat(500);
    const scenes = Array.from({ length: 260 }, (_, i) => (i === 0 ? long : `Scene ${i}`));
    c.send({ type: 'state', obs: { connected: true, version: '31.1.2', studioMode: false, currentScene: 'Scene 1', scenes,
        sources: { 'Scene 1': ['Camera', 'Alerts', 'Camera'], Nope: ['x'] }, inputs: [{ name: 'Mic/Aux', kind: 'wasapi_input_capture' }, { name: 'Title', kind: 'text_gdiplus_v3' }, { name: 'Alerts', kind: 'browser_source' }],
        filters: { Camera: ['Colour', 'Blur'] }, password: 'never-kept' }, sounds: ['airhorn', 'airhorn', 'drum'] });
    await c.next('state_ok');
    const live = hub.connected(profile.id).find((x) => x.deviceId === d.id);
    assert.equal(live.state.obs.scenes.length, STATE_LIMITS.scenes);
    assert.equal(live.state.obs.scenes[0].length, STATE_LIMITS.name);
    assert.deepEqual(live.state.obs.sources, { 'Scene 1': ['Camera', 'Alerts'] }, 'only scenes in the list, duplicates removed');
    assert.deepEqual(live.state.sounds, ['airhorn', 'drum']);
    assert.equal(JSON.stringify(live.state).includes('never-kept'), false, 'unknown fields are dropped');
    assert.equal(live.client, 'certifried-studio 0.2.0');
    const saved = await until(async () => (await store.getProfile(profile.id)).settings.studio);
    assert.equal(saved.deviceId, d.id);
    assert.equal(saved.obs.currentScene, 'Scene 1');
    assert.ok(saved.reportedAt);
    // The same state again is not written again.
    const before = studio._written.get(profile.id).json;
    c.send({ type: 'state', obs: { connected: true, version: '31.1.2', currentScene: 'Scene 1', scenes, sources: { 'Scene 1': ['Camera', 'Alerts'] },
        inputs: [{ name: 'Mic/Aux', kind: 'wasapi_input_capture' }, { name: 'Title', kind: 'text_gdiplus_v3' }, { name: 'Alerts', kind: 'browser_source' }], filters: { Camera: ['Colour', 'Blur'] } }, sounds: ['airhorn', 'drum'] });
    await c.next('state_ok');
    assert.equal(studio._written.get(profile.id).json, before);
    // A change is written after the throttle window.
    c.send({ type: 'state', obs: { connected: true, currentScene: 'Scene 2', scenes: ['Scene 1', 'Scene 2'] }, sounds: [] });
    await c.next('state_ok');
    await until(async () => (await store.getProfile(profile.id)).settings.studio?.obs?.currentScene === 'Scene 2', 2000);
    c.send({ type: 'state', obs: 'nope' });
    await c.next('state_ok');
    c.send({ type: 'state' });
    await c.next('state_ok');
    // The device view on the Devices page
    const v = studioView(hub.connected(profile.id).find((x) => x.deviceId === d.id));
    assert.equal(v.appVersion, '0.2.0');
    c.ws.close();
    await c.closed;
});

test('sanitiseState: a huge report is cut below 60 KB', () => {
    const big = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i}`.padEnd(190, 'x'));
    const scenes = big(200, 's');
    const sources = Object.fromEntries(scenes.map((s) => [s, big(200, 'i')]));
    const st = sanitiseState({ obs: { scenes, sources, inputs: big(600, 'n').map((name) => ({ name, kind: 'ffmpeg_source' })) }, sounds: big(600, 'a') });
    assert.ok(Buffer.byteLength(JSON.stringify(st)) <= STATE_LIMITS.bytes, 'at most 60 KB');
    assert.ok(st.obs.scenes.length > 0, 'scene names are the last thing given up');
    const small = sanitiseState({ obs: { inputs: big(600, 'n').slice(0, 10).map((name) => ({ name, kind: 'x' })) } });
    assert.equal(small.obs.inputs.length, 10);
    assert.equal(sanitiseState(null), null);
    assert.equal(sanitiseState('x'), null);
});

test('OBS events: stored as studio events, run automations; unknown types and floods are answered, not closed', async () => {
    const auto = await store.createAutomation(profile.id, { name: 'Count scenes', enabled: true, trigger_type: 'obs.scene_changed', trigger_config: {}, conditions: [],
        actions: [{ type: 'variable.increment', scope: 'channel', key: 'scene_changes', by: 1 }] });
    const d = await device();
    const c = client(d.token);
    await c.next('welcome');
    c.send({ type: 'event', event: { type: 'obs.scene_changed', metadata: { scene: 'BRB', previous: 'Game', secret: 'x' }, occurredAt: Date.now() } });
    const ev = await until(async () => (await store.listEvents(profile.id, { type: 'obs.scene_changed', limit: 5 }))[0]);
    assert.equal(ev.platform, 'studio');
    assert.deepEqual(ev.metadata, { scene: 'BRB', previous: 'Game' });
    assert.equal(ev.user, null);
    const run = await until(async () => (await store.listRuns(profile.id, { automationId: auto, limit: 5 })).find((r) => r.status === 'ok'));
    assert.equal(run.source, 'event');
    assert.equal(await store.variableStore.get(profile.id, 'server', 'scene_changes'), '1');

    c.send({ type: 'event', event: { type: 'obs.replay_saved', metadata: { file: 'C:\\Users\\someone\\Videos\\Replay 2026-11-19.mkv' } } });
    const rep = await until(async () => (await store.listEvents(profile.id, { type: 'obs.replay_saved', limit: 5 }))[0]);
    assert.equal(rep.metadata.file, 'Replay 2026-11-19.mkv', 'only the file name, never the folder');

    c.send({ type: 'event', event: { type: 'follow', metadata: {} } });
    assert.equal((await c.next('error')).code, 'unknown_event');
    c.send({ type: 'ping', t: 7 });
    assert.equal((await c.next('pong')).t, 7, 'still open');

    for (let i = 0; i < 32; i++) c.send({ type: 'event', event: { type: 'obs.stream_started', metadata: {} } });
    assert.equal((await c.next((m) => m.type === 'error' && m.code === 'event_rate')).code, 'event_rate');
    await sleep(300);
    const started = await store.listEvents(profile.id, { type: 'obs.stream_started', limit: 100 });
    assert.ok(started.length <= 28 && started.length >= 20, `${started.length} stored, the rest dropped`);
    c.ws.close();
    await c.closed;
});

test('requests: list, run (no conditions), sounds.list, errors', async () => {
    const d = await device();
    const c = client(d.token);
    await c.next('welcome');
    const id = await store.createAutomation(profile.id, { name: 'Hype button', enabled: true, trigger_type: 'chat', trigger_config: { match: { mode: 'command', text: '!hype' } },
        conditions: [{ type: 'role', roles: ['broadcaster'], mode: 'any' }, { type: 'cooldown', scope: 'global', seconds: 3600 }],
        actions: [{ type: 'variable.increment', scope: 'channel', key: 'hype', by: 1 }] });
    const off = await store.createAutomation(profile.id, { name: 'Off', enabled: false, trigger_type: 'follow', trigger_config: {}, conditions: [], actions: [{ type: 'variable.increment', scope: 'channel', key: 'off', by: 1 }] });
    const theirs = await store.createAutomation(other.id, { name: 'Not yours', enabled: true, trigger_type: 'follow', trigger_config: {}, conditions: [], actions: [{ type: 'variable.increment', scope: 'channel', key: 'x', by: 1 }] });

    const list = await c.request('automations.list', {});
    assert.equal(list.ok, true);
    assert.ok(list.result.automations.some((a) => a.id === id && a.name === 'Hype button' && a.enabled === true && a.trigger_type === 'chat'));
    assert.ok(!list.result.automations.some((a) => a.id === theirs), 'only this profile');

    for (let i = 0; i < 2; i++) {
        const r = await c.request('automations.run', { automationId: id });
        assert.equal(r.ok, true);
        assert.equal(r.result.status, 'ok', 'no trigger match, roles or cooldown for a manual run');
        const run = await store.getRun(profile.id, r.result.runId);
        assert.equal(run.source, 'studio');
        assert.equal(run.input.platform, 'studio');
        assert.deepEqual(run.checks, []);
    }
    assert.equal(await store.variableStore.get(profile.id, 'server', 'hype'), '2');
    assert.equal((await c.request('automations.run', { automationId: off })).error, 'disabled');
    assert.equal((await c.request('automations.run', { automationId: theirs })).error, 'not_found');
    assert.equal((await c.request('automations.run', { automationId: 'x' })).error, 'bad_params');
    assert.equal((await c.request('nope.method', {})).error, 'unknown_method');
    c.send({ type: 'request', id: 'bad id!', method: 'automations.list' });
    assert.equal((await c.next('error')).code, 'bad_request');

    const added = await sounds.add(profile.id, { name: 'airhorn.mp3', buffer: MP3_ID3 });
    assert.equal(added.ok, true);
    const sl = await c.request('sounds.list', {});
    assert.deepEqual(sl.result.sounds.map((s) => [s.name, s.size, s.mime, s.url]), [['airhorn', MP3_ID3.length, 'audio/mpeg', `/stream/bot/api/device/sounds/${added.sound.id}`]]);
    assert.match(sl.result.sounds[0].sha256, /^[0-9a-f]{64}$/);
    // A rate limit on runs from one device.
    let limited = false;
    for (let i = 0; i < 12 && !limited; i++) limited = (await c.request('automations.run', { automationId: id })).error === 'rate';
    assert.ok(limited, 'at most 10 runs in 10 s per device');
    assert.equal(hub.notify(profile.id, 'studio', { type: 'sounds_changed' }), 1);
    await c.next('sounds_changed');
    await sounds.remove(profile.id, added.sound.id);
    c.ws.close();
    await c.closed;
});

test('sound library: magic bytes, names, limits, delete', async () => {
    assert.deepEqual(sniffAudio(WAV), { ext: 'wav', mime: 'audio/wav' });
    assert.equal(sniffAudio(OGG).ext, 'ogg');
    assert.equal(sniffAudio(MP3_ID3).ext, 'mp3');
    assert.equal(sniffAudio(MP3_FRAME).ext, 'mp3');
    assert.equal(sniffAudio(M4A).ext, 'm4a');
    assert.equal(sniffAudio(WEBM).ext, 'webm');
    assert.equal(sniffAudio(PNG), null);
    assert.equal(sniffAudio(Buffer.from('MZ')), null);
    assert.equal(sniffAudio(Buffer.from('<?php echo 1; ?>  padding')), null);
    assert.equal(cleanName('..\\..\\evil/na:me?.wav'), '.. .. evil na me');
    assert.equal(cleanName('Airhorn.mp3'), 'Airhorn');

    const lib = createSoundLibrary({ store, dir: soundDir, limits: { fileBytes: 1000, count: 3, totalBytes: 700 } });
    const p = await store.ensureProfile(`sbs${String(Date.now()).slice(-9)}`, 'Sounds');
    assert.match((await lib.add(p.id, { name: 'fake.mp3', buffer: PNG })).error, /not an MP3/, 'the extension is not trusted');
    assert.match((await lib.add(p.id, { name: 'big', buffer: Buffer.concat([WAV, Buffer.alloc(1000)]) })).error, /at most/);
    assert.match((await lib.add(p.id, { name: '', buffer: WAV })).error, /name/);
    const a = await lib.add(p.id, { name: 'one', buffer: WAV });
    const b = await lib.add(p.id, { name: 'two', buffer: OGG });
    assert.ok(a.ok && b.ok);
    assert.match((await lib.add(p.id, { name: 'One', buffer: OGG })).error, /already have/);
    assert.match((await lib.add(p.id, { name: 'three', buffer: Buffer.concat([WAV, Buffer.alloc(300)]) })).error, /in total/);
    await lib.add(p.id, { name: 'three', buffer: MP3_FRAME });
    assert.match((await lib.add(p.id, { name: 'four', buffer: WEBM })).error, /the most/);
    const file = lib.filePath(p.id, a.sound);
    assert.ok(file.startsWith(path.join(soundDir, String(p.id))) && fs.existsSync(file));
    assert.deepEqual(fs.readFileSync(file), WAV);
    assert.equal((await lib.list(p.id)).length, 3);
    // Two uploads at once are both kept.
    await lib.remove(p.id, b.sound.id);
    const both = await Promise.all([lib.add(p.id, { name: 'x1', buffer: OGG }), lib.remove(p.id, a.sound.id)]);
    assert.ok(both[0].ok && both[1]);
    assert.deepEqual((await lib.list(p.id)).map((s) => s.name).sort(), ['three', 'x1']);
    assert.equal(fs.existsSync(file), false, 'the file goes with it');
    assert.equal(await lib.remove(p.id, 'ffffffffffffffff'), false);
    assert.equal(lib.filePath(p.id, { id: '../../etc', ext: 'wav' }), null);
    assert.equal(await lib.get(p.id, '../x'), null);
});

test('device download: the token decides; revoked, other profiles and unknown ids are refused', async () => {
    const app = express();
    app.get('/dl/:id', deviceSoundHandler(async () => ({ store, sounds })));
    const s = http.createServer(app);
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${s.address().port}/dl/`;
    const mine = await sounds.add(profile.id, { name: 'bell', buffer: WAV });
    const theirs = await sounds.add(other.id, { name: 'bell', buffer: OGG });
    const d = await device();
    const get = (id, auth) => fetch(base + id, { headers: auth ? { Authorization: auth } : {} });

    const ok = await get(mine.sound.id, `Bearer ${d.token}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'audio/wav');
    assert.equal(ok.headers.get('content-length'), String(WAV.length));
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), WAV);
    assert.equal((await get(mine.sound.id)).status, 401);
    assert.equal((await get(mine.sound.id, `Bearer ${newDeviceToken()}`)).status, 401);
    assert.equal((await get(mine.sound.id, 'Bearer not-a-token')).status, 401);
    assert.equal((await get(theirs.sound.id, `Bearer ${d.token}`)).status, 404, "another profile's sound");
    assert.equal((await get('0123456789abcdef', `Bearer ${d.token}`)).status, 404);
    await store.revokeDevice(profile.id, d.id);
    assert.equal((await get(mine.sound.id, `Bearer ${d.token}`)).status, 401, 'revoked');
    s.closeAllConnections?.();
    s.close();
    await sounds.remove(profile.id, mine.sound.id);
});

test('actions: every Phase 2 type validates; Phase 1 steps stay valid', async () => {
    const ok = (steps) => { const r = validateActions(steps); assert.deepEqual(r.errors, [], JSON.stringify(steps)); return r.value; };
    const bad = (step, re) => { const r = validateActions([step]); assert.ok(r.errors.some((e) => re.test(e)), `${JSON.stringify(step)} → ${r.errors.join(' | ')}`); };
    const v = ok([
        { type: 'obs.scene', scene: 'BRB' }, { type: 'obs.preview', scene: 'Game' }, { type: 'obs.transition' }, { type: 'obs.transition', transition: 'Fade', durationMs: 500 },
        { type: 'obs.source', source: 'Camera', visible: 'hide' }, { type: 'obs.mute', input: 'Mic/Aux', state: 'mute' }, { type: 'obs.volume', input: 'Music', volume: 40 },
        { type: 'obs.filter', source: 'Camera', filter: 'Blur', state: 'enable' }, { type: 'obs.stream', state: 'stop' }, { type: 'obs.record', state: 'toggle_pause' },
        { type: 'obs.replay', state: 'start' }, { type: 'obs.virtualcam', state: 'start' }, { type: 'obs.screenshot' }, { type: 'obs.text', source: 'Title', text: 'Hi {user.name}' },
        { type: 'obs.browser_url', source: 'Alerts', url: 'https://example.com/a' }, { type: 'obs.browser_url', source: 'Alerts', url: '{message}' },
        { type: 'obs.browser_refresh', source: 'Alerts' }, { type: 'obs.hotkey', name: 'OBSBasic.StartStreaming' },
        { type: 'sound.play', sound: 'airhorn', volume: 50, mode: 'queue' }, { type: 'sound.stop' },
    ]);
    assert.equal(v.find((s) => s.type === 'sound.play').mode, 'queue');
    assert.equal(v.find((s) => s.type === 'obs.stream').state, 'stop');
    assert.equal(v.filter((s) => s.type === 'obs.transition')[1].durationMs, 500);
    assert.equal('durationMs' in v.filter((s) => s.type === 'obs.transition')[0], false, 'empty duration stays empty');
    assert.ok(v.every((s) => s.queueSeconds === 120), 'client actions get the default wait');
    bad({ type: 'obs.preview' }, /scene name/);
    bad({ type: 'obs.transition', durationMs: 50000 }, /duration/);
    bad({ type: 'obs.mute' }, /audio source/);
    bad({ type: 'obs.volume', input: 'Mic', volume: 120 }, /0 to 100/);
    bad({ type: 'obs.filter', source: 'Camera' }, /filter name/);
    bad({ type: 'obs.browser_url', source: 'Alerts', url: 'javascript:alert(1)' }, /http/);
    bad({ type: 'obs.browser_refresh' }, /browser source/);
    bad({ type: 'obs.hotkey', name: 'bad<name>' }, /hotkey name/);
    // Phase 1 steps as saved before Phase 2.
    const legacy = ok([{ type: 'obs.replay' }, { type: 'obs.record', state: 'start' }, { type: 'sound.play', sound: 'x', volume: 80 }, { type: 'studio.hotkey', keys: 'Ctrl+Shift+F1' }]);
    assert.equal(legacy[0].state, 'save', 'a replay step without a state saves the replay');
    assert.equal(legacy[2].mode, 'overlap');
    assert.deepEqual(await clientParams({ type: 'obs.replay' }, async (t) => t), {}, 'an old stored step sends no state: Studio saves');
    assert.deepEqual(await clientParams({ type: 'obs.browser_url', source: 'A', url: 'https://x.test/{amount}' }, async (t) => t.replace('{amount}', '5')), { source: 'A', url: 'https://x.test/5' });
    // Every OBS action needs the obs capability; sounds need sound.
    for (const a of ACTION_TYPES) {
        if (a.type.startsWith('obs.')) assert.deepEqual([a.target, a.capability], ['studio', 'obs'], a.type);
        if (a.type.startsWith('sound.')) assert.equal(a.capability, 'sound', a.type);
        for (const f of a.fields || []) if (f.suggest) assert.ok(['scenes', 'sources', 'scenesAndSources', 'inputs', 'textSources', 'browserSources', 'filterSources', 'filters', 'sounds'].includes(f.suggest), `${a.type}.${f.name}`);
    }
    assert.equal(actionType('obs.source').fields.find((f) => f.name === 'source').suggest, 'sources');
});

test('OBS event types: catalogue, normalising and the Test sample', () => {
    assert.ok(PLATFORMS.includes('studio'));
    assert.deepEqual([...STUDIO_EVENT_TYPES].sort(), ['obs.recording_paused', 'obs.recording_resumed', 'obs.recording_started', 'obs.recording_stopped', 'obs.replay_saved',
        'obs.scene_changed', 'obs.stream_started', 'obs.stream_stopped', 'obs.virtualcam_started', 'obs.virtualcam_stopped', 'voice.phrase']);
    for (const t of STUDIO_EVENT_TYPES) {
        assert.equal(eventType(t).group, t === 'voice.phrase' ? 'Studio' : 'OBS');
        const s = sampleEvent(t);
        assert.equal(s.platform, 'studio', `${t} sample`);
        assert.equal(s.test, true);
    }
    assert.equal(normaliseStudio({ type: 'channel.follow' }), null);
    assert.equal(normaliseStudio(null), null);
    const e = normaliseStudio({ type: 'obs.scene_changed', metadata: { scene: 'x'.repeat(300), previous: null }, occurredAt: 1 });
    assert.equal(e.metadata.scene.length, 200);
    assert.ok(Date.now() - e.occurredAt.getTime() < 5000, 'a far-off client clock is not trusted');
    assert.deepEqual(normaliseStudio({ type: 'obs.stream_started', metadata: { any: 'thing' } }).metadata, {});
});

test('privacy delete removes the profile\'s sound files', async () => {
    const p = await store.ensureProfile(`sbp${String(Date.now()).slice(-9)}`, 'Bye');
    const lib = createSoundLibrary({ store, dir: soundDir });
    const s = await lib.add(p.id, { name: 'gone', buffer: WAV });
    const file = lib.filePath(p.id, s.sound);
    assert.ok(fs.existsSync(file));
    const privacy = createStreamBotPrivacy({ store, db: null, soundsDir: soundDir });
    const exp = await privacy.exportFor(p.ownerDiscordId);
    assert.equal(exp.tables[`${store.prefix}profiles`].rows[0].settings.sounds[0].name, 'gone', 'export lists sound names');
    await privacy.deleteFor(p.ownerDiscordId);
    assert.equal(fs.existsSync(path.dirname(file)), false);
});

test('the Sounds page and the Devices page Studio line render in Dark, Light and Sand', () => {
    const views = path.join(root, 'dashboard/views');
    const eng = createViewEngine({ viewsDir: views, publicDir: path.join(root, 'dashboard/public'), cache: false });
    const common = (theme) => ({ user: demo.user, uiTheme: theme, uiStyle: 'cards', uiDensity: 'comfortable', csrfToken: 't', clientId: demo.BOT_ID,
        userPrefs: { pinnedPages: [], recentPages: [], siteStyle: 'cards', theme, dashboardLayout: 'grid', density: 'comfortable' }, settings: {}, _locals: {} });
    const snd = soundView({ id: 'aaaaaaaaaaaaaaaa', name: '<b>horn</b>', size: 123456, mime: 'audio/mpeg', sha256: 'f'.repeat(64), uploadedAt: '2026-11-19T10:00:00.000Z' });
    const dev = { ...deviceView({ id: 9, kind: 'studio', name: 'Streaming PC', tokenHint: 'Ab12', capabilities: ['obs', 'sound'], clientInfo: 'certifried-studio 0.2.0',
        createdAt: new Date(), lastSeenAt: new Date(), revokedAt: null }, new Set([9])),
    studio: studioView({ kind: 'studio', client: 'certifried-studio 0.2.0', state: { obs: { connected: true, version: '31.1.2', currentScene: 'Just Chatting', scenes: ['a', 'b'] }, sounds: [] } }) };
    for (const theme of ['dark', 'light', 'sand']) {
        const html = eng.renderFile(path.join(views, 'stream-bot/sounds.ejs'), { ...common(theme), active: 'sounds', pageTitle: 'Sounds', sounds: [snd],
            limits: { fileMb: 5, count: 50, totalMb: 100 }, usedBytes: 123456 });
        assert.match(html, new RegExp(`<html data-theme="${theme}"`));
        assert.equal((html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/) || [])[1].trim(), 'Sounds');
        assert.match(html, /href="\/stream\/bot\/sounds" aria-current="page">Sounds/);
        assert.ok(html.includes('&lt;b&gt;horn&lt;/b&gt;') && !html.includes('<b>horn</b>'), 'names are escaped');
        const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
        for (const m of html.matchAll(/<label\b[^>]*\sfor="([^"]+)"/g)) assert.ok(ids.includes(m[1]), `label for ${m[1]}`);
        const dv = eng.renderFile(path.join(views, 'stream-bot/devices.ejs'), { ...common(theme), active: 'devices', pageTitle: 'Devices', devices: [dev], wsUrl: 'wss://example.test/stream/bot/ws' });
        assert.match(dv, /Studio 0\.2\.0/);
        assert.match(dv, /OBS connected \(31\.1\.2\)/);
        assert.match(dv, /On air: Just Chatting/);
        assert.match(dv, /href="\/downloads\/studio"/);
        assert.match(dv, /id="sb-pair-open"/);
    }
});
