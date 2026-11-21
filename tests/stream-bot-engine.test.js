import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../utils/db.js';
import { makeTables, makeProfile } from './fixtures/stream-bot-tables.js';
import { createEngine } from '../core/stream-bot/engine.js';
import { createRenderer, templateWarnings } from '../core/stream-bot/render.js';
import { createLimiter, checkConditions, triggerMatches, textMatches, validateConditions, validateTrigger } from '../core/stream-bot/conditions.js';
import { validateActions, countSteps } from '../core/stream-bot/actions.js';
import { createIngest } from '../core/stream-bot/ingest.js';
import { createFeed } from '../core/stream-bot/feed.js';
import { sampleEvent, normaliseTwitch } from '../core/stream-bot/events.js';

/*
 * The automation engine (core/stream-bot/engine.js, design §2.3) on throwaway tables (sbte…_), with fake chat,
 * Discord, webhook and dispatch: trigger matching, every condition type, cooldowns (global and per person),
 * rate limits, variables through the template engine ({sdb:}/{db:} and the variable actions), random choice,
 * run-another, loop protection (chains, depth, per-profile budget), dry runs, tests, the run log, ingestion
 * (de-duplication, echo guard, chat storage switch) and save-time validation.
 */

let T, store, profile;
const clock = { t: Date.parse('2026-11-19T12:00:00Z') };
const now = () => clock.t;

function fakeIo() {
    const io = {
        said: [], posted: [], hooks: [], dispatched: [],
        channelsFor: (id) => store.listChannels(id),
        sendChat: async (m) => { io.said.push(m); return { ok: true }; },
        postDiscord: async (m) => { io.posted.push(m); return { ok: true }; },
        postWebhook: async (url, body) => { io.hooks.push({ url, body }); return { status: 204 }; },
        dispatch: async (d) => { io.dispatched.push(d); return { id: `d_${io.dispatched.length}`, status: 'queued', devices: 0 }; },
    };
    return io;
}

function makeEngine(opts = {}) {
    const io = fakeIo();
    const render = createRenderer({ variableStore: store.variableStore });
    const engine = createEngine({ store, render, io, now, sleep: async () => {}, rng: opts.rng || (() => 0), limiter: createLimiter({ now }), limits: opts.limits });
    return { engine, io };
}

async function automation(a) {
    const id = await store.createAutomation(profile.id, { enabled: true, trigger_config: {}, conditions: [], ...a });
    return store.getAutomation(profile.id, id);
}

const follow = (name = 'MapleFan_88', id = '101') => normaliseTwitch('channel.follow', { broadcaster_user_id: '900000001', user_id: id, user_login: name.toLowerCase(), user_name: name });
const cheer = (bits, name = 'MapleFan_88') => normaliseTwitch('channel.cheer', { broadcaster_user_id: '900000001', user_id: '102', user_login: name.toLowerCase(), user_name: name, bits, message: `Cheer${bits}` });
const chat = (text, roles = [], id = '103') => normaliseTwitch('channel.chat.message', { broadcaster_user_id: '900000001', chatter_user_id: id, chatter_user_login: 'juniper', chatter_user_name: 'Juniper', message_id: `m${Math.random()}`, message: { text }, badges: roles.map((r) => ({ set_id: r })) });

test.before(async () => {
    T = await makeTables(pool, 'e');
    store = T.store;
    profile = await makeProfile(store);
});
test.after(async () => {
    await T.drop();
    const [rows] = await pool.query('SHOW TABLES LIKE ?', [`${T.prefix}%`]);
    assert.equal(rows.length, 0, 'throwaway tables dropped');
    await pool.end().catch(() => {});
});

test('a follow thanks the follower in chat, with the event in the template and the run logged', async () => {
    const { engine, io } = makeEngine();
    const a = await automation({ name: 'Thank followers', trigger_type: 'follow', actions: [{ type: 'chat.send', platform: 'event', text: 'Thanks for the follow, {user.name}! ({event.platform})' }] });
    const [r] = await engine.handleEvent(profile, follow(), null);
    assert.equal(r.status, 'ok');
    assert.equal(io.said.length, 1);
    assert.deepEqual([io.said[0].platform, io.said[0].login, io.said[0].text], ['twitch', 'maplehollow_tv', 'Thanks for the follow, MapleFan_88! (twitch)']);
    const run = await store.getRun(profile.id, r.runId);
    assert.equal(run.status, 'ok'); assert.equal(run.automationName, 'Thank followers'); assert.equal(run.input.type, 'follow');
    assert.equal(run.steps[0].type, 'chat.send'); assert.equal(run.steps[0].status, 'ok'); assert.ok(run.finishedAt);
    assert.ok((await store.getAutomation(profile.id, a.id)).last_run_at, 'last run time noted');
    await store.deleteAutomation(profile.id, a.id);
});

test('a viewer\'s message cannot inject template tokens', async () => {
    const { engine, io } = makeEngine();
    const a = await automation({ name: 'Echo', trigger_type: 'cheer', actions: [{ type: 'chat.send', platform: 'event', text: 'Said: {message}' }] });
    const ev = cheer(100);
    ev.message = '{sdb:set:hacked:1}{api:https://example.invalid/}';
    await engine.handleEvent(profile, ev);
    assert.equal(io.said[0].text, 'Said: {sdb:set:hacked:1}{api:https://example.invalid/}', 'printed literally');
    assert.equal(await store.variableStore.get(profile.id, 'server', 'hacked'), null, 'nothing stored');
    await store.deleteAutomation(profile.id, a.id);
});

test('conditions: role, amount, text, event detail; skipped runs say why', async () => {
    const { engine, io } = makeEngine();
    const big = await automation({ name: 'Big cheers', trigger_type: 'cheer', conditions: [{ type: 'amount', min: 500, max: 10000 }], actions: [{ type: 'chat.send', platform: 'twitch', text: 'Big {amount}' }] });
    let [r] = await engine.handleEvent(profile, cheer(100));
    assert.equal(r.status, 'skipped');
    let run = await store.getRun(profile.id, r.runId);
    assert.match(run.skipReason, /^amount: 100 is below 500/);
    [r] = await engine.handleEvent(profile, cheer(500));
    assert.equal(r.status, 'ok'); assert.equal(io.said.at(-1).text, 'Big 500');
    await store.deleteAutomation(profile.id, big.id);

    const mods = await automation({ name: 'Mods only', trigger_type: 'chat', trigger_config: { match: { mode: 'command', text: '!scene' } },
        conditions: [{ type: 'role', roles: ['moderator', 'broadcaster'], mode: 'any' }], actions: [{ type: 'obs.scene', scene: 'BRB', queueSeconds: 60 }] });
    [r] = await engine.handleEvent(profile, chat('!scene', ['subscriber']));
    assert.equal(r.status, 'skipped');
    [r] = await engine.handleEvent(profile, chat('!scene', ['moderator']));
    assert.equal(r.status, 'ok');
    assert.equal((await engine.handleEvent(profile, chat('hello !scene', ['moderator']))).length, 0, 'command must be the first word');
    assert.deepEqual(io.dispatched.at(-1), { profileId: profile.id, runId: r.runId, target: 'studio', capability: 'obs', actionType: 'obs.scene', params: { scene: 'BRB' }, queueSeconds: 60 });
    run = await store.getRun(profile.id, r.runId);
    assert.equal(run.steps[0].status, 'queued'); assert.match(run.steps[0].detail, /Needs CertiFried Studio/);
    await store.deleteAutomation(profile.id, mods.id);

    const ev = sampleEvent('redemption');
    let res = checkConditions([{ type: 'metadata', path: 'reward', op: 'eq', value: 'sound alert' }], ev);
    assert.equal(res.ok, true, 'case-insensitive');
    res = checkConditions([{ type: 'text', mode: 'contains', text: 'trombone', field: 'message' }, { type: 'role', roles: ['vip'], mode: 'any' }], ev);
    assert.equal(res.ok, false); assert.equal(res.failed.type, 'role'); assert.equal(res.results[0].ok, true);
    assert.equal(checkConditions([{ type: 'role', roles: ['vip'], mode: 'none' }], ev).ok, true);
    assert.equal(checkConditions([{ type: 'amount', min: 1, currency: 'bits' }], ev).ok, false, 'currency must match');
    assert.equal(checkConditions([{ type: 'amount', min: 1 }], sampleEvent('follow')).ok, false, 'no amount');
});

test('text matching modes, and slow regular expressions are refused', () => {
    assert.ok(textMatches('!Hello world', { mode: 'command', text: 'hello' }));
    assert.ok(textMatches('!hello', { mode: 'command', text: '!hello' }));
    assert.ok(!textMatches('!helloo', { mode: 'command', text: '!hello' }));
    assert.ok(textMatches('the boss is down', { mode: 'word', text: 'boss' }));
    assert.ok(!textMatches('bossy', { mode: 'word', text: 'boss' }));
    assert.ok(textMatches('GG', { mode: 'exact', text: 'gg' }));
    assert.ok(!textMatches('GG', { mode: 'exact', text: 'gg', caseSensitive: true }));
    assert.ok(textMatches('pog champ', { mode: 'starts', text: 'pog' }));
    assert.ok(textMatches('lvl 42', { mode: 'regex', text: '^lvl \\d+$' }));
    assert.ok(!textMatches('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!', { mode: 'regex', text: '(a+)+$' }), 'nested quantifier refused');
    assert.equal(validateTrigger('chat', { match: { mode: 'regex', text: '(a+)+' } }).ok, false);
    assert.ok(triggerMatches({ trigger_type: 'follow', trigger_config: { platforms: ['kick'] } }, { type: 'follow', platform: 'test' }), 'test events ignore the platform filter');
    assert.ok(!triggerMatches({ trigger_type: 'follow', trigger_config: { platforms: ['kick'] } }, { type: 'follow', platform: 'twitch' }));
});

test('cooldowns (global and per person) and rate limits', async () => {
    const { engine, io } = makeEngine();
    const a = await automation({ name: 'Hi', trigger_type: 'chat', trigger_config: { match: { mode: 'command', text: '!hi' } },
        conditions: [{ type: 'cooldown', scope: 'user', seconds: 30 }, { type: 'cooldown', scope: 'global', seconds: 5 }], actions: [{ type: 'chat.send', platform: 'event', text: 'hi {user.name}' }] });
    clock.t += 60_000;
    assert.equal((await engine.handleEvent(profile, chat('!hi', [], 'u1')))[0].status, 'ok');
    const [busy] = await engine.handleEvent(profile, chat('!hi', [], 'u2'));
    assert.equal(busy.status, 'skipped', 'global cooldown');
    assert.match((await store.getRun(profile.id, busy.runId)).skipReason, /cooling down/);
    clock.t += 6_000;
    assert.equal((await engine.handleEvent(profile, chat('!hi', [], 'u2')))[0].status, 'ok', 'other person after the global cooldown');
    clock.t += 6_000;
    assert.equal((await engine.handleEvent(profile, chat('!hi', [], 'u1')))[0].status, 'skipped', 'same person within 30 s');
    clock.t += 30_000;
    assert.equal((await engine.handleEvent(profile, chat('!hi', [], 'u1')))[0].status, 'ok');
    assert.equal(io.said.length, 3);
    // a test run reports the cooldown but is not blocked by it, and does not start one
    const t = await engine.runAutomation(profile, a, chat('!hi', [], 'u1'), { source: 'test', test: true, skipTrigger: true });
    assert.equal(t.status, 'ok');
    await store.deleteAutomation(profile.id, a.id);

    const rl = await automation({ name: 'Limited', trigger_type: 'follow', conditions: [{ type: 'rate_limit', scope: 'global', count: 2, windowSeconds: 60 }], actions: [{ type: 'variable.increment', scope: 'channel', key: 'rl', by: 1 }] });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await engine.handleEvent(profile, follow(`F${i}`, `20${i}`)))[0].status);
    assert.deepEqual(statuses, ['ok', 'ok', 'skipped', 'skipped']);
    clock.t += 61_000;
    assert.equal((await engine.handleEvent(profile, follow('F9', '209')))[0].status, 'ok', 'window moved on');
    assert.equal(await store.variableStore.get(profile.id, 'server', 'rl'), '3');
    await store.deleteAutomation(profile.id, rl.id);
});

test('variables: set, increment, per-viewer {db:} and per-channel {sdb:} through the template engine', async () => {
    const { engine, io } = makeEngine();
    const a = await automation({ name: 'Deaths', trigger_type: 'chat', trigger_config: { match: { mode: 'command', text: '!death' } }, actions: [
        { type: 'variable.increment', scope: 'channel', key: 'deaths', by: 1 },
        { type: 'variable.set', scope: 'user', key: 'last', value: 'died at {sdb:get:deaths}' },
        { type: 'chat.send', platform: 'event', text: 'Deaths: {sdb:get:deaths}. You: {db:get:last}. Total pokes: {db:incr:pokes}' },
    ] });
    await engine.handleEvent(profile, chat('!death', [], 'v1'));
    await engine.handleEvent(profile, chat('!death', [], 'v1'));
    assert.equal(io.said.at(-1).text, 'Deaths: 2. You: died at 2. Total pokes: 2');
    assert.equal(await store.variableStore.get(profile.id, 'twitch:v1', 'last'), 'died at 2');
    const tip = sampleEvent('tip');   // no viewer id: user scope is skipped, channel scope works
    const r = await engine.runAutomation(profile, a, tip, { skipTrigger: true });
    const run = await store.getRun(profile.id, r.runId);
    assert.equal(run.steps[0].status, 'ok'); assert.equal(run.steps[1].status, 'skipped');
    assert.equal(await store.variableStore.get(profile.id, 'server', 'deaths'), '3');
    await store.deleteAutomation(profile.id, a.id);
});

test('random picks one branch by weight; run-another chains; loops are stopped', async () => {
    const { engine, io } = makeEngine({ rng: () => 0.9 });
    const rnd = await automation({ name: 'Random', trigger_type: 'raid', actions: [{ type: 'random', branches: [
        { weight: 1, actions: [{ type: 'chat.send', platform: 'twitch', text: 'A' }] },
        { weight: 3, actions: [{ type: 'chat.send', platform: 'twitch', text: 'B' }, { type: 'delay', seconds: 1 }] },
    ] }] });
    const [r] = await engine.handleEvent(profile, sampleEvent('raid', { platform: 'twitch', channelId: '900000001' }));
    const run = await store.getRun(profile.id, r.runId);
    assert.deepEqual(run.steps.map((s) => [s.at, s.type, s.status]), [['1', 'random', 'ok'], ['1.2.1', 'chat.send', 'ok'], ['1.2.2', 'delay', 'ok']]);
    assert.equal(io.said.at(-1).text, 'B');
    await store.deleteAutomation(profile.id, rnd.id);

    const child = await automation({ name: 'Child', trigger_type: 'follow', enabled: true, actions: [{ type: 'chat.send', platform: 'twitch', text: 'child ran for {user.name}' }] });
    const parent = await automation({ name: 'Parent', trigger_type: 'cheer', actions: [{ type: 'automation.run', automationId: child.id }] });
    const [p] = await engine.handleEvent(profile, cheer(10));
    const prun = await store.getRun(profile.id, p.runId);
    assert.equal(prun.steps[0].status, 'ok');
    const crun = await store.getRun(profile.id, prun.steps[0].childRunId);
    assert.deepEqual([crun.source, crun.parentRunId, crun.depth, crun.status], ['automation', p.runId, 1, 'ok']);
    assert.equal(io.said.at(-1).text, 'child ran for MapleFan_88');

    // A ↔ B loop: the second hop back to A is refused
    const a = await automation({ name: 'Loop A', trigger_type: 'stream.online', actions: [] });
    const b = await automation({ name: 'Loop B', trigger_type: 'stream.online', actions: [{ type: 'automation.run', automationId: a.id }] });
    await store.updateAutomation(profile.id, a.id, { ...a, actions: [{ type: 'automation.run', automationId: b.id }] });
    const fresh = await store.getAutomation(profile.id, a.id);
    const lr = await engine.runAutomation(profile, fresh, sampleEvent('stream.online'), { skipTrigger: true });
    const aRun = await store.getRun(profile.id, lr.runId);
    const bRun = await store.getRun(profile.id, aRun.steps[0].childRunId);
    assert.equal(bRun.steps[0].status, 'failed'); assert.match(bRun.steps[0].detail, /loop stopped: automation \d+ is already running/);
    assert.equal(bRun.status, 'failed'); assert.equal(aRun.status, 'failed', 'a failed child fails the step');

    // depth: a chain of six distinct automations stops at the limit
    const chain = [];
    for (let i = 0; i < 6; i++) chain.push(await automation({ name: `D${i}`, trigger_type: 'stream.offline', actions: [] }));
    for (let i = 0; i < 5; i++) await store.updateAutomation(profile.id, chain[i].id, { ...chain[i], actions: [{ type: 'automation.run', automationId: chain[i + 1].id }] });
    let cur = await engine.runAutomation(profile, await store.getAutomation(profile.id, chain[0].id), sampleEvent('stream.offline'), { skipTrigger: true });
    let depth = 0, last;
    for (;;) {
        last = await store.getRun(profile.id, cur.runId);
        if (!last.steps[0]?.childRunId) break;
        cur = { runId: last.steps[0].childRunId };
        depth++;
    }
    assert.equal(depth, 4); assert.match(last.steps[0].detail, /more than 5 automations deep/);
    for (const x of [child, parent, a, b, ...chain]) await store.deleteAutomation(profile.id, x.id);
});

test('per-profile run budget: more than the limit in a minute is skipped as busy', async () => {
    const { engine } = makeEngine({ limits: { runsPerMinute: 3 } });
    const a = await automation({ name: 'Budget', trigger_type: 'follow', actions: [{ type: 'delay', seconds: 0.1 }] });
    clock.t += 120_000;
    const out = [];
    for (let i = 0; i < 5; i++) out.push((await engine.handleEvent(profile, follow(`B${i}`, `30${i}`)))[0]);
    assert.deepEqual(out.map((r) => r.status), ['ok', 'ok', 'ok', 'skipped', 'skipped']);
    assert.match((await store.getRun(profile.id, out[3].runId)).skipReason, /^busy/);
    await store.deleteAutomation(profile.id, a.id);
});

test('dry run sends nothing; webhook and Discord steps reach io; failures do not stop the run', async () => {
    const { engine, io } = makeEngine();
    await store.updateSettings(profile.id, { webhookAllowHosts: ['hooks.example.org'] });
    profile = await store.getProfile(profile.id);
    const a = await automation({ name: 'All', trigger_type: 'tip', actions: [
        { type: 'chat.send', platform: 'kick', text: 'Thanks {user.name} for {amount} {currency}' },
        { type: 'discord.post', guildId: '100000000000000001', channelId: '100000000000000002', text: '{user.name} tipped' },
        { type: 'webhook.post', url: 'https://hooks.example.org/x', body: '' },
        { type: 'overlay.alert', title: '{user.name}', message: '{message}', durationMs: 5000, style: 'default', queueSeconds: 0 },
    ] });
    const dry = await engine.runAutomation(profile, a, sampleEvent('tip'), { dryRun: true, test: true, skipTrigger: true });
    assert.deepEqual(dry.steps.map((s) => s.status), ['dry', 'dry', 'dry', 'dry']);
    assert.equal(io.said.length + io.posted.length + io.hooks.length + io.dispatched.length, 0, 'nothing sent');
    assert.match(dry.steps[0].detail, /would say in kick\/maplehollow: Thanks Juniper for 5 USD/);

    io.postDiscord = async () => ({ ok: false, error: 'you no longer manage that server' });
    const real = await engine.runAutomation(profile, a, sampleEvent('tip'), { skipTrigger: true });
    assert.deepEqual(real.steps.map((s) => s.status), ['ok', 'failed', 'ok', 'queued']);
    assert.equal(real.status, 'partial');
    const body = JSON.parse(io.hooks[0].body);
    assert.equal(body.event.type, 'tip'); assert.equal(body.automation.name, 'All'); assert.equal('raw' in body.event, false);
    assert.deepEqual(io.dispatched[0].params, { title: 'Juniper', message: 'Coffee is on me', durationMs: 5000, style: 'default' });
    await store.deleteAutomation(profile.id, a.id);
});

test('ingestion: stored once, chat kept only when switched on, echoes and the bot\'s own chat are not triggers', async () => {
    const { engine, io } = makeEngine();
    const feed = createFeed();
    const seen = [];
    feed.subscribe(profile.id, (e) => seen.push(e));
    const ingest = createIngest({ store, engine, feed, now, ignoreLogins: ['certifriedbot'] });
    const a = await automation({ name: 'Echo test', trigger_type: 'chat', trigger_config: { match: { mode: 'contains', text: 'ping' } }, actions: [{ type: 'chat.send', platform: 'event', text: 'ping back' }] });
    const f = { broadcaster_user_id: '900000001', user_id: '401', user_login: 'rowan', user_name: 'Rowan', followed_at: '2026-11-19T12:00:00Z' };
    assert.equal(await ingest.twitch('channel.follow', f, 'channel.follow'), 1);
    assert.equal(await ingest.twitch('channel.follow', f, 'channel.follow'), 0, 'same follow again is a duplicate');
    assert.equal((await store.listEvents(profile.id, { type: 'follow', q: 'rowan' })).length, 1);
    assert.equal(await ingest.twitch('channel.follow', { ...f, broadcaster_user_id: '123' }, 'channel.follow'), 0, 'channel nobody linked');

    const msg = (text, login = 'juniper', id = `c${Math.random()}`) => ({ broadcaster_user_id: '900000001', chatter_user_id: '5', chatter_user_login: login, chatter_user_name: login, message_id: id, message: { text } });
    await ingest.twitch('channel.chat.message', msg('ping please'), 'channel.chat.message');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(io.said.length, 1, 'chat triggered');
    assert.equal((await store.listEvents(profile.id, { type: 'chat' })).length, 0, 'chat not stored by default');
    assert.ok(seen.some((e) => e.type === 'chat'), 'but it is in the live feed');
    ingest.noteSent('twitch', '900000001', 'ping back');
    await ingest.twitch('channel.chat.message', msg('ping back'), 'channel.chat.message');
    await ingest.twitch('channel.chat.message', msg('ping from the bot', 'certifriedbot'), 'channel.chat.message');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(io.said.length, 1, 'its own echo and the bot account do not trigger');
    const dup = msg('ping dup', 'juniper', 'same-id');
    await ingest.twitch('channel.chat.message', dup, 'channel.chat.message');
    assert.equal(await ingest.twitch('channel.chat.message', dup, 'channel.chat.message'), 0, 'chat de-duplicated in memory');

    await store.updateSettings(profile.id, { storeChat: true });
    ingest.invalidate(profile.id);
    await ingest.kick('chat.message.sent', { broadcaster: { user_id: 800000001 }, message_id: 'kk1', content: 'hello from kick', sender: { user_id: 9, username: 'Sorrel' } });
    assert.equal((await store.listEvents(profile.id, { type: 'chat', platform: 'kick' })).length, 1, 'stored once switched on');
    await store.updateSettings(profile.id, { storeChat: false });
    await store.deleteAutomation(profile.id, a.id);
});

test('save-time validation of conditions, triggers and actions', () => {
    assert.equal(validateConditions([{ type: 'amount', min: 10, max: 5 }]).ok, false);
    assert.equal(validateConditions([{ type: 'role', roles: [] }]).ok, false);
    assert.deepEqual(validateConditions([{ type: 'cooldown', scope: 'user', seconds: '30' }]).value, [{ type: 'cooldown', scope: 'user', seconds: 30 }]);
    assert.equal(validateConditions([{ type: 'metadata', path: 'a;drop', value: 'x' }]).ok, false);
    assert.equal(validateConditions(new Array(11).fill({ type: 'cooldown', seconds: 1 })).ok, false, 'at most 10');
    assert.equal(validateTrigger('nope').ok, false);
    assert.deepEqual(validateTrigger('follow', { platforms: ['kick', 'studio'] }).value, { platforms: ['kick'] });
    assert.deepEqual(validateTrigger('follow', { platforms: ['youtube'] }).value, { platforms: ['youtube'] }, 'YouTube subscribers are follows (2026-11-20)');
    assert.equal(validateTrigger('chat', { match: { text: '' } }).ok, false);

    const ctx = { automationIds: new Set([1, 2]), selfId: 1, guildIds: new Set(['100000000000000001']), allowHosts: ['hooks.example.org'] };
    assert.equal(validateActions([], ctx).ok, false, 'at least one action');
    assert.equal(validateActions([{ type: 'automation.run', automationId: 1 }], ctx).ok, false, 'not itself');
    assert.equal(validateActions([{ type: 'automation.run', automationId: 3 }], ctx).ok, false, 'must exist');
    assert.equal(validateActions([{ type: 'automation.run', automationId: 2 }], ctx).ok, true);
    assert.equal(validateActions([{ type: 'discord.post', guildId: '100000000000000009', channelId: '100000000000000002', text: 'x' }], ctx).ok, false, 'only managed servers');
    assert.equal(validateActions([{ type: 'webhook.post', url: 'https://evil.example.net/' }], ctx).ok, false, 'host must be allow-listed');
    assert.equal(validateActions([{ type: 'webhook.post', url: 'http://hooks.example.org/' }], ctx).ok, false, 'https only');
    assert.equal(validateActions([{ type: 'delay', seconds: 9999 }], ctx).ok, false);
    assert.equal(validateActions([{ type: 'random', branches: [{ actions: [{ type: 'delay', seconds: 1 }] }] }], ctx).ok, false, 'two choices at least');
    const deep = (n) => (n === 0 ? [{ type: 'delay', seconds: 1 }] : [{ type: 'random', branches: [{ actions: deep(n - 1) }, { actions: [{ type: 'delay', seconds: 1 }] }] }]);
    assert.equal(validateActions(deep(3), ctx).ok, true);
    assert.equal(validateActions(deep(4), ctx).ok, false, 'nesting limit');
    assert.equal(validateActions(new Array(26).fill({ type: 'delay', seconds: 1 }), ctx).ok, false, 'step limit');
    assert.equal(countSteps(deep(2)), 5);
    const v = validateActions([{ type: 'obs.scene', scene: 'BRB' }, { type: 'sound.play', sound: 'airhorn.mp3', volume: 300, queueSeconds: 99999 }], ctx);
    assert.equal(v.ok, true); assert.equal(v.value[1].volume, 100); assert.equal(v.value[1].queueSeconds, 3600);
    assert.equal(validateActions([{ type: 'studio.hotkey', keys: 'Ctrl+<script>' }], ctx).ok, false);
    assert.deepEqual(templateWarnings('Thanks {user.name} for {amount} {nope}'), ['Unknown variable {nope}']);
});
