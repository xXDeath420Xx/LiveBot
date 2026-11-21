import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import pool from '../utils/db.js';
import { makeTables, makeProfile } from './fixtures/stream-bot-tables.js';
import { HEART_RATE, TRIGGER_CONFIG, ruleKey, ruleOf, createRuleState, stepRule, cleanReading, parsePulsoid } from '../core/stream-bot/heart/rules.js';
import { createHeartService, HEART_LIMITS } from '../core/stream-bot/heart/service.js';
import { createPulsoidFeeds, PULSOID_URL } from '../core/stream-bot/heart/pulsoid.js';
import { attachHeart, heartCondition, describeHeart } from '../core/stream-bot/heart/index.js';
import { registerEventType, eventType } from '../core/stream-bot/events.js';
import { validateTrigger, triggerMatches, checkConditions, registerConditionType, loadConditionData } from '../core/stream-bot/conditions.js';
import { createRenderer, STREAM_VARS } from '../core/stream-bot/render.js';
import { OVERLAY_TYPES, overlayType, defaultConfig, validateConfig, withDefaults } from '../core/stream-bot/overlays/config.js';
import { sampleFrames } from '../core/stream-bot/overlays/widgets.js';
import { createOverlayService } from '../core/stream-bot/overlays/service.js';
import { overlayDemo } from '../scripts/site-shots/stream-bot-overlays-demo.mjs';

/*
 * Heart rate (Studio 0.2.14; core/stream-bot/heart): readings from the owner's watch through Studio, Pulsoid as the fallback.
 *   rules     above / below / crossing, held for N seconds, cooldown, re-arming, gaps; the trigger's settings and match
 *   service   Studio readings, Pulsoid kept aside until Studio is silent for 10 s and back again, this stream's figures,
 *             {heart.*}, rules → one unstored heart.rate event per rule, Studio's heart.rate request and its refusals
 *   pulsoid   a fake WebSocket: the token in a header (never the URL), v2 messages, a refused token stops, a drop reconnects
 *   overlay   the heartrate type, its settings, the live frames, Test frames, the OBS page, the route's CSRF exemption
 *   storage   the Pulsoid token encrypted, masked in the privacy export, never in a reading table
 * No Bluetooth device, watch, Pulsoid or OBS is used.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
registerEventType(HEART_RATE);
test.after(async () => { await pool.end().catch(() => {}); });

// ── rules ──────────────────────────────────────────────────────────────────────────────────

test('rules: above, held and cooled down, runs once per climb', () => {
    const cfg = { mode: 'above', bpm: 140, holdSec: 5, cooldownSec: 60 };
    const st = createRuleState();
    let t = 0;
    const feed = (bpm, dt = 1000) => { t += dt; return stepRule(st, cfg, bpm, t); };
    assert.equal(feed(130), null);
    assert.equal(feed(140), null, 'exactly on the line is not above');
    for (let i = 0; i < 5; i++) assert.equal(feed(145), null, `held ${i} s`);
    assert.deepEqual(feed(146), { direction: 'up' }, 'after 5 s above');
    for (let i = 0; i < 20; i++) assert.equal(feed(150), null, 'once per climb, not every reading');
    assert.equal(feed(120), null);
    for (let i = 0; i < 6; i++) assert.equal(feed(150), null, 'back above but inside the 60 s cooldown');
    t += 40_000;
    assert.equal(stepRule(st, cfg, 150, t), null, 'a 40 s gap starts the hold again');
    for (let i = 0; i < 4; i++) assert.equal(feed(150), null);
    assert.deepEqual(feed(150), { direction: 'up' }, 'the cooldown is over and it held 5 s');
    const zero = createRuleState();
    assert.deepEqual(stepRule(zero, { mode: 'above', bpm: 100, holdSec: 0, cooldownSec: 0 }, 101, 1), { direction: 'up' }, 'hold 0 runs at once');
});

test('rules: below, and crossing either way', () => {
    const below = createRuleState();
    const b = { mode: 'below', bpm: 60, holdSec: 2, cooldownSec: 0 };
    assert.equal(stepRule(below, b, 58, 0), null);
    assert.equal(stepRule(below, b, 58, 1000), null);
    assert.deepEqual(stepRule(below, b, 57, 2000), { direction: 'down' });

    const x = createRuleState();
    const c = { mode: 'crossing', bpm: 120, holdSec: 3, cooldownSec: 30 };
    let t = 0;
    const feed = (bpm) => { t += 1000; return stepRule(x, c, bpm, t); };
    for (let i = 0; i < 5; i++) assert.equal(feed(100), null, 'the first side is only recorded');
    assert.equal(feed(125), null);
    assert.equal(feed(119), null, 'a dip back resets the hold');
    assert.equal(feed(125), null); assert.equal(feed(126), null); assert.equal(feed(127), null);
    assert.deepEqual(feed(128), { direction: 'up' }, 'settled above for 3 s');
    for (let i = 0; i < 4; i++) feed(110);
    assert.equal(x.side, 'low', 'a crossing inside the cooldown moves the side');
    t += 30_000;
    for (let i = 0; i < 3; i++) feed(130);
    assert.deepEqual(feed(131), { direction: 'up' });
    for (let i = 0; i < 3; i++) feed(118);
    t += 30_000;
    assert.equal(stepRule(x, c, 118, t), null, 'the gap restarts the hold');
    t += 1000; stepRule(x, c, 118, t); t += 1000; stepRule(x, c, 118, t); t += 1000;
    assert.deepEqual(stepRule(x, c, 118, t), { direction: 'down' });
});

test('trigger: settings, validation, matching by rule, sample and feed line', () => {
    const def = eventType('heart.rate');
    assert.ok(def && def.platforms.includes('studio') && def.platforms.includes('bot'));
    assert.deepEqual(TRIGGER_CONFIG.map((f) => f.name), ['mode', 'bpm', 'holdSec', 'cooldownSec']);
    const ok = validateTrigger('heart.rate', { mode: 'crossing', bpm: '150', holdSec: '10', cooldownSec: '120' });
    assert.ok(ok.ok, ok.errors.join());
    assert.deepEqual([ok.value.mode, ok.value.bpm, ok.value.holdSec, ok.value.cooldownSec], ['crossing', 150, 10, 120]);
    assert.equal(validateTrigger('heart.rate', { mode: 'above', bpm: 300 }).ok, false, 'above 240 refused');
    assert.equal(validateTrigger('heart.rate', { mode: 'sideways' }).value.mode, 'above', 'an unknown mode falls back');
    assert.deepEqual(ruleOf({}), { mode: 'above', bpm: 120, holdSec: 5, cooldownSec: 60 });
    const a = { trigger_type: 'heart.rate', trigger_config: { mode: 'above', bpm: 140, holdSec: 5, cooldownSec: 60 } };
    const other = { trigger_type: 'heart.rate', trigger_config: { mode: 'above', bpm: 150, holdSec: 5, cooldownSec: 60 } };
    const ev = { type: 'heart.rate', platform: 'studio', metadata: { rule: ruleKey(a.trigger_config) } };
    assert.equal(triggerMatches(a, ev), true);
    assert.equal(triggerMatches(other, ev), false, 'only automations with those settings');
    assert.equal(triggerMatches(other, { ...ev, test: true }), true, 'the Test button');
    assert.match(describeHeart({ type: 'heart.rate', amount: 146, metadata: { mode: 'above', line: 140 } }), /went above 140 \(146 BPM\)/);
    assert.match(describeHeart({ type: 'heart.rate', amount: 110, metadata: { mode: 'crossing', line: 120, direction: 'down' } }), /crossed 120 going down/);
});

test('readings: Studio request clean-up and Pulsoid messages', () => {
    const now = Date.parse('2026-11-21T12:00:00Z');
    assert.deepEqual(cleanReading({ bpm: 88, at: now - 500, contact: true, rr: [680, 10, 690, 5000, 'x'], battery: 71 }, now), { bpm: 88, at: now - 500, contact: true, rr: [680, 690], battery: 71 });
    assert.equal(cleanReading({ bpm: 88.5 }, now), null);
    assert.equal(cleanReading({ bpm: 20 }, now), null);
    assert.equal(cleanReading({ bpm: 251 }, now), null);
    assert.equal(cleanReading({ bpm: 90, at: now - 3_600_000 }, now).at, now, 'a far-off clock is replaced');
    assert.equal(cleanReading(null), null);
    assert.deepEqual(parsePulsoid(JSON.stringify({ type: 'heart_rate', timestamp: '2026-11-21T11:59:59.500Z', heartRate: { bpm: 101 } }), now), { bpm: 101, at: now - 500 });
    assert.deepEqual(parsePulsoid(JSON.stringify({ measured_at: now - 100, data: { heart_rate: 77 } }), now), { bpm: 77, at: now - 100 }, 'v1');
    assert.deepEqual(parsePulsoid('123', now), { bpm: 123, at: now }, 'plain text mode');
    assert.equal(parsePulsoid(JSON.stringify({ type: 'battery_level', batteryLevel: { percent: 60 } }), now), null);
    assert.equal(parsePulsoid(JSON.stringify({ type: 'ingestion_pause', ingestionPause: {} }), now), null);
    assert.equal(parsePulsoid('not json', now), null);
});

// ── the service ────────────────────────────────────────────────────────────────────────────

function harness(automations = []) {
    const clock = { t: Date.parse('2026-11-21T20:00:00Z') };
    const events = [];
    const views = [];
    const store = { enabledAutomationsFor: async (pid, type) => (type === 'heart.rate' ? automations : []) };
    const ingest = { internal: async (pid, ev) => { events.push([pid, ev]); return 1; } };
    const svc = createHeartService({ store, ingest, now: () => clock.t, onView: (pid, v) => views.push([pid, v]) });
    return { clock, events, views, svc, at: (dt) => { clock.t += dt; return clock.t; } };
}
const settle = () => new Promise((r) => setImmediate(r));

test('service: Pulsoid waits while Studio is fresh, takes over after 10 s of silence, and hands back', async () => {
    const h = harness();
    assert.equal(h.svc.currentSource(2), null);
    assert.equal(h.svc.reading(2, 'studio', { bpm: 80 }), 'ok');
    h.at(1000);
    assert.equal(h.svc.reading(2, 'pulsoid', { bpm: 95 }), 'standby', 'Studio sent something within 10 s');
    assert.equal(h.svc.view(2).bpm, 80);
    assert.equal(h.svc.currentSource(2), 'studio');
    h.at(8500);
    assert.equal(h.svc.reading(2, 'pulsoid', { bpm: 96 }), 'standby', '9.5 s still counts as fresh');
    h.at(600);
    assert.equal(h.svc.reading(2, 'pulsoid', { bpm: 97 }), 'ok', 'over 10 s: Pulsoid is used');
    assert.deepEqual([h.svc.view(2).bpm, h.svc.view(2).source, h.svc.currentSource(2)], [97, 'pulsoid', 'pulsoid']);
    h.at(1000);
    assert.equal(h.svc.reading(2, 'studio', { bpm: 82 }), 'ok');
    assert.deepEqual([h.svc.view(2).bpm, h.svc.view(2).source], [82, 'studio'], 'the watch is back: Studio again at once');
    h.at(1000);
    assert.equal(h.svc.reading(2, 'pulsoid', { bpm: 99 }), 'standby');
    assert.equal(h.svc.reading(2, 'bluetooth', { bpm: 99 }), 'bad');
    assert.equal(h.svc.reading(2, 'studio', { bpm: 'fast' }), 'bad');
    h.at(HEART_LIMITS.freshMs + 1);
    assert.equal(h.svc.currentSource(2), null, 'nothing fresh from either');
    assert.equal(h.svc.view(3).bpm, null, 'another profile has nothing');
});

test('service: this stream\'s figures, the graph, {heart.*}, the overlay feed and the reset on going live', async () => {
    const h = harness();
    for (const b of [90, 100, 110, 120]) { h.svc.reading(2, 'studio', { bpm: b, battery: 70 }); h.at(1000); }
    const v = h.svc.view(2);
    assert.deepEqual([v.bpm, v.min, v.max, v.avg, v.count, v.live, v.battery], [120, 90, 120, 105, 4, true, 70]);
    assert.deepEqual(v.history, [90, 100, 110, 120], 'one point a second');
    h.svc.reading(2, 'studio', { bpm: 121 });
    h.svc.reading(2, 'studio', { bpm: 122 });
    assert.equal(h.svc.view(2).history.length, 5, 'two readings in one second share a point');
    assert.deepEqual(h.svc.templateValues(2), { 'heart.bpm': '122', 'heart.max': '122', 'heart.min': '90', 'heart.avg': '111' });
    assert.ok(h.views.length >= 4 && h.views.every(([pid]) => pid === 2), 'the overlays are fed');
    assert.ok(h.views.length <= 5, 'at most about once a second');
    h.svc.resetStream(2);
    assert.deepEqual([h.svc.view(2).min, h.svc.view(2).max, h.svc.view(2).count], [122, 122, 1], 'live: the figures start again from now');
    h.at(16_000);
    assert.equal(h.svc.view(2).live, false);
    assert.equal(h.svc.templateValues(2)['heart.bpm'], '', 'no current number without a recent reading');
    assert.equal(h.svc.templateValues(2)['heart.max'], '122', 'the stream figures stay');
    h.at(HEART_LIMITS.statsResetMs);
    h.svc.reading(2, 'studio', { bpm: 70 });
    assert.deepEqual([h.svc.view(2).min, h.svc.view(2).max, h.svc.view(2).count], [70, 70, 1], '6 h later the figures start again by themselves');
    assert.deepEqual(h.svc.templateValues(9), { 'heart.bpm': '', 'heart.max': '', 'heart.min': '', 'heart.avg': '' });
});

test('service: rules raise one unstored heart.rate event per rule, with its settings', async () => {
    const cfg = { mode: 'above', bpm: 140, holdSec: 2, cooldownSec: 60 };
    const h = harness([
        { id: 1, trigger_config: cfg }, { id: 2, trigger_config: { ...cfg } },   // the same settings: one rule
        { id: 3, trigger_config: { mode: 'below', bpm: 60, holdSec: 0, cooldownSec: 0 } },
    ]);
    for (const b of [130, 145, 146, 147, 148]) { h.svc.reading(2, 'studio', { bpm: b }); await settle(); h.at(1000); }
    assert.equal(h.events.length, 1, 'one event for the two automations that share the rule');
    const [pid, ev] = h.events[0];
    assert.equal(pid, 2);
    assert.deepEqual([ev.type, ev.platform, ev.amount, ev.currency, ev.user], ['heart.rate', 'studio', 147, 'bpm', null]);
    assert.deepEqual(ev.metadata, { bpm: 147, line: 140, mode: 'above', direction: 'up', holdSec: 2, source: 'studio', rule: 'above:140:2:60' });
    h.at(11_000);
    h.svc.reading(2, 'pulsoid', { bpm: 55 });
    await settle();
    assert.equal(h.events.length, 2);
    assert.deepEqual([h.events[1][1].platform, h.events[1][1].metadata.source, h.events[1][1].metadata.direction], ['bot', 'pulsoid', 'down'], 'a Pulsoid reading runs as the bot');
});

test('service: Studio\'s heart.rate request: Studio only, cleaned, at most 90 a minute', async () => {
    const h = harness();
    const conn = { kind: 'studio', profileId: 2 };
    assert.deepEqual(await h.svc.onRequest(conn, 'heart.rate', { bpm: 77, at: h.clock.t }), { ok: true });
    assert.equal(h.svc.view(2).bpm, 77);
    await assert.rejects(h.svc.onRequest({ kind: 'overlay', profileId: 2 }, 'heart.rate', { bpm: 77 }), (e) => e.code === 'bad_params');
    await assert.rejects(h.svc.onRequest(conn, 'heart.rate', { bpm: 9000 }), (e) => e.code === 'bad_params');
    await assert.rejects(h.svc.onRequest(conn, 'heart.other', {}), (e) => e.code === 'unknown_method');
    for (let i = 0; i < 88; i++) await h.svc.onRequest(conn, 'heart.rate', { bpm: 80 });
    await assert.rejects(h.svc.onRequest(conn, 'heart.rate', { bpm: 80 }), (e) => e.code === 'rate');
    h.at(61_000);
    assert.deepEqual(await h.svc.onRequest(conn, 'heart.rate', { bpm: 81 }), { ok: true });
});

test('attachHeart: registers the trigger, condition and {heart.*}, keeps heart.rate out of the event log, and chains requests', async () => {
    const used = [];
    let published = 0;
    const box = {
        store: { enabledAutomationsFor: async () => [], heartPulsoidSources: async () => [], setHeartPulsoidStatus: async () => {} },
        ingest: { internal: async () => 1, allowInternal: (type, o) => used.push([type, o]) },
        feed: { publish: () => { published++; } },
        hub: { use: (h) => used.push(['hub', typeof h.onRequest]) },
        logger: null,
    };
    const prev = async (conn, method) => ({ passed: method });
    const heart = await attachHeart(box, { onRequest: prev });
    assert.deepEqual(used[0], ['heart.rate', { store: false }], 'heart rate is never written to the event log');
    assert.deepEqual(used[1], ['hub', 'function']);
    assert.deepEqual(await heart.onRequest({ kind: 'studio', profileId: 5 }, 'voice.phrases', {}), { passed: 'voice.phrases' }, 'other methods go on as before');
    assert.deepEqual(await heart.onRequest({ kind: 'studio', profileId: 5 }, 'heart.rate', { bpm: 101 }), { ok: true });
    await assert.rejects(heart.onRequest({ kind: 'studio', profileId: 5 }, 'heart.rate', { bpm: 1 }), (e) => e.code === 'bad_params' && !(e.constructor.name === 'HeartRequestError'));
    // {heart.bpm} in any text, rendered from memory
    const render = createRenderer({ variableStore: { get: async () => null } });
    assert.equal(await render('My heart: {heart.bpm} BPM (high {heart.max})', { ev: { type: 'chat', platform: 'twitch' }, profileId: 5 }), 'My heart: 101 BPM (high 101)');
    assert.ok(STREAM_VARS.some((v) => v.token === '{heart.bpm}') && STREAM_VARS.some((v) => v.token === '{heart.avg}'), 'listed in the editor');
    // going live starts the figures again
    heart.service.reading(5, 'studio', { bpm: 150 });
    box.feed.publish(5, { type: 'stream.online' });
    assert.equal(published, 1);
    assert.equal(heart.service.view(5).min, 150);
    // the condition, through the registered load
    const cond = heartCondition({ current: heart.service });
    const loaded = { heart: heart.service.view(5) };
    assert.equal(cond.check({ op: 'above', bpm: 140 }, {}, { loaded }).ok, true);
    assert.equal(cond.check({ op: 'below', bpm: 140 }, {}, { loaded }).ok, false);
    assert.equal(cond.check({ op: 'above', bpm: 140 }, {}, { loaded: {} }).ok, false, 'no reading: never passes');
    const checked = checkConditions([{ type: 'heart_rate', op: 'above', bpm: 120 }], { type: 'chat' }, { limiter: { check: () => ({ ok: true }) }, automationId: 1, loaded: await loadConditionData([{ type: 'heart_rate' }], {}, { profileId: 5 }) });
    assert.equal(checked.ok, true);
    assert.deepEqual(cond.validate({ op: 'sideways', bpm: '500' }, () => {}), { type: 'heart_rate', op: 'above', bpm: 240 });
    assert.equal(registerConditionType(cond), false, 'registered once');
    heart.stop();
});

// ── Pulsoid ────────────────────────────────────────────────────────────────────────────────

function fakeSockets() {
    const made = [];
    class FakeWs extends EventEmitter {
        constructor(url, opts) { super(); this.url = url; this.opts = opts; made.push(this); }
        close() { this.emit('close'); }
        terminate() { this.emit('close'); }
    }
    return { made, FakeWs };
}

test('pulsoid: token in the header, readings, a refused token stops, a drop reconnects', async () => {
    const { made, FakeWs } = fakeSockets();
    const readings = [];
    const statuses = [];
    const timers = [];
    let sources = [{ profileId: 2, token: '8c4da3ce-7ed7-4a19-a1f1-058498661e45' }, { profileId: 3, token: 'bad00000-0000-0000-0000-000000000000' }];
    const feeds = createPulsoidFeeds({
        listSources: async () => sources, onReading: (pid, r) => readings.push([pid, r.bpm]), setStatus: (pid, s) => statuses.push([pid, s]),
        WebSocket: FakeWs, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {}, refreshMs: 3_600_000,
    });
    await feeds.start();
    assert.equal(made.length, 2);
    assert.equal(made[0].url, PULSOID_URL);
    assert.equal(made[0].url.includes('access_token'), false, 'the token is never in the URL');
    assert.equal(made[0].opts.headers.Authorization, 'Bearer 8c4da3ce-7ed7-4a19-a1f1-058498661e45');
    made[0].emit('open');
    made[0].emit('message', Buffer.from(JSON.stringify({ type: 'heart_rate', timestamp: new Date().toISOString(), heartRate: { bpm: 88 } })));
    made[0].emit('message', Buffer.from('{"type":"battery_level","batteryLevel":{"percent":50}}'));
    assert.deepEqual(readings, [[2, 88]]);
    made[1].emit('unexpected-response', {}, { statusCode: 401 });
    await settle();
    assert.ok(statuses.some(([pid, s]) => pid === 3 && s === 'token_rejected'));
    assert.equal(timers.length, 0, 'a refused token is not retried');
    made[0].emit('close');
    await settle();
    assert.deepEqual(timers.map((x) => x.ms), [5000], 'a drop reconnects after 5 s');
    timers[0].fn();
    assert.equal(made.length, 3);
    made[2].emit('close');
    assert.deepEqual(timers.map((x) => x.ms), [5000, 10000], 'then 10 s');
    await settle();
    assert.ok(statuses.some(([pid, s]) => pid === 2 && s === 'ok') && statuses.some(([pid, s]) => pid === 2 && s === 'reconnecting'));
    sources = [];
    await feeds.refresh();
    assert.equal(feeds._conns.size, 0, 'a removed token closes its socket');
    feeds.stop();
});

// ── overlay ────────────────────────────────────────────────────────────────────────────────

test('overlay: the Heart rate type, its settings and their checks', () => {
    const t = overlayType('heartrate');
    assert.deepEqual([t.label, t.sourceName, t.audio], ['Heart rate', 'CertiFried Heart Rate', false]);
    assert.ok(OVERLAY_TYPES.some((x) => x.type === 'heartrate'));
    const d = defaultConfig('heartrate');
    assert.deepEqual([d.showHeart, d.showGraph, d.graphSec, d.zones, d.warmAt, d.hotAt, d.hideAfterSec, d.label], [true, true, 60, true, 120, 150, 15, 'BPM']);
    assert.equal(validateConfig('heartrate', { warmAt: 150, hotAt: 140 }).ok, false, 'red must be above amber');
    const v = validateConfig('heartrate', { graphSec: 999, hideAfterSec: -4, label: 'x'.repeat(50), accentColor: 'red', position: 'nowhere', warmAt: 110, hotAt: 160 });
    assert.ok(v.ok, v.errors.join());
    assert.deepEqual([v.value.graphSec, v.value.hideAfterSec, v.value.label.length, v.value.accentColor, v.value.position], [120, 0, 20, d.accentColor, d.position]);
    assert.equal(withDefaults('heartrate', { zones: false, warmAt: 150, hotAt: 140 }).hotAt, 151, 'kept above amber even with zones off');
    const [[name, data]] = sampleFrames('heartrate', d, Date.now());
    assert.equal(name, 'heart');
    assert.ok(data.test && data.heart.live && data.heart.history.length === 60);
});

test('overlay: pages get the reading when they open and every second after; other overlays do not', async () => {
    let view = { bpm: 99, at: new Date().toISOString(), live: true, source: 'studio', min: 80, max: 120, avg: 98, count: 10, battery: 50, history: [97, 98, 99] };
    const svc = createOverlayService({ store: {}, ostore: { touch: async () => {} }, timers: false, heartView: (pid) => (pid === 2 ? view : null) });
    const page = () => ({ sent: [], send(e, d) { this.sent.push([e, JSON.parse(JSON.stringify(d))]); return true; }, close() {} });
    const hr = page(); const chat = page(); const other = page();
    const cfg = withDefaults('heartrate', {});
    await svc.attach({ id: 41, profileId: 2, type: 'heartrate', config: cfg }, hr);
    await svc.attach({ id: 42, profileId: 2, type: 'viewers', config: withDefaults('viewers', {}) }, chat);
    await svc.attach({ id: 43, profileId: 3, type: 'heartrate', config: cfg }, other);
    assert.equal(hr.sent[0][0], 'hello');
    assert.equal(hr.sent[0][1].state.heart.bpm, 99);
    assert.equal(other.sent[0][1].state.heart.bpm, null, 'no reading for that profile');
    view = { ...view, bpm: 104 };
    assert.equal(svc.onHeart(2, view), 1);
    assert.deepEqual(hr.sent.at(-1), ['heart', { heart: view }]);
    assert.equal(chat.sent.filter((x) => x[0] === 'heart').length, 0);
    assert.equal(other.sent.filter((x) => x[0] === 'heart').length, 0);
    assert.equal((await svc.testWidget(2, 41)).sent, 1, 'the Test button');
    svc.close();
});

test('overlay route and pages: CSRF exemption, settings page, OBS page, editor fields, list summary, profile 2 script', async () => {
    const server = read('dashboard/server.js');
    assert.ok(server.includes("'/stream/bot/overlay/heartrate/',"));
    const D = await overlayDemo({ root });
    const frames = D.frames('heartrate');
    assert.equal(frames[0][0], 'hello');
    assert.equal(frames[1][0], 'heart');
    const edit = read('dashboard/views/stream-bot/overlay-edit.ejs');
    for (const k of ['showHeart', 'showGraph', 'graphSec', 'graphWidth', 'showStats', 'zones', 'warmAt', 'hotAt', 'warmColor', 'hotColor', 'hideAfterSec']) assert.ok(edit.includes(`data-cfg="${k}"`), k);
    assert.match(edit, /'viewers', 'heartrate', 'events', 'chat'\]\.includes\(t\)/, 'it has a Test button');
    const js = read('dashboard/public/js/stream-bot-overlay.js');
    assert.match(js, /heart: function \(d\) \{ if \(type === 'heartrate'\)/);
    assert.match(js, /animationDuration = \(60 \/ Math\.max\(30, Math\.min\(240, bpm\)\)\)/, 'the beat follows the BPM');
    assert.doesNotMatch(js, /innerHTML/);
    const { overlayView } = await import('../dashboard/routes/stream-bot-overlays.js');
    assert.equal(overlayView({ id: 1, type: 'heartrate', name: 'Heart rate', config: withDefaults('heartrate', { showStats: true }) }).summary,
        "The number, a beating heart, a 60-second graph and this stream's low, average and high");
    assert.match(read('scripts/stream-bot-add-widgets.mjs'), /\{ type: 'heartrate', name: 'Heart rate', config: \{\} \}/);
});

// ── storage, privacy, realtime ─────────────────────────────────────────────────────────────

test('storage: the Pulsoid token is encrypted, never shown, masked in the export; no reading table', async () => {
    const T = await makeTables(pool, 'h');
    try {
        const store = T.store;
        const profile = await makeProfile(store);
        assert.deepEqual(await store.heartPulsoidView(profile.id), { configured: false, status: null, lastError: null, addedAt: null });
        await store.setHeartPulsoid(profile.id, '8c4da3ce-7ed7-4a19-a1f1-058498661e45');
        const raw = JSON.stringify((await store.getProfile(profile.id)).settings);
        assert.ok(!raw.includes('8c4da3ce-7ed7-4a19-a1f1-058498661e45'), 'not stored in plain text');
        const v = await store.heartPulsoidView(profile.id);
        assert.deepEqual([v.configured, v.status, 'secret' in v], [true, 'new', false]);
        const src = (await store.heartPulsoidSources()).filter((r) => r.profileId === profile.id);
        assert.deepEqual(src, [{ profileId: profile.id, token: '8c4da3ce-7ed7-4a19-a1f1-058498661e45' }]);
        await store.setHeartPulsoidStatus(profile.id, 'token_rejected', 'Pulsoid refused the token.');
        assert.equal((await store.heartPulsoidView(profile.id)).status, 'token_rejected');
        assert.equal((await store.heartPulsoidSources()).filter((r) => r.profileId === profile.id).length, 1, 'the token is kept');
        const ex = await store.exportOwner(profile.ownerDiscordId);
        assert.equal(ex.profile.settings.heart.pulsoid.secret, '(saved, not exported)');
        assert.ok(!JSON.stringify(ex).includes('8c4da3ce'), 'the export has no token');
        await store.clearHeartPulsoid(profile.id);
        assert.equal((await store.heartPulsoidView(profile.id)).configured, false);
    } finally { await T.drop(); }
    for (const f of ['core/stream-bot/heart/service.js', 'core/stream-bot/heart/index.js', 'core/stream-bot/heart/rules.js']) {
        assert.doesNotMatch(read(f), /insertEvent|INSERT INTO|store\.set(?!HeartPulsoid)|setSettingsKey/, `${f}: no reading is written anywhere`);
    }
});

test('privacy and help: the Studio pages say what is sent and kept; Studio sends exactly those fields', () => {
    const priv = read('dashboard/views/studio-privacy.ejs');
    assert.match(priv, /Heart rate: beats per minute, the time of the reading, whether the sensor is touching your skin, the time between beats when the device sends it, and the device's battery level/);
    assert.match(priv, /in the server's memory only/);
    assert.match(priv, /Your Pulsoid token, only if you add one/);
    assert.match(priv, /two small Bluetooth helpers/);
    const how = read('dashboard/views/studio-how-it-works.ejs');
    assert.match(how, /install <strong>Heart for Bluetooth<\/strong>/);
    assert.match(how, /start broadcasting/);
    const studioMain = read('desktop/studio/src/main/main.js');
    const call = studioMain.match(/engine\.request\('heart\.rate', \{([^}]*)\}/);
    assert.ok(call, 'Studio sends heart.rate');
    assert.deepEqual(call[1].split(',').map((x) => x.split(':')[0].trim()).sort(), ['at', 'battery', 'bpm', 'contact', 'rr'], 'the fields the privacy page lists');
    const conn = read('dashboard/views/stream-bot/connections.ejs');
    assert.match(conn, /id="sb-pulsoid-token"/);
    assert.match(conn, /type="password" id="sb-pulsoid-token"/);
    const routes = read('dashboard/routes/stream-bot.js');
    assert.match(routes, /router\.post\('\/stream\/bot\/api\/heart\/pulsoid', needApi,/);
    assert.match(routes, /router\.delete\('\/stream\/bot\/api\/heart\/pulsoid', needApi,/);
    assert.match(read('core/stream-bot/realtime.js'), /rate = \{ count: 70, windowMs: 10_000 \}/, 'room for one reading a second');
    assert.match(read('docs/superpowers/specs/2026-11-19-stream-bot-design.md'), /Heart rate is health data \(Studio 0\.2\.14/);
});
