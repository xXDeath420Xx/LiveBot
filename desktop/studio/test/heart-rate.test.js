'use strict';
/*
 * Studio 0.2.14 heart rate (src/main/heart-rate.js) with a simulated Bluetooth device: the helper process is a fake that
 * answers scan / connect like heart-ble-helper.exe and pushes 0x2A37 notifications. No Bluetooth adapter or watch is used.
 *   parser    uint8 and uint16 BPM, sensor contact (supported / detected / not supported), energy expended, RR intervals
 *   reader    scan, choose, smoothing, the sparkline history, contact lost, link drop and stale data → reconnect with
 *             backoff 5 s doubling to 60 s, battery, forget
 *   sender    at most one send a second, repeats only every 3 s
 *   wiring    main.js, preload, the window, the helper's build script and packaging
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { parseHeartRate, usable, createHeartRate, createSender } = require('../src/main/heart-rate');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const hex = (...b) => Buffer.from(b).toString('hex');

// ── a fake clock and timers ──
function clock(start = 1_000_000) {
    let t = start;
    let id = 0;
    const timers = new Map();
    return {
        now: () => t,
        setTimer: (fn, ms) => { const k = ++id; timers.set(k, { at: t + ms, fn }); return k; },
        clearTimer: (k) => { timers.delete(k); },
        pending: () => [...timers.values()].map((x) => x.at - t).sort((a, b) => a - b),
        async advance(ms) {
            const end = t + ms;
            for (;;) {
                const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
                if (!next || next[1].at > end) break;
                t = next[1].at;
                timers.delete(next[0]);
                next[1].fn();
                await new Promise((r) => setImmediate(r));
            }
            t = end;
            await new Promise((r) => setImmediate(r));
        },
    };
}

// ── a fake heart-ble-helper.exe with one simulated watch ──
function fakeHelper({ devices = [{ address: 'C0FFEE123456', name: 'Galaxy Watch8 Classic (A1B2)', rssi: -58, hr: true }], connectOk = true } = {}) {
    const sim = { spawned: 0, sent: [], proc: null, connectOk };
    sim.spawn = () => {
        sim.spawned++;
        const p = new EventEmitter();
        p.stdout = new EventEmitter();
        p.stdout.setEncoding = () => {};
        p.stdin = new EventEmitter();
        p.stdin.write = (line) => {
            const m = JSON.parse(line);
            sim.sent.push(m);
            setImmediate(() => {
                if (m.op === 'scan') sim.out({ id: m.id, ok: true, devices: m.all ? [...devices, { address: 'AA0000000001', name: 'Bespoke Washer', rssi: -88, hr: false }] : devices });
                else if (m.op === 'connect') {
                    if (sim.connectOk) { sim.out({ type: 'link', address: m.address, connected: true }); sim.out({ id: m.id, ok: true, name: 'Galaxy Watch8 Classic', battery: 71 }); }
                    else sim.out({ id: m.id, ok: false, error: 'not_found', message: 'not_found' });
                } else sim.out({ id: m.id, ok: true });
            });
            return true;
        };
        p.stdin.end = () => {};
        p.kill = () => p.emit('exit', 0);
        sim.proc = p;
        setImmediate(() => sim.out({ type: 'ready' }));
        return p;
    };
    sim.out = (o) => sim.proc.stdout.emit('data', `${JSON.stringify(o)}\n`);
    sim.notify = (bytes, address = 'C0FFEE123456') => sim.out({ type: 'hr', address, hex: hex(...bytes) });
    return sim;
}
const tick = () => new Promise((r) => setImmediate(r));

// ── parser ──
test('0x2A37: uint8 and uint16 values, contact, energy and RR intervals', () => {
    assert.deepEqual(parseHeartRate(Buffer.from([0x00, 72])), { bpm: 72, sixteenBit: false, contactSupported: false, contact: null, energy: null, rr: [] });
    assert.equal(parseHeartRate(Buffer.from([0x01, 0x8c, 0x00])).bpm, 140, 'uint16 little endian');
    assert.equal(parseHeartRate(Buffer.from([0x01, 0x2c, 0x01])).bpm, 300);
    assert.equal(parseHeartRate([0x01, 0x8c]), null, 'uint16 flag with one value byte');
    assert.equal(parseHeartRate([0x00]), null);
    assert.equal(parseHeartRate(null), null);
    const worn = parseHeartRate([0x06, 88]);
    assert.deepEqual([worn.contactSupported, worn.contact], [true, true]);
    const off = parseHeartRate([0x04, 88]);
    assert.deepEqual([off.contactSupported, off.contact], [true, false]);
    assert.equal(parseHeartRate([0x02, 88]).contact, null, 'bit 1 alone means nothing when contact is not supported');
    // RR intervals in 1/1024 s: 1024 → 1000 ms, 820 → 801 ms
    const rr = parseHeartRate([0x10, 60, 0x00, 0x04, 0x34, 0x03]);
    assert.deepEqual(rr.rr, [1000, 801]);
    // energy expended (uint16 kJ) comes before the RR intervals; with a uint16 value too
    const all = parseHeartRate([0x1f, 0x9b, 0x00, 0x10, 0x02, 0x00, 0x03]);
    assert.deepEqual([all.bpm, all.energy, all.contact, all.rr], [155, 528, true, [750]]);
    assert.equal(parseHeartRate([0x08, 70, 0x01]), null, 'energy flag without its two bytes');
    assert.deepEqual(parseHeartRate([0x10, 70, 0x00, 0x04, 0x99]).rr, [1000], 'an odd trailing byte is ignored');
    assert.equal(parseHeartRate('0048').bpm, 72, 'hex text from the helper');
});

test('usable: worn and believable only', () => {
    assert.equal(usable(parseHeartRate([0x00, 72])), true);
    assert.equal(usable(parseHeartRate([0x06, 72])), true);
    assert.equal(usable(parseHeartRate([0x04, 72])), false, 'contact supported but not detected');
    assert.equal(usable(parseHeartRate([0x00, 0])), false);
    assert.equal(usable(parseHeartRate([0x01, 0x2c, 0x01])), false, '300 BPM');
    assert.equal(usable(null), false);
});

// ── the reader ──
function reader(sim, c, extra = {}) {
    const settings = { enabled: true, device: null, share: true };
    const readings = [];
    const states = [];
    const hr = createHeartRate({
        helperPath: 'heart-ble-helper.exe', spawnImpl: sim.spawn, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
        getSettings: () => settings, saveDevice: (d) => { settings.device = d; },
        onReading: (r) => readings.push(r), onStatus: (s) => states.push(s.state), ...extra,
    });
    return { hr, settings, readings, states };
}

test('reader: scan, choose, readings smoothed over 3, history, battery', async () => {
    const sim = fakeHelper();
    const c = clock();
    const { hr, settings, readings } = reader(sim, c);
    hr.start();
    assert.equal(hr.status().state, 'idle', 'on, but no device chosen');
    const list = await hr.scan({});
    assert.deepEqual(list.map((d) => [d.address, d.hr]), [['C0FFEE123456', true]]);
    const every = await hr.scan({ all: true });
    assert.equal(every.length, 2);
    assert.equal(every[0].hr, true, 'heart-rate sensors first');
    assert.equal(sim.sent.find((m) => m.op === 'scan' && m.all).all, true);
    hr.choose({ address: 'c0:ff:ee:12:34:56', name: 'Galaxy Watch8 Classic (A1B2)' });
    assert.deepEqual(settings.device, { address: 'C0FFEE123456', name: 'Galaxy Watch8 Classic (A1B2)' });
    await tick(); await tick();
    assert.equal(sim.sent.filter((m) => m.op === 'connect').length, 1);
    assert.equal(hr.status().state, 'waiting', 'connected, no reading yet');
    assert.equal(hr.status().battery, 71);
    for (const b of [90, 93, 99]) { sim.notify([0x06, b]); await c.advance(1000); }
    assert.deepEqual(readings.map((r) => r.bpm), [90, 92, 94], 'running mean of the last three');
    assert.equal(hr.status().state, 'connected');
    sim.notify([0x16, 120, 0x00, 0x04]);
    assert.deepEqual(readings.at(-1).rr, [1000]);
    assert.equal(readings.at(-1).contact, true);
    assert.equal(hr.status().history.length, 4);
    sim.notify([0x06, 121]);
    assert.equal(hr.status().history.length, 4, 'at most one history point a second');
    await c.advance(1000);
    sim.notify([0x06, 120]);
    assert.equal(hr.status().history.length, 5);
    sim.out({ type: 'battery', address: 'C0FFEE123456', percent: 64 });
    assert.equal(hr.status().battery, 64);
    sim.notify([0x00, 200], 'AABBCCDDEEFF');
    assert.notEqual(readings.at(-1).bpm, 200, 'notifications from another device are ignored');
    hr.close();
});

test('reader: watch off the wrist, link lost, stale data and a failed connect all reconnect with backoff', async () => {
    const sim = fakeHelper();
    const c = clock();
    const { hr, readings } = reader(sim, c, { staleMs: 20000 });
    hr.choose({ address: 'C0FFEE123456', name: 'Watch' });
    await tick(); await tick();
    sim.notify([0x06, 80]);
    assert.equal(hr.status().state, 'connected');
    sim.notify([0x04, 80]);
    assert.equal(hr.status().state, 'waiting', 'contact lost: no reading is used');
    assert.equal(readings.length, 1);
    sim.notify([0x06, 81]);
    assert.equal(hr.status().state, 'connected');

    sim.out({ type: 'link', address: 'C0FFEE123456', connected: false });
    assert.equal(hr.status().state, 'reconnecting');
    assert.equal(c.pending()[0], 5000, 'first retry after 5 s');
    sim.connectOk = false;
    await c.advance(5000);
    assert.equal(sim.sent.filter((m) => m.op === 'connect').length, 2);
    assert.match(hr.status().error, /not found/i);
    assert.equal(c.pending()[0], 10000, 'then 10 s');
    await c.advance(10000);
    assert.equal(c.pending()[0], 20000, 'then 20 s');
    await c.advance(20000);
    await c.advance(40000);
    assert.equal(c.pending()[0], 60000, 'capped at 60 s');
    sim.connectOk = true;
    await c.advance(60000);
    assert.equal(hr.status().state, 'waiting');
    sim.notify([0x06, 82]);
    assert.equal(hr.status().state, 'connected');

    // the watch app stops broadcasting but keeps the link: no reading for 20 s
    await c.advance(20000);
    assert.equal(hr.status().state, 'reconnecting');
    assert.match(hr.status().error, /stopped broadcasting/);
    assert.equal(c.pending()[0], 5000, 'a good reading reset the backoff');

    // the helper process itself stops
    await c.advance(5000);
    await tick();
    const before = sim.spawned;
    sim.proc.emit('exit', 1);
    assert.equal(hr.status().state, 'reconnecting');
    await c.advance(10000);
    await tick();
    assert.equal(sim.spawned, before + 1, 'the helper is started again');
    hr.close();
});

test('reader: off, forget, and a device without a valid address', async () => {
    const sim = fakeHelper();
    const c = clock();
    const { hr, settings } = reader(sim, c);
    settings.enabled = false;
    settings.device = { address: 'C0FFEE123456', name: 'Watch' };
    hr.start();
    assert.equal(hr.status().state, 'off');
    assert.equal(sim.spawned, 0, 'nothing starts while heart rate is off');
    settings.enabled = true;
    hr.start();
    await tick(); await tick();
    assert.equal(hr.status().state, 'waiting');
    hr.forget();
    await tick();
    assert.equal(settings.device, null);
    assert.equal(hr.status().state, 'idle');
    assert.equal(c.pending().length, 0, 'no retry left behind');
    assert.ok(sim.sent.some((m) => m.op === 'disconnect'));
    assert.throws(() => hr.choose({ address: 'nope' }), /Pick a device/);
    hr.close();
});

// ── the sender ──
test('sender: at most once a second, the same value only every 3 s', async () => {
    const c = clock();
    const sent = [];
    const s = createSender({ send: (r) => sent.push([c.now(), r.bpm]), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
    const t0 = c.now();
    s.push({ bpm: 80 });
    await c.advance(200); s.push({ bpm: 81 });
    await c.advance(200); s.push({ bpm: 82 });
    await c.advance(1000);
    assert.deepEqual(sent.map(([t, b]) => [t - t0, b]), [[0, 80], [1000, 82]], 'the newest value goes out when the second is up');
    for (let i = 0; i < 7; i++) { s.push({ bpm: 82 }); await c.advance(1000); }
    assert.deepEqual(sent.slice(2).map(([t, b]) => [t - t0, b]), [[4400, 82], [7400, 82]], 'a steady value every 3 s');
    s.push({ bpm: 'x' });
    s.close();
});

// ── wiring ──
test('wiring: main process, preload, window, help text, build and packaging', () => {
    const main = read('src/main/main.js');
    assert.match(main, /createHeartRate\(\{/);
    assert.match(main, /heart-ble-helper\.exe'\)\.replace\(`app\.asar\$\{path\.sep\}`, `app\.asar\.unpacked\$\{path\.sep\}`\)/);
    assert.match(main, /engine\.request\('heart\.rate', \{ bpm: r\.bpm/);
    assert.match(main, /config\.get\(\)\.heart\?\.share === false/, 'nothing is sent when sharing is off');
    assert.match(main, /heart\?\.close\(\)/, 'the helper stops on quit');
    for (const ch of ['heart:scan', 'heart:choose', 'heart:forget', 'heart:settings']) assert.match(main, new RegExp(`handle\\('${ch}'`));
    const pre = read('src/preload/preload.js');
    for (const ch of ['heart:scan', 'heart:choose', 'heart:forget', 'heart:settings']) assert.ok(pre.includes(`'${ch}'`), ch);
    assert.match(pre, /'heart'\]\)/, 'the heart push');
    const { DEFAULTS } = require('../src/main/config');
    assert.deepEqual(DEFAULTS.heart, { enabled: false, device: null, share: true });
    const html = read('src/renderer/index.html');
    assert.match(html, /data-tab="heart">Heart rate</);
    for (const id of ['heart-bpm', 'heart-spark', 'heart-scan', 'heart-forget', 'heart-enabled', 'heart-share', 'heart-all', 'heart-table']) assert.ok(html.includes(`id="${id}"`), id);
    assert.match(html, /Heart for Bluetooth/);
    assert.match(html, /start broadcasting/);
    assert.doesNotMatch(html + read('src/renderer/app.js'), /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2764}]/u, 'no emoji');
    assert.doesNotMatch(read('src/renderer/app.js'), /innerHTML/);
    const pkg = JSON.parse(read('package.json'));
    assert.ok(pkg.build.asarUnpack.includes('src/ble/**/*'), 'the helper is unpacked next to app.asar');
    assert.ok(fs.existsSync(path.join(root, 'src/ble/heart-ble-helper.exe')), 'the built helper ships');
    const cs = read('src/ble/heart-ble-helper.cs');
    assert.match(cs, /FromShortId\(0x180D\)/);
    assert.match(cs, /FromShortId\(0x2A37\)/);
    assert.doesNotMatch(cs, /System\.Net|HttpClient|WebClient|Windows\.Networking/, 'the helper has no network code');
    assert.match(read('scripts/build-ble-helper.ps1'), /'heart-ble-helper'/);
});
