'use strict';
/*
 * The lights manager (src/main/lights/index.js): routing ('all' vs one id, groups and bridges left out of 'all'),
 * errors, white-only notes, temporary changes and restore on a fake clock, flash/pulse counts, presets, the known list
 * (saved without secrets or online state), onChange; then one run through the sandbox with real drivers against the
 * Govee and Elgato mocks and the fake Litra.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { guardNetwork, fakeClock, fakeConfig, captureLogger, freeUdpPort } = require('./mocks/helpers');
const { startGoveeMock } = require('./mocks/govee-mock');
const { startElgatoMock } = require('./mocks/panel-mocks');
const { createLights } = require('../src/main/lights');
const { fakeHid } = require('../src/main/sandbox');

guardNetwork();

const caps = (o = {}) => ({ power: true, brightness: true, color: true, white: { min: 2000, max: 9000 }, scenes: [], effects: [], ...o });

/** A driver kept in memory: devices with state; every setState/scene call recorded. */
function memDriver(name, devs, { scenes = false } = {}) {
    const state = new Map(devs.map((d) => [d.id, { on: false, brightness: 50, color: { r: 1, g: 2, b: 3 }, kelvin: null, ...(d.state || {}) }]));
    const calls = [];
    const list = devs.map((d) => ({ driver: name, model: name, address: '127.0.0.1', online: true, needsPairing: false, kind: 'light', caps: caps(), ...d, state: undefined }));
    const d = {
        id: name, calls, state,
        discover: async () => list.map((x) => ({ ...x })),
        list: () => list.map((x) => ({ ...x })),
        restore() {},
        async getState(id) { calls.push(['get', id]); const s = state.get(id); if (!s) throw Object.assign(new Error('x'), { code: 'device_not_found' }); return { ...s }; },
        async setState(id, s) {
            calls.push(['set', id, { ...s }]);
            if (list.find((x) => x.id === id)?.fail) throw Object.assign(new Error('No answer'), { code: 'device_unreachable' });
            const cur = state.get(id);
            for (const k of ['on', 'brightness']) if (s[k] !== undefined) cur[k] = s[k];
            if (s.color) { cur.color = s.color; cur.kelvin = null; }
            if (s.kelvin) { cur.kelvin = s.kelvin; cur.color = null; }
        },
        close() { d.closed = true; },
        forget(id) { const i = list.findIndex((x) => x.id === id); if (i >= 0) list.splice(i, 1); },
    };
    if (scenes) d.scene = async (id, nm) => { calls.push(['scene', id, nm]); if (nm !== 'Relax') throw Object.assign(new Error('none'), { code: 'scene_not_found' }); return nm; };
    return d;
}

function setup({ known = [] } = {}) {
    const clock = fakeClock();
    const govee = memDriver('govee', [{ id: 'govee:aa', name: 'Strip' }, { id: 'govee:bb', name: 'Lamp' }]);
    const hue = memDriver('hue', [
        { id: 'hue:br', name: 'Bridge', kind: 'bridge', caps: caps({ power: false, brightness: false, color: false, white: null, scenes: ['Relax'] }) },
        { id: 'hue:br/l1', name: 'Hue colour only', caps: caps({ white: null }) },
        { id: 'hue:br/group/g1', name: 'Office', kind: 'group' },
    ], { scenes: true });
    const elgato = memDriver('elgato', [{ id: 'elgato:kl', name: 'Key Light', caps: caps({ color: false, white: { min: 2900, max: 7000 } }), state: { on: true, brightness: 40, color: null, kelvin: 5000 } }]);
    const nanoleaf = memDriver('nanoleaf', [{ id: 'nanoleaf:p', name: 'Panels', needsPairing: true }]);
    const lifx = memDriver('lifx', [{ id: 'lifx:off', name: 'Unplugged', online: false, fail: true }]);
    const config = fakeConfig({ lights: { known } });
    const { logger, lines } = captureLogger();
    const lights = createLights({ config, logger, drivers: { govee, hue, elgato, nanoleaf, lifx }, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    return { lights, clock, govee, hue, elgato, nanoleaf, lifx, config, lines };
}
const code = async (p) => { try { await p; return 'ok'; } catch (e) { return e.code; } };
const sets = (drv, id) => drv.calls.filter((c) => c[0] === 'set' && c[1] === id).map((c) => c[2]);

test('discover merges every driver, saves the list without online state or secrets, and calls onChange', async () => {
    const { lights, config } = setup();
    const changes = [];
    lights.onChange((l) => changes.push(l.length));
    const list = await lights.discover({ timeoutMs: 500 });
    assert.equal(list.length, 8);
    assert.equal(changes.length, 1);
    const saved = config.get().lights.known;
    assert.equal(saved.length, 8);
    assert.ok(saved.every((d) => !('online' in d) && !JSON.stringify(d).match(/token|username|application-key|secret|clientkey/i)));
    assert.deepEqual(Object.keys(list[0]).sort(), ['address', 'caps', 'driver', 'id', 'kind', 'model', 'name', 'needsPairing', 'online']);
});

test('"all" sets every paired, online light once (no groups, bridges, unpaired or offline); one id sets just that one', async () => {
    const { lights, govee, hue, elgato } = setup();
    await lights.discover();
    const r = await lights.run('light.set', { device: 'all', color: '#ff0000', brightness: 80 });
    assert.deepEqual(r.applied.sort(), ['elgato:kl', 'govee:aa', 'govee:bb', 'hue:br/l1']);
    assert.deepEqual(r.skipped, []);
    assert.deepEqual(r.notes, [{ id: 'elgato:kl', reason: 'white_only' }]);
    assert.deepEqual(sets(govee, 'govee:aa'), [{ on: true, brightness: 80, color: { r: 255, g: 0, b: 0 } }]);
    assert.equal(sets(hue, 'hue:br/group/g1').length, 0, 'the room is not set again');
    const kl = sets(elgato, 'elgato:kl')[0];
    assert.equal(kl.color, undefined);
    assert.ok(kl.kelvin >= 2900 && kl.kelvin <= 7000, 'red becomes the nearest (warm) white');

    const one = await lights.run('light.brightness', { device: 'govee:bb', brightness: 150 });
    assert.deepEqual(one, { applied: ['govee:bb'], skipped: [], notes: [] });
    assert.deepEqual(sets(govee, 'govee:bb').at(-1), { on: true, brightness: 100 }, 'clamped');
    await lights.run('light.brightness', { device: 'govee:bb', brightness: 0 });
    assert.deepEqual(sets(govee, 'govee:bb').at(-1), { on: false }, 'brightness 0 turns it off');
    await lights.run('light.set', { device: 'hue:br/group/g1', color: 'blue' });
    assert.equal(sets(hue, 'hue:br/group/g1').length, 1, 'a room can be set by its own id');
});

test('errors: device_not_found, needs_pairing, not_supported, bad_color, device_offline, no_lights, bad_params', async () => {
    const { lights } = setup();
    await lights.discover();
    assert.equal(await code(lights.run('light.set', { device: 'govee:nope', color: '#fff' })), 'device_not_found');
    assert.equal(await code(lights.run('light.set', { device: 'nanoleaf:p', color: '#fff' })), 'needs_pairing');
    assert.equal(await code(lights.run('light.white', { device: 'hue:br/l1', kelvin: 3000 })), 'not_supported');
    assert.equal(await code(lights.run('light.set', { device: 'hue:br', color: '#fff' })), 'not_supported');
    assert.equal(await code(lights.run('light.color', { device: 'govee:aa', color: 'blurple' })), 'bad_color');
    assert.equal(await code(lights.run('light.set', { device: 'govee:aa', color: 'rgb(300,0,0)' })), 'bad_color');
    assert.equal(await code(lights.run('light.set', { device: 'lifx:off', color: '#fff' })), 'device_offline');
    assert.equal(await code(lights.run('light.scene', { device: 'govee:aa', scene: 'Relax' })), 'not_supported');
    assert.equal(await code(lights.run('light.power', { device: 'govee:aa', state: 'sideways' })), 'bad_params');
    assert.equal(await code(lights.run('light.set', { device: 'govee:aa' })), 'bad_params');
    assert.equal(await code(lights.run('light.dance', {})), 'unsupported_action');
    const empty = createLights({ config: fakeConfig(), drivers: {} });
    assert.equal(await code(empty.run('light.set', { device: 'all', color: '#fff' })), 'no_lights');
    // 'all' with one light failing: the others apply, the failure is listed
    const r = await lights.run('light.white', { device: 'all', kelvin: 2700 });
    assert.deepEqual(r.skipped, [{ id: 'hue:br/l1', reason: 'not_supported', message: 'This light has no white setting' }]);
    assert.equal(r.applied.length, 3);
});

test('light.color takes text colours and kelvin; light.white clamps to the light; scene on the bridge; power toggle', async () => {
    const { lights, govee, hue, elgato } = setup();
    await lights.discover();
    await lights.run('light.color', { device: 'govee:aa', color: 'Hot Pink' });
    assert.deepEqual(sets(govee, 'govee:aa').at(-1).color, { r: 255, g: 105, b: 180 });
    await lights.run('light.color', { device: 'govee:aa', color: '3000K' });
    assert.equal(sets(govee, 'govee:aa').at(-1).kelvin, 3000);
    await lights.run('light.white', { device: 'elgato:kl', kelvin: 12000, brightness: 30 });
    assert.deepEqual(sets(elgato, 'elgato:kl').at(-1), { on: true, brightness: 30, kelvin: 7000 });
    const sc = await lights.run('light.scene', { device: 'hue:br', scene: 'Relax' });
    assert.deepEqual(sc.applied, ['hue:br']);
    assert.equal(await code(lights.run('light.scene', { device: 'hue:br', scene: 'Nope' })), 'scene_not_found');
    await lights.run('light.power', { device: 'govee:aa', state: 'toggle' });
    const was = sets(govee, 'govee:aa').at(-1).on;
    await lights.run('light.power', { device: 'govee:aa', state: 'toggle' });
    assert.equal(sets(govee, 'govee:aa').at(-1).on, !was);
    assert.ok(hue.calls.some((c) => c[0] === 'scene'));
});

test('durationMs: the state is read first and put back on time; a second temporary change keeps the first state', async () => {
    const { lights, clock, elgato } = setup();
    await lights.discover();
    await lights.run('light.white', { device: 'elgato:kl', kelvin: 3000, brightness: 100, durationMs: 5000 });
    assert.deepEqual(elgato.state.get('elgato:kl'), { on: true, brightness: 100, color: null, kelvin: 3000 });
    await clock.advance(2000);
    await lights.run('light.brightness', { device: 'elgato:kl', brightness: 10, durationMs: 5000 });
    assert.equal(elgato.calls.filter((c) => c[0] === 'get').length, 1, 'the second change did not read the state again');
    await clock.advance(4000);
    assert.equal(elgato.state.get('elgato:kl').brightness, 10, 'the first timer was replaced by the second');
    await clock.advance(1500);
    assert.deepEqual(elgato.state.get('elgato:kl'), { on: true, brightness: 40, color: null, kelvin: 5000 }, 'back to before the first change');
    assert.equal(lights.pendingRestores(), 0);
});

test('a permanent change cancels the pending restore', async () => {
    const { lights, clock, govee } = setup();
    await lights.discover();
    await lights.run('light.set', { device: 'govee:aa', color: '#00ff00', durationMs: 3000 });
    await lights.run('light.set', { device: 'govee:aa', color: '#0000ff' });
    await clock.advance(10000);
    assert.deepEqual(govee.state.get('govee:aa').color, { r: 0, g: 0, b: 255 });
    assert.equal(sets(govee, 'govee:aa').length, 2, 'no restore was sent');
});

test('flash: times on/off cycles at periodMs, then restore; pulse dims instead of turning off; test() flashes green once', async () => {
    const { lights, clock, govee } = setup();
    await lights.discover();
    const r = await lights.run('light.flash', { device: 'govee:aa', color: '#ff0000', brightness: 100, times: 3, periodMs: 1000, mode: 'flash' });
    assert.deepEqual(r.applied, ['govee:aa']);
    assert.equal(sets(govee, 'govee:aa').length, 1, 'the first flash is applied before run() returns');
    await clock.advance(3000);
    const calls = sets(govee, 'govee:aa');
    assert.equal(calls.length, 7, '3 on + 3 off + 1 restore');
    assert.deepEqual(calls.slice(0, 6).map((c) => c.on), [true, false, true, false, true, false]);
    assert.deepEqual(calls[6], { on: false, transitionMs: 0, brightness: 50, color: { r: 1, g: 2, b: 3 } });

    await lights.run('light.flash', { device: 'govee:bb', color: '#ffffff', brightness: 80, times: 2, periodMs: 400, mode: 'pulse' });
    await clock.advance(800);
    const p = sets(govee, 'govee:bb');
    assert.equal(p.length, 5);
    assert.deepEqual(p.slice(0, 4).map((c) => [c.on, c.brightness]), [[true, 80], [true, 12], [true, 80], [true, 12]]);

    await lights.test('govee:aa');
    assert.deepEqual(sets(govee, 'govee:aa').at(-1).color, { r: 0xb4, g: 0xe0, b: 0x4f });
    await clock.advance(800);
    assert.equal(sets(govee, 'govee:aa').length, 7 + 3);
    const t = await lights.run('light.flash', { device: 'govee:aa', times: 99, periodMs: 1 });
    assert.deepEqual(t.applied, ['govee:aa']);
    await clock.advance(20 * 200);
    assert.equal(sets(govee, 'govee:aa').length, 10 + 41, 'times clamped to 20, period to 200 ms');
});

test('preset: each entry applied (power, colour, kelvin, scene); unknown devices are listed as skipped', async () => {
    const { lights, govee, hue, elgato } = setup();
    await lights.discover();
    const r = await lights.run('light.preset', { preset: 'Chill', lights: [
        { device: 'govee:aa', color: 'purple', brightness: 30 },
        { device: 'govee:bb', power: 'off' },
        { device: 'elgato:kl', kelvin: 3200 },
        { device: 'hue:br/group/g1', scene: 'Relax' },
        { device: 'govee:gone', color: '#fff' },
    ] });
    assert.deepEqual(r.applied, ['govee:aa', 'govee:bb', 'elgato:kl', 'hue:br/group/g1']);
    assert.deepEqual(r.skipped, [{ id: 'govee:gone', reason: 'device_not_found' }]);
    assert.deepEqual(sets(govee, 'govee:bb'), [{ on: false }]);
    assert.equal(sets(elgato, 'elgato:kl')[0].kelvin, 3200);
    assert.ok(hue.calls.some((c) => c[0] === 'scene' && c[1] === 'hue:br/group/g1'));
    assert.equal(await code(lights.run('light.preset', { lights: [] })), 'bad_params');
});

test('forget drops the light and saves; close stops timers and closes drivers', async () => {
    const { lights, clock, config, govee } = setup();
    await lights.discover();
    await lights.run('light.set', { device: 'govee:aa', color: '#123456', durationMs: 5000 });
    assert.equal(lights.forget('govee:aa'), true);
    assert.equal(lights.list().some((d) => d.id === 'govee:aa'), false);
    assert.equal(config.get().lights.known.some((d) => d.id === 'govee:aa'), false);
    assert.equal(lights.pendingRestores(), 0);
    lights.close();
    assert.equal(clock.pending(), 0);
    assert.equal(govee.closed, true);
    assert.equal(await code(lights.run('light.set', { device: 'all', color: '#fff' })), 'driver_error');
});

test('sandbox run with real drivers: Govee mock, Elgato mock and the fake Litra; colour → white on white-only lights; restore', async () => {
    const listenPort = await freeUdpPort();
    const govee = await startGoveeMock({ listenPort });
    const key = await startElgatoMock();
    const recorded = [];
    const sandbox = {
        govee: { host: '127.0.0.1', scanPort: govee.scanPort, listenPort, controlPort: govee.controlPort },
        hue: [], nanoleaf: [], elgato: [{ host: '127.0.0.1', port: key.port }], lifx: null, litra: 'fake', record: (e) => recorded.push(e),
    };
    const clock = fakeClock();
    const config = fakeConfig({ lights: { drivers: { hue: false, nanoleaf: false, lifx: false } } });
    const { logger, lines } = captureLogger();
    const lights = createLights({ config, logger, sandbox, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, timing: { goveeGapMs: 0, goveeReplyMs: 500, httpTimeoutMs: 1000 } });
    try {
        const list = await lights.discover({ timeoutMs: 300 });
        assert.deepEqual(list.map((d) => d.id).sort(), ['elgato:BW33K1A01234', 'govee:1f80c5323236724e', 'litra:FAKEBEAM0001', 'litra:FAKEGLOW0001']);
        const r = await lights.run('light.color', { device: 'all', color: 'red', brightness: 90, durationMs: 4000 });
        assert.equal(r.applied.length, 4);
        assert.deepEqual(r.notes.map((n) => n.id).sort(), ['elgato:BW33K1A01234', 'litra:FAKEBEAM0001', 'litra:FAKEGLOW0001']);
        await new Promise((res) => setTimeout(res, 50));
        assert.deepEqual(govee.state.color, { r: 255, g: 0, b: 0 });
        assert.equal(key.state.brightness, 90);
        assert.ok(recorded.some((e) => e.device === 'litra' && e.report.startsWith('11ff041c01')));
        await clock.advance(4000);
        await new Promise((res) => setTimeout(res, 50));
        assert.deepEqual(govee.state.color, { r: 10, g: 20, b: 30 }, 'Govee back to its colour');
        assert.equal(govee.state.onOff, 0, 'and off again');
        assert.deepEqual([key.state.on, key.state.brightness, key.state.temperature], [0, 20, 200], 'Key Light back');
        assert.ok(!lines.some((l) => /error/i.test(l.split(' ')[0])));
    } finally { lights.close(); await govee.close(); await key.close(); }
});

test('known lights come back from settings (offline until found) and a single target is probed before use', async () => {
    const known = [{ id: 'litra:FAKEGLOW0001', driver: 'litra', name: 'Glow', model: 'Litra Glow', address: null, caps: {}, kind: 'light', needsPairing: false }];
    const hid = fakeHid([]);
    const lights = createLights({ config: fakeConfig({ lights: { known } }), sandbox: { litra: 'fake' }, hid });
    assert.deepEqual(lights.list().map((d) => [d.id, d.online, d.name]), [['litra:FAKEGLOW0001', false, 'Glow']]);
    const r = await lights.run('light.white', { device: 'litra:FAKEGLOW0001', kelvin: 5000 });
    assert.deepEqual(r.applied, ['litra:FAKEGLOW0001']);
    assert.equal(hid.state('fake-hid://litra-glow').kelvin, 5000);
    lights.close();
});
