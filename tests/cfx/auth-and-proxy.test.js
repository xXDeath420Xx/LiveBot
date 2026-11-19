// CertiFried Tycoon (cfx): the dev sign-in gate (H-400), Bits receipt verification (H-401), the
// dashboard reverse proxy for /game and /cfx/* including WebSocket upgrades (H-411, H-403), and the
// Twitch panel package rules (H-404).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

const SECRET_B64 = Buffer.from('cfx-test-extension-secret-0123456789').toString('base64');
process.env.CFX_TWITCH_EXT_SECRET = SECRET_B64;

const { verifyBitsReceipt } = await import('../../services/certifried-extension/middleware/twitch-jwt.js');
const { devAuthAllowed } = await import('../../services/certifried-extension/routes/auth.js');
const { mapCfxPath, cfxProxy, attachCfxUpgrade } = await import('../../services/certifried-extension/integration/dashboard-proxy.js');

const receipt = (data, opts = {}) => jwt.sign(
    { topic: opts.topic || 'bits_transaction_receipt', exp: Math.floor(Date.now() / 1000) + 60, data },
    opts.secret || Buffer.from(SECRET_B64, 'base64'), { algorithm: 'HS256' });
const goodData = { transactionId: 'tx-1', userId: '123', product: { sku: 'speed_boost_1h', cost: { amount: 100, type: 'bits' }, inDevelopment: false } };

test('dev sign-in: off unless CFX_DEV_AUTH=1, and only from loopback with no proxy headers', () => {
    const req = (ip, headers = {}) => ({ socket: { remoteAddress: ip }, headers });
    const saved = process.env.CFX_DEV_AUTH;
    try {
        delete process.env.CFX_DEV_AUTH;
        assert.equal(devAuthAllowed(req('127.0.0.1')), false);
        process.env.CFX_DEV_AUTH = '1';
        assert.equal(devAuthAllowed(req('127.0.0.1')), true);
        assert.equal(devAuthAllowed(req('::1')), true);
        assert.equal(devAuthAllowed(req('::ffff:127.0.0.1')), true);
        assert.equal(devAuthAllowed(req('203.0.113.9')), false, 'not from the internet');
        assert.equal(devAuthAllowed(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })), false, 'not through the dashboard proxy');
        assert.equal(devAuthAllowed(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' })), false);
    } finally {
        if (saved === undefined) delete process.env.CFX_DEV_AUTH; else process.env.CFX_DEV_AUTH = saved;
    }
});

test('Bits receipts: only a Twitch-signed bits receipt is accepted', () => {
    assert.deepEqual(verifyBitsReceipt(receipt(goodData)),
        { transactionId: 'tx-1', userId: '123', sku: 'speed_boost_1h', bits: 100, inDevelopment: false });
    assert.equal(verifyBitsReceipt(receipt(goodData, { secret: 'someone-else' })), null, 'wrong signature');
    assert.equal(verifyBitsReceipt(receipt(goodData, { topic: 'other' })), null, 'not a bits receipt');
    assert.equal(verifyBitsReceipt(receipt({ ...goodData, product: {} })), null, 'no SKU');
    assert.equal(verifyBitsReceipt(receipt({ ...goodData, userId: undefined })), null, 'no user');
    assert.equal(verifyBitsReceipt(undefined), null);
    assert.equal(verifyBitsReceipt('x'.repeat(5000)), null);
    const expired = jwt.sign({ topic: 'bits_transaction_receipt', exp: Math.floor(Date.now() / 1000) - 10, data: goodData },
        Buffer.from(SECRET_B64, 'base64'), { algorithm: 'HS256' });
    assert.equal(verifyBitsReceipt(expired), null, 'expired');
});

test('proxy path mapping', () => {
    assert.deepEqual(mapCfxPath('/game'), { path: '/game' });
    assert.deepEqual(mapCfxPath('/game/?signin=discord'), { path: '/game?signin=discord' });
    assert.deepEqual(mapCfxPath('/cfx'), { redirect: '/game' });
    assert.deepEqual(mapCfxPath('/cfx/'), { redirect: '/game' });
    assert.deepEqual(mapCfxPath('/cfx/api/v1/game/state?x=1'), { path: '/api/v1/game/state?x=1' });
    assert.deepEqual(mapCfxPath('/cfx/dist/app.js'), { path: '/dist/app.js' });
    assert.deepEqual(mapCfxPath('/cfx/ws?token=abc'), { path: '/ws?token=abc' });
    assert.deepEqual(mapCfxPath('/cfx/health'), { path: '/health' });
    // the older public address passes through unchanged (lets the edge send it to the dashboard)
    assert.deepEqual(mapCfxPath('/cfx-api/api/v1/auth/twitch/callback?code=1'), { path: '/cfx-api/api/v1/auth/twitch/callback?code=1' });
    assert.deepEqual(mapCfxPath('/cfx-api/game'), { path: '/cfx-api/game' });
    assert.deepEqual(mapCfxPath('/cfx-api/ws?token=a'), { path: '/cfx-api/ws?token=a' });
    assert.equal(mapCfxPath('/cfx-api/other'), null);
    assert.equal(mapCfxPath('/cfx-api/../x'), null);
    for (const u of ['/cfx/session/discord', '/cfx/admin', '/cfx/../etc/passwd', '/cfx/api/../../x', '/cfxapi/v1', '/gamer', '/dashboard']) {
        assert.equal(mapCfxPath(u), null, u);
    }
});

async function listen(server) {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return server.address().port;
}

test('proxy forwards requests, strips the dashboard cookie, adds forwarding headers, 502 when the game is down', async () => {
    const seen = [];
    const upstream = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, cookie: req.headers.cookie, xff: req.headers['x-forwarded-for'], body });
            res.writeHead(201, { 'content-type': 'application/json', 'x-cfx': 'yes' });
            res.end(JSON.stringify({ ok: true }));
        });
    });
    const upPort = await listen(upstream);
    const savedPort = process.env.CFX_PORT;
    process.env.CFX_PORT = String(upPort);
    const app = express();
    app.use(cfxProxy());
    app.use((req, res) => res.status(404).send('dashboard'));
    const front = http.createServer(app);
    const port = await listen(front);
    try {
        let r = await fetch(`http://127.0.0.1:${port}/cfx/api/v1/grow/plant?a=1`, {
            method: 'POST', headers: { 'content-type': 'application/json', cookie: 'connect.sid=secret', 'cf-connecting-ip': '198.51.100.7' },
            body: JSON.stringify({ slotNumber: 1 })
        });
        assert.equal(r.status, 201);
        assert.equal(r.headers.get('x-cfx'), 'yes');
        assert.deepEqual(seen[0], { method: 'POST', url: '/api/v1/grow/plant?a=1', cookie: undefined, xff: '198.51.100.7', body: '{"slotNumber":1}' });

        r = await fetch(`http://127.0.0.1:${port}/cfx`, { redirect: 'manual' });
        assert.equal(r.status, 302);
        assert.equal(r.headers.get('location'), '/game');

        r = await fetch(`http://127.0.0.1:${port}/cfx/session/discord`);
        assert.equal(await r.text(), 'dashboard', 'session route is left to the dashboard');

        r = await fetch(`http://127.0.0.1:${port}/game`, { method: 'POST' });
        assert.equal(await r.text(), 'dashboard', 'only GET/HEAD for the page');

        await new Promise((res) => upstream.close(res));
        r = await fetch(`http://127.0.0.1:${port}/cfx/api/v1/game/state`);
        assert.equal(r.status, 502);
        assert.equal((await r.json()).code, 'GAME_OFFLINE');
    } finally {
        if (savedPort === undefined) delete process.env.CFX_PORT; else process.env.CFX_PORT = savedPort;
        await new Promise((res) => front.close(res));
    }
});

test('proxy forwards WebSocket upgrades on /cfx/ws and leaves other upgrades alone', async () => {
    const upstream = http.createServer();
    const wss = new WebSocketServer({ server: upstream, path: '/ws' });
    wss.on('connection', (ws, req) => ws.send(`hello ${new URL(req.url, 'http://x').searchParams.get('token')}`));
    const upPort = await listen(upstream);
    const savedPort = process.env.CFX_PORT;
    process.env.CFX_PORT = String(upPort);
    // This covers the old game before the cutover; once GREENHOUSE_LIVE=1 (as on the live server) the proxy
    // answers 410 instead, which tests/cfx/v2/cutover.test.js covers.
    const savedLive = process.env.GREENHOUSE_LIVE;
    process.env.GREENHOUSE_LIVE = '0';
    const front = http.createServer((req, res) => res.end('page'));
    attachCfxUpgrade(front);
    let otherUpgrades = 0;
    front.on('upgrade', (req, socket) => { if (!req.url.startsWith('/cfx/ws')) { otherUpgrades++; socket.destroy(); } });
    const port = await listen(front);
    try {
        const msg = await new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/cfx/ws?token=abc`);
            ws.on('message', (m) => { resolve(String(m)); ws.close(); });
            ws.on('error', reject);
        });
        assert.equal(msg, 'hello abc');
        await new Promise((resolve) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4`);
            ws.on('error', () => resolve());
            ws.on('close', () => resolve());
        });
        assert.equal(otherUpgrades, 1, 'a non-game upgrade reaches the other handler');
    } finally {
        if (savedPort === undefined) delete process.env.CFX_PORT; else process.env.CFX_PORT = savedPort;
        if (savedLive === undefined) delete process.env.GREENHOUSE_LIVE; else process.env.GREENHOUSE_LIVE = savedLive;
        wss.close();
        await new Promise((res) => upstream.close(res));
        await new Promise((res) => front.close(res));
    }
});

test('Twitch panel package: helper is the only remote script, no inline script, relative assets', () => {
    const dir = new URL('../../services/certifried-extension/twitch-extension/panel/', import.meta.url);
    const html = fs.readFileSync(new URL('panel.html', dir), 'utf8');
    const srcs = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(srcs, ['https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js', 'panel.js']);
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline script');
    assert.ok(!/(href|src)="\//.test(html), 'no absolute asset paths');
    for (const f of ['app.js', 'main.css', 'panel.css', 'panel.js']) assert.ok(fs.existsSync(new URL(f, dir)), `${f} is in the package`);
    const bundle = fs.readFileSync(new URL('app.js', dir), 'utf8');
    assert.ok(!/\beval\(/.test(bundle), 'no eval in the bundle');
});
