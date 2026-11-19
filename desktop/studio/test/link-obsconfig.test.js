'use strict';
/*
 * 0.2.2: "Sign in with CertiFried" (pairing.js startLink / pollLink / waitForLink against a mock server that behaves
 * like dashboard/routes/stream-bot-link.js) and "Use my OBS settings" (obs-config.js, with fixture files only: the
 * real %APPDATA%\obs-studio config is never read here). Plus the real Electron app: OBS asks for a password, the
 * button is offered, clicking it reads a fixture file and OBS (the mock) connects.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { startLink, pollLink, waitForLink } = require('../src/main/pairing');
const { obsConfigPath, obsConfigExists, readObsConfig } = require('../src/main/obs-config');
const { startMockObs } = require('./mock-obs');

const TOKEN = `sbd_${'L'.repeat(43)}`;
const ID = 'A'.repeat(21) + 'b';
const SECRET = 'S'.repeat(42) + 'z';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-022-'));

/** A mock of the server's link endpoints. mode controls the answers. */
async function mockServer() {
    const s = { mode: 'ok', polls: 0, approveAfter: 2, seen: [] };
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            const j = body ? JSON.parse(body) : {};
            s.seen.push({ url: req.url, body: j });
            const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (s.mode === 'old') return send(404, { error: 'not_found' });
            if (s.mode === 'old-csrf') return send(403, { error: 'CSRF token missing. Please refresh the page.' });
            if (req.url === '/stream/bot/api/link/request') {
                if (s.mode === 'rate') return send(429, { error: 'rate_limited' });
                if (s.mode === 'junk') return send(200, { request: 'x' });
                return send(200, { request: ID, secret: SECRET, check: 'K7QM', expiresAt: new Date(Date.now() + 600000).toISOString(), url: 'https://evil.example/phish', pollMs: 1500 });
            }
            if (req.url === '/stream/bot/api/link/poll') {
                s.polls++;
                if (j.secret !== SECRET || j.request !== ID) return send(404, { status: 'expired' });
                if (s.mode === 'flaky' && s.polls === 1) { res.destroy(); return undefined; }
                if (s.mode === 'cancel') return send(200, { status: 'cancelled' });
                if (s.polls < s.approveAfter) return send(200, { status: 'pending' });
                return send(200, { status: 'approved', token: TOKEN, deviceId: 41, kind: 'studio', proto: 1 });
            }
            return send(404, {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    s.base = `http://127.0.0.1:${server.address().port}`;
    s.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
    return s;
}

test('sign-in: request, page URL built from our own server (not the answer), poll until approved, token once', async () => {
    const m = await mockServer();
    try {
        const r = await startLink({ base: m.base, name: 'DESK-PC', capabilities: ['obs', 'sound', 'hotkey'] });
        assert.deepEqual(m.seen[0], { url: '/stream/bot/api/link/request', body: { name: 'DESK-PC', capabilities: ['obs', 'sound', 'hotkey'] } });
        assert.equal(r.url, `${m.base}/stream/bot/devices/link?request=${ID}`, 'never the URL the server suggested');
        assert.ok(!r.url.includes(SECRET), 'the secret is never in the URL');
        assert.deepEqual([r.request, r.secret, r.check, r.pollMs], [ID, SECRET, 'K7QM', 1500]);
        assert.deepEqual(await pollLink({ base: m.base, request: ID, secret: SECRET }), { status: 'pending' });
        assert.deepEqual(await pollLink({ base: m.base, request: ID, secret: 'x'.repeat(43) }), { status: 'expired' }, 'wrong secret: nothing');
        const out = await waitForLink({ base: m.base, request: ID, secret: SECRET, pollMs: 10, expiresAt: Date.now() + 60000, sleep: () => Promise.resolve() });
        assert.deepEqual(out, { status: 'approved', token: TOKEN, deviceId: 41, kind: 'studio' });
    } finally { await m.close(); }
});

test('sign-in: old server, rate limit, odd answers, cancel in the browser, cancel in the app, expiry, a network blip', async () => {
    const m = await mockServer();
    try {
        m.mode = 'old';
        await assert.rejects(startLink({ base: m.base }), { code: 'not_supported' });
        m.mode = 'old-csrf';
        await assert.rejects(startLink({ base: m.base }), { code: 'not_supported' }, 'a live server without the routes answers 403 from its CSRF check');
        m.mode = 'rate';
        await assert.rejects(startLink({ base: m.base }), { code: 'rate_limited' });
        m.mode = 'junk';
        await assert.rejects(startLink({ base: m.base }), { code: 'bad_response' });
        await assert.rejects(startLink({ base: 'http://certifriedmultitool.com' }), { code: 'bad_server' }, 'plain http only on 127.0.0.1');
        m.mode = 'cancel';
        const fast = { base: m.base, request: ID, secret: SECRET, pollMs: 5, expiresAt: Date.now() + 60000, sleep: () => Promise.resolve() };
        assert.deepEqual(await waitForLink(fast), { status: 'cancelled' });
        m.mode = 'ok'; m.polls = 0; m.approveAfter = 1000;
        let stop = false;
        setTimeout(() => { stop = true; }, 60);
        assert.deepEqual(await waitForLink({ ...fast, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), isCancelled: () => stop }), { status: 'stopped' });
        let t = 1000;
        assert.deepEqual(await waitForLink({ ...fast, expiresAt: 0, now: () => (t += 10000) }), { status: 'expired' });
        m.mode = 'flaky'; m.polls = 0; m.approveAfter = 2;
        const gaps = [];
        const out = await waitForLink({ ...fast, pollMs: 100, sleep: (ms) => { gaps.push(ms); return Promise.resolve(); } });
        assert.equal(out.status, 'approved', 'a dropped connection is retried');
        assert.deepEqual(gaps.slice(0, 2), [100, 200], 'with a longer gap after the failure');
    } finally { await m.close(); }
});

// ── Use my OBS settings ─────────────────────────────────────────────────────────────────────

function fixture(obj, { raw = null, bom = false } = {}) {
    const f = path.join(tmp(), 'config.json');
    fs.writeFileSync(f, (bom ? '\uFEFF' : '') + (raw ?? JSON.stringify(obj, null, 4)));
    return f;
}

test('OBS settings: path, enabled with a password, without auth, turned off, missing, damaged', () => {
    assert.equal(obsConfigPath({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }), path.join('C:\\Users\\x\\AppData\\Roaming', 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json'));
    assert.equal(obsConfigPath({ APPDATA: 'C:\\A', CF_STUDIO_OBS_CONFIG: 'D:\\fixture.json' }), path.resolve('D:\\fixture.json'));
    const v5 = { alerts_enabled: false, auth_required: true, first_load: false, server_enabled: true, server_password: 'fixture-pw-123', server_port: 4466 };
    assert.deepEqual(readObsConfig(fixture(v5)), { enabled: true, port: 4466, authRequired: true, password: 'fixture-pw-123' });
    assert.deepEqual(readObsConfig(fixture(v5, { bom: true })).port, 4466, 'a byte-order mark is fine');
    assert.deepEqual(readObsConfig(fixture({ ...v5, auth_required: false, server_password: 'unused' })), { enabled: true, port: 4466, authRequired: false, password: '' });
    assert.equal(readObsConfig(fixture({ ...v5, server_enabled: false })).enabled, false);
    assert.equal(readObsConfig(fixture({ server_enabled: true, auth_required: false })).port, 4455, 'default port');
    const missing = path.join(tmp(), 'nope', 'config.json');
    assert.equal(obsConfigExists(missing), false);
    assert.throws(() => readObsConfig(missing), { code: 'not_found' });
    assert.throws(() => readObsConfig(fixture(null, { raw: '{ not json' })), { code: 'bad_format' });
    assert.throws(() => readObsConfig(fixture({ ServerEnabled: true })), { code: 'bad_format' }, 'an older plugin format');
    assert.throws(() => readObsConfig(fixture({ ...v5, server_port: 99999 })), { code: 'bad_format' });
    assert.throws(() => readObsConfig(fixture({ ...v5, server_password: '' })), { code: 'bad_format' }, 'auth on but no password saved');
    assert.throws(() => readObsConfig(fixture(null, { raw: 'x'.repeat(70000) })), { code: 'bad_format' });
    const err = (() => { try { readObsConfig(fixture({ ...v5, server_port: 0 })); return null; } catch (e) { return e.message; } })();
    assert.ok(!err.includes('fixture-pw-123'), 'the password is never in a message');
});

let electronPath = null;
try { electronPath = require('electron'); if (!fs.existsSync(electronPath)) electronPath = null; } catch { electronPath = null; }

test('Electron app: OBS asks for a password, the button is offered, clicking it uses the fixture and connects', { skip: !electronPath && 'electron binary not installed', timeout: 90000 }, async () => {
    const mock = await startMockObs({ password: 'fixture-obs-pw' });
    const userData = tmp();
    const cfgFile = fixture({ auth_required: true, server_enabled: true, server_password: 'fixture-obs-pw', server_port: mock.port });
    // OBS on the right port, but no password saved yet: OBS refuses (4009)
    fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ obs: { enabled: true, host: '127.0.0.1', port: mock.port } }));
    const smoke = path.join(userData, 'smoke.json');
    const env = { ...process.env, CF_STUDIO_USER_DATA: userData, CF_STUDIO_FAKE_SAFESTORAGE: 'unavailable', CF_STUDIO_SMOKE: smoke, CF_STUDIO_SMOKE_IMPORT: '1', CF_STUDIO_OBS_CONFIG: cfgFile, CF_STUDIO_CAPTURE_WAIT: '1000' };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
        const code = await new Promise((resolve) => {
            const child = spawn(electronPath, [path.join(__dirname, '..')], { env, stdio: 'ignore' });
            const killer = setTimeout(() => child.kill(), 60000);
            child.on('exit', (c) => { clearTimeout(killer); resolve(c); });
        });
        assert.equal(code, 0);
        const r = JSON.parse(fs.readFileSync(smoke, 'utf8'));
        assert.equal(r.importCheck.offered, true, 'the one-line offer and button show after OBS asks for a password');
        assert.deepEqual(r.importCheck.answer, { ok: true, port: mock.port, authRequired: true });
        assert.equal(r.importCheck.obsStatus, 'connected');
        assert.equal(r.hasObsPassword, true);
        const disk = fs.readFileSync(path.join(userData, 'secrets.json'), 'utf8') + fs.readFileSync(path.join(userData, 'settings.json'), 'utf8') + fs.readFileSync(path.join(userData, 'logs', 'studio.log'), 'utf8');
        assert.ok(!disk.includes('fixture-obs-pw'), 'the password is not in settings, the secrets file or the log in plain text');
    } finally {
        await mock.close();
        fs.rmSync(userData, { recursive: true, force: true });
    }
});
