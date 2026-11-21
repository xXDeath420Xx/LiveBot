import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseControlTwitch, normaliseControlKick, CONTROL_EVENT_TYPES, describeControl, _resetInfo } from '../core/stream-bot/control/events.js';
import { createTwitchControl, createKickControl, friendlyError } from '../core/stream-bot/control/platform.js';
import { controlActions } from '../core/stream-bot/control/actions.js';
import { controlConditions, parseDays, inWindow, compareValue } from '../core/stream-bot/control/conditions.js';
import { createQueues, validateQueue } from '../core/stream-bot/control/queues.js';
import { createChatPolls } from '../core/stream-bot/control/chat-polls.js';
import { createControlService, formatAge } from '../core/stream-bot/control/service.js';
import { INTERNAL_TYPES } from '../core/stream-bot/control/index.js';
import * as events from '../core/stream-bot/events.js';
import * as conditions from '../core/stream-bot/conditions.js';
import * as actions from '../core/stream-bot/actions.js';
import { createEngine } from '../core/stream-bot/engine.js';
import { createIngest } from '../core/stream-bot/ingest.js';
import { STREAM_BOT_SCOPES, FORBIDDEN_SCOPES, reapproveNeeded } from '../core/stream-bot/scopes.js';
import { KICK_CHANNEL_BOT_SCOPES } from '../core/stream-bot/kick-scopes.js';
import { evaluateMath } from '../core/math-expr.js';
import { renderTemplate, validateTemplate } from '../core/custom-command-vars.js';
import { parsePermit, grantPermit, hasPermit, _clearPermits } from '../services/certifried-bot/link-permits.js';

/*
 * Wave 2 group A of the stream feature-parity backlog (core/stream-bot/control): moderation triggers and steps, conditions,
 * action queues, on/off steps, rewards, marker / snooze / cancel raid, reply, user info, {math:}, !permit, chat polls,
 * first words / viewer arrived / viewer count / upcoming ad, goals and the Kick extras. Pure: fakes only, no database,
 * no Twitch, no Kick.
 */

// Register once, as attachControl does, with fakes behind the actions.
const calls = [];
const fakeTwitch = {
    userByLogin: async (pid, login) => ({ id: '555', login, name: login }),
    ban: async (pid, o) => { calls.push(['ban', o]); },
    unban: async (pid, id) => { calls.push(['unban', id]); },
    chatSettings: async (pid, b) => { calls.push(['chat', b]); },
    vip: async (pid, id, add) => { calls.push(['vip', id, add]); },
    moderator: async (pid, id, add) => { calls.push(['mod', id, add]); },
    shield: async (pid, on) => { calls.push(['shield', on]); },
    warn: async (pid, id, r) => { calls.push(['warn', id, r]); },
    manageableRewards: async () => [{ id: 'r1', title: 'Hydrate' }],
    updateReward: async (pid, id, body) => { calls.push(['reward', id, body]); },
    updateRedemption: async (pid, o) => { calls.push(['redeem', o]); },
    marker: async () => ({ id: 'm1', seconds: 3725 }),
    snoozeAd: async () => ({ snoozes: 2 }),
    cancelRaid: async () => { calls.push(['unraid']); },
};
const timerRows = [{ id: 7, is_enabled: 1 }];
const deps = {
    twitch: fakeTwitch,
    kick: { unban: async () => {}, userIdBySlug: async (c, s) => ({ id: '9', name: s }), rewards: async () => [{ id: 'k1', title: 'Hydrate' }], updateReward: async (c, id, b) => { calls.push(['kreward', id, b]); }, redemption: async (c, id, ok) => { calls.push(['kredeem', id, ok]); } },
    kickBan: async (c, id, o) => { calls.push(['kban', id, o]); },
    hub: { notify: () => calls.push(['notify']) },
    timers: { byName: async (pid, n) => (n.toLowerCase() === 'hydrate' ? timerRows : []), setEnabled: async (ids, on) => calls.push(['timer', ids, on]), reset: async (ids) => calls.push(['treset', ids]) },
    commands: { find: async (chans, name) => (name === 'discord' ? [{ id: 3, is_enabled: 1, channel_id: '42' }] : []), setEnabled: async (rows, on) => calls.push(['cmd', rows.length, on]) },
    reply: async (o) => { calls.push(['reply', o.platform, o.replyTo, o.text]); return { ok: true }; },
    youtubeTitle: async () => ({ status: 'ok', detail: 'set' }),
};
for (const d of controlActions(deps)) actions.registerActionType(d);
for (const d of CONTROL_EVENT_TYPES) events.registerEventType(d);
events.registerNormaliser('twitch', normaliseControlTwitch);
events.registerNormaliser('kick', normaliseControlKick);
events.registerDescriber(describeControl);
conditions.registerTriggerOption('queue', validateQueue);
const loaded = {};
for (const d of controlConditions({
    streamInfo: async () => ({ live: true, category: 'Celeste', viewers: 42 }),
    followedAt: async (pid, ev) => (ev.user?.id === 'f' ? { known: true, at: new Date(Date.now() - 40 * 86400000).toISOString() } : { known: true, at: null }),
    variable: async (pid, ev, scope, key) => (key === 'deaths' ? '13' : ''),
})) conditions.registerConditionType(d);

const profile = { id: 1, ownerDiscordId: '1' };
const twitchChan = { platform: 'twitch', platform_user_id: '42', login: 'maple' };
const kickChan = { platform: 'kick', platform_user_id: '77', login: 'maplek' };
const io = { channelsFor: async () => [twitchChan, kickChan] };
const chatEv = (o = {}) => ({ platform: 'twitch', type: 'chat', channelId: '42', user: { id: '100', login: 'viewer', name: 'Viewer', roles: [] }, message: '!hi', metadata: { messageId: 'abc-1' }, ...o });
async function run(step, ev = chatEv(), extra = {}) {
    const def = actions.actionType(step.type);
    const v = actions.validateActions([step], { automationIds: new Set([5]) });
    assert.deepEqual(v.errors, [], `${step.type}: ${v.errors.join(' ')}`);
    return def.execute(v.value[0], { profile, ev, io, dryRun: false, render: async (t) => String(t).replace('{arg1}', 'baddie'), store: extra.store, automation: { id: 9 }, ...extra });
}

// ── events ──
test('Twitch moderation, rewards, goals and title changes become stream bot events', () => {
    _resetInfo();
    const ban = events.normaliseTwitch('channel.ban', { broadcaster_user_id: '42', user_id: '1', user_login: 'x', user_name: 'X', moderator_user_name: 'Mod', reason: 'spam', is_permanent: true, banned_at: '2026-11-20T00:00:00Z' });
    assert.equal(ban.type, 'mod.ban');
    assert.equal(ban.metadata.moderator, 'Mod');
    const to = events.normaliseTwitch('channel.ban', { broadcaster_user_id: '42', user_id: '1', user_login: 'x', is_permanent: false, banned_at: '2026-11-20T00:00:00Z', ends_at: '2026-11-20T00:10:00Z' });
    assert.equal(to.type, 'mod.timeout');
    assert.equal(to.amount, 600);
    assert.equal(events.normaliseTwitch('channel.unban', { broadcaster_user_id: '42', user_id: '1' }).type, 'mod.unban');
    const cs = events.normaliseTwitch('channel.chat_settings.update', { broadcaster_user_id: '42', slow_mode: true, slow_mode_wait_time_seconds: 10 });
    assert.equal(cs.type, 'mod.chat_mode');
    assert.match(cs.message, /slow mode on/);
    const vip = events.normaliseTwitch('channel.vip.add', { broadcaster_user_id: '42', user_id: '1', user_login: 'x' });
    assert.deepEqual([vip.type, vip.metadata.role, vip.metadata.change], ['mod.role', 'vip', 'add']);
    assert.equal(events.normaliseTwitch('automod.message.hold', { broadcaster_user_id: '42', user_id: '1', message: { text: 'hi' }, message_id: 'm' }).type, 'automod.held');
    const g = events.normaliseTwitch('channel.goal.progress', { broadcaster_user_id: '42', id: 'g', type: 'follower', description: 'Road', current_amount: 120, target_amount: 1000 });
    assert.deepEqual([g.type, g.amount, g.currency, g.metadata.target], ['goal.progress', 120, 'followers', 1000]);
    const up = events.normaliseTwitch('channel.channel_points_custom_reward_redemption.update', { broadcaster_user_id: '42', id: 'r', status: 'canceled', reward: { id: 'w', title: 'Hydrate', cost: 100 }, user_id: '1' });
    assert.deepEqual([up.type, up.metadata.status], ['redemption.updated', 'refunded']);
    const a = events.normaliseTwitch('channel.update', { broadcaster_user_id: '42', title: 'A', category_name: 'Celeste' });
    const b = events.normaliseTwitch('channel.update', { broadcaster_user_id: '42', title: 'B', category_name: 'Celeste' });
    assert.equal(a.metadata.titleChanged && a.metadata.categoryChanged, true);
    assert.deepEqual([b.metadata.titleChanged, b.metadata.categoryChanged], [true, false]);
    assert.match(events.describeEvent(ban), /was banned by Mod/);
    // The built-in converter still handles its own types.
    assert.equal(events.normaliseTwitch('channel.cheer', { broadcaster_user_id: '42', bits: 5 }).type, 'cheer');
});

test('Kick bans, Kicks, reward redemptions and title changes', () => {
    const b = { broadcaster: { user_id: 77 } };
    const ban = events.normaliseKick('moderation.banned', { ...b, banned_user: { user_id: 5, username: 'x' }, moderator: { username: 'm' }, metadata: { reason: 'r', created_at: '2026-11-20T00:00:00Z', expires_at: '2026-11-20T00:05:00Z' } });
    assert.deepEqual([ban.type, ban.amount], ['mod.timeout', 300]);
    assert.equal(events.normaliseKick('moderation.banned', { ...b, banned_user: { user_id: 5 }, metadata: { expires_at: null } }).type, 'mod.ban');
    const k = events.normaliseKick('kicks.gifted', { ...b, sender: { user_id: 6, username: 'g' }, gift: { amount: 100, name: 'Rage Quit' } });
    assert.deepEqual([k.type, k.amount, k.currency], ['kicks.gifted', 100, 'kicks']);
    const pending = events.normaliseKick('channel.reward.redemption.updated', { ...b, id: 'R', status: 'pending', reward: { id: 'w', title: 'Hydrate', cost: 50 }, redeemer: { user_id: 6, username: 'g' } });
    assert.deepEqual([pending.type, pending.platform, pending.metadata.redemptionId], ['redemption', 'kick', 'R']);
    assert.equal(events.normaliseKick('channel.reward.redemption.updated', { ...b, id: 'R', status: 'rejected', reward: {} }).metadata.status, 'refunded');
    assert.equal(events.normaliseKick('livestream.metadata.updated', { ...b, metadata: { title: 't', category: { name: 'c' } } }).type, 'stream.updated');
    assert.equal(events.normaliseKick('chat.message.sent', { ...b, sender: { user_id: 1 }, content: 'hi' }).type, 'chat');
});

// ── triggers ──
test('Trigger settings: viewer step, ad minutes, role change kind and the queue option', () => {
    const v = conditions.validateTrigger('stream.viewers', { step: 25, queue: { name: 'Voice', blocking: true } });
    assert.deepEqual(v.value, { step: 25, queue: { name: 'Voice', blocking: true } });
    assert.equal(conditions.validateTrigger('stream.viewers', { step: 0 }).ok, false);
    assert.equal(conditions.validateTrigger('follow', { queue: { name: 'bad/name' } }).ok, false);
    const auto = (type, cfg) => ({ trigger_type: type, trigger_config: cfg });
    const vev = (prev, cur) => ({ type: 'stream.viewers', platform: 'twitch', amount: cur, metadata: { previous: prev } });
    assert.equal(conditions.triggerMatches(auto('stream.viewers', { step: 10 }), vev(48, 52)), true);
    assert.equal(conditions.triggerMatches(auto('stream.viewers', { step: 10 }), vev(51, 55)), false);
    assert.equal(conditions.triggerMatches(auto('ad.upcoming', { minutes: 2 }), { type: 'ad.upcoming', platform: 'twitch', metadata: { minutes: 2 } }), true);
    assert.equal(conditions.triggerMatches(auto('ad.upcoming', { minutes: 5 }), { type: 'ad.upcoming', platform: 'twitch', metadata: { minutes: 2 } }), false);
    assert.equal(conditions.triggerMatches(auto('mod.role', { kind: 'remove' }), { type: 'mod.role', platform: 'twitch', metadata: { change: 'add' } }), false);
    assert.equal(conditions.validateTrigger('stream.updated', { what: 'nonsense' }).value.what, 'any');
});

// ── conditions ──
test('Days, time windows (also past midnight) and value comparisons', () => {
    assert.deepEqual([...parseDays('Mon-Fri')].sort(), [1, 2, 3, 4, 5]);
    assert.deepEqual([...parseDays('fri-mon')].sort(), [0, 1, 5, 6]);
    assert.equal(parseDays('funday'), null);
    const fri2330 = Date.parse('2026-11-20T23:30:00Z');   // a Friday
    const sat0100 = Date.parse('2026-11-21T01:00:00Z');
    const c = { days: 'fri', from: '22:00', until: '02:00', timezone: 'UTC' };
    assert.equal(inWindow(c, fri2330).ok, true);
    assert.equal(inWindow(c, sat0100).ok, true, 'Friday night window still open after midnight');
    assert.equal(inWindow({ ...c, days: 'sat' }, sat0100).ok, false);
    assert.equal(inWindow({ days: '', from: '', until: '', timezone: 'Nowhere/Zone' }, fri2330).ok, false);
    assert.equal(compareValue('gt', '13', '10'), true);
    assert.equal(compareValue('empty', '', ''), true);
    assert.equal(compareValue('eq', 'Celeste', 'celeste'), true);
});

test('Conditions read their data once and check it', async () => {
    const list = conditions.validateConditions([
        { type: 'stream.live', state: 'live' }, { type: 'stream.category', op: 'eq', value: 'Hades|Celeste' },
        { type: 'stream.viewers', min: 10, max: 100 }, { type: 'variable.value', scope: 'channel', key: 'deaths', op: 'gt', value: '10' },
        { type: 'follow.check', state: 'follows', days: 30 },
    ]);
    assert.deepEqual(list.errors, []);
    const ev = { platform: 'twitch', type: 'chat', user: { id: 'f' } };
    const data = await conditions.loadConditionData(list.value, ev, { profileId: 1 });
    const r = conditions.checkConditions(list.value, ev, { loaded: data });
    assert.equal(r.ok, true, JSON.stringify(r.results));
    const notFollowing = await conditions.loadConditionData(list.value, { ...ev, user: { id: 'n' } }, { profileId: 1 });
    assert.equal(conditions.checkConditions(list.value, { ...ev, user: { id: 'n' } }, { loaded: notFollowing }).failed.type, 'follow.check');
    const bad = conditions.validateConditions([{ type: 'time.window', days: 'x', from: '25:00', until: '', timezone: 'Mars/Base' }]);
    assert.equal(bad.errors.length >= 3, true);
});

// ── queues ──
test('A blocking queue runs one at a time, in order; pause, resume and clear', async () => {
    const q = createQueues();
    const order = [];
    let release;
    const first = q.gate(profile, { id: 1, trigger_config: { queue: { name: 'Voice', blocking: true } } }, () => new Promise((r) => { order.push('a start'); release = () => { order.push('a end'); r('a'); }; }));
    const second = q.gate(profile, { id: 2, trigger_config: { queue: { name: 'voice', blocking: true } } }, async () => { order.push('b'); return 'b'; });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(order, ['a start']);
    assert.equal(q.pending(1), 1);
    release();
    assert.deepEqual([await first, await second], ['a', 'b']);
    assert.deepEqual(order, ['a start', 'a end', 'b']);
    q.pause(1, 'Voice');
    const held = q.gate(profile, { id: 3, trigger_config: { queue: { name: 'Voice' } } }, async () => 'c');
    const dropped = q.gate(profile, { id: 4, trigger_config: { queue: { name: 'Voice' } } }, async () => 'd');
    await new Promise((r) => setImmediate(r));
    assert.equal(q.pending(1, 'Voice'), 2);
    q.resume(1, 'Voice');
    assert.equal(await held, 'c');
    assert.equal(await dropped, 'd');
    q.pause(1, 'Voice');
    const gone = q.gate(profile, { id: 5, trigger_config: { queue: { name: 'Voice' } } }, async () => 'e');
    assert.equal(q.clear(1, 'Voice'), 1);
    assert.equal((await gone).status, 'skipped');
    assert.equal(await q.gate(profile, { id: 6, trigger_config: {} }, async () => 'free'), 'free');
    assert.deepEqual(q.vars.values({ profileId: 1, template: '{queue.pending}' }), { 'queue.pending': '0' });
});

test('The engine asks the run gate before each event run', async () => {
    let gated = 0;
    const store = {
        enabledAutomationsFor: async () => [{ id: 1, name: 'A', enabled: true, trigger_type: 'follow', trigger_config: {}, conditions: [], actions: [{ type: 'args.set', name: 'x', value: '1' }] }],
        createRun: async () => 1, finishRun: async () => {}, touchAutomation: async () => {},
    };
    const engine = createEngine({ store, render: async (t) => t, io: { channelsFor: async () => [] } });
    engine.setRunGate((p, a, start) => { gated++; return start(); });
    const out = await engine.handleEvent(profile, { platform: 'twitch', type: 'follow', metadata: {} });
    assert.equal(gated, 1);
    assert.equal(out[0].status, 'ok');
});

// ── actions ──
test('Moderation steps act on the event viewer or a named one, and say what they did', async () => {
    calls.length = 0;
    assert.equal((await run({ type: 'mod.timeout', platform: 'event', who: 'event', seconds: 30, reason: '' })).status, 'ok');
    assert.deepEqual(calls.pop(), ['ban', { userId: '100', seconds: 30, reason: '' }]);
    assert.equal((await run({ type: 'mod.ban', platform: 'twitch', who: 'named', viewer: '{arg1}' })).status, 'ok');
    assert.deepEqual(calls.pop(), ['ban', { userId: '555', reason: '' }]);
    assert.equal((await run({ type: 'mod.timeout', platform: 'event', who: 'event', seconds: 10 }, chatEv({ platform: 'kick', channelId: '77' }))).status, 'ok');
    assert.deepEqual(calls.pop(), ['kban', '100', { seconds: 60 }], 'Kick timeouts are whole minutes, at least one');
    await run({ type: 'mod.chat_mode', mode: 'slow', state: 'on', value: 30 });
    assert.deepEqual(calls.pop(), ['chat', { slow_mode: true, slow_mode_wait_time: 30 }]);
    await run({ type: 'mod.vip', platform: 'event', who: 'event', change: 'remove' });
    assert.deepEqual(calls.pop(), ['vip', '100', false]);
    const broad = await run({ type: 'mod.ban', platform: 'event', who: 'event' }, chatEv({ user: { id: '1', name: 'Me', roles: ['broadcaster'] } }));
    assert.equal(broad.status, 'skipped');
    const yt = await run({ type: 'mod.ban', platform: 'event', who: 'event' }, chatEv({ platform: 'youtube' }));
    assert.equal(yt.status, 'skipped');
    const dry = await run({ type: 'mod.warn', platform: 'event', who: 'event', reason: 'read the rules' }, chatEv(), { dryRun: true });
    assert.equal(dry.status, 'dry');
    assert.equal(actions.validateActions([{ type: 'mod.warn', platform: 'event', who: 'event', reason: '' }]).ok, false);
});

test('A missing Twitch permission says "Reconnect Twitch to enable"', async () => {
    const r = friendlyError(Object.assign(new Error('x'), { code: 'missing_scope', missing: ['channel:manage:vips'] }));
    assert.equal(r.status, 'skipped');
    assert.match(r.detail, /^Reconnect Twitch to enable this/);
    const saved = fakeTwitch.shield;
    fakeTwitch.shield = async () => { throw Object.assign(new Error('x'), { code: 'missing_scope', missing: ['moderator:manage:shield_mode'] }); };
    const out = await run({ type: 'mod.shield', platform: 'twitch', state: 'on' });
    fakeTwitch.shield = saved;
    assert.equal(out.status, 'skipped');
    assert.match(out.detail, /Reconnect Twitch/);
});

test('On and off steps for automations, timers and channel commands', async () => {
    calls.length = 0;
    const store = { getAutomation: async (pid, id) => ({ id, name: 'Hype', enabled: true }), setAutomationEnabled: async (pid, id, on) => calls.push(['auto', id, on]) };
    assert.equal((await run({ type: 'automation.state', automationId: 5, state: 'toggle' }, chatEv(), { store })).detail, 'Hype is off');
    assert.deepEqual(calls.slice(0, 2), [['auto', 5, false], ['notify']]);
    assert.equal((await run({ type: 'timer.state', timer: 'Hydrate', state: 'off' })).status, 'ok');
    assert.deepEqual(calls.pop(), ['timer', [7], false]);
    assert.equal((await run({ type: 'timer.reset', timer: 'nope' })).status, 'failed');
    assert.equal((await run({ type: 'command.state', command: '!discord', platform: 'all', state: 'off' })).status, 'ok');
    assert.deepEqual(calls.pop(), ['cmd', 1, false]);
});

test('Reward and redemption steps', async () => {
    calls.length = 0;
    const r = await run({ type: 'reward.update', platform: 'twitch', reward: 'hydrate', enabled: 'no', paused: 'keep', cost: '250', cooldown: 0 });
    assert.equal(r.status, 'ok');
    assert.deepEqual(calls.pop(), ['reward', 'r1', { is_enabled: false, cost: 250, is_global_cooldown_enabled: false }]);
    assert.equal((await run({ type: 'reward.update', platform: 'twitch', reward: 'Missing', paused: 'yes' })).status, 'failed');
    assert.equal(actions.validateActions([{ type: 'reward.update', platform: 'twitch', reward: 'x', enabled: 'keep', paused: 'keep' }]).ok, false, 'nothing to change');
    const ev = { platform: 'twitch', type: 'redemption', channelId: '42', user: { id: '1' }, metadata: { reward: 'Hydrate', rewardId: 'r1', redemptionId: 'x1' } };
    assert.equal((await run({ type: 'redemption.update', result: 'refund' }, ev)).status, 'ok');
    assert.deepEqual(calls.pop(), ['redeem', { rewardId: 'r1', redemptionId: 'x1', status: 'CANCELED' }]);
    await run({ type: 'redemption.update', result: 'fulfil' }, { ...ev, platform: 'kick', channelId: '77' });
    assert.deepEqual(calls.pop(), ['kredeem', 'x1', true]);
    assert.equal((await run({ type: 'redemption.update', result: 'fulfil' }, chatEv())).status, 'skipped');
});

test('Marker, snooze, cancel raid, reply and run program', async () => {
    const m = await run({ type: 'stream.marker', description: 'boss' });
    assert.deepEqual([m.status, m.vars['marker.time']], ['ok', '1:02:05']);
    assert.match((await run({ type: 'stream.ad_snooze' })).detail, /2 snoozes left/);
    assert.equal((await run({ type: 'stream.raid_cancel' })).status, 'ok');
    calls.length = 0;
    assert.equal((await run({ type: 'chat.reply', text: 'hello {arg1}' })).status, 'ok');
    assert.deepEqual(calls.pop(), ['reply', 'twitch', 'abc-1', 'hello baddie']);
    assert.equal((await run({ type: 'chat.reply', text: 'x' }, { type: 'follow', platform: 'twitch', metadata: {} })).status, 'skipped');
    assert.equal(actions.actionType('system.run').target, 'studio');
    assert.equal(actions.validateActions([{ type: 'system.run', program: 'rm -rf /' }]).ok, false);
    assert.equal(actions.validateActions([{ type: 'system.run', program: 'Notepad' }]).ok, true);
});

// ── platform calls ──
test('Helix and Kick calls use documented endpoints with the right scope', async () => {
    const seen = [];
    const helix = { call: async (pid, method, path, o) => { seen.push({ method, path, need: o?.need, query: typeof o?.query === 'function' ? o.query({ userId: '42' }) : o?.query, body: typeof o?.body === 'function' ? o.body({ userId: '42' }) : o?.body }); return { data: { data: [{ position_seconds: 5 }] } }; } };
    const t = createTwitchControl({ helix });
    await t.unban(1, '9');
    await t.chatSettings(1, { emote_mode: true });
    await t.snoozeAd(1);
    await t.cancelRaid(1);
    await t.marker(1, 'x');
    assert.deepEqual(seen.map((s) => `${s.method} ${s.path} ${s.need}`), [
        'DELETE /moderation/bans moderator:manage:banned_users', 'PATCH /chat/settings moderator:manage:chat_settings',
        'POST /channels/ads/schedule/snooze channel:manage:ads', 'DELETE /raids channel:manage:raids', 'POST /streams/markers channel:manage:broadcast',
    ]);
    assert.deepEqual(seen[0].query, { broadcaster_id: '42', moderator_id: '42', user_id: '9' });
    const fetched = [];
    const k = createKickControl({
        resolveChannel: async () => ({ token: 'tok', scopes: 'moderation:ban channel:rewards:write chat:write channel:read' }),
        fetchImpl: async (url, o) => { fetched.push(`${o.method} ${url} ${o.body || ''}`); return { ok: true, status: 200, json: async () => ({ data: [] }) }; },
    });
    await k.unban('77', '5');
    await k.redemption('77', 'R', false);
    await k.reply('77', 'hi', 'msg-1');
    assert.match(fetched[0], /^DELETE https:\/\/api\.kick\.com\/public\/v1\/moderation\/bans/);
    assert.match(fetched[1], /redemptions\/reject .*"ids":\["R"\]/);
    assert.match(fetched[2], /"reply_to_message_id":"msg-1"/);
    const noScope = createKickControl({ resolveChannel: async () => ({ token: 'tok', scopes: 'chat:write' }), fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
    await assert.rejects(noScope.rewards('77'), /needs permission/);
});

test('Scopes: the new ones are requested, never follows or revenue', () => {
    for (const s of ['moderator:manage:chat_settings', 'channel:manage:vips', 'channel:manage:moderators', 'moderator:manage:shield_mode', 'moderator:manage:warnings',
        'moderator:read:suspicious_users', 'moderator:manage:automod', 'channel:read:goals', 'channel:manage:ads', 'channel:moderate', 'moderation:read']) {
        assert.ok(STREAM_BOT_SCOPES.includes(s), s);
    }
    for (const f of FORBIDDEN_SCOPES) assert.ok(!STREAM_BOT_SCOPES.includes(f), f);
    assert.ok(reapproveNeeded(['user:read:chat']).includes('Change chat modes'));
    assert.ok(KICK_CHANNEL_BOT_SCOPES.includes('channel:rewards:write'));
});

// ── chat polls ──
test('Chat polls count one vote per viewer and end with Twitch-shaped events', async () => {
    const raised = [];
    const said = [];
    const timers = [];
    const p = createChatPolls({ raise: (pid, ev) => raised.push(ev), say: async (pid, pl, t) => said.push(t), setTimer: (fn) => { timers.push(fn); return 1; }, clearTimer: () => {} });
    const r = await p.start(1, { title: 'Next game?', choices: ['Celeste', 'Hades'], seconds: 60, platforms: ['kick', 'youtube'] });
    assert.equal(r.ok, true);
    assert.equal((await p.start(1, { title: 'x', choices: ['a', 'b'], seconds: 15, platforms: ['kick'] })).ok, false);
    const vote = (id, text, platform = 'kick') => p.onChat(1, { type: 'chat', platform, user: { id }, message: text });
    assert.equal(vote('a', '!vote 1'), true);
    assert.equal(vote('a', '!vote 2'), true, 'a new vote replaces the old one');
    vote('b', '!vote 2');
    vote('c', '!vote 1');
    vote('d', '!vote 9');
    assert.equal(vote('e', '!vote 1', 'twitch'), false, 'Twitch chat is not in this poll');
    const end = await p.end(1);
    assert.equal(end.winner, 'Hades');
    assert.deepEqual(raised.map((e) => e.type), ['poll.begin', 'poll.end']);
    assert.deepEqual(raised[1].metadata.choices, [{ title: 'Celeste', votes: 1 }, { title: 'Hades', votes: 2 }]);
    assert.equal(raised[1].internal, true);
    assert.match(said[0], /!vote/);
    assert.match(said[1], /Hades wins/);
    for (const t of ['poll.begin', 'poll.progress', 'poll.end']) assert.ok(INTERNAL_TYPES.includes(t));
});

// ── service ──
test('First words, viewer arrived, viewer count steps and upcoming ads', async () => {
    let t = Date.parse('2026-11-20T20:00:00Z');
    const raised = [];
    const db = { query: async (sql) => (sql.includes('FROM `stream_bot_viewers`') ? [[]] : [[{ profile_id: 1, trigger_type: 'stream.viewers', trigger_config: '{}' }, { profile_id: 1, trigger_type: 'ad.upcoming', trigger_config: '{"minutes":2}' }]]) };
    let viewers = 10;
    const svc = createControlService({
        db, now: () => t, raise: (pid, ev) => raised.push(ev), ignoreLogins: ['certifriedbot'],
        io: { channelsFor: async () => [twitchChan] },
        streamInfo: { get: async () => ({ live: true, viewers }) },
        twitch: { adSchedule: async () => ({ nextAdAt: t + 110_000, length: 90, snoozes: 3 }), followedAt: async () => '2025-11-20T00:00:00Z', userInfo: async () => ({ createdAt: '2020-01-01T00:00:00Z' }) },
    });
    const pub = (id, login = 'v') => ({ type: 'chat', platform: 'twitch', channelId: '42', user: { id, login, roles: [] }, message: 'hi' });
    await svc.onPublish(1, pub('1'));
    await svc.onPublish(1, pub('1'));
    await svc.onPublish(1, pub('2', 'certifriedbot'));
    assert.deepEqual(raised.map((e) => e.type).sort(), ['chat.arrived', 'chat.first_words']);
    await svc.onPublish(1, { type: 'stream.online', platform: 'twitch', channelId: '42' });
    await svc.onPublish(1, pub('1'));
    assert.equal(raised.filter((e) => e.type === 'chat.arrived').length, 2, 'arrives again on the next stream');
    raised.length = 0;
    await svc.tick();
    viewers = 23;
    await svc.tick();
    const vc = raised.find((e) => e.type === 'stream.viewers');
    assert.deepEqual([vc.amount, vc.metadata.previous], [23, 10]);
    const ad = raised.filter((e) => e.type === 'ad.upcoming');
    assert.equal(ad.length, 1, 'once per ad and threshold');
    assert.equal(ad[0].metadata.minutes, 2);
    const vals = await svc.userValues({ ev: { platform: 'twitch', user: { id: '1' } }, profileId: 1, template: '{user.followage} {user.accountage}' });
    assert.equal(vals['user.followage'], '1 year');
    assert.match(vals['user.accountage'], /^6 years/);
    assert.equal(formatAge(0, 3 * 86400000), '3 days');
});

test('ingest takes the stream bot\'s own viewer events once allowed', async () => {
    const handled = [];
    const store = { getProfile: async () => ({ id: 1, enabled: true }), insertEvent: async () => 99 };
    const ingest = createIngest({ store, engine: { handleEvent: async (p, ev) => handled.push(ev.type) }, feed: { publish: () => {} } });
    const ev = { platform: 'twitch', type: 'chat.arrived', channelId: '42', user: { id: '1' }, metadata: {}, internal: true, occurredAt: new Date() };
    assert.equal(await ingest.internal(1, ev), 0);
    ingest.allowInternal('chat.arrived', { store: false });
    assert.equal(await ingest.internal(1, ev), 1);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(handled, ['chat.arrived']);
});

// ── {math:} and !permit ──
test('{math:} works out sums safely, with variables inside', async () => {
    assert.equal(evaluateMath('2*(3+4)^2 - 10 % 3').text, '97');
    assert.equal(evaluateMath('round(10/3, 2)').text, '3.33');
    assert.equal(evaluateMath('max(1,5,3) + 1000').text, '1005');
    assert.equal(evaluateMath('process.exit()').ok, false);
    assert.equal(evaluateMath('1/0').ok, false);
    const { text } = await renderTemplate('{math:{arg1}*2} and {math:{random:5-5}+1}', { values: {}, args: ['7'] });
    assert.equal(text, '14 and 6');
    assert.ok(validateTemplate('{math:2+}').warnings.some((w) => /cannot work out/.test(w)));
});

test('!permit lets one viewer post links for a minute', () => {
    _clearPermits();
    assert.equal(parsePermit('!permit @Some_One'), 'some_one');
    assert.equal(parsePermit('!permit'), null);
    const t = 1_000_000;
    grantPermit('kick:5', 'Some_One', 60_000, t);
    assert.equal(hasPermit('kick:5', 'some_one', t + 59_000), true);
    assert.equal(hasPermit('kick:5', 'some_one', t + 61_000), false);
    assert.equal(hasPermit('kick:6', 'some_one', t), false);
});
