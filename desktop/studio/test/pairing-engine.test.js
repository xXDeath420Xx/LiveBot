'use strict';
/*
 * Pairing exchange (POST /stream/bot/api/pair) and the engine connection (hello, welcome, heartbeat, actions with
 * acks, repeated ids, reconnect with backoff, stop codes, phase 2 features) against a small fake engine on 127.0.0.1
 * that speaks the protocol in tests/stream-bot-realtime.test.js on the server.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { normaliseCode, codeFromDeepLink, argvDeepLink, checkServer, wsUrlFor, exchangeCode } = require('../src/main/pairing');
const { createEngineClient } = require('../src/main/engine-client');

const TOKEN = `sbd_${'A'.repeat(43)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(15); }
}

test('codes and deep links', () => {
    assert.equal(normaliseCode('abcd efgh'), 'ABCD-EFGH');
    assert.equal(normaliseCode('ABCD-EFG0'), null, '0 is not in the alphabet');
    assert.equal(normaliseCode('ABC'), null);
    assert.equal(codeFromDeepLink('certifried-studio://pair?code=abcd-efgh'), 'ABCD-EFGH');
    assert.equal(codeFromDeepLink('certifried-studio://pair/?code=ABCDEFGH'), 'ABCD-EFGH');
    assert.equal(codeFromDeepLink('certifried-studio://evil?code=ABCD-EFGH'), null);
    assert.equal(codeFromDeepLink('https://pair?code=ABCD-EFGH'), null);
    assert.equal(argvDeepLink(['C:\\x\\CertiFried Studio.exe', '--flag', 'certifried-studio://pair?code=ABCD-EFGH']), 'certifried-studio://pair?code=ABCD-EFGH');
    assert.equal(argvDeepLink(['a.exe']), null);
});

test('server address: https anywhere, http only on 127.0.0.1', () => {
    assert.equal(checkServer('https://certifriedmultitool.com/'), 'https://certifriedmultitool.com');
    assert.equal(checkServer('http://127.0.0.1:3001'), 'http://127.0.0.1:3001');
    assert.throws(() => checkServer('http://certifriedmultitool.com'), { code: 'bad_server' });
    assert.throws(() => checkServer('ftp://x'), { code: 'bad_server' });
    assert.equal(wsUrlFor('https://certifriedmultitool.com'), 'wss://certifriedmultitool.com/stream/bot/ws');
    assert.equal(wsUrlFor('http://127.0.0.1:3001'), 'ws://127.0.0.1:3001/stream/bot/ws');
});

test('pairing exchange: posts the code once, returns the token; maps 400/429/500/bad bodies', async () => {
    const seen = [];
    let mode = 'ok';
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], body: JSON.parse(body) });
            const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (mode === 'ok') send(200, { token: TOKEN, deviceId: 12, kind: 'studio', wsUrl: 'wss://x/stream/bot/ws', proto: 1 });
            else if (mode === 'bad') send(400, { error: 'invalid_code' });
            else if (mode === 'rate') send(429, { error: 'rate_limited' });
            else if (mode === 'junk') send(200, { token: 'nope' });
            else send(500, { error: 'server_error' });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const r = await exchangeCode({ base, code: 'abcd-efgh', name: 'Desk PC', capabilities: ['obs', 'sound', 'hotkey'] });
        assert.deepEqual(r, { token: TOKEN, deviceId: 12, kind: 'studio' });
        assert.deepEqual(seen[0], { method: 'POST', url: '/stream/bot/api/pair', type: 'application/json', body: { code: 'ABCD-EFGH', name: 'Desk PC', capabilities: ['obs', 'sound', 'hotkey'] } });
        for (const [m, code] of [['bad', 'invalid_code'], ['rate', 'rate_limited'], ['err', 'server_error'], ['junk', 'bad_response']]) {
            mode = m;
            await assert.rejects(exchangeCode({ base, code: 'ABCD-EFGH' }), { code });
        }
        await assert.rejects(exchangeCode({ base, code: 'short' }), { code: 'invalid_code' });
        assert.equal(seen.length, 5, 'a malformed code is not sent');
        await assert.rejects(exchangeCode({ base: 'http://127.0.0.1:1', code: 'ABCD-EFGH', timeoutMs: 2000 }), { code: 'network' });
    } finally {
        server.close();
    }
});

/** A fake engine speaking proto 1. features: what welcome announces. */
async function fakeEngine({ features = [], closeWith = null } = {}) {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    const e = { wss, url: `ws://127.0.0.1:${wss.address().port}/stream/bot/ws`, frames: [], sockets: [], hellos: 0, closeWith };
    wss.on('connection', (ws) => {
        e.sockets.push(ws);
        ws.on('message', (raw) => {
            const m = JSON.parse(String(raw));
            e.frames.push(m);
            if (m.type === 'hello') {
                e.hellos++;
                if (m.token !== TOKEN) { ws.send(JSON.stringify({ type: 'error', code: 'auth_failed' })); ws.close(4401); return; }
                if (e.closeWith) { ws.close(e.closeWith); return; }
                ws.send(JSON.stringify({ type: 'welcome', proto: 1, deviceId: 5, kind: 'studio', heartbeatMs: 5000, serverTime: Date.now(), ...(features.length ? { features } : {}) }));
            } else if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: m.t }));
            else if (m.type === 'request') {
                if (m.method === 'automations.list') ws.send(JSON.stringify({ type: 'response', id: m.id, ok: true, result: { automations: [{ id: 3, name: 'BRB', enabled: true }] } }));
                else ws.send(JSON.stringify({ type: 'response', id: m.id, ok: false, error: 'unknown_method' }));
            }
        });
    });
    e.action = (msg) => { for (const ws of e.sockets) if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'action', ...msg })); };
    e.close = () => new Promise((r) => { for (const ws of e.sockets) ws.terminate(); wss.close(() => r()); });
    return e;
}

test('engine: hello with token and capabilities, welcome, actions acked once even when repeated', async () => {
    const eng = await fakeEngine();
    let runs = 0;
    const c = createEngineClient({
        url: eng.url, getToken: () => TOKEN, clientInfo: { app: 'certifried-studio', version: '0.2.0' }, capabilities: ['obs', 'sound', 'hotkey'],
        onAction: async ({ action, params }) => { runs++; return action === 'obs.scene' ? { ok: true, result: { scene: params.scene } } : { ok: false, error: 'scene_not_found' }; },
    });
    try {
        c.start();
        await until(() => c.status === 'connected');
        const hello = eng.frames.find((f) => f.type === 'hello');
        assert.deepEqual(hello, { type: 'hello', proto: 1, token: TOKEN, client: { app: 'certifried-studio', version: '0.2.0' }, capabilities: ['obs', 'sound', 'hotkey'] });
        eng.action({ id: 'd_1', action: 'obs.scene', params: { scene: 'BRB' }, runId: 9, attempt: 1 });
        await until(() => eng.frames.some((f) => f.type === 'ack' && f.id === 'd_1'));
        assert.deepEqual(eng.frames.find((f) => f.type === 'ack'), { type: 'ack', id: 'd_1', ok: true, result: { scene: 'BRB' } });
        eng.action({ id: 'd_1', action: 'obs.scene', params: { scene: 'BRB' }, attempt: 2 });     // our ack was "lost"
        await until(() => eng.frames.filter((f) => f.type === 'ack' && f.id === 'd_1').length === 2);
        assert.equal(runs, 1, 'not run twice');
        eng.action({ id: 'd_2', action: 'obs.scene_x', params: {} });
        await until(() => eng.frames.some((f) => f.type === 'ack' && f.id === 'd_2'));
        assert.deepEqual(eng.frames.find((f) => f.id === 'd_2'), { type: 'ack', id: 'd_2', ok: false, error: 'scene_not_found' });
        // phase 1 server: no features → state/event/request are not sent (the server would close on unknown types)
        assert.equal(c.sendState({ obs: { connected: true } }), false);
        assert.equal(c.sendEvent({ type: 'obs.stream_started', metadata: {} }), false);
        await assert.rejects(c.request('automations.list'), { code: 'not_supported' });
        assert.equal(eng.frames.some((f) => ['state', 'event', 'request'].includes(f.type)), false);
    } finally {
        c.stop();
        await eng.close();
    }
});

test('engine: phase 2 features — state (deduplicated), events (rate-limited), requests', async () => {
    const eng = await fakeEngine({ features: ['state', 'event', 'request'] });
    const c = createEngineClient({ url: eng.url, getToken: () => TOKEN, onAction: async () => ({ ok: true }), eventLimit: { count: 3, windowMs: 10000 } });
    try {
        c.sendState({ obs: { connected: true, scenes: ['Main'] }, sounds: [] });   // before connecting: kept and sent after welcome
        c.start();
        await until(() => eng.frames.some((f) => f.type === 'state'));
        assert.deepEqual(eng.frames.find((f) => f.type === 'state'), { type: 'state', obs: { connected: true, scenes: ['Main'] }, sounds: [] });
        c.sendState({ obs: { connected: true, scenes: ['Main'] }, sounds: [] });
        await sleep(50);
        assert.equal(eng.frames.filter((f) => f.type === 'state').length, 1, 'identical state not resent');
        for (let i = 0; i < 5; i++) c.sendEvent({ type: 'obs.scene_changed', metadata: { scene: `S${i}` } });
        await sleep(80);
        const evs = eng.frames.filter((f) => f.type === 'event');
        assert.equal(evs.length, 3, 'limited');
        assert.equal(evs[0].event.type, 'obs.scene_changed');
        assert.ok(evs[0].event.occurredAt > 0);
        assert.deepEqual(await c.request('automations.list'), { automations: [{ id: 3, name: 'BRB', enabled: true }] });
        await assert.rejects(c.request('nope'), { code: 'unknown_method' });
    } finally {
        c.stop();
        await eng.close();
    }
});

test('engine: reconnects with backoff after a drop; stops on 4401, 4403 and 4409', async () => {
    const eng = await fakeEngine();
    const c = createEngineClient({ url: eng.url, getToken: () => TOKEN, onAction: async () => ({ ok: true }), backoff: { min: 50, max: 100 } });
    try {
        c.start();
        await until(() => c.status === 'connected');
        eng.sockets[0].terminate();
        await until(() => eng.hellos === 2 && c.status === 'connected');
    } finally {
        c.stop();
        await eng.close();
    }
    for (const [code, status] of [[4401, 'auth_failed'], [4403, 'revoked'], [4409, 'replaced']]) {
        const e2 = await fakeEngine({ closeWith: code });
        const c2 = createEngineClient({ url: e2.url, getToken: () => TOKEN, onAction: async () => ({ ok: true }), backoff: { min: 20, max: 20 } });
        c2.start();
        await until(() => c2.status === status);
        await sleep(120);
        assert.equal(e2.hellos, 1, `${code}: no reconnect loop`);
        c2.stop();
        await e2.close();
    }
    const none = createEngineClient({ url: 'ws://127.0.0.1:1/x', getToken: () => null, onAction: async () => ({ ok: true }) });
    none.start();
    assert.equal(none.status, 'auth_failed', 'not paired: does not try');
});
