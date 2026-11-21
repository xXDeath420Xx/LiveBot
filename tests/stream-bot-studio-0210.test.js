import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTrigger } from '../core/stream-bot/conditions.js';
import { createStudioServices, sanitiseState, sanitiseVoiceLogEntry, VOICE_OUTCOMES } from '../core/stream-bot/studio.js';
import { createStudioJobs, versionAtLeast, studioVersion, ownerLiveCheck } from '../core/stream-bot/studio-jobs.js';
import { createDeviceService } from '../core/stream-bot/devices/service.js';
import { buildPlan } from '../core/stream-bot/switchover.js';

/*
 * Server side of CertiFried Studio 0.2.10 (2026-11-20), without a database (fake stores):
 *   voice trigger    its own confidence (percent or fraction) and wait before it runs again, validated
 *   voice.phrases    sends each command's confidence and cooldown (default 10 s) to Studio
 *   voice.log        Studio's summary entries cleaned, kept newest 200 per profile, replace / clear, rate limit, Studio only
 *   state            the new voice fields (thresholdSet, catchAll, voiceLog); a voice change alone is saved
 *   studio jobs      once, only with a capable and new enough Studio, never while the streamer is (maybe) live, three tries
 *   lights.cloud     Studio's Lights tab gets the cloud lights (no keys) and can test one; LAN ids refused
 *   switchover       never suggests Streamer.bot's 0.2
 *   pages            the editor fields, the voice log section and its API route exist
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tick = () => new Promise((r) => setImmediate(r));

test('voice trigger: own confidence (20 to 95, % or fraction) and cooldown (0 to 3600 s), both optional', () => {
    const ok = validateTrigger('voice.phrase', { phrases: ['BRB'], confidence: 85, cooldownSec: 30 });
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.value.confidence, 0.85);
    assert.equal(ok.value.cooldownSec, 30);
    assert.equal(validateTrigger('voice.phrase', { phrases: ['BRB'], confidence: 0.75 }).value.confidence, 0.75);
    const none = validateTrigger('voice.phrase', { phrases: ['BRB'], confidence: '', cooldownSec: null });
    assert.deepEqual(none.errors, []);
    assert.equal('confidence' in none.value, false, 'empty: Studio\'s own setting');
    assert.equal('cooldownSec' in none.value, false, 'empty: 10 s in Studio');
    assert.match(validateTrigger('voice.phrase', { phrases: ['BRB'], confidence: 10 }).errors.join(' '), /20% to 95%/);
    assert.match(validateTrigger('voice.phrase', { phrases: ['BRB'], confidence: 99 }).errors.join(' '), /20% to 95%/);
    assert.match(validateTrigger('voice.phrase', { phrases: ['BRB'], cooldownSec: 1.5 }).errors.join(' '), /whole number/);
    assert.match(validateTrigger('voice.phrase', { phrases: ['BRB'], cooldownSec: 4000 }).errors.join(' '), /0 to 3600/);
    assert.equal(validateTrigger('voice.phrase', { phrases: ['BRB'], cooldownSec: 0 }).value.cooldownSec, 0);
});

function fakeStore(automations = []) {
    const settings = new Map();
    return {
        settings,
        writes: [],
        async enabledAutomationsFor(pid, type) { return automations.filter((a) => a.enabled && a.trigger_type === type); },
        async getSettingsKey(pid, key) { return settings.get(`${pid}:${key}`) ?? null; },
        async setSettingsKey(pid, key, v) { this.writes.push([pid, key, v]); settings.set(`${pid}:${key}`, JSON.parse(JSON.stringify(v))); },
        async getProfile(id) { return { id, enabled: true, ownerDiscordId: 'owner-1' }; },
    };
}

test('voice.phrases: each command\'s confidence and cooldown (default 10 s) go to Studio', async () => {
    const store = fakeStore([
        { id: 1, name: 'BRB', enabled: true, trigger_type: 'voice.phrase', trigger_config: { phrases: ['BRB', 'be right back'], confidence: 0.85, cooldownSec: 30 } },
        { id: 2, name: 'Pokecheck', enabled: true, trigger_type: 'voice.phrase', trigger_config: { phrases: ['Pokecheck'] } },
        { id: 3, name: 'Off', enabled: false, trigger_type: 'voice.phrase', trigger_config: { phrases: ['off one'] } },
    ]);
    const s = createStudioServices({ store, engine: {}, ingest: {} });
    const r = await s.onRequest({ profileId: 7, kind: 'studio' }, 'voice.phrases', {});
    assert.deepEqual(r.phrases, [
        { text: 'BRB', automationId: 1, automationName: 'BRB', confidence: 0.85, cooldownSec: 30 },
        { text: 'be right back', automationId: 1, automationName: 'BRB', confidence: 0.85, cooldownSec: 30 },
        { text: 'Pokecheck', automationId: 2, automationName: 'Pokecheck', confidence: null, cooldownSec: 10 },
    ]);
});

test('voice.log: cleaned summaries, newest 200 per profile, replace and clear; only Studio; rate limited', async () => {
    let t = 1_800_000_000_000;
    const s = createStudioServices({ store: fakeStore(), engine: {}, ingest: {}, now: () => t });
    const conn = { profileId: 5, kind: 'studio' };
    const r = await s.onRequest(conn, 'voice.log', { entries: [
        { t: t - 1000, phrase: 'brb', confidence: 0.934567, threshold: 0.7, outcome: 'fired', automationId: 1, heard: 'should not stay' },
        { t: t - 900, phrase: 'secret words', confidence: 1, threshold: null, outcome: 'noise', heard: 'what a\u0000 lovely day' },
        { t: t - 800, phrase: 'x', confidence: 0.5, outcome: 'nonsense' },
        { t: t + 10 * 60_000, phrase: 'pokecheck', confidence: 0.6, threshold: 0.7, outcome: 'below', automationId: 'x' },
    ] });
    assert.equal(r.kept, 3, 'the unknown outcome is dropped');
    const log = s.voiceLog(5);
    // 0.2.13: Studio sends the words only when the streamer shares them, and then for every outcome, so they are kept on any line
    assert.deepEqual(log[2], { t: t - 1000, phrase: 'brb', confidence: 0.935, threshold: 0.7, outcome: 'fired', automationId: 1, heard: 'should not stay' }, 'words kept on any outcome (0.2.13)');
    assert.deepEqual(log[1], { t: t - 900, phrase: null, confidence: 1, threshold: null, outcome: 'noise', automationId: null, heard: 'what a lovely day' }, 'no phrase on noise; words cleaned');
    assert.equal(log[0].t, t, 'a time far in the future becomes now');
    assert.equal(log[0].automationId, null);
    assert.deepEqual(VOICE_OUTCOMES, ['fired', 'below', 'cooldown', 'noise', 'disabled']);

    const many = Array.from({ length: 250 }, (_, i) => ({ t: t - 250 + i, phrase: `p${i}`, confidence: 0.8, threshold: 0.7, outcome: 'fired' }));
    t += 20_000;
    await s.onRequest(conn, 'voice.log', { entries: many, replace: true });
    assert.equal(s.voiceLog(5).length, 200);
    assert.equal(s.voiceLog(5)[0].phrase, 'p249', 'newest first');
    await s.onRequest(conn, 'voice.log', { entries: [], replace: true });
    assert.equal(s.voiceLog(5).length, 0, 'Studio cleared its log');
    await s.onRequest(conn, 'voice.log', { entries: [many[0]] });
    s.clearVoiceLog(5);
    assert.deepEqual(s.voiceLog(5), []);
    assert.deepEqual(s.voiceLog(6), [], 'other profiles have their own list');

    await assert.rejects(() => s.onRequest({ profileId: 5, kind: 'overlay' }, 'voice.log', { entries: [] }), (e) => e.code === 'bad_params');
    const c2 = { profileId: 9, kind: 'studio' };
    for (let i = 0; i < 20; i++) await s.onRequest(c2, 'voice.log', { entries: [] });
    await assert.rejects(() => s.onRequest(c2, 'voice.log', { entries: [] }), (e) => e.code === 'rate');
    assert.equal(sanitiseVoiceLogEntry(null), null);
});

test('state: the 0.2.10 voice fields are kept; older Studios report without them; a voice change alone is saved', async () => {
    const v = sanitiseState({ obs: {}, voice: { enabled: true, state: 'listening', phrases: 3, threshold: 0.85, thresholdSet: true, catchAll: 'garbage', voiceLog: true } }).voice;
    assert.deepEqual(v, { enabled: true, state: 'listening', error: null, phrases: 3, threshold: 0.85, thresholdSet: true, catchAll: 'garbage', voiceLog: true });
    assert.deepEqual(sanitiseState({ obs: {}, voice: { enabled: true, state: 'listening', phrases: 3, threshold: 0.7 } }).voice, { enabled: true, state: 'listening', error: null, phrases: 3, threshold: 0.7 });
    assert.equal(sanitiseState({ obs: {}, voice: { catchAll: 'evil' } }).voice.catchAll, undefined);

    let t = 1_000_000;
    const store = fakeStore();
    const s = createStudioServices({ store, engine: {}, ingest: {}, now: () => t, limits: { stateWriteMs: 0 } });
    const conn = { profileId: 3, kind: 'studio', deviceId: 'd1' };
    s.onState(conn, { obs: {}, voice: { enabled: true, state: 'listening', threshold: 0.7 } });
    await tick();
    t += 1000;
    s.onState(conn, { obs: {}, voice: { enabled: true, state: 'listening', threshold: 0.85 } });
    await tick();
    const studioWrites = store.writes.filter((w) => w[1] === 'studio');
    assert.equal(studioWrites.length, 2, 'the confidence change alone was written');
    assert.equal(studioWrites[1][2].voice.threshold, 0.85);
});

function jobHub({ version = '0.2.10', caps = ['obs', 'voice', 'alertaudio'], connected = true, answer = { status: 'acked', result: { applied: ['SoundAlerts'] }, error: null } } = {}) {
    const sent = [];
    return {
        sent,
        connected: () => (connected ? [{ kind: 'studio', capabilities: caps, client: { app: 'certifried-studio', version }, connectedAt: new Date() }] : []),
        async dispatch(d) { sent.push(d); return { id: `x${sent.length}`, status: 'sent' }; },
        onAck(id, fn) { setImmediate(() => fn(typeof answer === 'function' ? answer() : answer)); return () => {}; },
    };
}

test('studio jobs: run once with a capable, new enough Studio while not live; skipped otherwise; three failures and it stops', async () => {
    assert.equal(versionAtLeast('0.2.10', '0.2.9'), true);
    assert.equal(versionAtLeast('0.2.9', '0.2.10'), false);
    assert.equal(versionAtLeast('1.0.0', '0.2.10'), true);
    assert.equal(versionAtLeast(null, '0.2.10'), false);
    assert.equal(versionAtLeast('0.2.1', null), true);
    assert.equal(studioVersion({ client: { version: '0.2.10' } }), '0.2.10');
    assert.equal(studioVersion({ client: 'certifried-studio 0.2.9' }), '0.2.9');

    let t = 100_000;
    let live = true;
    const store = fakeStore();
    let hub = jobHub({ version: '0.2.9', caps: ['obs', 'voice'] });
    const jobs = createStudioJobs({ store, hub: { connected: (...a) => hub.connected(...a), dispatch: (d) => hub.dispatch(d), onAck: (i, f) => hub.onAck(i, f) }, isLive: async () => live, now: () => t, minGapMs: 1000, ackWaitMs: 500 });
    const job = { id: 'alert-audio-2026-11-20', actionType: 'obs.alert_audio', capability: 'alertaudio', params: {}, minVersion: '0.2.10', notLive: true };
    await jobs.add(2, job);
    await jobs.add(2, { ...job, params: { undo: true } });
    assert.equal((await jobs.list(2)).length, 1, 'the same id twice is one job');

    await jobs.check(2);
    assert.equal((await jobs.list(2))[0].skipped, 'studio_too_old');
    t += 1000;
    hub = jobHub();
    await jobs.check(2);
    assert.equal((await jobs.list(2))[0].skipped, 'live', 'never while the streamer may be live');
    assert.equal(hub.sent.length, 0);
    t += 500;
    live = false;
    assert.deepEqual(await jobs.check(2), { checked: false }, 'not more often than minGapMs');
    t += 1000;
    await jobs.check(2);
    const done = (await jobs.list(2))[0];
    assert.equal(done.status, 'done');
    assert.deepEqual(done.result, { applied: ['SoundAlerts'] });
    assert.deepEqual([hub.sent[0].actionType, hub.sent[0].capability, hub.sent[0].queueSeconds], ['obs.alert_audio', 'alertaudio', 0]);
    t += 1000;
    await jobs.check(2);
    assert.equal(hub.sent.length, 1, 'done jobs do not run again');

    hub = jobHub({ answer: { status: 'failed', result: null, error: 'live: OBS is streaming' } });
    await jobs.add(2, { id: 'voice-fix', actionType: 'voice.set', capability: 'voice', params: { threshold: 0.7, onlyIfUnset: true }, minVersion: '0.2.10' });
    for (let i = 0; i < 4; i++) { t += 1000; await jobs.check(2); }
    const failed = (await jobs.list(2)).find((j) => j.id === 'voice-fix');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.tries, 3);
    assert.match(failed.error, /OBS is streaming/);
    assert.equal(hub.sent.length, 3);
});

test('studio jobs: the live check is the owner\'s open live_announcements row, and unsure means live', async () => {
    const store = fakeStore();
    const q = [];
    const isLive = ownerLiveCheck({ store, db: { query: async (sql, args) => { q.push([sql, args]); return [[{ n: 0 }]]; } } });
    assert.equal(await isLive(2), false);
    assert.match(q[0][0], /FROM live_announcements WHERE offline_check_count = 0 AND discord_user_id = \?/);
    assert.deepEqual(q[0][1], ['owner-1']);
    assert.equal(await ownerLiveCheck({ store, db: { query: async () => [[{ n: 1 }]] } })(2), true);
    assert.equal(await ownerLiveCheck({ store, db: { query: async () => { throw new Error('db down'); } } })(2), true);
});

test('Studio 0.2.10 Lights tab: lights.cloud lists the cloud lights without keys; lights.cloudTest flashes a cloud light only', async () => {
    const accounts = { async list() { return [{ provider: 'govee', status: 'ok', lastError: null, keyHint: 'ab12', devices: [{ id: 'govee-cloud:H6054:5A:0E:D6:39:32:37:09:41', name: 'Death Light Bars', model: 'H6054' }, { id: 'govee-cloud:H6195:11:22:33:44:55:66:77:88', name: 'Death Lights', model: 'H6195' }] }]; } };
    const svc = createDeviceService({ store: fakeStore(), hub: { connected: () => [] }, accounts, cloud: {} });
    const conn = { profileId: 2, kind: 'studio' };
    const r = await svc.onStudioRequest(conn, 'lights.cloud', {});
    assert.deepEqual(r.lights.map((l) => [l.name, l.model, l.provider, l.providerLabel]), [['Death Light Bars', 'H6054', 'govee', 'Govee'], ['Death Lights', 'H6195', 'govee', 'Govee']]);
    assert.equal(JSON.stringify(r).includes('ab12'), false, 'no key or key hint goes to Studio');
    assert.deepEqual(r.accounts, [{ provider: 'govee', label: 'Govee', status: 'ok', lastError: null }]);
    const tested = [];
    svc.test = async (pid, device) => { tested.push([pid, device]); return { ok: true, message: 'Flashed.' }; };
    assert.deepEqual(await svc.onStudioRequest(conn, 'lights.cloudTest', { device: 'govee-cloud:H6054:5A:0E:D6:39:32:37:09:41' }), { ok: true, message: 'Flashed.' });
    assert.deepEqual(tested, [[2, 'govee-cloud:H6054:5A:0E:D6:39:32:37:09:41']]);
    await assert.rejects(() => svc.onStudioRequest(conn, 'lights.cloudTest', { device: 'govee:AA:BB' }), (e) => e.code === 'bad_params');
    for (let i = 0; i < 5; i++) await svc.onStudioRequest(conn, 'lights.cloudTest', { device: 'govee-cloud:H6195:11:22:33:44:55:66:77:88' });
    await assert.rejects(() => svc.onStudioRequest(conn, 'lights.cloudTest', { device: 'govee-cloud:H6195:11:22:33:44:55:66:77:88' }), (e) => e.code === 'rate');
});

test('switchover: Streamer.bot\'s 0.2 is never suggested, whatever the import says', () => {
    for (const speech of [0.2, 0.5, 0.9, null]) {
        const v = buildPlan({ automations: [], importItems: [], studio: { connected: true, voice: true }, speech }).voice;
        assert.equal(v.suggestedThreshold, null);
    }
    const js = fs.readFileSync(path.join(root, 'dashboard/public/js/stream-bot-switchover.js'), 'utf8');
    assert.doesNotMatch(js, /Set the voice confidence in Studio to/);
    assert.match(js, /Studio scores speech differently/);
});

test('pages: the editor has the per-command fields; the Automations page has the voice log; the route answers', () => {
    const js = fs.readFileSync(path.join(root, 'dashboard/public/js/stream-bot.js'), 'utf8');
    assert.match(js, /How sure, in % \(optional\)/);
    assert.match(js, /Wait before it can run again, in seconds/);
    assert.match(js, /trigger_config\.cooldownSec = Number\(S\.voiceWait\)/);
    assert.match(js, /\/stream\/bot\/api\/voice\/log/);
    const ejs = fs.readFileSync(path.join(root, 'dashboard/views/stream-bot/automations.ejs'), 'utf8');
    assert.match(ejs, /id="sb-voice-log"/);
    assert.match(ejs, /if \(locals\.hasVoice\)/);
    assert.doesNotMatch(ejs + js, /[\u{1F300}-\u{1FAFF}]/u, 'no emoji');
    const routes = fs.readFileSync(path.join(root, 'dashboard/routes/stream-bot.js'), 'utf8');
    assert.match(routes, /router\.get\('\/stream\/bot\/api\/voice\/log', needApi/);
    assert.match(routes, /router\.delete\('\/stream\/bot\/api\/voice\/log', needApi/);
});

test('Studio 0.2.11 Bluetooth: a cloud light Studio reaches over Bluetooth goes to Studio; the cloud is the fallback', async () => {
    const { sanitiseDevices } = await import('../core/stream-bot/devices/state.js');
    const { DEVICE_ID, DRIVER_LABEL } = await import('../core/stream-bot/devices/catalog.js');
    const CLOUD = 'govee-cloud:H6054:5A:0E:D6:39:32:37:09:41';
    const st = sanitiseDevices({ lights: [
        { id: 'goveeble:D63932370941', driver: 'goveeble', name: 'Death Light Bars', model: 'H6054', online: true, needsPairing: false, cloudId: CLOUD, caps: { power: true, brightness: true, color: true } },
        { id: 'goveeble:C76A03C65162', driver: 'goveeble', name: 'Govee H6076 (5162)', online: true, needsPairing: true, cloudId: 'nonsense<script>', caps: {} },
    ] });
    assert.equal(st.lights[0].cloudId, CLOUD);
    assert.equal(st.lights[1].cloudId, undefined, 'a bad cloud id is dropped');
    assert.ok(DEVICE_ID.test('goveeble:D63932370941'));
    assert.equal(DRIVER_LABEL.goveeble, 'Govee (Bluetooth)');

    const rows = new Map();
    let ack = 'acked';
    const store = { ...fakeStore(), async insertDispatch(r) { rows.set(r.id, { ...r }); }, async updateDispatch(id, p) { rows.set(id, { ...rows.get(id), ...p }); }, async getDispatch(id) { return rows.get(id) || null; } };
    const sent = [];
    const hub = {
        connected: () => [{ kind: 'studio', capabilities: ['light'], connectedAt: new Date(), state: { devices: st } }],
        async dispatch(d) { sent.push(d); const id = `h${sent.length}`; rows.set(id, { id, status: ack }); return { id, status: 'sent' }; },
    };
    const cloudRuns = [];
    const cloud = { async run(pid, type, params) { cloudRuns.push([type, params.device]); return { applied: [params.device], skipped: [], notes: [] }; }, async devices() { return [{ id: CLOUD }]; } };
    const svc = createDeviceService({ store, hub, accounts: { async list() { return []; } }, cloud, ackWaitMs: 300, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) });
    const r = await svc.dispatch({ profileId: 2, runId: null, target: 'studio', capability: 'light', actionType: 'light.power', params: { device: CLOUD, state: 'on' }, queueSeconds: 0 }, () => { throw new Error('next not used'); });
    assert.equal(r.status, 'done');
    assert.match(r.detail, /over Bluetooth/);
    assert.deepEqual([sent[0].params.device, cloudRuns.length], ['goveeble:D63932370941', 0], 'Studio did it; the cloud was not used');

    ack = 'failed';
    const r2 = await svc.dispatch({ profileId: 2, runId: null, target: 'studio', capability: 'light', actionType: 'light.power', params: { device: CLOUD, state: 'off' }, queueSeconds: 0 }, () => { throw new Error('next not used'); });
    assert.equal(r2.status, 'done');
    assert.deepEqual(cloudRuns, [['light.power', CLOUD]], 'Bluetooth failed: the cloud did it');

    const other = 'govee-cloud:H6195:11:22:33:44:55:66:77:88';
    await svc.dispatch({ profileId: 2, runId: null, target: 'studio', capability: 'light', actionType: 'light.power', params: { device: other, state: 'on' }, queueSeconds: 0 }, () => { throw new Error('next not used'); });
    assert.deepEqual(cloudRuns.at(-1), ['light.power', other], 'no Bluetooth twin: cloud as before');
    assert.equal(sent.length, 2);
});
