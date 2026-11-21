'use strict';
/*
 * Govee over Bluetooth (src/main/lights/govee-ble.js, 0.2.11) with a fake helper process speaking the helper's JSON lines:
 * packets against packets sniffed from the Govee app (Home Assistant forum), the status answers the owner's H6054 gave,
 * which lights are listed and which need pairing (neighbours), the cloud MAC match, 'all' and the cloud, the power blink for
 * flash and test, putting a plain colour back. On Windows the real helper starts and scans (no light is touched).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const { createGoveeBleDriver, packet, powerPacket, brightnessPacket, colorPacket, statusPacket, macFromCloudId, parseName } = require('../src/main/lights/govee-ble');
const { createLights } = require('../src/main/lights');

const H6054 = 'D63932370941';
const NEIGHBOUR = 'C76A03C65162';

/** A fake helper: scan answers, status queries from a small light model, writes recorded. */
function fakeHelper({ lights = {} } = {}) {
    const writes = [];
    const spawnImpl = () => {
        const p = new EventEmitter();
        p.stdout = new PassThrough();
        p.stdin = new PassThrough();
        p.kill = () => p.emit('exit', 0);
        let buf = '';
        const say = (o) => p.stdout.write(`${JSON.stringify(o)}\n`);
        p.stdin.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const m = JSON.parse(buf.slice(0, i));
                buf = buf.slice(i + 1);
                const L = lights[m.address];
                if (m.op === 'scan') say({ id: m.id, ok: true, devices: Object.entries(lights).map(([address, l]) => ({ address, name: l.name, rssi: -50 })) });
                else if (!L) say({ id: m.id, ok: false, error: 'not_found', message: 'not_found' });
                else if (m.op === 'connect' || m.op === 'disconnect') say({ id: m.id, ok: true });
                else if (m.op === 'write') {
                    writes.push([m.address, m.hex]);
                    const b = Buffer.from(m.hex, 'hex');
                    if (b[1] === 0x01) L.on = b[2] === 1;
                    if (b[1] === 0x04) L.level = b[2];
                    if (b[1] === 0x05) L.mode = [...b.subarray(2, 10)];
                    say({ id: m.id, ok: true });
                } else if (m.op === 'query') {
                    const q = Buffer.from(m.hex, 'hex')[1];
                    const body = q === 0x01 ? [L.on ? 1 : 0] : q === 0x04 ? [L.level] : q === 0x05 ? L.mode : [];
                    say({ id: m.id, ok: true, hex: packet([0xaa, q, ...body]) });
                }
            }
        });
        setImmediate(() => say({ type: 'ready' }));
        return p;
    };
    return { spawnImpl, writes };
}

test('packets: 20 bytes, XOR checksum, matching packets sniffed from the Govee app', () => {
    // Home Assistant forum "Govee Bluetooth lights" (michaelmior, from the Govee Android app): on and off.
    assert.equal(powerPacket(true), '3301010000000000000000000000000000000033');
    assert.equal(powerPacket(false), '3301000000000000000000000000000000000032');
    // The owner's H6054 answered these status requests (aa 01, aa 04, aa 05) during the read-only probe.
    assert.equal(statusPacket(0x01), 'aa010000000000000000000000000000000000ab');
    assert.equal(brightnessPacket(100), packet([0x33, 0x04, 100]));
    assert.equal(brightnessPacket(100, 'byte').slice(4, 6), 'ff');
    assert.equal(colorPacket('H6054', { r: 255, g: 0, b: 16 }).slice(0, 28), '33051501ff00100000000000ff7f', 'segmented form, all segments');
    assert.equal(colorPacket('H6195', { r: 1, g: 2, b: 3 }).slice(0, 12), '330502010203', 'plain manual colour');
    for (const hex of [powerPacket(true), colorPacket('H6054', { r: 9, g: 8, b: 7 })]) {
        const b = Buffer.from(hex, 'hex');
        assert.equal(b.length, 20);
        let x = 0; for (let i = 0; i < 19; i++) x ^= b[i];
        assert.equal(b[19], x);
    }
    assert.equal(macFromCloudId('govee-cloud:H6054:5A:0E:D6:39:32:37:09:41'), H6054);
    assert.equal(macFromCloudId('govee-cloud:H6195:11:22:33:44:55:66'), '112233445566');
    assert.equal(macFromCloudId('lifx-cloud:abc'), null);
    assert.deepEqual(parseName('Govee_H6054_0941'), { model: 'H6054', tail: '0941' });
    assert.deepEqual(parseName('ihoment_H6195_ABCD'), { model: 'H6195', tail: 'ABCD' });
    assert.equal(parseName('Echo Dot-27U'), null);
});

test('discovery: the streamer\'s cloud light is added at once; a neighbour\'s needs Pair; status as the H6054 answered', async () => {
    const h = fakeHelper({ lights: { [H6054]: { name: 'Govee_H6054_0941', on: true, level: 100, mode: [0x13, 0x05, 0x63, 0x00, 0xff] }, [NEIGHBOUR]: { name: 'Govee_H6076_5162', on: true, level: 50, mode: [0x02, 1, 2, 3] } } });
    const d = createGoveeBleDriver({ helperPath: 'x.exe', spawnImpl: h.spawnImpl, getCloudMacs: () => new Map([[H6054, { id: 'govee-cloud:H6054:5A:0E:D6:39:32:37:09:41', name: 'Death Light Bars' }]]) });
    const found = await d.discover({ timeoutMs: 1000 });
    const mine = found.find((x) => x.address === H6054);
    const other = found.find((x) => x.address === NEIGHBOUR);
    assert.deepEqual([mine.name, mine.needsPairing, mine.cloudId, mine.model], ['Death Light Bars', false, 'govee-cloud:H6054:5A:0E:D6:39:32:37:09:41', 'H6054']);
    assert.equal(other.needsPairing, true, 'Bluetooth reaches next door: not used until Pair');
    assert.match(d.notes()[0].message, /lights next door/);
    const s = await d.getState(`goveeble:${H6054}`);
    assert.deepEqual([s.on, s.brightness, s.color, s.mode], [true, 100, null, 0x13], 'a scene-type mode has no colour to put back');
    const s2 = await d.getState(`goveeble:${NEIGHBOUR}`);
    assert.deepEqual(s2.color, { r: 1, g: 2, b: 3 });
    const pr = await d.pair(`goveeble:${NEIGHBOUR}`);
    assert.equal(pr.ok, true);
    assert.equal(d.list().find((x) => x.address === NEIGHBOUR).needsPairing, false);
    d.close();
});

test('flash and test blink the power and leave the light as it was; colour, brightness and putting a plain colour back', async () => {
    const lightsModel = { [H6054]: { name: 'Govee_H6054_0941', on: true, level: 80, mode: [0x13, 0x05, 0x63, 0x00, 0xff] } };
    const h = fakeHelper({ lights: lightsModel });
    const d = createGoveeBleDriver({ helperPath: 'x.exe', spawnImpl: h.spawnImpl, getCloudMacs: () => new Map([[H6054, { id: 'govee-cloud:H6054:5A:0E:D6:39:32:37:09:41', name: 'Bars' }]]) });
    await d.discover({ timeoutMs: 1000 });
    const r = await d.test(`goveeble:${H6054}`, { gapMs: 300 });
    assert.deepEqual(r, { before: true, after: true, restored: true });
    assert.deepEqual(h.writes.map((w) => w[1].slice(0, 6)), ['330100', '330101'], 'off, then on again: nothing else written');
    assert.deepEqual(lightsModel[H6054].mode.slice(0, 1), [0x13], 'the scene was not touched');

    h.writes.length = 0;
    await d.setState(`goveeble:${H6054}`, { on: true, color: { r: 10, g: 20, b: 30 }, brightness: 40 });
    assert.deepEqual(h.writes.map((w) => w[1].slice(0, 6)), ['330101', '330515', '330428']);
    lightsModel[H6054].mode = [0x02, 200, 100, 50];
    const saved = await d.getState(`goveeble:${H6054}`);
    h.writes.length = 0;
    await d.restoreState(`goveeble:${H6054}`, saved);
    assert.deepEqual(h.writes.map((w) => w[1].slice(0, 14)), ['33010100000000', '33051501c86432', h.writes[2][1].slice(0, 14)], 'power, the plain colour, brightness');
    assert.equal(h.writes[2][1].slice(0, 4), '3304');
    d.close();
});

test('the lights manager: Bluetooth lights in the list, flash blinks, \'all\' leaves cloud-matched lights to the cloud', async () => {
    const model = { [H6054]: { name: 'Govee_H6054_0941', on: true, level: 100, mode: [0x13] }, [NEIGHBOUR]: { name: 'Govee_H6076_5162', on: false, level: 50, mode: [0x02, 1, 2, 3] } };
    const h = fakeHelper({ lights: model });
    let saved = { lights: { enabled: true, drivers: { goveeble: true }, known: [] } };
    const config = { get: () => saved, update: (p) => { saved = { ...saved, lights: { ...saved.lights, ...p.lights } }; } };
    const drv = createGoveeBleDriver({ helperPath: 'x.exe', spawnImpl: h.spawnImpl, getCloudMacs: () => new Map([[H6054, { id: 'govee-cloud:H6054:5A:0E:D6:39:32:37:09:41', name: 'Bars' }]]) });
    const lights = createLights({ config, drivers: { goveeble: drv } });
    const list = await lights.discover({ timeoutMs: 1000 });
    assert.equal(list.length, 2);
    assert.equal(list.find((l) => l.id === `goveeble:${H6054}`).cloudId, 'govee-cloud:H6054:5A:0E:D6:39:32:37:09:41');
    await assert.rejects(() => lights.run('light.power', { device: 'all', state: 'off' }), (e) => e.code === 'no_lights', 'the cloud light is left to the cloud; the neighbour is not paired');
    h.writes.length = 0;
    const r = await lights.run('light.flash', { device: `goveeble:${H6054}`, color: '#ff0000', times: 2, periodMs: 600 });
    assert.deepEqual(r.applied, [`goveeble:${H6054}`]);
    assert.deepEqual(h.writes.map((w) => w[1].slice(0, 6)), ['330100', '330101', '330100', '330101'], 'two blinks, no colour');
    h.writes.length = 0;
    await lights.test(`goveeble:${H6054}`);
    assert.deepEqual(h.writes.map((w) => w[1].slice(0, 6)), ['330100', '330101']);
    await lights.run('light.color', { device: `goveeble:${H6054}`, color: 'red' });
    assert.equal(h.writes.at(-1)[1].slice(0, 14), '33051501ff0000');
    lights.close();
});

test('the real helper starts and scans on Windows (no light is connected to or changed)', { skip: process.platform !== 'win32' && 'Windows only', timeout: 30000 }, async () => {
    const exe = path.join(__dirname, '..', 'src', 'ble', 'govee-ble-helper.exe');
    const p = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const lines = [];
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 50)); return fn(); };
    assert.ok(await until(() => lines.some((l) => l.type === 'ready')), 'ready');
    p.stdin.write(`${JSON.stringify({ id: 1, op: 'scan', ms: 1500 })}\n`);
    const ans = await until(() => lines.find((l) => l.id === 1));
    assert.ok(ans, 'scan answered');
    if (ans.ok) assert.ok(ans.devices.every((x) => /^(Govee|ihoment|GBK|Minger)_/.test(x.name)), 'only Govee names');
    else assert.equal(ans.error, 'no_adapter');
    p.stdin.write(`${JSON.stringify({ id: 2, op: 'write', address: 'zz', hex: '00' })}\n`);
    assert.equal((await until(() => lines.find((l) => l.id === 2))).error, 'bad_params');
    p.stdin.end();
    await new Promise((r) => { p.on('exit', r); setTimeout(r, 3000); });
});
