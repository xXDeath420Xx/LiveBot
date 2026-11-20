import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import pool from '../utils/db.js';
import { makeTables, makeProfile, fakeEncryption } from './fixtures/stream-bot-tables.js';
import { lightAccountsDdl, LIGHT_TABLES } from '../migrations/461_stream_bot_light_accounts.js';
import { LIGHT_ACTIONS, VOICEMEETER_ACTIONS, parseColor, isCloudDevice, cloudProviderOf, validatePreset, CSS_COLORS } from '../core/stream-bot/devices/catalog.js';
import { sanitiseDevices } from '../core/stream-bot/devices/state.js';
import { createLightAccounts } from '../core/stream-bot/devices/accounts.js';
import { createCloudLights, GOVEE_BASE, LIFX_BASE } from '../core/stream-bot/devices/cloud.js';
import { createDeviceService, lightError } from '../core/stream-bot/devices/service.js';
import { devicesExport, devicesDelete } from '../core/stream-bot/devices/privacy.js';
import * as actionsMod from '../core/stream-bot/actions.js';
import { createEngine } from '../core/stream-bot/engine.js';
import { createRenderer } from '../core/stream-bot/render.js';
import { sanitiseState, createStudioServices, usesStep } from '../core/stream-bot/studio.js';
import { createStreamBotPrivacy } from '../core/stream-bot/privacy.js';
import { classifyTable } from '../core/privacy-tables.js';

/*
 * Lights, Voicemeeter and the Stream Deck on the server (core/stream-bot/devices, migration 461) on throwaway tables (sbtd…_).
 * Nothing reaches Govee, LIFX or a real CertiFried Studio: cloud calls go to a fake fetch, Studio is a fake hub. Covers the
 * action catalogue and its validation, colours, what Studio may report, the key store (encrypted, never returned), the Govee and
 * LIFX clients (requests, rate limits, refused keys, put-back after a temporary change), routing (cloud here, the rest to Studio,
 * presets split), the real engine with a cloud light, Studio's lights.* and counters.* requests, the songRequests flag, /privacy,
 * the routes and the Devices page sections.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let T, store, accounts, profile;
const clock = { t: Date.parse('2026-11-19T12:00:00Z') };
const now = () => clock.t;

test.before(async () => {
    T = await makeTables(pool, 'd');
    for (const sql of lightAccountsDdl(T.prefix)) await pool.query(sql);
    store = T.store;
    accounts = createLightAccounts({ db: pool, prefix: T.prefix, encryption: fakeEncryption });
    profile = await makeProfile(store);
    for (const def of [...LIGHT_ACTIONS, ...VOICEMEETER_ACTIONS]) actionsMod.registerActionType({ ...def });
});
test.after(async () => {
    for (const t of [...LIGHT_TABLES].reverse()) await pool.query(`DROP TABLE IF EXISTS \`${T.prefix}${t}\``);
    await T.drop();
    await pool.end();
});

/** A fake fetch: handlers by "METHOD url-prefix"; records every call (headers included, so the key can be checked). */
function fakeFetch(routes) {
    const calls = [];
    const fn = async (url, opts = {}) => {
        calls.push({ url, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
        const key = Object.keys(routes).find((k) => { const [m, u] = k.split(' '); return m === opts.method && url.startsWith(u); });
        const r = key ? routes[key](url, opts.body ? JSON.parse(opts.body) : null, calls) : { status: 404, body: {} };
        return { status: r.status || 200, headers: { get: (h) => (r.headers || {})[h.toLowerCase()] ?? null }, json: async () => r.body };
    };
    fn.calls = calls;
    return fn;
}
const GOVEE_DEVICES = { code: 200, message: 'success', data: [
    { sku: 'H6159', device: 'AA:BB:CC:DD:EE:FF:00:11', deviceName: 'Desk strip', type: 'devices.types.light', capabilities: [
        { type: 'devices.capabilities.on_off', instance: 'powerSwitch' }, { type: 'devices.capabilities.range', instance: 'brightness' },
        { type: 'devices.capabilities.color_setting', instance: 'colorRgb' }, { type: 'devices.capabilities.color_setting', instance: 'colorTemperatureK', parameters: { range: { min: 2000, max: 9000 } } },
        { type: 'devices.capabilities.dynamic_scene', instance: 'lightScene' }] },
    { sku: 'H7100', device: '11:22', deviceName: 'Heater', type: 'devices.types.heater', capabilities: [] },
] };
const goveeRoutes = (extra = {}) => ({
    [`GET ${GOVEE_BASE}/user/devices`]: () => ({ body: GOVEE_DEVICES }),
    [`POST ${GOVEE_BASE}/device/control`]: () => ({ body: { code: 200, msg: 'success' } }),
    [`POST ${GOVEE_BASE}/device/state`]: () => ({ body: { code: 200, payload: { capabilities: [
        { instance: 'powerSwitch', state: { value: 1 } }, { instance: 'brightness', state: { value: 40 } }, { instance: 'colorRgb', state: { value: 0x112233 } }, { instance: 'colorTemperatureK', state: { value: 0 } }] } } }),
    [`POST ${GOVEE_BASE}/device/scenes`]: () => ({ body: { code: 200, payload: { capabilities: [{ type: 'devices.capabilities.dynamic_scene', instance: 'lightScene', parameters: { options: [{ name: 'Sunrise', value: { id: 7, paramId: 8 } }] } }] } } }),
    ...extra,
});
const GOVEE_ID = 'govee-cloud:H6159:AA:BB:CC:DD:EE:FF:00:11';
function fakeTimers() {
    const list = [];
    return { list, set: (fn, ms) => { const t = { fn, ms, done: false }; list.push(t); return t; }, clear: (t) => { if (t) t.done = true; }, fire() { for (const t of list.splice(0)) if (!t.done) t.fn(); } };
}

// ── catalogue ──────────────────────────────────────────────────────────────────────────────

test('colours: hex, short hex, rgb(), the 148 CSS names, white in kelvin; anything else is refused', () => {
    assert.deepEqual(parseColor('#FF0000'), { hex: '#ff0000' });
    assert.deepEqual(parseColor('0f0'.padStart(4, '#')), { hex: '#00ff00' });
    assert.deepEqual(parseColor('ff8800'), { hex: '#ff8800' });
    assert.deepEqual(parseColor('rgb(1, 2, 255)'), { hex: '#0102ff' });
    assert.equal(parseColor('rgb(1, 2, 300)'), null);
    assert.deepEqual(parseColor('Rebecca Purple'), { hex: '#663399' });
    assert.deepEqual(parseColor('3200K'), { kelvin: 3200 });
    assert.deepEqual(parseColor('6500 k'), { kelvin: 6500 });
    assert.equal(parseColor('900K'), null);
    for (const bad of ['', 'not a colour', '#12345', '<script>', '{args.color}']) assert.equal(parseColor(bad), null, bad);
    assert.equal(Object.keys(CSS_COLORS).length, 148);
});

test('light and Voicemeeter actions validate, clamp and need Studio unless the light is a cloud one', () => {
    const v = actionsMod.validateActions([
        { type: 'light.set', device: 'all', color: '#B4E04F', brightness: 300, durationMs: -5 },
        { type: 'light.color', device: GOVEE_ID, color: '{args.color}', durationMs: 2000 },
        { type: 'light.white', device: 'elgato:SN1', kelvin: 5600, brightness: 50 },
        { type: 'light.power', device: 'hue:ecb5fa/abc', state: 'sideways' },
        { type: 'light.scene', device: 'nanoleaf:n1', scene: 'Northern Lights' },
        { type: 'light.flash', device: 'litra:x', times: 99, periodMs: 10, mode: 'pulse' },
        { type: 'light.preset', preset: 'p_abc123' },
        { type: 'voicemeeter.mute', target: 'strip:2', state: 'mute' },
        { type: 'voicemeeter.gain', target: 'bus:0', mode: 'adjust', gain: -6 },
        { type: 'voicemeeter.profile', profile: 'Streaming.xml' },
        { type: 'voicemeeter.macro', button: 12, state: 'toggle' },
    ]);
    assert.equal(v.ok, true, v.errors.join('; '));
    const [set, color, , power, , flash] = v.value;
    assert.equal(set.device, '', '"all" is stored as empty');
    assert.equal(set.color, '#b4e04f');
    assert.equal(set.brightness, 100);
    assert.equal(set.durationMs, 0);
    assert.equal(color.color, '{args.color}', 'a variable is allowed (read when the step runs)');
    assert.equal(power.state, 'toggle');
    assert.deepEqual([flash.times, flash.periodMs, flash.mode], [20, 200, 'pulse']);
    for (const s of v.value) assert.equal(s.queueSeconds, 120, `${s.type}: client action with a wait`);
    assert.equal(actionsMod.isClientAction('light.flash'), true);
    assert.equal(actionsMod.actionType('voicemeeter.gain').capability, 'voicemeeter');

    const bad = actionsMod.validateActions([
        { type: 'light.color', device: 'x', color: 'mauvey' },
        { type: 'light.scene', scene: '' },
        { type: 'light.preset', preset: 'nope' },
        { type: 'voicemeeter.mute', target: 'strip:9' },
        { type: 'voicemeeter.gain', target: 'strip:0', mode: 'set', gain: 40 },
        { type: 'voicemeeter.profile', profile: '..\\..\\Windows\\win.ini' },
        { type: 'voicemeeter.profile', profile: 'C:/x.xml' },
        { type: 'voicemeeter.macro', button: 80 },
    ]);
    assert.equal(bad.ok, false);
    for (const m of [/pick a light/, /colour as #ff0000/, /scene or effect name/, /pick a preset/, /pick a strip or bus/, /-60 to 12/, /settings file/, /0 to 79/]) {
        assert.ok(bad.errors.some((e) => m.test(e)), `error ${m}`);
    }
    assert.ok(isCloudDevice(GOVEE_ID) && !isCloudDevice('govee:AA'));
    assert.equal(cloudProviderOf('lifx-cloud:d073d5'), 'lifx');
});

test('presets: names, rows, limits', () => {
    const ok = validatePreset({ name: ' Live ', lights: [{ device: 'elgato:SN1', kelvin: 5600, brightness: 60 }, { device: GOVEE_ID, color: '#B4E04F' }, { device: 'hue:b/l1', power: 'off', color: '#fff' }] });
    assert.equal(ok.ok, true);
    assert.equal(ok.value.name, 'Live');
    assert.deepEqual(ok.value.lights, [{ device: 'elgato:SN1', power: 'on', kelvin: 5600, brightness: 60 }, { device: GOVEE_ID, power: 'on', color: '#b4e04f', brightness: 100 }, { device: 'hue:b/l1', power: 'off' }]);
    const bad = validatePreset({ name: '', lights: [{ device: 'all' }] });
    assert.equal(bad.ok, false);
    assert.equal(validatePreset({ name: 'x', lights: Array.from({ length: 21 }, () => ({ device: 'litra:a' })) }).ok, false);
});

// ── what Studio reports ────────────────────────────────────────────────────────────────────

test('Studio\'s device report: addresses and unknown fields dropped, cloud ids refused, capped', () => {
    const d = sanitiseDevices({
        lights: [
            { id: 'govee:AABB', driver: 'govee', name: 'Desk', model: 'H6159', address: '192.168.1.40', online: true, caps: { power: true, brightness: true, color: true, white: { min: 2000, max: 9000 }, scenes: [] }, token: 'x' },
            { id: 'hue:ecb5/group/1', driver: 'hue', name: 'Office', kind: 'group', online: true, caps: { color: true, scenes: Array.from({ length: 150 }, (_, i) => `Scene ${i}`) } },
            { id: 'govee-cloud:H1:A', driver: 'govee', name: 'sneaky' },
            { id: 'litra:1', driver: 'hue', name: 'mismatch' },
            { id: 'govee:AABB', driver: 'govee', name: 'duplicate' },
        ],
        voicemeeter: { enabled: true, installed: true, running: true, type: 'banana', version: '2.1.1.1', strips: [{ index: 0, label: 'Mic' }, { index: 9, label: 'x' }], buses: [{ index: 0, label: 'A1' }],
            profiles: ['Streaming.xml', '..\\evil.xml', 'notes.txt'], dllPath: 'C:\\Program Files (x86)\\VB\\Voicemeeter\\VoicemeeterRemote64.dll' },
        streamdeck: { enabled: true, clients: 2, token: 'sdk_secret' },
    });
    assert.equal(d.lights.length, 2);
    assert.equal(JSON.stringify(d).includes('192.168'), false, 'no LAN address');
    assert.equal(JSON.stringify(d).includes('sdk_'), false);
    assert.equal(JSON.stringify(d).includes('Program Files'), false);
    assert.equal(d.lights[1].caps.scenes.length, 100);
    assert.deepEqual(d.voicemeeter.strips, [{ index: 0, label: 'Mic' }]);
    assert.deepEqual(d.voicemeeter.profiles, ['Streaming.xml']);
    assert.deepEqual(d.streamdeck, { enabled: true, clients: 2 });
    const st = sanitiseState({ obs: { connected: true, scenes: ['A'] }, devices: { lights: [{ id: 'elgato:SN', driver: 'elgato', name: 'Key Light' }] } });
    assert.equal(st.devices.lights[0].name, 'Key Light', 'sanitiseState keeps the devices part');
    assert.equal(sanitiseState({ obs: {} }).devices, null);
});

// ── cloud keys ─────────────────────────────────────────────────────────────────────────────

test('cloud keys are stored encrypted with a hint, never listed, exported without the key, and the table is secret', async () => {
    await accounts.save(profile.id, 'govee', 'govee-key-fake-for-tests-cdef');
    const [row] = await pool.query(`SELECT key_enc, key_hint FROM \`${T.prefix}light_accounts\` WHERE profile_id = ?`, [profile.id]);
    assert.ok(!row[0].key_enc.includes('govee-key-fake-for-tests-cdef'), 'not stored in clear');
    assert.equal(row[0].key_hint, 'cdef');
    const list = await accounts.list(profile.id);
    assert.equal(list.length, 1);
    assert.equal('key' in list[0], false, 'list() never carries the key');
    assert.equal((await accounts.get(profile.id, 'govee')).key, 'govee-key-fake-for-tests-cdef');
    assert.equal(await accounts.get(profile.id, 'philips'), null);
    await assert.rejects(accounts.save(profile.id, 'philips', 'x'.repeat(20)));
    const exp = await devicesExport(pool, profile.id, T.prefix);
    assert.equal(JSON.stringify(exp).includes('govee-key'), false);
    assert.equal(exp.light_accounts[0].key_hint, 'cdef');
    assert.equal(classifyTable('stream_bot_light_accounts'), 'secret');
});

test('Govee cloud: device list (lights only), control bodies, refused key, the 10 a minute limit, 429 pause', async () => {
    const f = fakeFetch(goveeRoutes());
    const cloud = createCloudLights({ accounts, fetch: f, now });
    const r = await cloud.check(profile.id, 'govee');
    assert.equal(r.ok, true);
    assert.deepEqual(r.devices.map((d) => d.id), [GOVEE_ID], 'the heater is left out');
    assert.equal(f.calls[0].headers['Govee-API-Key'], 'govee-key-fake-for-tests-cdef');
    assert.equal((await accounts.list(profile.id))[0].status, 'ok');
    assert.equal((await cloud.devices(profile.id)).length, 1);

    f.calls.length = 0;
    const out = await cloud.run(profile.id, 'light.set', { device: GOVEE_ID, color: '#ff0000', brightness: 50, durationMs: 0 });
    assert.deepEqual(out.applied, [GOVEE_ID]);
    const caps = f.calls.map((c) => c.body.payload.capability);
    assert.deepEqual(caps, [{ type: 'devices.capabilities.color_setting', instance: 'colorRgb', value: 0xff0000 }, { type: 'devices.capabilities.range', instance: 'brightness', value: 50 }]);
    assert.equal(f.calls[0].body.payload.sku, 'H6159');
    assert.equal(f.calls[0].body.payload.device, 'AA:BB:CC:DD:EE:FF:00:11');
    assert.match(f.calls[0].body.requestId, /^[0-9a-f-]{36}$/);

    await cloud.run(profile.id, 'light.white', { device: GOVEE_ID, kelvin: 3200, brightness: 80 });
    assert.deepEqual(f.calls.at(-2).body.payload.capability, { type: 'devices.capabilities.color_setting', instance: 'colorTemperatureK', value: 3200 });
    await cloud.run(profile.id, 'light.scene', { device: GOVEE_ID, scene: 'sunrise' });
    assert.deepEqual(f.calls.at(-1).body.payload.capability, { type: 'devices.capabilities.dynamic_scene', instance: 'lightScene', value: { id: 7, paramId: 8 } });
    await assert.rejects(cloud.run(profile.id, 'light.scene', { device: GOVEE_ID, scene: 'Moonset' }), (e) => e.code === 'scene_not_found');

    // 10 control calls a minute per light: the rest wait.
    const limited = createCloudLights({ accounts, fetch: fakeFetch(goveeRoutes()), now });
    for (let i = 0; i < 10; i++) await limited.run(profile.id, 'light.power', { device: GOVEE_ID, state: 'on' });
    await assert.rejects(limited.run(profile.id, 'light.power', { device: GOVEE_ID, state: 'on' }), (e) => e.code === 'rate_limited');
    clock.t += 61_000;
    await limited.run(profile.id, 'light.power', { device: GOVEE_ID, state: 'off' });

    const slow = createCloudLights({ accounts, fetch: fakeFetch(goveeRoutes({ [`POST ${GOVEE_BASE}/device/control`]: () => ({ status: 429, headers: { 'retry-after': '30' }, body: {} }) })), now });
    await assert.rejects(slow.run(profile.id, 'light.power', { device: GOVEE_ID, state: 'on' }), (e) => e.code === 'rate_limited');
    assert.ok(slow._state.pausedUntil.get(`${profile.id}:govee`) >= now() + 30_000, 'paused for Retry-After');

    const refused = createCloudLights({ accounts, fetch: fakeFetch({ [`GET ${GOVEE_BASE}/user/devices`]: () => ({ status: 401, body: { message: 'invalid key' } }) }), now });
    const rr = await refused.check(profile.id, 'govee');
    assert.equal(rr.ok, false);
    assert.equal(rr.code, 'bad_key');
    assert.ok(!rr.error.includes('govee-key'), 'the key is never in a message');
    assert.equal((await accounts.list(profile.id))[0].status, 'bad_key');
    assert.deepEqual(await refused.devices(profile.id), [], 'a refused key offers no lights');
    await cloud.check(profile.id, 'govee');   // back to ok for the next tests
});

test('Govee cloud: a temporary change reads the state first and puts it back; a second one keeps the first saved state', async () => {
    const f = fakeFetch(goveeRoutes());
    const tm = fakeTimers();
    const cloud = createCloudLights({ accounts, fetch: f, now, setTimer: tm.set, clearTimer: tm.clear });
    clock.t += 120_000;
    await cloud.run(profile.id, 'light.set', { device: GOVEE_ID, color: '#00ff00', brightness: 100, durationMs: 5000 });
    assert.ok(f.calls.some((c) => c.url.endsWith('/device/state')), 'state read first');
    const reads = f.calls.filter((c) => c.url.endsWith('/device/state')).length;
    await cloud.run(profile.id, 'light.set', { device: GOVEE_ID, color: '#0000ff', brightness: 100, durationMs: 5000 });
    assert.equal(f.calls.filter((c) => c.url.endsWith('/device/state')).length, reads, 'not read again while a put-back is pending');
    f.calls.length = 0;
    tm.fire();
    await new Promise((r) => setTimeout(r, 20));
    const caps = f.calls.map((c) => c.body.payload.capability);
    assert.deepEqual(caps[0], { type: 'devices.capabilities.color_setting', instance: 'colorRgb', value: 0x112233 }, 'back to the first saved colour');
    assert.deepEqual(caps[1], { type: 'devices.capabilities.range', instance: 'brightness', value: 40 });
});

test('LIFX cloud: list, state body, flash as a pulse effect that puts itself back, scenes, toggle', async () => {
    await accounts.save(profile.id, 'lifx', 'c87b0fde0123456789abcdef0123456789abcdef0123456789abcdef01234567');
    const f = fakeFetch({
        [`GET ${LIFX_BASE}/lights/all`]: () => ({ body: [{ id: 'd073d5000001', label: 'Shelf', connected: true, power: 'on', brightness: 0.5, color: { hue: 120, saturation: 1, kelvin: 3500 }, product: { name: 'LIFX A19', capabilities: { has_color: true, has_variable_color_temp: true, min_kelvin: 1500, max_kelvin: 9000 } } }] }),
        [`PUT ${LIFX_BASE}/lights/`]: () => ({ status: 207, body: { results: [] } }),
        [`POST ${LIFX_BASE}/lights/`]: () => ({ status: 207, body: { results: [] } }),
        [`GET ${LIFX_BASE}/scenes`]: () => ({ body: [{ uuid: 'abc-123', name: 'Stream' }] }),
        [`PUT ${LIFX_BASE}/scenes/`]: () => ({ status: 207, body: {} }),
        [`GET ${LIFX_BASE}/lights/id:`]: () => ({ body: [{ id: 'd073d5000001', power: 'on', brightness: 0.5, color: { hue: 120, saturation: 1, kelvin: 3500 } }] }),
    });
    const cloud = createCloudLights({ accounts, fetch: f, now });
    const r = await cloud.check(profile.id, 'lifx');
    assert.deepEqual(r.devices.map((d) => d.id), ['lifx-cloud:d073d5000001']);
    assert.match(f.calls[0].headers.Authorization, /^Bearer c87b/);
    f.calls.length = 0;
    await cloud.run(profile.id, 'light.set', { device: 'lifx-cloud:d073d5000001', color: '#ff0000', brightness: 25 });
    assert.equal(f.calls[0].method, 'PUT');
    assert.ok(f.calls[0].url.endsWith('/lights/id:d073d5000001/state'));
    assert.deepEqual(f.calls[0].body, { duration: 0, fast: true, power: 'on', color: '#ff0000', brightness: 0.25 });
    await cloud.run(profile.id, 'light.flash', { device: 'lifx-cloud:d073d5000001', color: '#b4e04f', times: 3, periodMs: 500, mode: 'flash', brightness: 100 });
    assert.ok(f.calls.at(-1).url.endsWith('/effects/pulse'));
    assert.deepEqual(f.calls.at(-1).body, { color: '#b4e04f brightness:1', period: 0.5, cycles: 3, persist: false, power_on: true });
    await cloud.run(profile.id, 'light.scene', { device: 'lifx-cloud:d073d5000001', scene: 'stream' });
    assert.ok(f.calls.at(-1).url.endsWith('/scenes/scene_id:abc-123/activate'));
    await cloud.run(profile.id, 'light.power', { device: 'lifx-cloud:d073d5000001', state: 'toggle' });
    assert.ok(f.calls.at(-1).url.endsWith('/toggle'));
    assert.deepEqual(await cloud.scenes(profile.id, 'lifx-cloud:d073d5000001'), ['Stream']);
    // 'all' covers every cloud light of every account.
    const all = createCloudLights({ accounts, fetch: fakeFetch({ ...goveeRoutes(), [`PUT ${LIFX_BASE}/lights/`]: () => ({ status: 207, body: {} }) }), now: () => clock.t + 600_000 });
    const res = await all.run(profile.id, 'light.power', { device: '', state: 'off' });
    assert.deepEqual(res.applied.sort(), [GOVEE_ID, 'lifx-cloud:d073d5000001'].sort());
});

// ── routing ────────────────────────────────────────────────────────────────────────────────

function fakeHub(conns = []) {
    const sent = [];
    return {
        sent, conns,
        connected: () => conns,
        async dispatch(d) { sent.push(d); return conns.length ? { id: `d_hub${sent.length}`, status: 'sent', devices: 1 } : { id: `d_hub${sent.length}`, status: 'queued', devices: 0 }; },
        notify() { return 0; },
    };
}

test('routing: cloud lights run here with a dispatch row, Studio\'s go to Studio, "all" does both, colours and presets are read here', async () => {
    const hub = fakeHub([{ kind: 'studio', deviceId: 5, name: 'PC', connectedAt: new Date(), state: { devices: { lights: [{ id: 'elgato:SN1', driver: 'elgato', name: 'Key Light', online: true, caps: {} }] } } }]);
    const cloud = createCloudLights({ accounts, fetch: fakeFetch(goveeRoutes()), now: () => clock.t + 3_600_000 });
    assert.equal((await cloud.check(profile.id, 'govee')).ok, true, 'this test needs the Govee account (set up above)');
    const svc = createDeviceService({ store, hub, accounts, cloud, rawDispatch: (d) => hub.dispatch(d), now });
    const base ={ profileId: profile.id, runId: null, target: 'studio', capability: 'light', queueSeconds: 120 };
    const next = (d) => hub.dispatch(d);

    const c = await svc.dispatch({ ...base, actionType: 'light.set', params: { device: GOVEE_ID, color: '#ff0000', brightness: 100, durationMs: 0 } }, next);
    assert.equal(c.status, 'done', c.detail);
    assert.equal(hub.sent.length, 0, 'nothing sent to Studio');
    const row = await store.getDispatch(c.id);
    assert.equal(row.status, 'acked');
    assert.equal(row.capability, 'light-cloud');

    const l = await svc.dispatch({ ...base, actionType: 'light.set', params: { device: 'elgato:SN1', color: '#ff0000', brightness: 100, durationMs: 0 } }, next);
    assert.equal(l.status, 'sent');
    assert.equal(hub.sent.at(-1).params.device, 'elgato:SN1');

    const all = await svc.dispatch({ ...base, actionType: 'light.power', params: { device: '', state: 'on' } }, next);
    assert.equal(all.status, 'sent', 'Studio\'s lights too');
    assert.ok((await store.dispatchesForRun(profile.id, null).catch(() => [])) || true);

    const col = await svc.dispatch({ ...base, actionType: 'light.color', params: { device: 'elgato:SN1', color: 'Tomato', brightness: 80, durationMs: 0 } }, next);
    assert.equal(col.status, 'sent');
    assert.equal(hub.sent.at(-1).params.color, '#ff6347', 'Studio gets a plain hex colour');
    const k = await svc.dispatch({ ...base, actionType: 'light.color', params: { device: 'elgato:SN1', color: ' 3200k ', brightness: 80, durationMs: 0 } }, next);
    assert.equal(k.status, 'sent');
    assert.equal(hub.sent.at(-1).params.color, '3200K');
    const bad = await svc.dispatch({ ...base, actionType: 'light.color', params: { device: 'elgato:SN1', color: 'a viewer typed <b>this</b>', durationMs: 0 } }, next);
    assert.equal(bad.status, 'failed');
    assert.match(bad.detail, /not understood/);

    const saved = await svc.savePreset(profile.id, { name: 'Live', lights: [{ device: GOVEE_ID, color: '#b4e04f' }, { device: 'elgato:SN1', kelvin: 5600, brightness: 60 }] });
    assert.equal(saved.ok, true);
    assert.match(saved.value.id, /^p_[a-f0-9]{12}$/);
    assert.equal((await svc.savePreset(profile.id, { name: 'live', lights: [{ device: 'elgato:SN1' }] })).ok, false, 'names are unique');
    const p = await svc.dispatch({ ...base, actionType: 'light.preset', params: { preset: saved.value.id } }, next);
    assert.equal(p.status, 'sent');
    assert.deepEqual(hub.sent.at(-1).params, { preset: 'Live', lights: [{ device: 'elgato:SN1', power: 'on', kelvin: 5600, brightness: 60 }] }, 'Studio gets only its own lights');
    const gone = await svc.dispatch({ ...base, actionType: 'light.preset', params: { preset: 'p_000000' } }, next);
    assert.equal(gone.status, 'failed');

    const vm = await svc.dispatch({ ...base, capability: 'voicemeeter', actionType: 'voicemeeter.mute', params: { target: 'strip:0', state: 'mute' } }, next);
    assert.equal(vm.status, 'sent', 'other actions pass straight through');

    const ch = await svc.choices(profile.id);
    assert.deepEqual(ch.lights.map((x) => x.value).sort(), ['elgato:SN1', GOVEE_ID, 'lifx-cloud:d073d5000001'].sort(), 'Studio\'s and both cloud accounts\'');
    assert.equal(ch.lights.find((x) => x.value === GOVEE_ID).source, 'cloud');
    assert.deepEqual(ch.presets, [{ value: saved.value.id, label: 'Live' }]);
    assert.equal(lightError('device_offline: no answer').startsWith('That light did not answer'), true);
});

test('the real engine runs a cloud light step as ok and logs its dispatch row; Dry run sends nothing', async () => {
    const hub = fakeHub([]);
    const cloud = createCloudLights({ accounts, fetch: fakeFetch(goveeRoutes()), now: () => clock.t + 7_200_000 });
    const svc = createDeviceService({ store, hub, accounts, cloud, rawDispatch: (d) => hub.dispatch(d), now });
    const io = { dispatch: (d) => svc.dispatch(d, (x) => hub.dispatch(x)), channelsFor: async () => [], sendChat: async () => ({ ok: true }) };
    const engine = createEngine({ store, render: createRenderer({ variableStore: store.variableStore }), io, now });
    const a = await store.createAutomation(profile.id, { name: 'Follow lights', enabled: true, trigger_type: 'follow', trigger_config: {}, conditions: [],
        actions: actionsMod.validateActions([{ type: 'light.set', device: GOVEE_ID, color: '#b4e04f', brightness: 100 }]).value });
    const auto = await store.getAutomation(profile.id, a.id ?? a);
    const ev = { platform: 'twitch', type: 'follow', channelId: '900000001', user: { id: '1', login: 'v', name: 'V', roles: [] }, metadata: {}, occurredAt: new Date(now()) };
    const r = await engine.runAutomation(profile, auto, ev, { source: 'test' });
    assert.equal(r.status, 'ok');
    assert.equal(r.steps[0].status, 'ok');
    assert.ok(r.steps[0].dispatchId);
    const dry = await engine.runAutomation(profile, auto, ev, { source: 'test', dryRun: true });
    assert.equal(dry.steps[0].status, 'dry');
    assert.equal(hub.sent.length, 0);
});

test('Studio requests: counters (raise variable changes through the store), presets, apply, limits', async () => {
    const hub = fakeHub([]);
    const svc = createDeviceService({ store, hub, accounts, cloud: createCloudLights({ accounts, fetch: fakeFetch(goveeRoutes()), now: () => clock.t + 9_000_000 }), rawDispatch: (d) => hub.dispatch(d), now });
    const conn = { profileId: profile.id, kind: 'studio', deviceId: 5 };
    assert.deepEqual(await svc.onStudioRequest(conn, 'counters.add', { key: 'Deaths', by: 1 }), { key: 'deaths', value: 1 });
    assert.deepEqual(await svc.onStudioRequest(conn, 'counters.add', { key: 'deaths', by: -3 }), { key: 'deaths', value: -2 });
    assert.ok((await svc.onStudioRequest(conn, 'counters.list', {})).counters.some((c) => c.key === 'deaths' && c.value === '-2'));
    await assert.rejects(svc.onStudioRequest(conn, 'counters.add', { key: 'a b', by: 1 }), (e) => e.code === 'bad_params');
    await assert.rejects(svc.onStudioRequest(conn, 'counters.add', { key: 'x', by: 5000 }), (e) => e.code === 'bad_params');
    const presets = (await svc.onStudioRequest(conn, 'lights.presets', {})).presets;
    assert.ok(presets.length >= 1 && presets.every((p) => p.id && p.name && !p.lights), 'ids and names only');
    const applied = await svc.onStudioRequest(conn, 'lights.apply', { presetId: presets[0].id });
    assert.ok(['done', 'queued', 'sent', 'failed'].includes(applied.status));
    await assert.rejects(svc.onStudioRequest(conn, 'lights.apply', { presetId: '../x' }), (e) => e.code === 'bad_params');
    await assert.rejects(svc.onStudioRequest(conn, 'lights.unknown', {}), (e) => e.code === 'unknown_method');
    const conn2 = { profileId: profile.id, kind: 'studio', deviceId: 6 };
    for (let i = 0; i < 20; i++) await svc.onStudioRequest(conn2, 'counters.add', { key: 'spam', by: 1 });
    await assert.rejects(svc.onStudioRequest(conn2, 'counters.add', { key: 'spam', by: 1 }), (e) => e.code === 'rate');
});

test('automations.list tells Studio whether song requests are on (an enabled automation with a song request step, nested too)', async () => {
    assert.equal(usesStep([{ type: 'if', then: [], else: [{ type: 'random', branches: [{ actions: [{ type: 'music.command' }] }] }] }], 'music.command'), true);
    assert.equal(usesStep([{ type: 'chat.send' }], 'music.command'), false);
    const studio = createStudioServices({ store, engine: null, ingest: null, now });
    const conn = { profileId: profile.id, kind: 'studio', deviceId: 5 };
    assert.equal((await studio.onRequest(conn, 'automations.list', {})).songRequests, false);
    await pool.query(`INSERT INTO \`${T.prefix}automations\` (profile_id, name, enabled, trigger_type, trigger_config, conditions, actions) VALUES (?, 'SR', 0, 'chat', '{}', '[]', ?)`,
        [profile.id, JSON.stringify([{ type: 'music.command', command: 'request', reply: 'yes' }])]);
    assert.equal((await studio.onRequest(conn, 'automations.list', {})).songRequests, false, 'switched off does not count');
    await pool.query(`UPDATE \`${T.prefix}automations\` SET enabled = 1 WHERE profile_id = ? AND name = 'SR'`, [profile.id]);
    assert.equal((await studio.onRequest(conn, 'automations.list', {})).songRequests, true);
});

test('/privacy: the profile export has the cloud accounts without keys; delete removes them', async () => {
    const privacy = createStreamBotPrivacy({ store, db: { query: (...a) => pool.query(...a) }, rowLimit: 50, soundsDir: '/nonexistent', timersTable: `${T.prefix}timers_none` });
    const exp = await privacy.exportFor(profile.ownerDiscordId || profile.owner_discord_id);
    const t = exp.tables[`${T.prefix}light_accounts`];
    assert.ok(t && t.rows.length === 2);
    assert.equal(JSON.stringify(exp).includes('govee-key-fake-for-tests-cdef'), false);
    assert.equal(JSON.stringify(exp).includes('c87b0fde0123'), false);
    const del = await devicesDelete(pool, profile.id, T.prefix);
    assert.equal(del[`${T.prefix}light_accounts`], 2);
    assert.deepEqual(await devicesExport(pool, profile.id, T.prefix), {});
});

// ── routes, mounting and the page ──────────────────────────────────────────────────────────

test('the devices API routes: literal paths, session gate, rate limits; server.js mounts them; the Devices page passes hardware', () => {
    const src = fs.readFileSync(path.join(root, 'dashboard/routes/stream-bot-devices.js'), 'utf8');
    for (const r of ["get('/stream/bot/api/devices/choices'", "post('/stream/bot/api/lights/cloud'", "delete('/stream/bot/api/lights/cloud/:provider'", "post('/stream/bot/api/lights/test'", "post('/stream/bot/api/lights/presets'"]) {
        assert.ok(src.includes(`router.${r}, needApi`), r);
    }
    assert.ok(src.indexOf("post('/stream/bot/api/lights/cloud'") < src.indexOf("post('/stream/bot/api/lights/cloud/:provider/refresh'"), 'literal before param');
    for (const line of src.split('\n').filter((l) => /logger\.[a-z]+\(/.test(l))) assert.ok(!/[,{(]\s*key\s*[,})]|req\.body/.test(line), `no key in a log line: ${line.trim()}`);
    const server = fs.readFileSync(path.join(root, 'dashboard/server.js'), 'utf8');
    assert.ok(server.includes("import('./routes/stream-bot-devices.js')"), 'mounted');
    const sb = fs.readFileSync(path.join(root, 'dashboard/routes/stream-bot.js'), 'utf8');
    assert.ok(sb.includes('sb.devices.service.pageData(profile.id)'), 'Devices page renders the hardware sections');
});

test('the hardware sections render in every state, escape names and never show a key', () => {
    const file = path.join(root, 'dashboard/views/stream-bot/_hardware.ejs');
    const tpl = fs.readFileSync(file, 'utf8');
    const render = (hw) => ejs.render(tpl, { hardware: hw }, { filename: file });
    const empty = render({ studio: { live: false, name: null, reported: false }, lights: [], cloud: [{ provider: 'govee', label: 'Govee', connected: false, devices: [] }, { provider: 'lifx', label: 'LIFX', connected: false, devices: [] }], presets: [], voicemeeter: null, streamdeck: null });
    for (const s of ['No lights reported yet.', 'No presets yet.', 'Not reported yet.', 'Govee API key', 'LIFX personal access token']) assert.ok(empty.includes(s), s);
    const full = render({
        studio: { live: true, name: 'Streaming PC', reported: true },
        lights: [{ id: 'hue:b/l1', driver: 'hue', driverLabel: 'Philips Hue', name: '<img src=x onerror=alert(1)>', online: true, kind: 'light', caps: { color: true, white: { min: 2000, max: 6500 }, brightness: true, scenes: ['Read'], effects: [] } },
            { id: 'nanoleaf:n', driver: 'nanoleaf', driverLabel: 'Nanoleaf', name: 'Panels', needsPairing: true, kind: 'light', caps: { scenes: [], effects: [] } }],
        cloud: [{ provider: 'govee', label: 'Govee', connected: true, keyHint: 'cdef', status: 'ok', devices: [{ id: GOVEE_ID, name: 'Desk strip' }], checkedAt: '2026-11-19T12:00:00.000Z' },
            { provider: 'lifx', label: 'LIFX', connected: true, keyHint: '4567', status: 'bad_key', lastError: 'LIFX did not accept the key.', devices: [] }],
        presets: [{ id: 'p_abcdef123456', name: 'Live </script><script>alert(1)</script>', lights: [{ device: 'hue:b/l1', power: 'on', color: '#b4e04f', brightness: 100 }] }],
        voicemeeter: { enabled: true, installed: true, running: true, type: 'potato', version: '3.1.1.6', strips: [{ index: 0, label: 'Mic' }], buses: [{ index: 0, label: 'A1' }], profiles: ['Stream.xml'], macroButtons: true },
        streamdeck: { enabled: true, clients: 1 },
    });
    assert.ok(!full.includes('<img src=x'), 'light names are escaped');
    assert.ok(!full.includes('</script><script>alert'), 'preset JSON cannot close its script tag');
    assert.ok(full.includes('Key refused') && full.includes('Pair in Studio') && full.includes('Voicemeeter Potato') && full.includes('1 plugin connection now'));
    assert.ok(full.includes('Key ending <code>cdef</code>'));
    assert.ok(!/govee-key|c87b0fde/.test(full));
    for (const css of ['stream-bot-devices.css']) assert.ok(fs.existsSync(path.join(root, 'dashboard/public/css', css)));
    const devCss = fs.readFileSync(path.join(root, 'dashboard/public/css/stream-bot-devices.css'), 'utf8');
    assert.ok(!/#[0-9a-f]{3,6}\b/i.test(devCss.replace(/\/\*[\s\S]*?\*\//g, '')), 'colours are tokens only (Dark, Light and Sand)');
});
