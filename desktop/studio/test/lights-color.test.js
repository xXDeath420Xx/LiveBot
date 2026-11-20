'use strict';
/*
 * Lights building blocks: colour parsing and conversions (color.js), the device sandbox file (sandbox.js), and mDNS
 * browsing (mdns.js) against a fake multicast-dns. No network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const color = require('../src/main/lights/color');
const { loadSandbox, makeRecorder, SANDBOX_ENV } = require('../src/main/sandbox');
const { createMdns } = require('../src/main/lights/mdns');
const { parseAddress, isLanIPv4, guardHost, safeId } = require('../src/main/lights/util');
const { fakeMdns, captureLogger } = require('./mocks/helpers');

test('parseColor reads hex, rgb(), the 148 CSS names and kelvin; refuses the rest', () => {
    assert.equal(Object.keys(color.CSS_COLORS).length, 148);
    assert.deepEqual(color.parseColor('#b4e04f'), { rgb: { r: 180, g: 224, b: 79 }, hex: '#b4e04f' });
    assert.deepEqual(color.parseColor(' #ABC ').rgb, { r: 170, g: 187, b: 204 });
    assert.deepEqual(color.parseColor('rgb(255, 0, 10)').rgb, { r: 255, g: 0, b: 10 });
    assert.deepEqual(color.parseColor('Rebecca Purple').rgb, { r: 102, g: 51, b: 153 });
    assert.deepEqual(color.parseColor('cornflowerblue').hex, '#6495ed');
    assert.deepEqual(color.parseColor('2700K'), { kelvin: 2700 });
    assert.deepEqual(color.parseColor('6500 k'), { kelvin: 6500 });
    for (const bad of ['', 'nope', '#12', '#1234567', 'rgb(256,0,0)', '900K', '13000K', 'red; drop', 42, null, 'x'.repeat(60)]) {
        assert.equal(color.parseColor(bad), null, String(bad));
    }
});

test('conversions: hsv round trip, kelvin to rgb and back, xy inside the gamut', () => {
    const rgb = { r: 180, g: 224, b: 79 };
    const hsv = color.rgbToHsv(rgb);
    const back = color.hsvToRgb(hsv.h, hsv.s, hsv.v);
    for (const k of ['r', 'g', 'b']) assert.ok(Math.abs(back[k] - rgb[k]) <= 2);
    for (const k of [2000, 2700, 4000, 6500, 9000]) assert.ok(Math.abs(color.rgbToKelvin(color.kelvinToRgb(k)) - k) <= 200, String(k));
    assert.equal(color.rgbToKelvin({ r: 255, g: 120, b: 0 }) < 2500, true, 'orange is a warm white');
    assert.equal(color.rgbToKelvin({ r: 160, g: 190, b: 255 }) > 7000, true, 'pale blue is a cold white');
    const white = color.rgbToXy({ r: 255, g: 255, b: 255 });
    assert.ok(Math.abs(white.x - 0.3127) < 0.002 && Math.abs(white.y - 0.329) < 0.002);
    const blue = color.rgbToXy({ r: 0, g: 0, b: 255 });
    assert.ok(blue.x >= 0.15 && blue.y >= 0.047, 'blue is clamped into Gamut C');
    const narrow = { red: { x: 0.6, y: 0.35 }, green: { x: 0.3, y: 0.55 }, blue: { x: 0.2, y: 0.15 } };
    const red = color.rgbToXy({ r: 255, g: 0, b: 0 }, narrow);
    assert.ok(red.x <= 0.6001, 'clamped into the light\'s own gamut');
    assert.deepEqual(color.xyToRgb(0.3127, 0.329), { r: 255, g: 255, b: 255 });
    assert.equal(color.kelvinToMirek(2000), 500);
    assert.equal(color.mirekToKelvin(153), 6536);
});

test('addresses: IPv4 only, LAN only, the sandbox guard, safe ids', () => {
    assert.deepEqual(parseAddress('192.168.1.20', 443), { host: '192.168.1.20', port: 443 });
    assert.deepEqual(parseAddress('192.168.1.20:16021', 80), { host: '192.168.1.20', port: 16021 });
    for (const bad of ['bridge.local', '192.168.1.300', '1.2.3.4:70000', 'http://1.2.3.4', '']) assert.equal(parseAddress(bad, 80), null, bad);
    assert.equal(isLanIPv4('10.0.0.5'), true);
    assert.equal(isLanIPv4('8.8.8.8'), false);
    assert.throws(() => guardHost({}, '192.168.1.5'), (e) => e.code === 'sandbox_refused');
    assert.doesNotThrow(() => guardHost({}, '127.0.0.1'));
    assert.doesNotThrow(() => guardHost(null, '192.168.1.5'));
    assert.match(safeId('1F:80:C5/../x'), /^[A-Za-z0-9._-]+$/);
});

test('sandbox: unset → null; a valid file is read; anything not 127.0.0.1 closes it instead of falling back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-sbx-'));
    const file = path.join(dir, 'sandbox.json');
    const record = path.join(dir, 'record.json');
    assert.equal(loadSandbox({}), null);
    fs.writeFileSync(file, JSON.stringify({
        govee: { host: '127.0.0.1', scanPort: 14001, listenPort: 14002, controlPort: 14003 },
        hue: [{ address: '127.0.0.1:18443' }], lifx: { host: '127.0.0.1', port: 15670 },
        nanoleaf: [{ address: '127.0.0.1:16021' }], elgato: [{ address: '127.0.0.1:19123' }], litra: 'fake', voicemeeter: 'fake', recordFile: record,
    }));
    const sb = loadSandbox({ [SANDBOX_ENV]: file });
    assert.equal(sb.invalid, false);
    assert.deepEqual(sb.hue, [{ host: '127.0.0.1', port: 18443 }]);
    assert.equal(sb.govee.listenPort, 14002);
    assert.equal(sb.litra, 'fake');
    sb.record({ device: 'test', n: 1 });
    sb.record({ device: 'test', n: 2 });
    assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf8')).map((e) => e.n), [1, 2]);

    const { logger, lines } = captureLogger();
    fs.writeFileSync(file, JSON.stringify({ hue: [{ address: '192.168.1.40:443' }] }));
    const closed = loadSandbox({ [SANDBOX_ENV]: file }, { logger });
    assert.equal(closed.invalid, true);
    assert.deepEqual([closed.hue, closed.nanoleaf, closed.elgato, closed.govee, closed.lifx], [[], [], [], null, null]);
    assert.equal(closed.litra, 'fake');
    assert.ok(lines.some((l) => l.startsWith('error') && /sandbox/.test(l)));
    fs.writeFileSync(file, JSON.stringify({ govee: { host: '0.0.0.0', scanPort: 1, listenPort: 2, controlPort: 3 } }));
    assert.equal(loadSandbox({ [SANDBOX_ENV]: file }).invalid, true);
    assert.equal(loadSandbox({ [SANDBOX_ENV]: path.join(dir, 'missing.json') }).invalid, true);
    makeRecorder(null)({});   // no file: a no-op
    fs.rmSync(dir, { recursive: true, force: true });
});

test('mDNS browse collects PTR/SRV/TXT/A, keeps LAN addresses only, and closes its socket', async () => {
    const factory = fakeMdns([
        { type: '_hue._tcp.local', instance: 'Hue Bridge - 123456', host: 'bridge.local', address: '127.0.0.1', port: 4443, txt: { bridgeid: '001788fffe123456', modelid: 'BSB002' } },
        { type: '_hue._tcp.local', instance: 'Outside', host: 'far.local', address: '8.8.8.8', port: 443, txt: {} },
        { type: '_elg._tcp.local', instance: 'Key Light', host: 'kl.local', address: '127.0.0.1', port: 9123, txt: {} },
    ]);
    const mdns = createMdns({ factory });
    const found = await mdns.browse('_hue._tcp.local', { timeoutMs: 100 });
    assert.equal(found.length, 1);
    assert.deepEqual(found[0], { instance: 'hue bridge - 123456', host: 'bridge.local', address: '127.0.0.1', port: 4443, txt: { bridgeid: '001788fffe123456', modelid: 'BSB002' } });
    assert.equal(factory.destroyed(), 1);
    await assert.rejects(mdns.browse('bad type'), (e) => e.code === 'bad_params');
});
