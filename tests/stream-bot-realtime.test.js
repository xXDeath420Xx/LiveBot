import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import pool from '../utils/db.js';
import { makeTables, makeProfile } from './fixtures/stream-bot-tables.js';
import { createHub, CLOSE, WS_PATH } from '../core/stream-bot/realtime.js';
import { newDeviceToken, newPairingCode, normaliseCode, hashSecret, tokenHint, isTokenShape, CODE_TTL_MS } from '../core/stream-bot/pairing.js';

/*
 * The realtime channel (core/stream-bot/realtime.js, design §2.4) on a real ws server bound to 127.0.0.1 with
 * throwaway tables: pairing codes and device tokens (hashed, single use, expiry, revocation), the hello / welcome
 * handshake and its failures, heartbeat, dispatch with acks, timeouts and retries, the offline queue and its
 * expiry, capabilities, event push and the per-socket message limit.
 */

let T, store, profile, server, hub, port;
let offset = 0;
const now = () => Date.now() + offset;
const ACK_MS = 150;

async function device(kind = 'studio', name = 'Desk PC') {
    const token = newDeviceToken();
    const id = await store.createDevice(profile.id, { kind, name, tokenHash: hashSecret(token), tokenHint: tokenHint(token), capabilities: [] });
    return { token, id };
}

function client({ token, caps = ['obs', 'sound'], hello = true, autoAck = true, ackOk = true } = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
    const c = { ws, msgs: [], actions: [], waiters: [], autoAck, ackOk };
    c.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
    ws.on('message', (data) => {
        const m = JSON.parse(String(data));
        c.msgs.push(m);
        if (m.type === 'action') {
            c.actions.push(m);
            if (c.autoAck) ws.send(JSON.stringify(c.ackOk ? { type: 'ack', id: m.id, ok: true, result: { done: m.action } } : { type: 'ack', id: m.id, ok: false, error: 'scene_not_found' }));
        }
        for (const w of [...c.waiters]) if (w.test(m)) { c.waiters.splice(c.waiters.indexOf(w), 1); w.resolve(m); }
    });
    c.next = (type, ms = 3000) => new Promise((resolve, reject) => {
        const hit = c.msgs.find((m) => m.type === type && !m._seen);
        if (hit) { hit._seen = true; return resolve(hit); }
        const t = setTimeout(() => reject(new Error(`no ${type} within ${ms} ms`)), ms);
        c.waiters.push({ test: (m) => m.type === type && !m._seen && (m._seen = true), resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
    c.send = (o) => ws.send(typeof o === 'string' ? o : JSON.stringify(o));
    c.opened = new Promise((resolve) => ws.on('open', resolve));
    if (hello && token) c.opened.then(() => c.send({ type: 'hello', proto: 1, token, client: { app: 'certifried-studio', version: '0.0.1-test' }, capabilities: caps }));
    return c;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error('condition not met in time');
        await sleep(20);
    }
};

test.before(async () => {
    T = await makeTables(pool, 'r');
    store = T.store;
    profile = await makeProfile(store);
    server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    hub = createHub({ store, now, heartbeatMs: 300, helloTimeoutMs: 250, ackTimeoutMs: ACK_MS, maxAttempts: 3, sweepMs: 60_000, rate: { count: 30, windowMs: 1000 } });
    hub.attach(server);
});
test.after(async () => {
    hub.close();
    server.closeAllConnections?.();
    // Not awaited: the unhandled upgrade from the last test keeps a raw socket the server never finishes.
    server.close();
    server.unref();
    await T.drop();
    const [rows] = await pool.query('SHOW TABLES LIKE ?', [`${T.prefix}%`]);
    assert.equal(rows.length, 0, 'throwaway tables dropped');
    await pool.end().catch(() => {});
});

test('pairing codes and tokens: shapes, hashing, single use, expiry', async () => {
    const code = newPairingCode();
    assert.match(code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    assert.equal(normaliseCode(code.toLowerCase().replace('-', ' ')), code, 'case, spaces and dashes ignored');
    assert.equal(normaliseCode('ABCD-EFG0'), null, 'look-alike characters are not in the alphabet');
    assert.equal(normaliseCode('short'), null);
    const tok = newDeviceToken();
    assert.ok(isTokenShape(tok)); assert.ok(!isTokenShape('sbd_short')); assert.ok(!isTokenShape(null));
    assert.notEqual(newDeviceToken(), tok);
    assert.equal(hashSecret(tok).length, 64); assert.equal(hashSecret(tok), hashSecret(tok)); assert.equal(tokenHint(tok), tok.slice(-4));

    await store.createPairingCode(profile.id, { codeHash: hashSecret(code), kind: 'studio', name: 'Desk PC', expiresAt: new Date(Date.now() + CODE_TTL_MS) });
    const used = await store.consumePairingCode(hashSecret(code));
    assert.deepEqual(used, { profileId: profile.id, kind: 'studio', name: 'Desk PC' });
    assert.equal(await store.consumePairingCode(hashSecret(code)), null, 'single use');
    const old = newPairingCode();
    await store.createPairingCode(profile.id, { codeHash: hashSecret(old), kind: 'studio', expiresAt: new Date(Date.now() - 1000) });
    assert.equal(await store.consumePairingCode(hashSecret(old)), null, 'expired');
    assert.equal(await store.consumePairingCode(hashSecret(newPairingCode())), null, 'unknown');
    const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM \`${T.prefix}pairing_codes\` WHERE code_hash = ?`, [code]);
    assert.equal(Number(n), 0, 'the code itself is never stored');
});

test('hello: a valid token gets welcome; bad, revoked, missing hello and bad JSON are closed', async () => {
    const d = await device();
    const ok = client({ token: d.token });
    const w = await ok.next('welcome');
    assert.deepEqual([w.proto, w.deviceId, w.kind, w.heartbeatMs], [1, d.id, 'studio', 300]);
    assert.equal(hub.connected(profile.id).length, 1);
    const dev = await store.getDevice(profile.id, d.id);
    assert.ok(dev.lastSeenAt); assert.equal(dev.clientInfo, 'certifried-studio 0.0.1-test'); assert.deepEqual(dev.capabilities, ['obs', 'sound']);
    ok.send({ type: 'ping', t: 42 });
    assert.equal((await ok.next('pong')).t, 42);

    const bad = client({ token: newDeviceToken() });
    assert.equal((await bad.next('error')).code, 'auth_failed');
    assert.equal(await bad.closed, CLOSE.auth);
    const junk = client({ token: 'not-a-token' });
    assert.equal(await junk.closed, CLOSE.auth);

    const early = client({ hello: false });
    await early.opened;
    early.send({ type: 'ping' });
    assert.equal(await early.closed, CLOSE.auth, 'hello first');
    const silent = client({ hello: false });
    await silent.opened;
    await sleep(300);
    await hub.sweep();
    assert.equal(await silent.closed, CLOSE.timeout, 'no hello in time');
    const garbage = client({ hello: false });
    await garbage.opened;
    garbage.send('{not json');
    assert.equal(await garbage.closed, CLOSE.bad);

    // same token again replaces the first connection
    const again = client({ token: d.token });
    await again.next('welcome');
    assert.equal(await ok.closed, CLOSE.replaced);
    // revoke while connected: closed at once, and the token no longer works
    assert.ok(await store.revokeDevice(profile.id, d.id));
    assert.ok(hub.disconnectDevice(d.id));
    assert.equal(await again.closed, CLOSE.revoked);
    const after = client({ token: d.token });
    assert.equal(await after.closed, CLOSE.auth);
    await until(() => hub.connected(profile.id).length === 0);
});

test('heartbeat: silence for 2.5 heartbeats closes the socket', async () => {
    const d = await device();
    const c = client({ token: d.token });
    await c.next('welcome');
    await sleep(800);
    await hub.sweep();
    assert.equal(await c.closed, CLOSE.timeout);
});

test('dispatch: sent to the device, acked with a result; a reported failure is recorded', async () => {
    const d = await device();
    const c = client({ token: d.token });
    await c.next('welcome');
    const r = await hub.dispatch({ profileId: profile.id, runId: 77, target: 'studio', capability: 'obs', actionType: 'obs.scene', params: { scene: 'BRB' }, queueSeconds: 60 });
    assert.equal(r.status, 'sent');
    const a = await c.next('action');
    assert.deepEqual([a.id, a.action, a.params.scene, a.runId, a.attempt], [r.id, 'obs.scene', 'BRB', 77, 1]);
    const row = await until(async () => { const x = await store.getDispatch(r.id); return x.status === 'acked' && x; });
    assert.deepEqual([row.deviceId, row.attempts, row.result], [d.id, 1, { done: 'obs.scene' }]);
    assert.ok(row.sentAt && row.ackedAt);

    c.ackOk = false;
    const r2 = await hub.dispatch({ profileId: profile.id, runId: 78, target: 'studio', capability: 'obs', actionType: 'obs.scene', params: { scene: 'Nope' } });
    const row2 = await until(async () => { const x = await store.getDispatch(r2.id); return x.status === 'failed' && x; });
    assert.equal(row2.error, 'scene_not_found');
    assert.equal((await store.dispatchesForRun(profile.id, 78)).length, 1);
    c.ws.close();
    await c.closed;
});

test('no ack: retried on another device, then given up after three tries', async () => {
    const d1 = await device('studio', 'PC one');
    const d2 = await device('studio', 'PC two');
    const c1 = client({ token: d1.token, autoAck: false });
    await c1.next('welcome');
    await sleep(20);
    const c2 = client({ token: d2.token, autoAck: false });
    await c2.next('welcome');
    const r = await hub.dispatch({ profileId: profile.id, target: 'studio', capability: 'sound', actionType: 'sound.play', params: { sound: 'airhorn.mp3', volume: 80 } });
    const first = await c2.next('action');               // newest connection first
    assert.equal(first.attempt, 1);
    const second = await c1.next('action', 2000);         // no ack → the other device
    assert.equal(second.attempt, 2);
    c1.send({ type: 'ack', id: second.id, ok: true });
    const row = await until(async () => { const x = await store.getDispatch(r.id); return x.status === 'acked' && x; });
    assert.deepEqual([row.attempts, row.deviceId], [2, d1.id]);
    c2.send({ type: 'ack', id: first.id, ok: true });     // a late ack from the first device changes nothing
    await sleep(50);
    assert.equal((await store.getDispatch(r.id)).deviceId, d1.id);

    const r2 = await hub.dispatch({ profileId: profile.id, target: 'studio', capability: 'sound', actionType: 'sound.play', params: { sound: 'x' } });
    const row2 = await until(async () => { const x = await store.getDispatch(r2.id); return x.status === 'failed' && x; }, 3000);
    assert.equal(row2.attempts, 3); assert.match(row2.error, /no answer after 3 tries/);
    c1.ws.close(); c2.ws.close();
    await Promise.all([c1.closed, c2.closed]);
});

test('offline: queued, delivered in order at the next hello; capabilities respected; queued rows expire', async () => {
    await until(() => hub.connected(profile.id).length === 0);
    const q1 = await hub.dispatch({ profileId: profile.id, runId: 90, target: 'studio', capability: 'obs', actionType: 'obs.scene', params: { scene: 'Starting' }, queueSeconds: 120 });
    const q2 = await hub.dispatch({ profileId: profile.id, runId: 90, target: 'studio', capability: 'obs', actionType: 'obs.record', params: { state: 'start' }, queueSeconds: 120 });
    const qs = await hub.dispatch({ profileId: profile.id, runId: 90, target: 'studio', capability: 'hotkey', actionType: 'studio.hotkey', params: { keys: 'F1' }, queueSeconds: 120 });
    const none = await hub.dispatch({ profileId: profile.id, target: 'overlay', capability: 'alert', actionType: 'overlay.alert', params: { title: 'x' }, queueSeconds: 0 });
    assert.deepEqual([q1.status, q2.status, none.status], ['queued', 'queued', 'none']);
    assert.equal((await store.getDispatch(none.id)).status, 'expired', 'queueSeconds 0 and nothing connected: dropped');

    const d = await device();
    const c = client({ token: d.token, caps: ['obs'] });
    await c.next('welcome');
    const a1 = await c.next('action');
    const a2 = await c.next('action');
    assert.deepEqual([a1.id, a2.id], [q1.id, q2.id], 'in order');
    await until(async () => (await store.getDispatch(q2.id)).status === 'acked');
    await sleep(100);
    assert.equal(c.actions.some((a) => a.id === qs.id), false, 'a device without the hotkey capability is not sent hotkeys');
    assert.equal((await store.getDispatch(qs.id)).status, 'queued');

    // expiry: move the clock past it and sweep
    c.ws.close();
    await c.closed;
    offset += 121_000;
    await hub.sweep();
    assert.equal((await store.getDispatch(qs.id)).status, 'expired');
    offset = 0;
});

test('events are pushed to subscribers only; too many messages closes the socket', async () => {
    const d = await device('overlay', 'Alert box');
    const sub = client({ token: d.token, caps: [] });
    await sub.next('welcome');
    sub.send({ type: 'subscribe', topics: ['events', 'secrets'] });
    assert.deepEqual((await sub.next('subscribed')).topics, ['events']);
    const d2 = await device('studio', 'Quiet');
    const quiet = client({ token: d2.token });
    await quiet.next('welcome');
    hub.publishEvent(profile.id, { type: 'follow', user: { name: 'Juniper' } });
    hub.publishEvent(profile.id + 999, { type: 'follow', user: { name: 'Elsewhere' } });
    const ev = await sub.next('event');
    assert.equal(ev.event.user.name, 'Juniper');
    await sleep(100);
    assert.equal(quiet.msgs.some((m) => m.type === 'event'), false);
    assert.equal(sub.msgs.filter((m) => m.type === 'event').length, 1, 'other profiles\' events never arrive');

    for (let i = 0; i < 40; i++) quiet.send({ type: 'ping', t: i });
    assert.equal(await quiet.closed, CLOSE.rate);
    sub.ws.close();
    await sub.closed;
});

test('only the stream bot path is upgraded', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    const outcome = await Promise.race([
        new Promise((r) => ws.on('open', () => r('open'))),
        new Promise((r) => ws.on('error', () => r('error'))),
        sleep(400).then(() => 'no answer'),
    ]);
    assert.notEqual(outcome, 'open');
    ws.terminate();
});
