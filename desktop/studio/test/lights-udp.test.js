'use strict';
/*
 * Govee LAN and LIFX LAN drivers against UDP mocks on 127.0.0.1 (test/mocks/govee-mock.js, lifx-mock.js), through a
 * sandbox. The network guard makes any non-loopback send, bind, broadcast or multicast membership throw.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { guardNetwork, freeUdpPort, captureLogger } = require('./mocks/helpers');
const { startGoveeMock } = require('./mocks/govee-mock');
const { startLifxMock } = require('./mocks/lifx-mock');
const { createGoveeDriver, LAN_HINT } = require('../src/main/lights/govee-lan');
const { createLifxDriver, encode, decode, T } = require('../src/main/lights/lifx-lan');

guardNetwork();

test('Govee: scan reply → device; set sends turn/colorwc/brightness; devStatus read back', async () => {
    const listenPort = await freeUdpPort();
    const mock = await startGoveeMock({ listenPort });
    const sandbox = { govee: { host: '127.0.0.1', scanPort: mock.scanPort, listenPort, controlPort: mock.controlPort } };
    const g = createGoveeDriver({ sandbox, sendGapMs: 0, replyTimeoutMs: 500 });
    try {
        const found = await g.discover({ timeoutMs: 200 });
        assert.equal(found.length, 1);
        const d = found[0];
        assert.equal(d.id, 'govee:1f80c5323236724e');
        assert.equal(d.model, 'H6199');
        assert.equal(d.address, '127.0.0.1');
        assert.deepEqual(d.caps.white, { min: 2000, max: 9000 });
        assert.deepEqual(g.notes(), []);

        await g.setState(d.id, { on: true, color: { r: 255, g: 0, b: 0 }, brightness: 70 });
        await new Promise((r) => setTimeout(r, 50));
        assert.deepEqual(mock.commands.map((c) => c.cmd), ['turn', 'colorwc', 'brightness']);
        assert.deepEqual(mock.commands[1].data, { color: { r: 255, g: 0, b: 0 }, colorTemInKelvin: 0 });
        assert.deepEqual(await g.getState(d.id), { on: true, brightness: 70, color: { r: 255, g: 0, b: 0 }, kelvin: null });

        await g.setState(d.id, { kelvin: 12000 });
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(mock.state.colorTemInKelvin, 9000, 'kelvin clamped to 2000-9000');
        assert.equal((await g.getState(d.id)).kelvin, 9000);

        await g.setState(d.id, { on: false, brightness: 0 });
        await new Promise((r) => setTimeout(r, 50));
        assert.deepEqual(mock.commands.slice(-2).map((c) => [c.cmd, c.data.value]), [['brightness', 1], ['turn', 0]], 'off is sent last');
    } finally { g.close(); await mock.close(); }
});

test('Govee: nothing answers → the note and the error say to switch on LAN control', async () => {
    const listenPort = await freeUdpPort();
    const deadScan = await freeUdpPort();
    const mute = await startGoveeMock({ listenPort, answerStatus: false });
    const { logger, lines } = captureLogger();
    const g = createGoveeDriver({ logger, sandbox: { govee: { host: '127.0.0.1', scanPort: deadScan, listenPort, controlPort: mute.controlPort } }, sendGapMs: 0, replyTimeoutMs: 150 });
    try {
        assert.deepEqual(await g.discover({ timeoutMs: 200 }), []);
        assert.match(g.notes()[0].message, /LAN control/);
        assert.ok(lines.some((l) => /LAN control/.test(l)));
        g.restore({ id: 'govee:abcdef', driver: 'govee', name: 'Shelf', model: 'H6199', address: '127.0.0.1' });
        await assert.rejects(g.getState('govee:abcdef'), (e) => e.code === 'device_unreachable' && e.message === LAN_HINT);
        assert.equal(g.list()[0].online, false);
    } finally { g.close(); await mute.close(); }
});

test('Govee: a sandbox refuses any other address; no sandbox entry means no Govee at all', async () => {
    const listenPort = await freeUdpPort();
    const g = createGoveeDriver({ sandbox: { govee: { host: '127.0.0.1', scanPort: 1, listenPort, controlPort: 2 } }, sendGapMs: 0 });
    try {
        await assert.rejects(g.addManual('192.168.1.50'), (e) => e.code === 'sandbox_refused');
        g.restore({ id: 'govee:far', driver: 'govee', name: 'Far', model: 'H6199', address: '192.168.1.51' });
        await assert.rejects(g.setState('govee:far', { on: true }), (e) => e.code === 'sandbox_refused');
    } finally { g.close(); }
    const none = createGoveeDriver({ sandbox: {} });
    assert.deepEqual(await none.discover({ timeoutMs: 100 }), []);
    none.close();
});

test('LIFX: header encoding matches the documented layout', () => {
    const b = encode({ type: T.SetColor, target: Buffer.from('d073d5001337', 'hex'), source: 2, sequence: 1, ack: true, payload: Buffer.alloc(13) });
    assert.equal(b.length, 49);
    assert.equal(b.readUInt16LE(0), 49);
    assert.equal(b.readUInt16LE(2), 0x1400, 'protocol 1024 + addressable, not tagged');
    assert.equal(b.readUInt32LE(4), 2);
    assert.equal(b.subarray(8, 16).toString('hex'), 'd073d50013370000');
    assert.equal(b.readUInt8(22), 2, 'ack_required');
    assert.equal(b.readUInt8(23), 1);
    assert.equal(b.readUInt16LE(32), 102);
    const tagged = encode({ type: T.GetService, tagged: true, source: 7, sequence: 9 });
    assert.equal(tagged.readUInt16LE(2), 0x3400);
    assert.equal(decode(tagged).type, 2);
    assert.equal(decode(Buffer.alloc(10)), null);
});

test('LIFX: discovery finds two bulbs with labels; set colour/white/power with duration; state read back', async () => {
    const mock = await startLifxMock({ bulbs: [{ mac: 'd073d5000001', label: 'Desk' }, { mac: 'd073d5000002', label: 'Shelf', power: 65535 }] });
    const l = createLifxDriver({ sandbox: { lifx: { host: '127.0.0.1', port: mock.port } }, replyTimeoutMs: 200 });
    try {
        const found = await l.discover({ timeoutMs: 200 });
        assert.deepEqual(found.map((d) => [d.id, d.name]).sort(), [['lifx:d073d5000001', 'Desk'], ['lifx:d073d5000002', 'Shelf']]);
        assert.equal(found[0].address, `127.0.0.1:${mock.port}`);

        await l.setState('lifx:d073d5000001', { on: true, color: { r: 0, g: 0, b: 255 }, brightness: 50, transitionMs: 400 });
        const b1 = mock.bulbs.get('d073d5000001');
        assert.equal(b1.power, 65535);
        assert.equal(Math.round((b1.hue / 65535) * 360), 240);
        assert.equal(b1.sat, 65535);
        assert.equal(Math.round((b1.bri / 65535) * 100), 50);
        assert.equal(b1.lastDuration, 400);
        assert.deepEqual(await l.getState('lifx:d073d5000001'), { on: true, brightness: 50, color: { r: 0, g: 0, b: 255 }, kelvin: null });

        await l.setState('lifx:d073d5000001', { kelvin: 12000 });
        assert.equal(b1.kelvin, 9000);
        assert.equal(b1.sat, 0);
        assert.deepEqual(await l.getState('lifx:d073d5000001'), { on: true, brightness: 50, color: null, kelvin: 9000 });

        await l.setState('lifx:d073d5000002', { on: false });
        assert.equal(mock.bulbs.get('d073d5000002').power, 0);
        assert.ok(mock.commands.some((c) => c.type === T.SetPower));
    } finally { l.close(); await mock.close(); }
});

test('LIFX: a bulb that stops answering is marked offline (with retries)', async () => {
    const mock = await startLifxMock({ bulbs: [{ mac: 'd073d5000009', label: 'Gone' }] });
    const l = createLifxDriver({ sandbox: { lifx: { host: '127.0.0.1', port: mock.port } }, replyTimeoutMs: 60, retries: 1 });
    try {
        await l.discover({ timeoutMs: 150 });
        mock.bulbs.delete('d073d5000009');
        await assert.rejects(l.getState('lifx:d073d5000009'), (e) => e.code === 'device_unreachable');
        assert.equal(l.list()[0].online, false);
    } finally { l.close(); await mock.close(); }
});
