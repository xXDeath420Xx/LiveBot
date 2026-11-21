import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../utils/db.js';
import { makeTables, makeProfile } from './fixtures/stream-bot-tables.js';
import { importDdl, IMPORT_TABLES } from '../migrations/455_stream_bot_imports.js';
import { normaliseTwitch, describeEvent } from '../core/stream-bot/events.js';
import { triggerMatches, validateTrigger } from '../core/stream-bot/conditions.js';
import { templateValues } from '../core/stream-bot/render.js';
import { validateActions, actionType, isStreamAction } from '../core/stream-bot/actions.js';
import { createHelix } from '../core/stream-bot/helix.js';
import { createStreamActions } from '../core/stream-bot/stream-actions.js';
import { STREAM_BOT_SCOPES, reapproveNeeded } from '../core/stream-bot/scopes.js';
import { convertEffects, parseFirebot } from '../core/stream-bot/import/firebot.js';
import { convertSubActions, parseStreamerbot } from '../core/stream-bot/import/streamerbot.js';
import { buildPlan as buildImportPlan } from '../core/stream-bot/import/mapper.js';
import { createImportStore, applyPlan } from '../core/stream-bot/import/apply.js';
import { buildPlan as buildSwitchPlan, attentionFor } from '../core/stream-bot/switchover.js';

/*
 * The 2026-11-20 import audit of the owner's Firebot and Streamer.bot setups (design doc §14):
 *   - custom power-ups (EventSub channel.bits.use type custom_power_up) reach automations, matched by the power-up's id;
 *   - "Send a chat message as you" (stream.say, user:write:chat) for lines other bots act on (Firebot "chat as Streamer",
 *     Streamer.bot "Use bot" off);
 *   - the import remembers what was switched off in the source (sourceOn) and the switchover leaves those off unless ticked;
 *   - an item the owner removed (dismissItem) is never imported again; untouched stream bot timers follow the mapping.
 * Invented data and throwaway tables only; nothing reaches Twitch, Kick, OBS or Studio.
 */

const bitsUse = (extra) => normaliseTwitch('channel.bits.use', { broadcaster_user_id: '900000001', user_id: '5', user_login: 'juniper', user_name: 'Juniper',
    bits: 500, message: { text: '', fragments: [] }, power_up: null, custom_power_up: null, ...extra });

test('custom power-ups: normalised with id and title, matched by kind and id, shown by title', () => {
    const ev = bitsUse({ type: 'custom_power_up', custom_power_up: { title: 'Volcano', reward_id: 'cp-1' } });
    assert.deepEqual([ev.metadata.kind, ev.metadata.powerUpId, ev.metadata.powerUpTitle], ['custom_power_up', 'cp-1', 'Volcano']);
    const auto = (cfg, conditions = []) => ({ trigger_type: 'bits.used', trigger_config: { platforms: ['twitch'], ...cfg }, conditions });
    assert.equal(triggerMatches(auto({ bitsKind: 'custom_power_up' }), ev), true);
    assert.equal(triggerMatches(auto({ bitsKind: 'power_up' }), ev), false, 'the built-in power-up kind is not a custom one');
    assert.equal(triggerMatches(auto({ bitsKind: 'any' }), ev), true);
    assert.equal(validateTrigger('bits.used', { bitsKind: 'custom_power_up' }).value.bitsKind, 'custom_power_up');
    assert.equal(templateValues(ev).powerup, 'Volcano');
    assert.match(describeEvent(ev), /Volcano power-up/);
    const builtIn = bitsUse({ type: 'power_up', power_up: { type: 'celebration', emote: null } });
    assert.equal(builtIn.metadata.powerUpId, undefined);
    assert.equal(templateValues(builtIn).powerup, 'celebration');
});

test('stream.say: a Twitch line from the streamer, validated, sent through Helix with user:write:chat; old grants are told to re-approve', async () => {
    assert.ok(STREAM_BOT_SCOPES.includes('user:write:chat'));
    assert.ok(reapproveNeeded(STREAM_BOT_SCOPES.filter((s) => s !== 'user:write:chat')).includes('Send chat messages as you'));
    assert.equal(isStreamAction('stream.say'), true);
    assert.deepEqual(actionType('stream.say').platforms, ['twitch']);
    assert.equal(validateActions([{ type: 'stream.say', text: '  ' }]).ok, false);
    assert.deepEqual(validateActions([{ type: 'stream.say', text: '!pokecatch ultraball', extra: 1 }]).value, [{ type: 'stream.say', text: '!pokecatch ultraball' }]);
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return { ok: true, status: 200, json: async () => ({ data: [{ message_id: 'm1', is_sent: true }] }) }; };
    const needs = [];
    const helix = createHelix({ auth: { token: async (pid, o = {}) => { needs.push(...(o.need || [])); return { token: 'tok', userId: '900000001' }; } }, fetchImpl, clientId: 'cid' });
    const sa = createStreamActions({ helix, kick: {}, sendChat: async () => ({ ok: true }) });
    const ctx = { profile: { id: 1 }, ev: { platform: 'twitch' }, render: async (t) => t, dryRun: false, channels: [{ platform: 'twitch', platform_user_id: '900000001', login: 'maplehollow_tv' }] };
    const r = await sa.run({ type: 'stream.say', text: '!pokecatch ultraball' }, ctx);
    assert.equal(r.status, 'ok', r.detail);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/helix\/chat\/messages$/);
    assert.deepEqual(JSON.parse(calls[0].init.body), { broadcaster_id: '900000001', sender_id: '900000001', message: '!pokecatch ultraball' });
    assert.deepEqual(needs, ['user:write:chat']);
    assert.equal((await sa.run({ type: 'stream.say', text: 'hi' }, { ...ctx, dryRun: true })).status, 'dry');
    assert.equal((await sa.run({ type: 'stream.say', text: 'hi' }, { ...ctx, channels: [] })).status, 'skipped');
    const dropped = createHelix({ auth: { token: async () => ({ token: 'tok', userId: '1' }) }, clientId: 'cid',
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ message_id: '', is_sent: false, drop_reason: { message: 'blocked' } }] }) }) });
    await assert.rejects(dropped.sayAsBroadcaster(1, 'x'), /blocked/);
});

test('importer: lines sent as the streamer become stream.say; bot lines and replies stay with the bot; custom power-ups keyed by id', () => {
    const fb = convertEffects([
        { type: 'firebot:chat', chatter: 'Streamer', message: '!pokecatch ultraball' },
        { type: 'firebot:chat', chatter: 'Streamer', message: 'Thanks $user' },
        { type: 'firebot:chat', chatter: 'Bot', message: '!roll' },
    ], { counters: new Map() });
    assert.deepEqual(fb.actions.map((a) => a.type), ['stream.say', 'chat.send', 'chat.send']);
    const emotes = convertEffects([{ type: 'firebot:chat', message: 'PansexualPride death01Love' }, { type: 'firebot:chat', message: 'Join the grove on Discord' }], { counters: new Map(), timer: true });
    assert.deepEqual(emotes.actions.map((a) => a.type), ['stream.say', 'chat.send'], 'only emote-only lines need the account of the streamer');
    const sb = convertSubActions([
        { id: 'a', type: 10, text: '!cheers', useBot: false, index: 0 },
        { id: 'b', type: 10, text: '!dab+', useBot: true, index: 1 },
    ]);
    assert.deepEqual(sb.actions.map((a) => a.type), ['stream.say', 'chat.send']);

    const files = new Map([
        ['actions.json', Buffer.from(JSON.stringify({ actions: [
            { id: 'pu', name: 'Volcano', enabled: true, triggers: [{ id: 't', type: 496, customPowerUpId: 'cp-1', enabled: true }], subActions: [{ id: 's', type: 23, text: 'Boom', color: 0, index: 0 }] },
            { id: 'ck', name: 'Cheers', enabled: true, triggers: [{ id: 't2', type: 401, commandId: 'c1', enabled: true }], subActions: [{ id: 's2', type: 10, text: '!cheers', useBot: false, index: 0 }] },
        ] }))],
        ['commands.json', Buffer.from(JSON.stringify({ commands: [{ id: 'c1', command: '!toast', enabled: false, mode: 0, location: 0, sources: 1, permittedGroups: [] }] }))],
    ]);
    const b = parseStreamerbot({ files });
    const pu = b.automations.find((a) => a.name === 'Volcano');
    assert.equal(pu.trigger.config.bitsKind, 'custom_power_up');
    assert.deepEqual(pu.trigger.conditions, [{ type: 'metadata', path: 'powerUpId', op: 'eq', value: 'cp-1' }]);
    const plan = buildImportPlan([b], { channels: [{ platform: 'twitch', platformUserId: '900000001' }], channelBots: [] });
    const toast = plan.items.find((i) => i.name === '!toast');
    assert.equal(toast.sourceOn, false, 'a command switched off in Streamer.bot is marked');
    assert.deepEqual(toast.target.draft.actions, [{ type: 'stream.say', text: '!cheers' }]);
    assert.equal(plan.items.find((i) => i.name === 'Volcano').sourceOn, true);
});

test('Firebot timers keep their off state; a single streamer line becomes a timer that runs a stream.say automation; !clear for anyone is flagged', () => {
    const files = new Map([
        ['timers.json', Buffer.from(JSON.stringify([{ id: 't1', name: 'Thoughts', active: false, interval: 1800, requiredChatLines: 5, onlyWhenLive: true,
            effects: { list: [{ type: 'firebot:chat', chatter: 'Streamer', message: '!stonedthoughts' }] } }]))],
        ['chat/commands.json', Buffer.from(JSON.stringify({ customCommands: [{ id: 'c1', trigger: '!clear', active: true, effects: { list: [{ type: 'firebot:chat', message: '/clear' }] } }] }))],
    ]);
    const b = parseFirebot({ files });
    const plan = buildImportPlan([b], { channels: [{ platform: 'twitch', platformUserId: '900000001' }], channelBots: [] });
    const timer = plan.items.find((i) => i.kind === 'timer');
    const action = plan.items.find((i) => i.kind === 'timer_action');
    assert.equal(timer.sourceOn, false);
    assert.equal(action.sourceOn, false);
    assert.deepEqual(action.target.draft.actions, [{ type: 'stream.say', text: '!stonedthoughts' }]);
    assert.ok(timer.why.some((w) => /switched off in Firebot/.test(w)));
    const clear = plan.items.find((i) => i.name === '!clear');
    assert.ok(clear.why.some((w) => /check it before turning it on/.test(w)));
    assert.ok(attentionFor({ actions: [{ type: 'chat.clear' }] }, { notes: clear.why }).length > 0, 'the switchover holds it for a look');
});

test('switchover: items off in the source stay off unless ticked; stream.say waits for the re-approved grant', () => {
    const A = (id, name, actions) => ({ id, name, enabled: false, trigger_type: 'chat', trigger_config: {}, conditions: [], actions });
    const automations = [A(1, 'Firebot: Pokemon', [{ type: 'stream.say', text: '!pokecheck' }]), A(2, 'Firebot: Timer: Roll', [{ type: 'stream.say', text: '!roll' }]), A(3, 'Firebot: !dab+', [{ type: 'variable.increment', key: 'dabs', by: 1 }])];
    const items = [
        { source: 'firebot', kind: 'event', source_id: 'e1', target_kind: 'automation', target_ref: 'automation:1', data: { sourceOn: true } },
        { source: 'firebot', kind: 'timer_action', source_id: 't1', target_kind: 'automation', target_ref: 'automation:2', data: { sourceOn: false } },
        { source: 'firebot', kind: 'command', source_id: 'c1', target_kind: 'automation', target_ref: 'automation:3', data: {} },
        { source: 'firebot', kind: 'timer', source_id: 't1', target_kind: 'bot_timer', target_ref: 'timer:7', data: { sourceOn: false } },
        { source: 'firebot', kind: 'command', source_id: 'c9', target_kind: 'dismissed', target_ref: null, data: {} },
    ];
    const timers = new Map([[7, { id: 7, is_enabled: 0, name: 'Roll' }]]);
    const without = buildSwitchPlan({ automations, importItems: items, timers, grantScopes: new Set(['user:read:chat']) });
    const st = Object.fromEntries(without.automations.map((a) => [a.id, a.state]));
    assert.deepEqual(st, { 1: 'attention', 2: 'source_off', 3: 'turn_on' });
    assert.match(without.automations[0].reasons.join(' '), /re-approve Twitch/);
    assert.equal(without.timers[0].state, 'source_off');
    assert.equal(without.counts.sourceOff, 2);
    const withScope = buildSwitchPlan({ automations, importItems: items, timers, grantScopes: new Set(['user:write:chat']) });
    assert.equal(withScope.automations.find((a) => a.id === 1).state, 'turn_on');
});

// ── on throwaway tables ─────────────────────────────────────────────────────────────────────

let T, store, importStore, profile, ch;
test.before(async () => {
    T = await makeTables(pool, 'x');
    for (const sql of importDdl(T.prefix)) await pool.query(sql);
    ch = { channels: `${T.prefix}tk_channels`, commands: `${T.prefix}tk_cc`, timers: `${T.prefix}tk_timers` };
    await pool.query(`CREATE TABLE \`${ch.channels}\` LIKE tokes_channels`);
    await pool.query(`CREATE TABLE \`${ch.commands}\` LIKE tokes_custom_commands`);
    await pool.query(`CREATE TABLE \`${ch.timers}\` LIKE tokes_timers`);
    store = T.store;
    importStore = createImportStore({ db: pool, prefix: T.prefix, channelTables: ch });
    profile = await makeProfile(store);
});
test.after(async () => {
    for (const n of [...IMPORT_TABLES].reverse()) await pool.query(`DROP TABLE IF EXISTS \`${T.prefix}${n}\``);
    for (const t of Object.values(ch || {})) await pool.query(`DROP TABLE IF EXISTS \`${t}\``);
    await T.drop();
    await pool.end().catch(() => {});
});

test('apply: sourceOn is stored; a dismissed item never comes back; an untouched timer follows the mapping', async () => {
    const fbFiles = (line) => new Map([
        ['timers.json', Buffer.from(JSON.stringify([{ id: 't1', name: 'Roll', active: false, interval: 900, onlyWhenLive: true, effects: { list: [{ type: 'firebot:chat', chatter: line, message: '!roll' }] } }]))],
        ['chat/commands.json', Buffer.from(JSON.stringify({ customCommands: [
            { id: 'k1', trigger: '!tank', active: true, effects: { list: [{ type: 'firebot:chat', chatter: 'Bot', message: 'Tank needs a vet' }, { type: 'firebot:delay', delay: 1 }] } },
            { id: 'k2', trigger: '!dab+', active: true, effects: { list: [{ type: 'firebot:chat', chatter: 'Bot', message: 'dab' }, { type: 'firebot:delay', delay: 1 }] } },
        ] }))],
    ]);
    const plan = (line) => buildImportPlan([parseFirebot({ files: fbFiles(line) })], { channels: [{ platform: 'twitch', platformUserId: '900000001' }], channelBots: [] });
    const run = (line) => applyPlan({ store, importStore, profileId: profile.id, plan: plan(line), categories: ['commands', 'timers'], meta: { sources: 'firebot' } });
    // First as Firebot's "Bot" chatter: a plain timer message.
    await run('Bot');
    const timerItem = await importStore.getItem(profile.id, 'firebot', 'timer', 't1');
    assert.equal(timerItem.data.sourceOn, false);
    assert.equal((await importStore.getItem(profile.id, 'firebot', 'command', 'k2')).data.sourceOn, true);
    const timerId = Number(timerItem.target_ref.split(':')[1]);
    const [[before]] = await pool.query(`SELECT message, automation_id FROM \`${ch.timers}\` WHERE id = ?`, [timerId]);
    assert.equal(before.message, '!roll');
    // The owner removes !tank: the automation goes, the item is marked, and a re-import leaves it out.
    const tank = await importStore.getItem(profile.id, 'firebot', 'command', 'k1');
    await store.deleteAutomation(profile.id, Number(tank.target_ref.split(':')[1]));
    await importStore.dismissItem(profile.id, { source: 'firebot', kind: 'command', sourceId: 'k1', name: '!tank', reason: 'owner: no longer needed' });
    // Re-import with the streamer as chatter: the untouched timer now runs a stream.say automation; !tank stays gone.
    const out = await run('Streamer');
    assert.equal(out.results.find((r) => r.name === '!tank').result, 'skipped');
    assert.equal((await store.listAutomations(profile.id)).some((a) => a.name === 'Firebot: !tank'), false);
    assert.equal(out.results.find((r) => r.kind === 'timer').result, 'updated');
    const [[after]] = await pool.query(`SELECT message, automation_id, is_enabled FROM \`${ch.timers}\` WHERE id = ?`, [timerId]);
    assert.equal(after.is_enabled, 0);
    const auto = await store.getAutomation(profile.id, Number(after.automation_id));
    assert.deepEqual(auto.actions, [{ type: 'stream.say', text: '!roll' }]);
    assert.equal((await importStore.getItem(profile.id, 'firebot', 'timer', 't1')).data.sourceOn, false, 'sourceOn survives the refresh');
    // A timer the streamer switched on is left alone by later imports.
    await pool.query(`UPDATE \`${ch.timers}\` SET is_enabled = 1 WHERE id = ?`, [timerId]);
    const again = await run('Bot');
    assert.equal(again.results.find((r) => r.kind === 'timer').result, 'already');
});
