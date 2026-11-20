'use strict';
/*
 * Nanoleaf and Elgato drivers against mock HTTP servers on 127.0.0.1 (test/mocks/panel-mocks.js), and the Litra driver
 * against the in-process fake HID (sandbox.js fakeHid): exact report bytes, reads, lumen mapping, unplugging.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { guardNetwork, fakeClock, fakeConfig, captureLogger, fakeMdns } = require('./mocks/helpers');
const { startNanoleafMock, startElgatoMock } = require('./mocks/panel-mocks');
const { createNanoleafDriver } = require('../src/main/lights/nanoleaf');
const { createElgatoDriver } = require('../src/main/lights/elgato');
const { createLitraDriver, report, pctToLumen, lumenToPct, MODELS } = require('../src/main/lights/litra');
const { createMdns } = require('../src/main/lights/mdns');
const { fakeHid } = require('../src/main/sandbox');

guardNetwork();

test('Nanoleaf: needs pairing; 403 until the power button is held, then the token is kept; set/get/effects', async () => {
    const mock = await startNanoleafMock({ openAfter: 2 });
    const config = fakeConfig();
    const { logger, lines } = captureLogger();
    const clock = fakeClock({ auto: true });
    const n = createNanoleafDriver({ logger, config, sandbox: { nanoleaf: [{ host: '127.0.0.1', port: mock.port }] }, setTimer: clock.setTimer, now: clock.now, timeoutMs: 1000 });
    try {
        const [d] = await n.discover({ timeoutMs: 100 });
        // An opaque id (a hash of the address): ids reach the dashboard, network addresses never do.
        assert.match(d.id, /^nanoleaf:a[0-9a-f]{12}$/);
        assert.ok(!d.id.includes('127.0.0.1'));
        const key = d.id.slice('nanoleaf:'.length);
        assert.equal(d.needsPairing, true);
        await assert.rejects(n.setState(d.id, { on: true }), (e) => e.code === 'needs_pairing');

        assert.deepEqual(await n.pair(d.id), { ok: true, message: 'Paired with the Nanoleaf panel.' });
        assert.equal(mock.requests.filter((q) => q.url === '/api/v1/new').length, 3);
        assert.equal(config.getSecret(`dev:nanoleaf:${key}`), mock.token);
        const paired = n.list()[0];
        assert.equal(paired.needsPairing, false);
        assert.equal(paired.name, 'Shapes 1A2B');
        assert.deepEqual(paired.caps.scenes, ['Northern Lights', 'Flames', 'Forest']);

        await n.setState(d.id, { on: true, color: { r: 0, g: 0, b: 255 }, brightness: 80, transitionMs: 2000 });
        assert.deepEqual(mock.state.lastBody, { on: { value: true }, hue: { value: 240 }, sat: { value: 100 }, brightness: { value: 80, duration: 2 } });
        assert.deepEqual(await n.getState(d.id), { on: true, brightness: 80, color: { r: 0, g: 0, b: 255 }, kelvin: null });
        await n.setState(d.id, { kelvin: 9000 });
        assert.equal(mock.state.ct.value, 6500);
        assert.equal((await n.getState(d.id)).kelvin, 6500);

        assert.equal(await n.scene(d.id, 'flames'), 'Flames');
        assert.equal(mock.state.select, 'Flames');
        assert.deepEqual(await n.getState(d.id), { on: true, brightness: 80, color: null, kelvin: null, scene: 'Flames' });
        await assert.rejects(n.scene(d.id, 'Nope'), (e) => e.code === 'scene_not_found');
        assert.ok(!lines.join('\n').includes(mock.token), 'the token never reaches the log');

        n.forget(d.id);
        assert.equal(config.getSecret(`dev:nanoleaf:${key}`), null);
    } finally { await mock.close(); }
});

test('Nanoleaf: pairing gives up after 30 s with the power-button message; mDNS id from TXT', async () => {
    const mock = await startNanoleafMock({ openAfter: Infinity });
    const clock = fakeClock({ auto: true });
    const mdns = createMdns({ factory: fakeMdns([{ type: '_nanoleafapi._tcp.local', instance: 'Shapes 1A2B', host: 'shapes.local', address: '127.0.0.1', port: mock.port, txt: { id: '5C:E7:4B:1A:2B:3C', md: 'NL42' } }]) });
    const n = createNanoleafDriver({ config: fakeConfig(), mdns, setTimer: clock.setTimer, now: clock.now, timeoutMs: 1000 });
    try {
        const [d] = await n.discover({ timeoutMs: 100 });
        assert.equal(d.id, 'nanoleaf:5CE74B1A2B3C');
        assert.equal(d.model, 'NL42');
        const r = await n.pair(d.id);
        assert.equal(r.ok, false);
        assert.match(r.message, /power button for 5 to 7 seconds/);
    } finally { await mock.close(); }
});

test('Elgato Key Light: white only, temperature as 1000000/K, brightness; Light Strip takes colour', async () => {
    const key = await startElgatoMock();
    const strip = await startElgatoMock({ strip: true, serial: 'STRIP0001' });
    const e = createElgatoDriver({ sandbox: { elgato: [{ host: '127.0.0.1', port: key.port }, { host: '127.0.0.1', port: strip.port }] }, timeoutMs: 1000 });
    try {
        const found = await e.discover({ timeoutMs: 100 });
        const kl = found.find((d) => d.id === 'elgato:BW33K1A01234');
        const ls = found.find((d) => d.id === 'elgato:STRIP0001');
        assert.equal(kl.name, 'Key Light Left');
        assert.equal(kl.caps.color, false);
        assert.deepEqual(kl.caps.white, { min: 2900, max: 7000 });
        assert.equal(ls.caps.color, true);

        await e.setState(kl.id, { on: true, brightness: 1, kelvin: 4000 });
        assert.deepEqual(key.requests.at(-1).body, { numberOfLights: 1, lights: [{ on: 1, brightness: 3, temperature: 250 }] });
        assert.deepEqual(await e.getState(kl.id), { on: true, brightness: 3, color: null, kelvin: 4000 });
        await assert.rejects(e.setState(kl.id, { color: { r: 255, g: 0, b: 0 } }), (x) => x.code === 'not_supported');

        await e.setState(ls.id, { on: true, color: { r: 0, g: 255, b: 0 }, brightness: 60 });
        assert.deepEqual(strip.state, { on: 1, brightness: 60, hue: 120, saturation: 100 });
        assert.deepEqual(await e.getState(ls.id), { on: true, brightness: 60, color: { r: 0, g: 255, b: 0 }, kelvin: null });
    } finally { await key.close(); await strip.close(); }
});

test('Litra: report bytes for power, brightness (lumen, big-endian) and temperature; reads answer through the fake HID', async () => {
    const recorded = [];
    const hid = fakeHid(recorded);
    const l = createLitraDriver({ hid });
    const found = await l.discover();
    assert.deepEqual(found.map((d) => [d.id, d.model, d.address, d.caps.color]), [['litra:FAKEGLOW0001', 'Litra Glow', null, false], ['litra:FAKEBEAM0001', 'Litra Beam', null, false]]);
    assert.equal(hid.opened, 0, 'listing does not open the device');

    await l.setState('litra:FAKEBEAM0001', { on: true, brightness: 100, kelvin: 3333 });
    const hex = hid.writes.map((w) => Buffer.from(w.bytes).toString('hex'));
    assert.deepEqual(hex, [
        `11ff041c01${'00'.repeat(15)}`,       // power on
        `11ff049c0ce4${'00'.repeat(14)}`,     // 3333 K rounded to 3300 K = 0x0ce4
        `11ff044c0190${'00'.repeat(14)}`,     // 100 % on a Beam = 400 lm = 0x0190
    ]);
    assert.ok(hid.writes.every((w) => w.bytes.length === 20));
    assert.equal(recorded.length, 3);
    assert.equal(recorded[0].report, hex[0]);
    assert.deepEqual(hid.state('fake-hid://litra-beam'), { on: true, lumen: 400, kelvin: 3300, plugged: true });
    assert.deepEqual(await l.getState('litra:FAKEBEAM0001'), { on: true, brightness: 100, color: null, kelvin: 3300 });

    await l.setState('litra:FAKEGLOW0001', { brightness: 1, on: false });
    assert.deepEqual(hid.state('fake-hid://litra-glow'), { on: false, lumen: 20, kelvin: 4000, plugged: true });
    assert.equal(Buffer.from(hid.writes.at(-1).bytes).toString('hex').slice(0, 10), '11ff041c00', 'off sent last');
    await assert.rejects(l.setState('litra:FAKEGLOW0001', { color: { r: 1, g: 2, b: 3 } }), (e) => e.code === 'not_supported');

    hid.unplug('fake-hid://litra-glow');
    await assert.rejects(l.setState('litra:FAKEGLOW0001', { on: true }), (e) => e.code === 'device_unreachable');
    assert.equal(l.list().find((d) => d.id === 'litra:FAKEGLOW0001').online, false);
    hid.plug('fake-hid://litra-glow');
    await l.setState('litra:FAKEGLOW0001', { on: true });
    assert.equal(hid.state('fake-hid://litra-glow').on, true);
    l.close();
});

test('Litra: lumen mapping per model, Beam LX uses feature 0x06, sandbox without "litra" has no devices', async () => {
    assert.equal(pctToLumen(MODELS[0xc900], 1), 20);
    assert.equal(pctToLumen(MODELS[0xc900], 100), 250);
    assert.equal(pctToLumen(MODELS[0xc901], 50), 213);
    assert.equal(lumenToPct(MODELS[0xc901], 213), 50);
    assert.deepEqual(report(MODELS[0xb901].feature, 0x1c, 1).slice(0, 5), [0x11, 0xff, 0x06, 0x1c, 0x01]);
    const none = createLitraDriver({ sandbox: {} });
    assert.deepEqual(await none.discover(), []);
    const viaSandbox = createLitraDriver({ sandbox: { litra: 'fake', record: () => {} } });
    assert.equal((await viaSandbox.discover()).length, 2);
});
