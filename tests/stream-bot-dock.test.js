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
import { createLimiter, validateTrigger, triggerMatches, normalisePhrase } from '../core/stream-bot/conditions.js';
import { createIngest } from '../core/stream-bot/ingest.js';
import { createFeed } from '../core/stream-bot/feed.js';
import { createStudioServices } from '../core/stream-bot/studio.js';
import { createSoundLibrary } from '../core/stream-bot/sounds.js';
import { isDockKey, dockUrls, openDockStreams, closeDockStreams } from '../core/stream-bot/dock.js';
import { normaliseStudio, sampleEvent, eventType, STUDIO_EVENT_TYPES } from '../core/stream-bot/events.js';
import { createDockRouter } from '../dashboard/routes/stream-bot-dock.js';
import { deviceSoundHandler } from '../dashboard/routes/stream-bot.js';
import { createViewEngine } from '../dashboard/services/view-engine.js';

/*
 * Phase 2c (design §5.10): OBS dock keys and pages, and the voice.phrase trigger.
 *   dock keys   issued over the realtime channel (docks.key), regenerate revokes the old one, a dock key never works for
 *               the realtime hello or the device sound download
 *   dock pages  activity / controls / chat render with the key (Dark, Light, Sand), 401 without; headers; the run API
 *               runs only this profile's automations; the SSE feed is scoped to the profile and the kind, and Revoke
 *               closes it; rate limits
 *   voice       normalise, trigger validation and matching, the voice.phrases request, an event that runs an automation
 *   wiring      server.js mounts and CSRF-exempts only the dock run API; automation changes notify Studio
 * Throwaway tables; a real ws and http server on 127.0.0.1.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');
let T, store, profile, other, server, hub, port, engine, ingest, feed, studio, soundDir, sounds;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('condition not met in time'); await sleep(20); }
};

async function device(p = profile, kind = 'studio', name = 'Streaming PC') {
    const token = newDeviceToken();
    const id = await store.createDevice(p.id, { kind, name, tokenHash: hashSecret(token), tokenHint: tokenHint(token), capabilities: [] });
    return { token, id };
}

function client(token) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
    const c = { ws, msgs: [] };
    c.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
    ws.on('message', (d) => c.msgs.push(JSON.parse(String(d))));
    c.send = (o) => ws.send(JSON.stringify(o));
    c.next = async (pred, ms = 4000) => {
        const t = typeof pred === 'string' ? (m) => m.type === pred : pred;
        const m = await until(() => c.msgs.find((x) => !x._seen && t(x)), ms);
        m._seen = true;
        return m;
    };
    c.request = async (method, params = {}) => {
        const id = `r${Math.random().toString(36).slice(2, 10)}`;
        c.send({ type: 'request', id, method, params });
        return c.next((m) => m.type === 'response' && m.id === id);
    };
    ws.on('open', () => c.send({ type: 'hello', proto: 1, token, client: { app: 'certifried-studio', version: '0.2.4' }, capabilities: ['obs', 'sound', 'hotkey'] }));
    return c;
}

test.before(async () => {
    T = await makeTables(pool, 'd');
    store = T.store;
    profile = await makeProfile(store);
    other = await store.ensureProfile(`sbd${String(Date.now()).slice(-9)}`, 'Elsewhere');
    soundDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbt-dock-sounds-'));
    sounds = createSoundLibrary({ store, dir: soundDir });
    server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    hub = createHub({ store, heartbeatMs: 5000, ackTimeoutMs: 500, sweepMs: 60_000 });
    const io = { channelsFor: (id) => store.listChannels(id), sendChat: async () => ({ ok: true }), postDiscord: async () => ({ ok: true }),
        postWebhook: async () => ({ status: 204 }), dispatch: (d) => hub.dispatch(d) };
    engine = createEngine({ store, render: createRenderer({ variableStore: store.variableStore }), io, limiter: createLimiter() });
    feed = createFeed();
    ingest = createIngest({ store, engine, feed, hub });
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

/** An express app with the dock routes on the throwaway tables, real views. */
async function dockApp(limits) {
    const eng = createViewEngine({ viewsDir: views, publicDir: path.join(root, 'dashboard/public'), cache: false });
    const a = express();
    a.engine('ejs', (f, o, cb) => { try { cb(null, eng.renderFile(f, o)); } catch (e) { cb(e); } });
    a.set('views', views);
    a.set('view engine', 'ejs');
    a.use('/', createDockRouter({ getSb: async () => ({ store, feed, engine }), limits, heartbeatMs: 60_000, recheckMs: 200, runWaitMs: 3000 }));
    a.get('/dl/:id', deviceSoundHandler(async () => ({ store, sounds })));
    const s = http.createServer(a);
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    return { base: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) };
}

const keyOf = (url) => new URL(url).searchParams.get('key');
const localUrl = (base, url) => base + new URL(url).pathname + new URL(url).search;

test('docks.key: a scoped key per Studio, shown once; asking again revokes the old one; never a realtime or sound token', async () => {
    const d = await device();
    const c = client(d.token);
    await c.next('welcome');
    const r1 = await c.request('docks.key');
    assert.equal(r1.ok, true);
    const { key, deviceId, urls } = r1.result;
    assert.ok(isDockKey(key));
    assert.deepEqual(urls, dockUrls(process.env.DASHBOARD_URL || 'https://certifriedmultitool.com', key));
    assert.equal(keyOf(urls.activity), key);
    const row = await store.getDevice(profile.id, deviceId);
    assert.deepEqual([row.kind, row.name, row.capabilities], ['dock', 'OBS docks (Streaming PC)', ['dock', `of:${d.id}`]]);
    const [[n]] = await pool.query(`SELECT COUNT(*) AS n FROM \`${T.prefix}devices\` WHERE token_hash = ?`, [key]);
    assert.equal(Number(n.n), 0, 'only the hash is stored');

    const r2 = await c.request('docks.key');
    assert.notEqual(r2.result.key, key);
    assert.ok((await store.getDevice(profile.id, deviceId)).revokedAt, 'the earlier key is revoked');
    assert.ok(!(await store.deviceByTokenHash(hashSecret(key))), 'the old key no longer resolves');

    // a dock key in the realtime hello: refused
    const bad = client(r2.result.key);
    assert.equal(await bad.closed, CLOSE.auth);
    // and for the device sound download
    const app = await dockApp();
    const snd = await sounds.add(profile.id, { name: 'bell', buffer: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(100, 1)]) });
    assert.equal((await fetch(`${app.base}/dl/${snd.sound.id}`, { headers: { Authorization: `Bearer ${r2.result.key}` } })).status, 401);
    assert.equal((await fetch(`${app.base}/dl/${snd.sound.id}`, { headers: { Authorization: `Bearer ${d.token}` } })).status, 200);
    await app.close();
    // new keys are limited per Studio
    for (let i = 0; i < 4; i++) await c.request('docks.key');
    assert.equal((await c.request('docks.key')).error, 'rate', 'at most 5 new keys in 10 minutes');
    c.ws.close();
    await c.closed;
});

test('dock pages: activity, controls and chat with the key, in three themes; 401 without; headers', async () => {
    const d = await device(profile, 'studio', 'Desk');
    const c = client(d.token);
    await c.next('welcome');
    const { key, urls } = (await c.request('docks.key')).result;
    const onA = await store.createAutomation(profile.id, { name: 'BRB scene', enabled: true, trigger_type: 'follow', trigger_config: {}, conditions: [], actions: [{ type: 'variable.increment', scope: 'channel', key: 'deaths', by: 1 }] });
    await store.createAutomation(profile.id, { name: 'Turned off', enabled: false, trigger_type: 'follow', trigger_config: {}, conditions: [], actions: [{ type: 'delay', seconds: 1 }] });
    await store.variableStore.set(profile.id, 'server', 'deaths', '4');
    c.send({ type: 'event', event: { type: 'obs.scene_changed', metadata: { scene: 'Just <b>Chatting</b>', previous: 'Intro' } } });
    await until(async () => (await store.listEvents(profile.id, { type: 'obs.scene_changed', limit: 5 })).length);
    const app = await dockApp();
    try {
        for (const theme of ['dark', 'light', 'sand']) {
            const res = await fetch(`${localUrl(app.base, urls.activity)}${theme === 'dark' ? '' : `&theme=${theme}`}`);
            assert.equal(res.status, 200);
            const html = await res.text();
            assert.match(html, new RegExp(`<html lang="en" data-theme="${theme}">`));
            assert.ok(html.includes('OBS switched to Just &lt;b&gt;Chatting&lt;/b&gt;'), 'text is escaped');
            assert.equal(res.headers.get('cache-control'), 'no-store');
            assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
            assert.match(res.headers.get('x-robots-tag'), /noindex/);
            assert.doesNotMatch(html, /site-header|cf-site-footer/, 'no site chrome in a dock');
        }
        const ctl = await (await fetch(localUrl(app.base, urls.controls))).text();
        assert.match(ctl, new RegExp(`data-run="${onA}"`));
        assert.doesNotMatch(ctl, /Turned off/, 'only automations that are on');
        assert.match(ctl, /<dt>deaths<\/dt><dd>4<\/dd>/);
        const chat = await (await fetch(localUrl(app.base, urls.chat))).text();
        assert.match(chat, /Chat from your Twitch and Kick channels shows here/);
        const none = await fetch(`${app.base}/stream/bot/dock/activity?key=sbk_${'A'.repeat(22)}`);
        assert.equal(none.status, 401);
        assert.match(await none.text(), /This dock key was replaced or removed\. In CertiFried Studio choose Add CertiFried docks again\./);
        assert.equal((await fetch(`${app.base}/stream/bot/dock/controls`)).status, 401);
        const st = await (await fetch(`${app.base}/stream/bot/dock/api/state`, { headers: { 'X-Dock-Key': key } })).json();
        assert.deepEqual(st.counters, [{ key: 'deaths', value: '4' }]);
    } finally { await app.close(); c.ws.close(); await c.closed; }
});

test('dock run: only this profile\'s automations, only when on; logged as run from an OBS dock', async () => {
    const d = await device(profile, 'studio', 'Runner');
    const c = client(d.token);
    await c.next('welcome');
    const { key } = (await c.request('docks.key')).result;
    c.ws.close();
    const mine = await store.createAutomation(profile.id, { name: 'Count', enabled: true, trigger_type: 'follow', trigger_config: {}, conditions: [{ type: 'role', roles: ['moderator'], mode: 'any' }], actions: [{ type: 'variable.increment', scope: 'channel', key: 'clicks', by: 1 }] });
    const off = await store.createAutomation(profile.id, { name: 'Off', enabled: false, trigger_type: 'follow', trigger_config: {}, conditions: [], actions: [{ type: 'delay', seconds: 1 }] });
    const theirs = await store.createAutomation(other.id, { name: 'Theirs', enabled: true, trigger_type: 'follow', trigger_config: {}, conditions: [], actions: [{ type: 'delay', seconds: 1 }] });
    const app = await dockApp();
    const run = (id, k = key) => fetch(`${app.base}/stream/bot/dock/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(k ? { 'X-Dock-Key': k } : {}) }, body: JSON.stringify({ automationId: id }) });
    try {
        const ok = await run(mine);
        assert.equal(ok.status, 200);
        const body = await ok.json();
        assert.equal(body.status, 'ok', 'conditions are skipped for a manual run');
        assert.equal(await store.variableStore.get(profile.id, 'server', 'clicks'), '1');
        const runs = await store.listRuns(profile.id, { automationId: mine, limit: 5 });
        assert.equal(runs[0].source, 'dock');
        assert.equal((await run(theirs)).status, 404, 'another profile\'s automation is not found');
        assert.equal((await run(off)).status, 409);
        assert.equal((await run(mine, null)).status, 401);
        assert.equal((await run(mine, `sbk_${'Z'.repeat(22)}`)).status, 401);
        assert.equal((await run('x')).status, 400);
    } finally { await app.close(); }
});

test('dock feed: this profile only, by kind; Revoke closes it at once; a revoked key cannot reconnect', async () => {
    const d = await device(profile, 'studio', 'Feeds');
    const c = client(d.token);
    await c.next('welcome');
    const { key, deviceId } = (await c.request('docks.key')).result;
    c.ws.close();
    const app = await dockApp();
    const open = async (kind) => {
        const ctrl = new AbortController();
        const res = await fetch(`${app.base}/stream/bot/dock/api/feed?key=${encodeURIComponent(key)}&kind=${kind}`, { signal: ctrl.signal });
        const s = { res, text: '', ended: false, ctrl };
        (async () => { try { for await (const chunk of res.body) s.text += Buffer.from(chunk).toString('utf8'); } catch { /* aborted */ } s.ended = true; })();
        return s;
    };
    try {
        const act = await open('activity');
        const chat = await open('chat');
        assert.match(act.res.headers.get('content-type'), /^text\/event-stream/);
        await until(() => openDockStreams(deviceId) === 2);
        feed.publish(profile.id, { type: 'follow', platform: 'twitch', user: { name: 'Juniper' }, occurredAt: new Date() });
        feed.publish(profile.id, { type: 'chat', platform: 'kick', user: { name: 'Rowan' }, message: 'hello there', occurredAt: new Date() });
        feed.publish(other.id, { type: 'follow', platform: 'twitch', user: { name: 'Elsewhere' }, occurredAt: new Date() });
        await until(() => act.text.includes('Juniper') && chat.text.includes('hello there'));
        await sleep(100);
        assert.ok(!act.text.includes('hello there'), 'chat stays out of the activity dock');
        assert.ok(!chat.text.includes('Juniper'), 'the chat dock is chat only');
        assert.ok(!act.text.includes('Elsewhere') && !chat.text.includes('Elsewhere'), 'other profiles never arrive');
        // Revoke (the Devices page calls revokeDevice + closeDockStreams)
        await store.revokeDevice(profile.id, deviceId);
        assert.equal(closeDockStreams(deviceId), 2);
        await until(() => act.ended && chat.ended);
        assert.match(act.text, /event: closed/);
        assert.equal((await fetch(`${app.base}/stream/bot/dock/api/feed?key=${encodeURIComponent(key)}`)).status, 401);
    } finally { await app.close(); }
});

test('dock rate limits per key and IP', async () => {
    const d = await device(profile, 'studio', 'Limits');
    const c = client(d.token);
    await c.next('welcome');
    const { urls, key } = (await c.request('docks.key')).result;
    c.ws.close();
    const app = await dockApp({ page: 3, run: 2, feed: 2 });
    try {
        const codes = [];
        for (let i = 0; i < 4; i++) codes.push((await fetch(localUrl(app.base, urls.controls))).status);
        assert.deepEqual(codes, [200, 200, 200, 429]);
        const r = [];
        for (let i = 0; i < 3; i++) r.push((await fetch(`${app.base}/stream/bot/dock/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dock-Key': key }, body: '{"automationId":999999}' })).status);
        assert.deepEqual(r, [404, 404, 429]);
    } finally { await app.close(); }
});

test('voice.phrase: event, trigger validation and matching, the phrases request, a spoken phrase runs its automation', async () => {
    assert.ok(STUDIO_EVENT_TYPES.includes('voice.phrase'));
    assert.equal(eventType('voice.phrase').label, 'Voice command');
    assert.equal(sampleEvent('voice.phrase').message, 'start the raid');
    const ev = normaliseStudio({ type: 'voice.phrase', metadata: { phrase: '  Start   the RAID ', confidence: 0.87654, audio: 'never kept' } });
    assert.deepEqual([ev.platform, ev.message, ev.user.roles, ev.metadata], ['studio', 'Start the RAID', ['broadcaster'], { phrase: 'Start the RAID', confidence: 0.877 }]);
    assert.equal(normaliseStudio({ type: 'voice.phrase', metadata: { phrase: '   ' } }), null);
    assert.equal(normaliseStudio({ type: 'voice.phrase', metadata: { phrase: 'x'.repeat(300) } }).message.length, 100);

    assert.deepEqual(validateTrigger('voice.phrase', { phrases: ' Start  the raid \nstart the raid\nBRB\n\n' }), { ok: true, errors: [], value: { phrases: ['Start the raid', 'BRB'] } });
    assert.equal(validateTrigger('voice.phrase', { phrases: [] }).ok, false);
    assert.equal(validateTrigger('voice.phrase', { phrases: Array.from({ length: 21 }, (_, i) => `p${i}`) }).ok, false);
    assert.equal(validateTrigger('voice.phrase', { phrases: ['y'.repeat(101)] }).ok, false);
    const a = { trigger_type: 'voice.phrase', trigger_config: { phrases: ['start the raid', 'BRB'] } };
    assert.equal(triggerMatches(a, ev), true);
    assert.equal(triggerMatches(a, { ...ev, message: 'start the raids' }), false);
    assert.equal(normalisePhrase('  A  b '), 'a b');

    const auto = await store.createAutomation(profile.id, { name: 'Raid time', enabled: true, trigger_type: 'voice.phrase', trigger_config: { phrases: ['start the raid', 'raid now'] },
        conditions: [{ type: 'role', roles: ['broadcaster'], mode: 'any' }], actions: [{ type: 'variable.increment', scope: 'channel', key: 'raids', by: 1 }] });
    await store.createAutomation(profile.id, { name: 'Off voice', enabled: false, trigger_type: 'voice.phrase', trigger_config: { phrases: ['never listed'] }, conditions: [], actions: [{ type: 'delay', seconds: 1 }] });
    const d = await device(profile, 'studio', 'Mic PC');
    const c = client(d.token);
    await c.next('welcome');
    const ph = await c.request('voice.phrases');
    assert.deepEqual(ph.result.phrases.filter((p) => p.automationId === auto), [{ text: 'start the raid', automationId: auto, automationName: 'Raid time' }, { text: 'raid now', automationId: auto, automationName: 'Raid time' }]);
    assert.ok(!ph.result.phrases.some((p) => p.text === 'never listed'), 'automations that are off are left out');
    c.send({ type: 'event', event: { type: 'voice.phrase', metadata: { phrase: 'Raid Now', confidence: 0.9 } } });
    await until(async () => (await store.variableStore.get(profile.id, 'server', 'raids')) === '1');
    c.send({ type: 'event', event: { type: 'voice.phrase', metadata: { phrase: 'something else', confidence: 0.9 } } });
    await sleep(200);
    assert.equal(await store.variableStore.get(profile.id, 'server', 'raids'), '1', 'a phrase no automation lists runs nothing');
    const stored = await store.listEvents(profile.id, { type: 'voice.phrase', limit: 5 });
    assert.equal(stored.length, 2);
    assert.ok(stored.every((e) => !JSON.stringify(e).includes('audio')), 'only the phrase and confidence are kept');
    c.ws.close();
    await c.closed;
});

test('wiring: server.js mounts the dock routes and exempts only the dock run API; automation changes notify Studio; Revoke closes dock feeds', () => {
    const srv = fs.readFileSync(path.join(root, 'dashboard/server.js'), 'utf8');
    assert.match(srv, /import\('\.\/routes\/stream-bot-dock\.js'\)/);
    assert.equal((srv.match(/'\/stream\/bot\/dock\/[^']*',/g) || []).join(','), "'/stream/bot/dock/api/run',", 'only the run API is CSRF-exempt');
    const r = fs.readFileSync(path.join(root, 'dashboard/routes/stream-bot.js'), 'utf8');
    assert.equal((r.match(/automationsChanged\(sb, profile\.id\);/g) || []).length, 4, 'create, update, delete, toggle');
    assert.match(r, /type: 'automations_changed'/);
    assert.equal((r.match(/closeDockStreams\(id\);/g) || []).length, 2, 'revoke and delete');
    const dockRoutes = fs.readFileSync(path.join(root, 'dashboard/routes/stream-bot-dock.js'), 'utf8');
    for (const m of dockRoutes.matchAll(/logger\.\w+\(([^;]*)\);/g)) assert.doesNotMatch(m[1], /\bkey\b\s*[,}]/, 'dock keys are never logged');
});

test('VOD-safe music: the state report keeps a capped music block; studioMusicStatus reads the newest Studio', async () => {
    const { sanitiseMusic, studioMusicStatus } = await import('../core/stream-bot/studio.js');
    assert.deepEqual(sanitiseMusic({ vodSafe: true, reason: null, vodTrack: 2, liveTrack: 1, sourceReady: true, live: true, checkedAt: 1763550000000, extra: 'dropped' }),
        { vodSafe: true, reason: null, vodTrack: 2, liveTrack: 1, sourceReady: true, live: true, checkedAt: 1763550000000 });
    const odd = sanitiseMusic({ vodSafe: 'yes', reason: 'x'.repeat(300), vodTrack: 9, liveTrack: '3', checkedAt: 'soon' });
    assert.deepEqual([odd.vodSafe, odd.reason.length, odd.vodTrack, odd.liveTrack, odd.checkedAt], [false, 200, null, 3, null]);
    assert.equal(sanitiseMusic(null), null);

    assert.deepEqual(studioMusicStatus(hub, profile.id + 999), { vodSafe: false, reason: 'CertiFried Studio is not connected.', deviceId: null });
    const d = await device(profile, 'studio', 'Music PC');
    const c = client(d.token);
    await c.next('welcome');
    assert.equal(studioMusicStatus(hub, profile.id).vodSafe, false, 'not reported yet');
    const reason = "Music is paused: VOD protection isn't active in OBS. It turns on at the next stream start.";
    c.send({ type: 'state', obs: { connected: true, scenes: ['Main'] }, sounds: [], music: { vodSafe: false, reason, vodTrack: 2, liveTrack: 1, sourceReady: false, live: false, checkedAt: Date.now() } });
    await c.next('state_ok');
    assert.deepEqual(studioMusicStatus(hub, profile.id), { vodSafe: false, reason, deviceId: d.id });
    const live = hub.connected(profile.id).find((x) => x.deviceId === d.id);
    assert.equal(live.state.music.vodTrack, 2);
    c.send({ type: 'state', obs: { connected: true, scenes: ['Main'] }, sounds: [], music: { vodSafe: true, reason: null, vodTrack: 2, liveTrack: 1, sourceReady: true, live: true, checkedAt: Date.now() } });
    await c.next('state_ok');
    assert.deepEqual(studioMusicStatus(hub, profile.id), { vodSafe: true, reason: null, deviceId: d.id });
    const saved = await until(async () => { const s = (await store.getProfile(profile.id)).settings.studio; return s?.deviceId === d.id && s.music?.vodSafe === true && s; });
    assert.equal(saved.music.liveTrack, 1, 'kept in settings.studio');
    c.ws.close();
    await c.closed;
});
