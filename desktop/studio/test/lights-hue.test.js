'use strict';
/*
 * Philips Hue driver against a mock HTTPS bridge on 127.0.0.1 (test/mocks/hue-mock.js, selfsigned certificate):
 * mDNS discovery, the link-button pairing flow (error 101 until pressed), certificate pinning (trust on first use,
 * cert_changed afterwards with nothing sent), CLIP v2 set/get/scene, the CLIP v1 fallback, and no key in the logs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { guardNetwork, fakeClock, fakeConfig, captureLogger, fakeMdns } = require('./mocks/helpers');
const { startHueMock } = require('./mocks/hue-mock');
const { createHueDriver } = require('../src/main/lights/hue');
const { createMdns } = require('../src/main/lights/mdns');

guardNetwork();

const L1 = 'aaaa1111-0000-4000-8000-000000000001';
const L2 = 'aaaa1111-0000-4000-8000-000000000002';
const G1 = 'bbbb2222-0000-4000-8000-000000000001';

function driverFor(mock, { config = fakeConfig(), logger = null, sandbox = null, clock = fakeClock({ auto: true }) } = {}) {
    const mdns = createMdns({ factory: fakeMdns([{ type: '_hue._tcp.local', instance: 'Hue Bridge', host: 'hue.local', address: '127.0.0.1', port: mock.port, txt: { bridgeid: mock.bridgeid } }]) });
    return createHueDriver({ config, logger, sandbox, mdns, hostName: 'TEST-PC', setTimer: clock.setTimer, now: clock.now, timeoutMs: 2000 });
}

test('Hue: mDNS finds the bridge; pairing retries while the link button is not pressed, pins the certificate, keeps the username', async () => {
    const mock = await startHueMock({ pressAfter: 2 });
    const config = fakeConfig();
    const { logger, lines } = captureLogger();
    const hue = driverFor(mock, { config, logger });
    try {
        const found = await hue.discover({ timeoutMs: 100 });
        assert.deepEqual(found.map((d) => [d.id, d.kind, d.needsPairing]), [[`hue:${mock.bridgeid}`, 'bridge', true]]);
        assert.equal(mock.connections, 0, 'nothing is sent to an unpaired bridge found by mDNS');

        const r = await hue.pair(`hue:${mock.bridgeid}`);
        assert.deepEqual(r, { ok: true, message: 'Paired with the Hue bridge.' });
        const posts = mock.requests.filter((q) => q.method === 'POST' && q.url === '/api');
        assert.equal(posts.length, 3, 'two "link button not pressed" answers, then success');
        assert.deepEqual(posts[0].body, { devicetype: 'certifried_studio#TEST-PC', generateclientkey: true });
        assert.equal(config.getSecret(`dev:hue:${mock.bridgeid}`), mock.username);
        assert.deepEqual(config.get().lights.hue.bridges, [{ id: mock.bridgeid, address: `127.0.0.1:${mock.port}`, certSha256: mock.fingerprint }]);

        const list = hue.list();
        assert.deepEqual(list.map((d) => d.id).sort(), [`hue:${mock.bridgeid}`, `hue:${mock.bridgeid}/${L1}`, `hue:${mock.bridgeid}/${L2}`, `hue:${mock.bridgeid}/group/${G1}`].sort());
        const l1 = list.find((d) => d.id.endsWith(L1));
        const l2 = list.find((d) => d.id.endsWith(L2));
        const g = list.find((d) => d.kind === 'group');
        assert.deepEqual(l1.caps.white, { min: 2203, max: 6536 });
        assert.equal(l2.caps.white, null, 'a colour-only light has no white');
        assert.equal(g.name, 'Office');
        assert.deepEqual(g.caps.scenes, ['Relax', 'Energize']);
        assert.equal(list.find((d) => d.kind === 'bridge').needsPairing, false);
        assert.ok(!lines.join('\n').includes(mock.username), 'the username never reaches the log');
    } finally { await mock.close(); }
});

test('Hue: pairing gives up after 30 s with the link-button message', async () => {
    const mock = await startHueMock({ pressAfter: Infinity });
    const clock = fakeClock({ auto: true });
    const hue = driverFor(mock, { clock });
    try {
        await hue.discover({ timeoutMs: 100 });
        const start = clock.now();
        const r = await hue.pair(`hue:${mock.bridgeid}`);
        assert.equal(r.ok, false);
        assert.match(r.message, /link button/);
        assert.ok(clock.now() - start <= 30000);
        assert.ok(mock.requests.filter((q) => q.url === '/api').length >= 14);
    } finally { await mock.close(); }
});

test('Hue CLIP v2: colour as xy with a transition, white as mirek, rooms, scene recall, state read back', async () => {
    const mock = await startHueMock({ pressAfter: 0 });
    const hue = driverFor(mock);
    const B = `hue:${mock.bridgeid}`;
    try {
        await hue.discover({ timeoutMs: 100 });
        assert.equal((await hue.pair(B)).ok, true);

        await hue.setState(`${B}/${L1}`, { on: true, color: { r: 255, g: 0, b: 0 }, brightness: 60, transitionMs: 500 });
        const put = mock.requests.filter((q) => q.method === 'PUT').at(-1);
        assert.equal(put.url, `/clip/v2/resource/light/${L1}`);
        assert.equal(put.key, mock.username);
        assert.deepEqual(put.body, { on: { on: true }, dimming: { brightness: 60 }, color: { xy: { x: 0.6401, y: 0.33 } }, dynamics: { duration: 500 } });
        const st = await hue.getState(`${B}/${L1}`);
        assert.equal(st.on, true);
        assert.equal(st.brightness, 60);
        assert.equal(st.kelvin, null);
        assert.ok(st.color.r > 200 && st.color.g < 60 && st.color.b < 60, JSON.stringify(st.color));

        await hue.setState(`${B}/${L1}`, { kelvin: 9000 });
        assert.deepEqual(mock.requests.at(-1).body, { color_temperature: { mirek: 153 } }, 'clamped to the light\'s mirek range');
        assert.deepEqual(await hue.getState(`${B}/${L1}`), { on: true, brightness: 60, color: null, kelvin: 6536 });

        await hue.setState(`${B}/group/${G1}`, { on: true, brightness: 25 });
        assert.equal(mock.state.groups[G1].bri, 25);
        assert.deepEqual(await hue.getState(`${B}/group/${G1}`), { on: true, brightness: 25, color: null, kelvin: null });

        assert.equal(await hue.scene(`${B}/group/${G1}`, 'relax', { transitionMs: 0 }), 'Relax');
        assert.deepEqual(mock.state.recalled, ['dddd4444-0000-4000-8000-000000000001']);
        await assert.rejects(hue.scene(`${B}/group/${G1}`, 'Nope'), (e) => e.code === 'scene_not_found');
        await assert.rejects(hue.setState(B, { on: true }), (e) => e.code === 'not_supported');
        await assert.rejects(hue.setState(`${B}/ffff`, { on: true }), (e) => e.code === 'device_not_found');
    } finally { await mock.close(); }
});

test('Hue: a different certificate than the pinned one → cert_changed, and nothing is sent', async () => {
    const mock = await startHueMock({ pressAfter: 0 });
    const config = fakeConfig({ lights: { hue: { bridges: [{ id: mock.bridgeid, address: `127.0.0.1:${mock.port}`, certSha256: 'AA:BB:CC' }] } } });
    config.setSecret(`dev:hue:${mock.bridgeid}`, mock.username);
    const sandbox = { hue: [{ host: '127.0.0.1', port: mock.port }] };
    const hue = driverFor(mock, { config, sandbox });
    try {
        await hue.discover({ timeoutMs: 100 });
        assert.match(hue.notes()[0].message, /certificate changed/);
        hue.restore({ id: `hue:${mock.bridgeid}/${L1}`, driver: 'hue', name: 'Desk lamp', address: `127.0.0.1:${mock.port}`, caps: { brightness: true, color: true, white: { min: 2203, max: 6536 } } });
        await assert.rejects(hue.setState(`hue:${mock.bridgeid}/${L1}`, { on: true }), (e) => e.code === 'cert_changed' && /pair it again/.test(e.message));
        const p = await hue.pair(`hue:${mock.bridgeid}`);
        assert.equal(p.ok, false);
        assert.match(p.message, /certificate changed/);
        assert.ok(!mock.requests.some((q) => q.key), 'the key was never sent');
        assert.equal(mock.requests.filter((q) => q.url !== '/api/config').length, 0, 'not even the pairing request was sent');
    } finally { await mock.close(); }
});

test('Hue: forget drops the username, the pin and the lights', async () => {
    const mock = await startHueMock({ pressAfter: 0 });
    const config = fakeConfig();
    const hue = driverFor(mock, { config });
    try {
        await hue.discover({ timeoutMs: 100 });
        await hue.pair(`hue:${mock.bridgeid}`);
        hue.forget(`hue:${mock.bridgeid}`);
        assert.equal(config.getSecret(`dev:hue:${mock.bridgeid}`), null);
        assert.deepEqual(config.get().lights.hue.bridges, []);
        assert.deepEqual(hue.list(), []);
    } finally { await mock.close(); }
});

test('Hue CLIP v1 fallback (no /clip/v2): lights, bri/ct/transitiontime, scenes on their group', async () => {
    const mock = await startHueMock({ mode: 'v1', pressAfter: 0 });
    const { logger, lines } = captureLogger();
    const hue = driverFor(mock, { logger, sandbox: { hue: [{ host: '127.0.0.1', port: mock.port }] } });
    const B = `hue:${mock.bridgeid}`;
    try {
        const first = await hue.discover({ timeoutMs: 100 });
        assert.deepEqual(first.map((d) => d.id), [B], 'found through /api/config');
        assert.equal((await hue.pair(B)).ok, true);
        const ids = hue.list().map((d) => d.id).sort();
        assert.deepEqual(ids, [B, `${B}/1`, `${B}/group/1`].sort());
        assert.deepEqual(await hue.getState(`${B}/1`), { on: true, brightness: 50, color: null, kelvin: 3333 });

        await hue.setState(`${B}/1`, { on: true, brightness: 100, kelvin: 2700, transitionMs: 1000 });
        const put = mock.requests.at(-1);
        assert.equal(put.url, `/api/${mock.username}/lights/1/state`);
        assert.deepEqual(put.body, { on: true, bri: 254, ct: 370, transitiontime: 10 });
        await hue.setState(`${B}/1`, { on: false, brightness: 30 });
        assert.deepEqual(mock.requests.at(-1).body, { on: false, transitiontime: 0 });

        assert.equal(await hue.scene(`${B}/group/1`, 'Read'), 'Read');
        assert.equal(mock.requests.at(-1).url, `/api/${mock.username}/groups/1/action`);
        assert.deepEqual(mock.state.recalled, ['AbC123']);
        assert.ok(!lines.join('\n').includes(mock.username), 'the username (in v1 URLs) never reaches the log');
    } finally { await mock.close(); }
});
