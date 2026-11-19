import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import pool from '../utils/db.js';
import { makeTables, makeProfile } from './fixtures/stream-bot-tables.js';
import { createLinkRequests, cleanDeviceName, isLinkId, LINK_TTL_MS } from '../core/stream-bot/link.js';
import { createLinkRouter } from '../dashboard/routes/stream-bot-link.js';
import { hashSecret, isTokenShape } from '../core/stream-bot/pairing.js';
import { csrfProtection } from '../utils/csrf-protection.js';
import { createViewEngine } from '../dashboard/services/view-engine.js';

/*
 * "Sign in with CertiFried" for CertiFried Studio (core/stream-bot/link.js, dashboard/routes/stream-bot-link.js):
 *   the request store (secret-only polling, single use, expiry, wrong-secret limit, capacity), and over HTTP with the
 *   real CSRF middleware, a real view render and throwaway tables: sign-in redirect, approval page, CSRF on Approve,
 *   pending → approved → token once, cancel, expiry, rate limits, and no secret or token in any URL or page.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');
let T, store, profile;

test.before(async () => {
    T = await makeTables(pool, 'l');
    store = T.store;
    profile = await makeProfile(store, `sblink${String(Date.now()).slice(-8)}`);
});
test.after(async () => {
    await T.drop();
    const [rows] = await pool.query('SHOW TABLES LIKE ?', [`${T.prefix}%`]);
    assert.equal(rows.length, 0, 'throwaway tables dropped');
    await pool.end().catch(() => {});
});

// ── the store ───────────────────────────────────────────────────────────────────────────────

test('store: secret-only polling, approval, single use, cancel, expiry, wrong secrets, capacity', () => {
    let t = 1_000_000;
    const links = createLinkRequests({ now: () => t, maxPending: 3 });
    const a = links.create({ name: 'Streaming PC', capabilities: ['OBS', 'sound', 'bad cap!'] });
    assert.ok(isLinkId(a.id));
    assert.match(a.secret, /^[A-Za-z0-9_-]{43}$/);
    assert.match(a.check, /^[A-HJKMNP-Z2-9]{4}$/);
    assert.equal(links.poll(a.id, a.secret).status, 'pending');
    assert.equal(links.poll(a.id, 'x'.repeat(43)), null, 'wrong secret: same as unknown');
    assert.equal(links.poll(a.id, undefined), null);
    assert.equal(links.approve(a.id, null), false);
    assert.ok(links.approve(a.id, profile.id));
    assert.equal(links.approve(a.id, profile.id), false, 'only once');
    assert.equal(links.cancel(a.id), false, 'approved cannot be cancelled');
    const got = links.poll(a.id, a.secret);
    assert.deepEqual(got, { status: 'approved', profileId: profile.id, name: 'Streaming PC', capabilities: ['obs', 'sound'] });
    assert.equal(links.poll(a.id, a.secret).status, 'pending', 'while minting a second poll waits');
    links.release(a.id);
    assert.equal(links.poll(a.id, a.secret).status, 'approved', 'minting failed: can try again');
    links.finish(a.id);
    assert.equal(links.poll(a.id, a.secret), null, 'single use');
    assert.equal(links.view(a.id), null);

    const b = links.create({ name: 'x' });
    assert.ok(links.cancel(b.id));
    assert.equal(links.poll(b.id, b.secret).status, 'cancelled');
    assert.equal(links.poll(b.id, b.secret), null, 'cancelled is reported once');

    const c = links.create({});
    for (let i = 0; i < 4; i++) assert.equal(links.poll(c.id, 'y'.repeat(43)), null);
    assert.equal(links.poll(c.id, c.secret).status, 'pending', 'four wrong secrets: still alive');
    assert.equal(links.poll(c.id, 'y'.repeat(43)), null);
    assert.equal(links.poll(c.id, c.secret), null, 'the fifth wrong secret ends it');

    const d = links.create({ name: 'Later' });
    t += LINK_TTL_MS + 1;
    assert.equal(links.poll(d.id, d.secret), null, 'expired');
    assert.equal(links.approve(d.id, profile.id), false);
    links.create({}); links.create({}); links.create({});
    assert.throws(() => links.create({}), { code: 'busy' });
    t += LINK_TTL_MS + 1;
    assert.doesNotThrow(() => links.create({}), 'expired ones are swept to make room');
    assert.equal(cleanDeviceName('  PC\u0000\n<b>x</b>  '), 'PC <b>x</b>');
    assert.equal(cleanDeviceName(''), 'CertiFried Studio');
    assert.equal(isLinkId('../../etc'), false);
});

// ── over HTTP ───────────────────────────────────────────────────────────────────────────────

const eng = createViewEngine({ viewsDir: views, publicDir: path.join(root, 'dashboard/public'), cache: false });

async function app({ links = createLinkRequests(), limits = { request: 50, poll: 200 } } = {}) {
    const a = express();
    a.engine('ejs', (file, opts, cb) => { try { cb(null, eng.renderFile(file, opts)); } catch (e) { cb(e); } });
    a.set('views', views);
    a.set('view engine', 'ejs');
    const sessions = new Map();
    a.use((req, res, next) => {
        const sid = req.headers['x-test-session'] || 'anon';
        if (!sessions.has(sid)) sessions.set(sid, {});
        req.session = sessions.get(sid);
        const signed = req.headers['x-test-user'] === '1';
        req.user = signed ? { id: profile.ownerDiscordId || profile.owner_discord_id, username: 'maple' } : undefined;
        req.isAuthenticated = () => signed;
        Object.assign(res.locals, { uiTheme: 'dark', uiStyle: 'cards', uiDensity: 'comfortable', userPrefs: null, settings: {} });
        next();
    });
    a.use(express.urlencoded({ extended: false }));
    a.use(csrfProtection({ ignorePaths: ['/stream/bot/api/link/request', '/stream/bot/api/link/poll'] }));
    a.use('/', createLinkRouter({ links, getSb: async () => ({ store }), publicUrl: 'https://certifriedmultitool.com', limits }));
    const server = http.createServer(a);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = async (method, p, { body, form, headers = {} } = {}) => {
        const h = { ...headers };
        let payload;
        if (body) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
        if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
        const res = await fetch(base + p, { method, headers: h, body: payload, redirect: 'manual' });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* html */ }
        return { status: res.status, text, json, location: res.headers.get('location') };
    };
    return { req, links, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

const signed = { 'x-test-user': '1', 'x-test-session': 's1' };
const csrfFrom = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];

test('HTTP: request, sign-in redirect, approval page, CSRF on Approve, token once, never in a URL', async () => {
    const h = await app();
    try {
        const r = await h.req('POST', '/stream/bot/api/link/request', { body: { name: 'Streaming PC <script>', capabilities: ['obs', 'sound', 'hotkey'] } });
        assert.equal(r.status, 200);
        const { request, secret, check, url } = r.json;
        assert.equal(url, `https://certifriedmultitool.com/stream/bot/devices/link?request=${request}`);
        assert.ok(!url.includes(secret), 'the secret is not in the URL');
        assert.equal(r.json.pollMs, 2000);

        const out = await h.req('GET', `/stream/bot/devices/link?request=${request}`);
        assert.equal(out.status, 302);
        assert.equal(out.location, `/auth/discord?returnTo=${encodeURIComponent(`/stream/bot/devices/link?request=${request}`)}`);

        const pg = await h.req('GET', `/stream/bot/devices/link?request=${request}`, { headers: signed });
        assert.equal(pg.status, 200);
        assert.match(pg.text, /CertiFried Studio on <strong>Streaming PC &lt;script&gt;<\/strong> wants to connect to your stream bot\./);
        assert.ok(pg.text.includes(`<strong>${check}</strong>`), 'the check code is shown');
        assert.ok(!pg.text.includes(secret), 'the secret is never on the page');
        assert.match(pg.text, /<html data-theme="dark"/);

        assert.equal((await h.req('POST', '/stream/bot/api/link/poll', { body: { request, secret } })).json.status, 'pending');

        const noCsrf = await h.req('POST', '/stream/bot/devices/link', { form: { request, decision: 'approve' }, headers: signed });
        assert.equal(noCsrf.status, 403, 'Approve needs the CSRF token');
        const badCsrf = await h.req('POST', '/stream/bot/devices/link', { form: { request, decision: 'approve', _csrf: 'f'.repeat(64) }, headers: signed });
        assert.equal(badCsrf.status, 403);
        const otherSession = await h.req('POST', '/stream/bot/devices/link', { form: { request, decision: 'approve', _csrf: csrfFrom(pg.text) }, headers: { 'x-test-user': '1', 'x-test-session': 's2' } });
        assert.equal(otherSession.status, 403, 'a token from another session does not work');
        assert.equal(h.links.view(request).status, 'pending');

        const ok = await h.req('POST', '/stream/bot/devices/link', { form: { request, decision: 'approve', _csrf: csrfFrom(pg.text) }, headers: signed });
        assert.equal(ok.status, 200);
        assert.match(ok.text, /is connecting now/);

        assert.equal((await h.req('POST', '/stream/bot/api/link/poll', { body: { request, secret: 'z'.repeat(43) } })).status, 404, 'the id alone gets nothing');
        const got = await h.req('POST', '/stream/bot/api/link/poll', { body: { request, secret } });
        assert.equal(got.status, 200);
        assert.equal(got.json.status, 'approved');
        assert.ok(isTokenShape(got.json.token));
        const dev = await store.getDevice(profile.id, got.json.deviceId);
        assert.deepEqual([dev.kind, dev.name, dev.capabilities], ['studio', 'Streaming PC <script>', ['obs', 'sound', 'hotkey']]);
        assert.ok(await store.deviceByTokenHash(hashSecret(got.json.token)), 'the token is a working device token');

        const again = await h.req('POST', '/stream/bot/api/link/poll', { body: { request, secret } });
        assert.deepEqual([again.status, again.json], [404, { status: 'expired' }], 'single use');
        const ended = await h.req('GET', `/stream/bot/devices/link?request=${request}`, { headers: signed });
        assert.match(ended.text, /expired or was already used/);
    } finally { await h.close(); }
});

test('HTTP: cancel, expiry and bad input', async () => {
    let t = Date.now();
    const links = createLinkRequests({ now: () => t });
    const h = await app({ links });
    try {
        const { request, secret } = (await h.req('POST', '/stream/bot/api/link/request', { body: { name: 'PC' } })).json;
        const pg = await h.req('GET', `/stream/bot/devices/link?request=${request}`, { headers: signed });
        const c = await h.req('POST', '/stream/bot/devices/link', { form: { request, decision: 'cancel', _csrf: csrfFrom(pg.text) }, headers: signed });
        assert.match(c.text, /Nothing was connected/);
        assert.equal((await h.req('POST', '/stream/bot/api/link/poll', { body: { request, secret } })).json.status, 'cancelled');
        assert.equal((await h.req('POST', '/stream/bot/api/link/poll', { body: { request, secret } })).status, 404);

        const second = (await h.req('POST', '/stream/bot/api/link/request', { body: { name: 'PC' } })).json;
        t += LINK_TTL_MS + 1000;
        assert.equal((await h.req('POST', '/stream/bot/api/link/poll', { body: { request: second.request, secret: second.secret } })).status, 404, 'expired after 10 minutes');
        const pg2 = await h.req('GET', `/stream/bot/devices/link?request=${second.request}`, { headers: signed });
        assert.match(pg2.text, /expired or was already used/);
        const late = await h.req('POST', '/stream/bot/devices/link', { form: { request: second.request, decision: 'approve', _csrf: csrfFrom(pg.text) }, headers: signed });
        assert.equal(late.status, 410);

        assert.equal((await h.req('POST', '/stream/bot/devices/link', { form: { request: '../x', decision: 'approve', _csrf: csrfFrom(pg.text) }, headers: signed })).status, 400);
        assert.equal((await h.req('POST', '/stream/bot/api/link/poll', { body: { request: 'nope', secret: 'x' } })).status, 404);
        const bogus = await h.req('GET', '/stream/bot/devices/link?request=%3Cscript%3E', { headers: signed });
        assert.match(bogus.text, /expired or was already used/);
    } finally { await h.close(); }
});

test('HTTP: request and poll are rate limited per IP', async () => {
    const h = await app({ limits: { request: 3, poll: 4 } });
    try {
        const codes = [];
        for (let i = 0; i < 4; i++) codes.push((await h.req('POST', '/stream/bot/api/link/request', { body: { name: 'PC' } })).status);
        assert.deepEqual(codes, [200, 200, 200, 429]);
        const p = [];
        for (let i = 0; i < 5; i++) p.push((await h.req('POST', '/stream/bot/api/link/poll', { body: { request: 'a'.repeat(22), secret: 'b'.repeat(43) } })).status);
        assert.deepEqual(p, [404, 404, 404, 404, 429]);
    } finally { await h.close(); }
});
