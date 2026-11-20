'use strict';
/*
 * The Stream Deck bridge (src/main/bridge-server.js) with a real ws client on 127.0.0.1 and random free ports:
 * Origin and Host checks, the hello/token handshake and its lockout, request round trips, rate limiting, broadcast only
 * to signed-in clients, token regeneration, and that nothing listens beyond 127.0.0.1.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const WebSocket = require('ws');
const { createBridgeServer, generateBridgeToken } = require('../src/main/bridge-server');

const TOKEN = generateBridgeToken();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function memLogger() {
    const lines = [];
    const add = (level) => (msg, meta) => lines.push({ level, msg, meta: JSON.stringify(meta ?? null) });
    return { lines, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

/** Open a client; resolves { ws, frames, closed } once open (or rejects with the HTTP status on a refused upgrade). */
function connect(port, { origin, host, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const h = { ...headers };
        if (host) h.Host = host;
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: h, ...(origin ? { origin } : {}) });
        const frames = [];
        const c = { ws, frames, closed: null };
        c.closedP = new Promise((res) => ws.on('close', (code, reason) => { c.closed = { code, reason: String(reason) }; res(c.closed); }));
        ws.on('message', (d) => frames.push(JSON.parse(String(d))));
        ws.on('open', () => resolve(c));
        ws.on('unexpected-response', (req, res) => { reject(Object.assign(new Error('refused'), { status: res.statusCode })); ws.terminate(); });
        ws.on('error', (e) => reject(e));
    });
}
async function until(fn, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(10); }
}
const send = (c, m) => c.ws.send(JSON.stringify(m));
async function signIn(port, token = TOKEN) {
    const c = await connect(port);
    send(c, { type: 'hello', token, client: { app: 'test', version: '1.0.0' } });
    await until(() => c.frames.find((f) => f.type === 'welcome' || f.type === 'error'));
    return c;
}
function request(c, id, method, params) {
    send(c, { type: 'request', id, method, params });
    return until(() => c.frames.find((f) => f.type === 'response' && f.id === id));
}

let bridge, port, log, calls;
const handlers = {
    'automations.list': async () => ({ automations: [{ id: 1, name: 'Hype', enabled: true }] }),
    'obs.scene': async (p) => { calls.push(p); if (p.scene === 'Nope') { const e = new Error('No such scene'); e.code = 'scene_not_found'; throw e; } return { scene: p.scene }; },
    status: async () => ({ obs: { connected: true, currentScene: 'Main' } }),
};

test.before(async () => {
    log = memLogger();
    calls = [];
    bridge = createBridgeServer({ logger: log, port: 0, getToken: () => TOKEN, handlers, version: '0.2.6' });
    ({ port } = await bridge.start());
});
test.after(async () => { await bridge.stop(); });

test('token format', () => {
    assert.match(TOKEN, /^sdk_[A-Za-z0-9_-]{32}$/);
    assert.notEqual(generateBridgeToken(), TOKEN);
});

test('listens on 127.0.0.1 only', async () => {
    assert.equal(bridge.status().running, true);
    assert.equal(bridge.status().port, port);
    const tryConnect = (host) => new Promise((resolve) => {
        const s = net.connect({ host, port }, () => { s.destroy(); resolve('open'); });
        s.on('error', (e) => resolve(e.code));
        s.setTimeout(1000, () => { s.destroy(); resolve('timeout'); });
    });
    assert.equal(await tryConnect('127.0.0.1'), 'open');
    assert.notEqual(await tryConnect('127.0.0.2'), 'open', 'another loopback address is not served');
    assert.notEqual(await tryConnect('::1'), 'open', 'IPv6 loopback is not served');
});

test('a connection with an Origin header is refused with 403 and logged without its value', async () => {
    await assert.rejects(connect(port, { origin: 'https://evil.example' }), (e) => e.status === 403);
    const line = log.lines.find((l) => l.msg.includes('refused') && l.meta.includes('origin_present'));
    assert.ok(line);
    assert.ok(!log.lines.some((l) => l.meta.includes('evil.example') || l.msg.includes('evil.example')));
});

test('a wrong Host header is refused (DNS rebinding); localhost:<port> is accepted', async () => {
    await assert.rejects(connect(port, { host: `rebind.example:${port}` }), (e) => e.status === 403);
    await assert.rejects(connect(port, { host: `127.0.0.1:${port + 1}` }), (e) => e.status === 403);
    assert.ok(log.lines.some((l) => l.meta.includes('bad_host')));
    assert.ok(!log.lines.some((l) => l.meta.includes('rebind.example')));
    const c = await connect(port, { host: `localhost:${port}` });
    c.ws.close();
    await c.closedP;
});

test('wrong token: auth_failed then close 4401; a request before hello closes 4400', async () => {
    const c = await signIn(port, 'sdk_wrong');
    assert.deepEqual(c.frames[0].code, 'auth_failed');
    assert.equal((await c.closedP).code, 4401);
    assert.ok(!log.lines.some((l) => l.meta.includes('sdk_wrong')), 'the token is never logged');

    const d = await connect(port);
    send(d, { type: 'request', id: 1, method: 'status' });
    assert.equal((await d.closedP).code, 4400);
    assert.equal(d.frames[0].code, 'hello_required');
});

test('no hello within the time limit closes 4408', async () => {
    const b = createBridgeServer({ port: 0, getToken: () => TOKEN, handlers, helloMs: 100 });
    const { port: p } = await b.start();
    try {
        const c = await connect(p);
        assert.equal((await c.closedP).code, 4408);
    } finally { await b.stop(); }
});

test('hello → welcome, request round trip, handler errors, unknown method, bad frames', async () => {
    const c = await signIn(port);
    const w = c.frames.find((f) => f.type === 'welcome');
    assert.equal(w.proto, 1);
    assert.deepEqual(w.studio, { version: '0.2.6' });
    assert.deepEqual(w.methods, ['automations.list', 'obs.scene', 'status']);
    assert.deepEqual(await request(c, 'a', 'automations.list', {}), { type: 'response', id: 'a', ok: true, result: { automations: [{ id: 1, name: 'Hype', enabled: true }] } });
    assert.deepEqual(await request(c, 2, 'obs.scene', { scene: 'BRB' }), { type: 'response', id: 2, ok: true, result: { scene: 'BRB' } });
    assert.deepEqual(calls.at(-1), { scene: 'BRB' });
    assert.deepEqual(await request(c, 3, 'obs.scene', { scene: 'Nope' }), { type: 'response', id: 3, ok: false, error: 'scene_not_found', message: 'No such scene' });
    assert.equal((await request(c, 4, 'nope.method', {})).error, 'unknown_method');
    assert.equal((await request(c, 5, 'toString', {})).error, 'unknown_method', 'no prototype methods');
    c.ws.send('not json');
    await until(() => c.frames.find((f) => f.code === 'bad_frame'));
    assert.equal(c.closed, null, 'a signed-in client keeps its socket after a bad frame');
    assert.equal(bridge.status().clients, 1);
    assert.deepEqual(bridge.status().clientList.map((x) => x.app), ['test']);
    c.ws.close();
    await c.closedP;
});

test('more than 20 requests in a second are refused with rate_limited', async () => {
    const c = await signIn(port);
    // Start right after a second boundary so the burst lands in one window.
    await sleep(1000 - (Date.now() % 1000) + 5);
    for (let i = 0; i < 30; i++) send(c, { type: 'request', id: `r${i}`, method: 'status' });
    await until(() => c.frames.filter((f) => f.type === 'response').length === 30);
    const res = c.frames.filter((f) => f.type === 'response');
    assert.equal(res.filter((f) => f.ok).length, 20);
    assert.equal(res.filter((f) => f.error === 'rate_limited').length, 10);
    c.ws.close();
    await c.closedP;
});

test('broadcast reaches signed-in clients only', async () => {
    const a = await signIn(port);
    const pending = await connect(port);
    const n = bridge.broadcast({ type: 'obs', event: 'CurrentProgramSceneChanged', data: { sceneName: 'BRB' } });
    assert.equal(n, 1);
    await until(() => a.frames.find((f) => f.type === 'obs'));
    await sleep(50);
    assert.equal(pending.frames.length, 0);
    a.ws.close(); pending.ws.close();
    await Promise.all([a.closedP, pending.closedP]);
});

test('dropClients (token regenerated) closes everyone with 4403', async () => {
    const a = await signIn(port);
    const b = await signIn(port);
    assert.equal(bridge.dropClients(), 2);
    assert.equal((await a.closedP).code, 4403);
    assert.equal((await b.closedP).code, 4403);
});

test('at most 8 connections', async () => {
    const open = [];
    for (let i = 0; i < 8; i++) open.push(await connect(port));
    await assert.rejects(connect(port), (e) => e.status === 503);
    for (const c of open) c.ws.close();
    await Promise.all(open.map((c) => c.closedP));
});

test('10 failed hellos in a minute lock every hello out for 60 s', async () => {
    let t = 1_000_000;
    const b = createBridgeServer({ port: 0, getToken: () => TOKEN, handlers, now: () => t });
    const { port: p } = await b.start();
    try {
        for (let i = 0; i < 10; i++) {
            const c = await signIn(p, `sdk_bad${i}`);
            assert.equal((await c.closedP).code, 4401);
        }
        const good = await signIn(p);
        assert.equal(good.frames[0].code, 'locked_out', 'even the right token is refused while locked');
        assert.equal((await good.closedP).code, 4429);
        assert.ok(b.status().lockedUntil);
        t += 61_000;
        const later = await signIn(p);
        assert.equal(later.frames[0].type, 'welcome');
        later.ws.close();
        await later.closedP;
    } finally { await b.stop(); }
});

test('failures spread over more than a minute do not lock', async () => {
    let t = 5_000_000;
    const b = createBridgeServer({ port: 0, getToken: () => TOKEN, handlers, now: () => t });
    const { port: p } = await b.start();
    try {
        for (let i = 0; i < 12; i++) { const c = await signIn(p, 'sdk_bad'); await c.closedP; t += 7_000; }
        const ok = await signIn(p);
        assert.equal(ok.frames[0].type, 'welcome');
        ok.ws.close();
        await ok.closedP;
    } finally { await b.stop(); }
});

test('no token configured: every hello fails; a frame over 16 KB closes the socket', async () => {
    const b = createBridgeServer({ port: 0, getToken: () => null, handlers });
    const { port: p } = await b.start();
    try {
        const c = await signIn(p, '');
        assert.equal(c.frames[0].code, 'auth_failed');
        await c.closedP;
        const d = await connect(p);
        d.ws.send(JSON.stringify({ type: 'hello', token: 'x'.repeat(17 * 1024) }));
        assert.equal((await d.closedP).code, 1009);
    } finally { await b.stop(); }
});

test('a port in use is reported as port_in_use; stop closes clients with 1001', async () => {
    const other = createBridgeServer({ port, getToken: () => TOKEN, handlers });
    await assert.rejects(other.start(), (e) => e.code === 'port_in_use');
    const b = createBridgeServer({ port: 0, getToken: () => TOKEN, handlers });
    const { port: p } = await b.start();
    const c = await signIn(p);
    await b.stop();
    assert.equal((await c.closedP).code, 1001);
    assert.equal(b.status().running, false);
});
