import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../utils/db.js';
import { makeTables, makeProfile } from './fixtures/stream-bot-tables.js';
import { firebotFiles } from './fixtures/stream-bot-import.js';
import { viewersDdl, VIEWER_TABLES, RETENTION_ROWS } from '../migrations/464_stream_bot_viewers.js';
import { withDefaults, validateSettings, rankFor, rankCrossed, watchAward, currencyCommand, formatWatch, DEFAULT_IGNORE } from '../core/stream-bot/viewers/settings.js';
import { createViewerStore } from '../core/stream-bot/viewers/store.js';
import { createViewerService, parseAmount, CHATTERS_SCOPE } from '../core/stream-bot/viewers/service.js';
import { registerViewers, viewerActions, RANK_UP } from '../core/stream-bot/viewers/register.js';
import { commandDrafts, seedCommands } from '../core/stream-bot/viewers/seed.js';
import { viewersExport, viewersDelete } from '../core/stream-bot/viewers/privacy.js';
import { createStreamBotPrivacy } from '../core/stream-bot/privacy.js';
import { createImportStore } from '../core/stream-bot/import/apply.js';
import { importDdl, IMPORT_TABLES } from '../migrations/455_stream_bot_imports.js';
import { parseFirebot, firebotLoyalty, convertEffects } from '../core/stream-bot/import/firebot.js';
import { parseStreamerbot } from '../core/stream-bot/import/streamerbot.js';
import { STREAM_BOT_SCOPES, FORBIDDEN_SCOPES, REAPPROVE } from '../core/stream-bot/scopes.js';
import * as actionsMod from '../core/stream-bot/actions.js';
import * as eventsMod from '../core/stream-bot/events.js';
import * as renderMod from '../core/stream-bot/render.js';
import * as conditionsMod from '../core/stream-bot/conditions.js';
import { createEngine } from '../core/stream-bot/engine.js';
import { createLimiter, validateConditions, validateTrigger } from '../core/stream-bot/conditions.js';
import { publicEvent } from '../core/stream-bot/events.js';

/*
 * Viewer stats and loyalty points (H-747; core/stream-bot/viewers, migration 464) on throwaway tables (sbtv…_): the settings
 * maths, records from events (chat, follows, subs, gifts, Bits once, raids, tips by name), the 5-minute watch-time sample
 * (Twitch chatters list through a fake Helix, active chatters on Kick and without the scope), points with bonuses and the
 * sub multiplier, rank-ups raised as events, every chat command, linking by hand, the importer (Firebot rows, currency and
 * ranks, Streamer.bot names and last seen, idempotent re-runs, the 400-day cut), the engine hooks (actions, conditions,
 * variables, trigger) through the real engine, the scope, and /privacy as a streamer and as a viewer.
 */

let T, store, vs, profile, svc;
const clock = { t: Date.parse('2026-11-19T20:00:00Z') };
const now = () => clock.t;
const TW = '900000001';   // makeProfile's Twitch channel
const KK = '800000001';
const fan = { id: '100000001', login: 'maplefan_88', name: 'MapleFan_88', roles: ['subscriber'] };
const wren = { id: '100000002', login: 'wren_reads', name: 'Wren_Reads', roles: [] };
const pip = { id: '5550001', login: 'pip_kick', name: 'Pip', roles: [] };
const live = { twitch: true, kick: true };
const raised = [];
const helixCalls = [];
let chatters = [];
let grantScopes = [...STREAM_BOT_SCOPES];

const pub = (o) => publicEvent({ amount: null, currency: null, message: null, metadata: {}, occurredAt: new Date(now()), ...o });
const fakeHelix = {
    async call(profileId, method, path, { query, need }) {
        helixCalls.push({ path, need, query: query({ userId: TW }) });
        const after = query({ userId: TW }).after;
        if (!after) return { data: { data: chatters.slice(0, 2), pagination: chatters.length > 2 ? { cursor: 'page2' } : {} } };
        return { data: { data: chatters.slice(2), pagination: {} } };
    },
};
const fakeInfo = { async get({ platform }) { return { live: !!live[platform], title: '', category: '', viewers: 3, startedAt: null }; } };
const sent = [];
const fakeIo = {
    async channelsFor() { return [{ platform: 'twitch', platform_user_id: TW, login: 'maplehollow_tv' }, { platform: 'kick', platform_user_id: KK, login: 'maplehollow' }]; },
    async sendChat(m) { sent.push(m); return { ok: true }; },
};
const fakeIngest = { async internal(profileId, ev) { raised.push(ev); return 1; }, isEcho: (ev) => String(ev.message || '').startsWith('[bot]') };

test.before(async () => {
    T = await makeTables(pool, 'v');
    for (const sql of viewersDdl(T.prefix)) await pool.query(sql);
    for (const sql of importDdl(T.prefix)) await pool.query(sql);
    store = T.store;
    profile = await makeProfile(store);
    // The grant whose scopes decide chatters vs active chatters (store.getTwitchGrant reads it).
    store.getTwitchGrant = async () => ({ twitch_user_id: TW, status: 'active', scopes: grantScopes });
    vs = createViewerStore({ db: pool, prefix: T.prefix, now });
    svc = createViewerService({ db: pool, store, vstore: vs, helix: fakeHelix, streamInfo: fakeInfo, io: fakeIo, ingest: fakeIngest, now, rng: () => 0.1, ignoreLogins: ['certifriedbot'] });
});
test.after(async () => {
    svc?.stop();
    for (const n of [...IMPORT_TABLES].reverse()) await pool.query(`DROP TABLE IF EXISTS \`${T.prefix}${n}\``);
    for (const n of [...VIEWER_TABLES].reverse()) await pool.query(`DROP TABLE IF EXISTS \`${T.prefix}${n}\``);
    await T.drop();
    await pool.end().catch(() => {});
});

// ── settings (pure) ─────────────────────────────────────────────────────────────────────────

test('settings: defaults, cleaning, ranks, watch awards, the currency command', () => {
    const d = withDefaults(null);
    assert.equal(d.tracking, true);
    assert.equal(d.currency, 'points');
    assert.equal(d.gamble.enabled, false, 'gambling is off by default');
    assert.deepEqual(d.ignore, [...DEFAULT_IGNORE]);
    const s = withDefaults({ currency: 'Maple Leaves!', earn: { minutes: 7, points: -5, subMultiplier: 2.25 }, ranks: { basis: 'points', list: [{ name: 'B', min: 500 }, { name: 'A', min: 0 }, { name: 'a', min: 3 }, { name: '', min: 1 }] }, gamble: { min: 50, max: 10 } });
    assert.equal(s.currency, 'points', 'a name with punctuation is refused');
    assert.equal(s.earn.minutes, 10, 'periods are multiples of the 5-minute sample');
    assert.equal(s.earn.points, 0);
    assert.equal(s.earn.subMultiplier, 2.3);
    assert.deepEqual(s.ranks.list, [{ name: 'A', min: 0 }, { name: 'B', min: 500 }], 'sorted, duplicates and blanks dropped');
    assert.equal(s.gamble.max, 50, 'the largest bet is never below the smallest');
    const v = validateSettings({ currency: '!!', earn: { minutes: 7 }, ranks: { list: [{ name: '', min: '' }, { name: 'X', min: 1 }, { name: 'x', min: 2 }] }, ignore: ['nightbot', 'bad name!'] });
    assert.equal(v.ok, false);
    assert.equal(v.errors.length, 6, v.errors.join(' | '));
    const r = withDefaults({ ranks: { basis: 'watch', list: [{ name: 'Newcomer', min: 0 }, { name: 'Regular', min: 600 }, { name: 'Legend', min: 6000 }] } });
    assert.equal(rankFor(r, { watchMinutes: 599 }).name, 'Newcomer');
    assert.equal(rankFor(r, { watchMinutes: 600 }).name, 'Regular');
    assert.equal(rankCrossed(r, 595, 600), 'Regular');
    assert.equal(rankCrossed(r, 600, 605), null);
    assert.equal(rankCrossed(r, 0, 7000), 'Legend', 'the highest crossed');
    assert.equal(watchAward(d, 0, 5), 0, 'half a 10-minute period earns nothing yet');
    assert.equal(watchAward(d, 5, 5), 10);
    assert.equal(watchAward(withDefaults({ earn: { subMultiplier: 2 } }), 5, 5, true), 20);
    assert.equal(currencyCommand(withDefaults({ currency: 'Coins' })), 'coins');
    assert.equal(currencyCommand(withDefaults({ currency: 'Maple leaves' })), 'mapleleaves');
    assert.equal(currencyCommand(d), null);
    assert.equal(formatWatch(125), '2h 05m');
    assert.equal(parseAmount('all', 90), 90);
    assert.equal(parseAmount('50%', 91), 45);
    assert.equal(parseAmount('1,000', 0), 1000);
    assert.equal(parseAmount('ten', 0), null);
});

test('migration: two tables with retention rows for 400 days', () => {
    assert.deepEqual(VIEWER_TABLES, ['viewers', 'viewer_history']);
    assert.deepEqual(RETENTION_ROWS.map((r) => [r[0], r[1], r[2]]), [['stream_bot_viewers', 'last_seen_at', 400], ['stream_bot_viewer_history', 'created_at', 400]]);
});

// ── records from events ─────────────────────────────────────────────────────────────────────

test('events become records: chat, follow, subs, gifts, Bits counted once, raids, tips by name; bots, the channel and tests skipped', async () => {
    await store.setSettingsKey(profile.id, 'viewers', withDefaults({}));
    const P = profile.id;
    await svc.onEvent(P, pub({ platform: 'twitch', type: 'chat', channelId: TW, user: fan, message: 'hello' }));
    await svc.onEvent(P, pub({ platform: 'twitch', type: 'chat', channelId: TW, user: fan, message: 'again' }));
    await svc.onEvent(P, pub({ platform: 'twitch', type: 'chat', channelId: TW, user: { id: '1', login: 'nightbot', name: 'Nightbot', roles: [] }, message: 'spam' }));
    await svc.onEvent(P, pub({ platform: 'twitch', type: 'chat', channelId: TW, user: { id: TW, login: 'maplehollow_tv', name: 'MapleHollow_TV', roles: ['broadcaster'] }, message: 'me' }));
    await svc.onEvent(P, pub({ platform: 'twitch', type: 'chat', channelId: TW, user: fan, message: '[bot] echo' }));
    await svc.onEvent(P, { ...pub({ platform: 'twitch', type: 'chat', channelId: TW, user: fan, message: 'test' }), test: true });
    let r = await vs.byAccount(P, 'twitch', fan.id);
    assert.equal(r.messages, 2);
    assert.equal(r.name, 'MapleFan_88');
    assert.equal(await vs.byAccount(P, 'twitch', '1'), null, 'Nightbot is on the not-counted list');
    assert.equal(await vs.byAccount(P, 'twitch', TW), null, 'the broadcaster is not a viewer of their own channel');

    await svc.onEvent(P, pub({ platform: 'twitch', type: 'follow', channelId: TW, user: wren }));
    await svc.onEvent(P, pub({ platform: 'twitch', type: 'resub', channelId: TW, user: fan, amount: 7, metadata: { months: 7, tier: '1000' } }));
    await svc.onEvent(P, pub({ platform: 'twitch', type: 'gift_sub', channelId: TW, user: fan, amount: 3, metadata: { count: 3 } }));
    await svc.onEvent(P, pub({ platform: 'twitch', type: 'sub', channelId: TW, user: wren, metadata: { isGift: true } }));
    await svc.onEvent(P, pub({ platform: 'twitch', type: 'cheer', channelId: TW, user: fan, amount: 250 }));
    await svc.onEvent(P, pub({ platform: 'twitch', type: 'bits.used', channelId: TW, user: fan, amount: 250, metadata: { kind: 'cheer' } }));
    await svc.onEvent(P, pub({ platform: 'twitch', type: 'bits.used', channelId: TW, user: fan, amount: 100, metadata: { kind: 'power_up', powerUp: 'celebration' } }));
    await svc.onEvent(P, pub({ platform: 'twitch', type: 'raid', channelId: TW, user: { id: '100000009', login: 'bramblebyte_live', name: 'BrambleByte_Live', roles: [] }, amount: 42 }));
    await svc.onEvent(P, pub({ platform: 'streamelements', type: 'tip', user: { id: null, login: null, name: 'MapleFan_88', roles: [] }, amount: 5, currency: 'USD' }));
    await svc.onEvent(P, pub({ platform: 'kick', type: 'follow', channelId: KK, user: pip }));
    r = await vs.byAccount(P, 'twitch', fan.id);
    assert.deepEqual([r.subs, r.subMonths, r.gifts, r.giftedSubs, r.cheers, r.bits, r.tips], [1, 7, 1, 3, 1, 350, 1]);
    assert.deepEqual(r.tipAmounts, { USD: 5 });
    // resub 250 + 3 gifts × 100 + 2 × 10 (250 Bits) + 10 (100 Bits of power-ups) = 580
    assert.equal(r.points, 580);
    const w = await vs.byAccount(P, 'twitch', wren.id);
    assert.equal(w.follows, 1);
    assert.equal(w.subs, 1, 'a gifted sub received is counted');
    assert.equal(w.points, 50, 'the follow bonus only: the gifter has the gift bonus');
    assert.deepEqual([(await vs.byAccount(P, 'twitch', '100000009')).raidViewers, (await vs.byAccount(P, 'twitch', '100000009')).points], [42, 100]);
    assert.equal((await vs.byAccount(P, 'kick', pip.id)).follows, 1);
    const h = await vs.history(P, [r.id]);
    assert.ok(h.some((x) => x.kind === 'bonus' && /Gift bonus \(3 subs\)/.test(x.note)));
});

test('the watch-time sample: Twitch chatters list (paged) while live, Kick active chatters, points per period, sub multiplier', async () => {
    const P = profile.id;
    await svc.saveSettings(P, withDefaults({ earn: { minutes: 5, points: 2, subMultiplier: 2 } }));
    chatters = [
        { user_id: fan.id, user_login: fan.login, user_name: fan.name },
        { user_id: wren.id, user_login: wren.login, user_name: wren.name },
        { user_id: '100000010', user_login: 'quiet_lurker', user_name: 'Quiet_Lurker' },
        { user_id: TW, user_login: 'maplehollow_tv', user_name: 'MapleHollow_TV' },
        { user_id: '2', user_login: 'streamelements', user_name: 'StreamElements' },
    ];
    const before = (await vs.byAccount(P, 'twitch', fan.id)).points;
    await svc.onEvent(P, pub({ platform: 'kick', type: 'chat', channelId: KK, user: pip, message: 'hi from kick' }));
    const st = await svc.sampleProfile(P, (await fakeIo.channelsFor()).map((c) => ({ ...c })));
    assert.deepEqual(st.channels.map((c) => [c.platform, c.live, c.source, c.counted]), [['twitch', true, 'chatters', 3], ['kick', true, 'active', 1]]);
    assert.equal(helixCalls.length, 2, 'two pages');
    assert.deepEqual(helixCalls[0].need, [CHATTERS_SCOPE]);
    assert.equal(helixCalls[0].query.moderator_id, TW);
    const lurker = await vs.byAccount(P, 'twitch', '100000010');
    assert.equal(lurker.watchMinutes, 5);
    assert.equal(lurker.points, 2);
    assert.equal((await vs.byAccount(P, 'twitch', fan.id)).points - before, 4, 'a subscriber earns double');
    assert.equal(await vs.byAccount(P, 'twitch', TW), null, 'the broadcaster is not counted');
    assert.equal(await vs.byAccount(P, 'twitch', '2'), null, 'bots are not counted');
    assert.equal((await vs.byAccount(P, 'kick', pip.id)).watchMinutes, 5);

    // Without the scope: active chatters only. Offline: nothing.
    grantScopes = STREAM_BOT_SCOPES.filter((s) => s !== CHATTERS_SCOPE);
    clock.t += 11 * 60_000;   // Pip's Kick line is now older than 10 minutes
    await svc.onEvent(P, pub({ platform: 'twitch', type: 'chat', channelId: TW, user: wren, message: 'still here' }));
    live.kick = false;
    const st2 = await svc.sampleProfile(P, await fakeIo.channelsFor());
    assert.deepEqual(st2.channels.map((c) => [c.platform, c.live, c.source, c.reason, c.counted]), [['twitch', true, 'active', 'scope', 1], ['kick', false, null, null, 0]]);
    assert.equal((await vs.byAccount(P, 'twitch', '100000010')).watchMinutes, 5, 'the lurker is not counted without the chatters list');
    grantScopes = [...STREAM_BOT_SCOPES];
    live.kick = true;
});

test('rank-ups: crossing a threshold raises "Viewer reached a new rank" on the viewer\'s platform; changed thresholds re-rank quietly', async () => {
    const P = profile.id;
    await svc.saveSettings(P, withDefaults({ earn: { minutes: 5, points: 2 }, ranks: { basis: 'watch', list: [{ name: 'Newcomer', min: 0 }, { name: 'Regular', min: 10 }] } }));
    raised.length = 0;
    chatters = [{ user_id: '100000010', user_login: 'quiet_lurker', user_name: 'Quiet_Lurker' }];
    await svc.sampleProfile(P, (await fakeIo.channelsFor()).filter((c) => c.platform === 'twitch'));
    const lurker = await vs.byAccount(P, 'twitch', '100000010');
    assert.equal(lurker.watchMinutes, 10);
    assert.equal(lurker.rankName, 'Regular');
    assert.equal(raised.length, 1);
    assert.deepEqual([raised[0].type, raised[0].platform, raised[0].channelId, raised[0].user.name, raised[0].metadata.rank, raised[0].internal], ['viewer.rank_up', 'twitch', TW, 'Quiet_Lurker', 'Regular', true]);
    // Wren was already past 10 minutes when the ranks were made: the rank is set without an event (no threshold crossed now).
    raised.length = 0;
    assert.equal((await vs.byAccount(P, 'twitch', wren.id)).watchMinutes, 10);
    chatters = [{ user_id: wren.id, user_login: wren.login, user_name: wren.name }];
    await svc.sampleProfile(P, (await fakeIo.channelsFor()).filter((c) => c.platform === 'twitch'));
    assert.equal((await vs.byAccount(P, 'twitch', wren.id)).rankName, 'Regular');
    assert.equal(raised.length, 0);
    // Ranks by points: a dashboard change past a threshold raises it too.
    await svc.saveSettings(P, withDefaults({ ranks: { basis: 'points', list: [{ name: 'Rich', min: 100000 }] } }));
    const w = await vs.byAccount(P, 'twitch', wren.id);
    await svc.changePoints(P, w.id, 100000, { kind: 'edit', note: 'test', actor: 'dashboard:1' });
    assert.equal(raised.at(-1)?.metadata.rank, 'Rich');
});

test('chat commands: !points, !top, !give, !gamble (off, then on), !addpoints / !removepoints for moderators only', async () => {
    const P = profile.id;
    await svc.saveSettings(P, withDefaults({ currency: 'Leaves' }));
    const ev = (user, message, platform = 'twitch') => ({ platform, type: 'chat', channelId: platform === 'twitch' ? TW : KK, user, message });
    const run = (cmd, user, message) => svc.commands.run(profile, cmd, { ev: ev(user, message), input: message.split(/\s+/).slice(1).join(' ') });
    const mine = async () => (await vs.person(P, (await vs.byAccount(P, 'twitch', fan.id)).id)).points;

    let r = await run('points', fan, '!points');
    assert.match(r.reply, /^MapleFan_88 has [\d,]+ Leaves \(#\d+\).*has watched/);
    r = await run('points', fan, '!points @nobody_here');
    assert.equal(r.reply, 'I have not seen nobody_here here yet.');
    r = await run('top', fan, '!top');
    assert.match(r.reply, /^Top Leaves: 1\. Wren_Reads \(100,0\d\d\)/);
    r = await run('top', fan, '!top watch');
    assert.match(r.reply, /^Top watch time: 1\. /);

    const start = await mine();
    r = await run('give', fan, '!give @wren_reads 10');
    assert.equal(r.reply, 'MapleFan_88 gave 10 Leaves to Wren_Reads.');
    assert.equal(await mine(), start - 10);
    r = await run('give', fan, '!give @wren_reads 99999999');
    assert.match(r.reply, /you have [\d,]+ Leaves/);
    r = await run('give', fan, '!give @maplefan_88 5');
    assert.equal(r.reply, 'You cannot give to yourself.');

    r = await run('gamble', fan, '!gamble 20');
    assert.equal(r.reply, 'Gambling is turned off on this channel.');
    await svc.saveSettings(P, withDefaults({ currency: 'Leaves', gamble: { enabled: true, min: 10, max: 100, winChance: 50 } }));
    const g0 = await mine();
    r = await run('gamble', fan, '!gamble 20');   // rng 0.1 → a win
    assert.match(r.reply, /^MapleFan_88 won 20 Leaves and now has/);
    assert.equal(await mine(), g0 + 20);
    r = await run('gamble', fan, '!gamble 5');
    assert.match(r.reply, /^Bet 10 to 100 Leaves/);
    r = await run('gamble', fan, '!gamble all');
    assert.match(r.reply, /won 100 Leaves/, '"all" is capped at the largest bet');

    r = await run('addpoints', fan, '!addpoints @wren_reads 5');
    assert.equal(r.reply, null, 'not a moderator');
    const mod = { ...wren, roles: ['moderator'] };
    const wb = (await vs.person(P, (await vs.byAccount(P, 'twitch', wren.id)).id)).points;
    r = await run('addpoints', mod, '!addpoints @maplefan_88 5');
    assert.match(r.reply, /^MapleFan_88 now has/);
    r = await run('removepoints', mod, '!removepoints @wren_reads 1');
    assert.equal((await vs.person(P, (await vs.byAccount(P, 'twitch', wren.id)).id)).points, wb - 1);
    const hist = await vs.history(P, [(await vs.byAccount(P, 'twitch', fan.id)).id]);
    assert.ok(hist.some((h) => h.kind === 'give' && h.actor === 'chat:maplefan_88'));
    assert.ok(hist.some((h) => h.kind === 'gamble'));
});

test('linking by hand: points move to the primary, totals add up, rows on the same platform refuse; unlink keeps the points', async () => {
    const P = profile.id;
    const t = await vs.byAccount(P, 'twitch', fan.id);
    await vs.changePoints(P, (await vs.byAccount(P, 'kick', pip.id)).id, 30, { kind: 'edit' });
    const k = await vs.byAccount(P, 'kick', pip.id);
    const before = (await vs.get(P, t.id)).points;
    assert.equal((await vs.link(P, t.id, (await vs.byAccount(P, 'twitch', wren.id)).id)).error, 'same_platform');
    const r = await vs.link(P, t.id, k.id, { actor: 'dashboard:1' });
    assert.equal(r.ok, true);
    assert.equal(r.moved, k.points);
    assert.ok(k.points >= 30);
    const person = await vs.person(P, k.id);
    assert.equal(person.primary.id, t.id);
    assert.equal(person.points, before + k.points);
    assert.equal(person.totals.watchMinutes, t.watchMinutes + k.watchMinutes);
    assert.equal((await vs.link(P, t.id, k.id)).error, 'already_linked');
    // Points for the Kick account go to the person.
    await svc.changePoints(P, k.id, 5, { kind: 'edit' });
    const total = before + k.points + 5;
    assert.equal((await vs.get(P, t.id)).points, total);
    const list = await vs.list(P, { platform: 'kick' });
    assert.equal(list.rows.find((x) => x.id === k.id).shownPoints, total, 'the table shows the person\'s points on the linked row');
    const top = await vs.top(P, { by: 'watch', limit: 50 });
    assert.equal(top.filter((x) => x.id === t.id).length, 1, 'one line per person');
    assert.equal((await vs.unlink(P, k.id)).ok, true);
    assert.equal((await vs.get(P, k.id)).points, 0);
    assert.equal((await vs.get(P, t.id)).points, total);
});

// ── the engine hooks ────────────────────────────────────────────────────────────────────────

test('engine hooks: points actions, viewers.command, conditions, {user.points} and friends, the rank-up trigger', async () => {
    const P = profile.id;
    const ref = { current: svc };
    const reg = registerViewers({ ref, actions: actionsMod, events: eventsMod, render: renderMod, conditions: conditionsMod });
    // Registered once per process (a second call is refused by the hooks); the first registration may come from another file.
    assert.ok(actionsMod.actionType('points.add') && actionsMod.actionType('viewers.command') && eventsMod.eventType('viewer.rank_up'), JSON.stringify(reg));
    assert.equal(eventsMod.eventType('viewer.rank_up').label, RANK_UP.label);
    assert.ok(conditionsMod.CONDITION_TYPES.some((c) => c.type === 'viewer.points' && c.fields[0].kind === 'number'));

    const v = actionsMod.validateActions([{ type: 'points.add', who: 'named', viewer: '', amount: 'ten' }, { type: 'points.set', who: 'event', amount: '{amount}' }, { type: 'viewers.command', command: 'nope' }]);
    assert.equal(v.ok, false);
    assert.equal(v.errors.length, 3, v.errors.join(' | '));
    const c = validateConditions([{ type: 'viewer.watch', min: 60 }, { type: 'viewer.messages', min: -1 }]);
    assert.deepEqual(c.value[0], { type: 'viewer.watch', min: 60 });
    assert.equal(c.errors.length, 1);
    assert.equal(validateTrigger('viewer.rank_up', { platforms: ['kick'] }).ok, true);

    const render = renderMod.createRenderer({ variableStore: store.variableStore });
    const engine = createEngine({ store, render, io: fakeIo, limiter: createLimiter({ now }), now });
    const ev = { platform: 'twitch', type: 'chat', channelId: TW, user: fan, message: '!lucky @wren_reads', amount: null, metadata: {}, occurredAt: new Date(now()) };
    const w0 = (await vs.person(P, (await vs.byAccount(P, 'twitch', wren.id)).id)).points;
    const f0 = (await vs.person(P, (await vs.byAccount(P, 'twitch', fan.id)).id)).points;
    const auto = { id: 9001, name: 'Lucky', enabled: true, trigger_type: 'chat', trigger_config: { match: { mode: 'command', text: '!lucky' } },
        conditions: [{ type: 'viewer.points', min: 1 }, { type: 'viewer.messages', min: 1 }],
        actions: [
            { type: 'points.add', who: 'named', viewer: '{arg1}', amount: '25' },
            { type: 'points.remove', who: 'event', amount: '5' },
            { type: 'chat.send', platform: 'event', text: '{user.name}: {user.points} {points.name}, {user.messages} messages, rank "{user.rank}", watched {user.watchtime}' },
        ] };
    const r = await engine.runAutomation(profile, auto, ev, { source: 'event' });
    assert.equal(r.status, 'ok', JSON.stringify(r.steps));
    assert.equal((await vs.person(P, (await vs.byAccount(P, 'twitch', wren.id)).id)).points, w0 + 25);
    assert.equal((await vs.person(P, (await vs.byAccount(P, 'twitch', fan.id)).id)).points, f0 - 5);
    assert.match(sent.at(-1).text, new RegExp(`^MapleFan_88: ${(f0 - 5).toLocaleString('en-US')} Leaves, [\\d,]+ messages, rank "", watched \\d+m$`));
    // The condition stops a viewer without enough.
    const poor = await engine.runAutomation(profile, { ...auto, id: 9002, conditions: [{ type: 'viewer.points', min: 999999999 }] }, ev, { source: 'event' });
    assert.equal(poor.status, 'skipped');
    const run = await store.getRun(P, poor.runId);
    assert.match(run.skipReason, /^viewer\.points: MapleFan_88 has [\d,]+ points; needs 999,999,999$/);
    // A dry run changes nothing.
    const dry = await engine.runAutomation(profile, auto, ev, { source: 'event', dryRun: true });
    assert.equal(dry.steps[0].status, 'dry');
    assert.equal((await vs.person(P, (await vs.byAccount(P, 'twitch', wren.id)).id)).points, w0 + 25);
    // {rank.name} on the rank-up trigger.
    const text = await render('{user.name} is now {rank.name} (was {rank.previous})', { ev: { platform: 'twitch', type: 'viewer.rank_up', user: fan, metadata: { rank: 'Regular', previous: 'Newcomer' } }, profileId: P });
    assert.equal(text, 'MapleFan_88 is now Regular (was Newcomer)');
    // viewers.command answers in the chat the event came from.
    const cmd = await engine.runAutomation(profile, { ...auto, id: 9003, trigger_config: { match: { mode: 'command', text: '!points' } }, conditions: [], actions: [{ type: 'viewers.command', command: 'points', reply: 'yes' }] }, { ...ev, message: '!points' }, { source: 'event' });
    assert.equal(cmd.status, 'ok');
    assert.match(sent.at(-1).text, /^MapleFan_88 has /);
    assert.equal(viewerActions(ref).length, 4);
});

test('seeded commands: six automations, switched off, made once; a one-word currency adds its own command', async () => {
    const d = commandDrafts({ currency: 'leaves' });
    assert.equal(d.length, 6);
    assert.equal(d[0].trigger_config.match.text, '^!(?:points|leaves)(?:\\s|$)');
    assert.ok(d.every((x) => x.enabled === false));
    assert.ok(d.filter((x) => /addpoints|removepoints/.test(x.name)).every((x) => x.conditions[0].roles.includes('moderator')));
    for (const x of d) {
        assert.equal(validateTrigger(x.trigger_type, x.trigger_config).ok, true, x.name);
        assert.equal(validateConditions(x.conditions).ok, true, x.name);
        assert.equal(actionsMod.validateActions(x.actions).ok, true, x.name);
    }
    const a = await seedCommands(store, profile.id, { currency: 'leaves' });
    const b = await seedCommands(store, profile.id, { currency: 'leaves' });
    assert.deepEqual([a.created, b.created, b.existing], [6, 0, 6]);
});

// ── the scope ───────────────────────────────────────────────────────────────────────────────

test('the Stream bot grant asks for moderator:read:chatters; still never follows or revenue', () => {
    assert.ok(STREAM_BOT_SCOPES.includes(CHATTERS_SCOPE));
    assert.ok(REAPPROVE.some((r) => r.scope === CHATTERS_SCOPE));
    for (const s of FORBIDDEN_SCOPES) assert.equal(STREAM_BOT_SCOPES.includes(s), false);
});

// ── import ──────────────────────────────────────────────────────────────────────────────────

test('import: Firebot rows with names, dates and points; currency and ranks settings; currency effects; Streamer.bot names and last seen', () => {
    const files = firebotFiles({
        'db/users.db': [
            { _id: '700000201', username: 'acorn', displayName: 'Acorn', minutesInChannel: 90, chatMessages: 4, joinDate: Date.parse('2026-01-02T00:00:00Z'), lastSeen: Date.parse('2026-11-01T00:00:00Z'), currency: { c1: 120, c2: 3 } },
            { _id: '700000202', username: 'old_oak', minutesInChannel: 9000, chatMessages: 1, lastSeen: Date.parse('2024-01-01T00:00:00Z'), currency: {} },
        ],
        'currency/currency.json': { c1: { id: 'c1', name: 'Acorns', active: true, interval: 7, payout: 7 }, c2: { id: 'c2', name: 'Old', active: false } },
        'ranks.json': { l1: { id: 'l1', name: 'Ladder', mode: 'auto', settings: { trackBy: 'view_time' }, ranks: [{ name: 'Sprout', value: 0 }, { name: 'Tree', value: 10 }] } },
    });
    const b = parseFirebot({ files, wantViewers: true });
    assert.deepEqual(b.viewers.rows[0], { platform: 'twitch', id: '700000201', login: 'acorn', name: 'Acorn', watchMinutes: 90, chatMessages: 4, firstSeen: Date.parse('2026-01-02T00:00:00Z'), lastSeen: Date.parse('2026-11-01T00:00:00Z'), points: 120 });
    assert.deepEqual(b.viewers.settings, { currency: 'Acorns', earn: { minutes: 5, points: 5 }, ranks: { basis: 'watch', list: [{ name: 'Sprout', min: 0 }, { name: 'Tree', min: 600 }] } });
    assert.ok(b.viewers.notes.some((n) => /every 7 minutes/.test(n)));
    assert.equal(firebotLoyalty(new Map(), []).settings, null);
    const fx = convertEffects([
        { type: 'firebot:currency', action: 'Add', target: 'individual', userTarget: '$user', amount: '50' },
        { type: 'firebot:currency', action: 'Remove', target: 'individual', userTarget: '$arg[1]', amount: '$arg[2]' },
        { type: 'firebot:currency', action: 'Add', target: 'allOnline', amount: '5' },
    ], { counters: new Map() });
    assert.deepEqual(fx.actions[0], { type: 'points.add', who: 'event', viewer: '', amount: '50' });
    assert.equal(fx.actions[1].type, 'points.remove');
    assert.equal(fx.actions[1].who, 'named');
    assert.deepEqual(fx.gaps.map((g) => g.gap), ['currency.bulk']);
    const sb = parseStreamerbot({ files: new Map([['users.dat', Buffer.from(JSON.stringify({ users: [
        { id: '700000201', name: 'acorn', display: 'Acorn', type: 'twitch', lastActive: '0001-01-01T00:00:00', previousActive: '2026-11-10T10:00:00.2331007-07:00' },
        { id: 'UCx', name: 'yt', type: 'youtube', lastActive: '2026-11-10T10:00:00Z' },
    ] }))]]), wantViewers: true });
    assert.deepEqual(sb.viewers.rows, [{ platform: 'twitch', id: '700000201', login: 'acorn', name: 'Acorn', lastSeen: Date.parse('2026-11-10T10:00:00.2331007-07:00') }]);
});

test('import into records: idempotent, imported shares replaced not added, 400-day cut unless seen since, live counts kept', async () => {
    const P = profile.id;
    const imp = createImportStore({ db: pool, prefix: T.prefix });
    const rows = [
        { platform: 'twitch', id: '700000301', login: 'birch', name: 'Birch', watchMinutes: 100, chatMessages: 10, points: 40, firstSeen: Date.parse('2026-02-01T00:00:00Z'), lastSeen: Date.parse('2026-10-01T12:00:00.600Z') },
        { platform: 'twitch', id: '700000302', login: 'elm', watchMinutes: 500, chatMessages: 1, lastSeen: Date.parse('2024-06-01T00:00:00Z') },
        { platform: 'twitch', id: '700000303', login: 'yew', watchMinutes: 50, chatMessages: 1, lastSeen: Date.parse('2024-06-01T00:00:00Z'), seenElsewhere: Date.parse('2026-11-01T00:00:00Z') },
    ];
    const a = await imp.importViewers(P, rows, 'firebot', { now: now() });
    assert.deepEqual(a, { created: 2, updated: 0, unchanged: 0, skippedOld: 1 });
    // Watched live since the import; then the import runs again with a corrected Firebot number.
    const birch = await vs.byAccount(P, 'twitch', '700000301');
    await vs.seen(P, 'twitch', [{ id: '700000301' }], { minutes: 5, messages: 2 });
    await vs.changePoints(P, birch.id, -15, { kind: 'edit' });
    const again = await imp.importViewers(P, rows, 'firebot', { now: now() });
    assert.deepEqual(again, { created: 0, updated: 0, unchanged: 2, skippedOld: 1 }, 'a second identical import changes nothing');
    const fixed = await imp.importViewers(P, [{ ...rows[0], watchMinutes: 120, points: 50 }], 'firebot', { now: now() });
    assert.equal(fixed.updated, 1);
    const b2 = await vs.byAccount(P, 'twitch', '700000301');
    assert.deepEqual([b2.watchMinutes, b2.messages, b2.points], [125, 12, 35], 'imported share replaced, live minutes and the spent points kept');
    // A Streamer.bot row for an old Firebot viewer seen since keeps them; names fill in only where missing.
    await imp.importViewers(P, [{ platform: 'twitch', id: '700000303', login: 'yew', name: 'Yew!', lastSeen: Date.parse('2026-11-01T00:00:00Z') }], 'streamerbot', { now: now() });
    const yew = await vs.byAccount(P, 'twitch', '700000303');
    assert.equal(yew.importedFrom, 'firebot,streamerbot');
    assert.equal(new Date(yew.lastSeenAt).toISOString(), '2026-11-01T00:00:00.000Z');
});

// ── privacy ─────────────────────────────────────────────────────────────────────────────────

test('/privacy: a viewer exports and deletes their records in every channel; a streamer\'s delete removes the profile\'s records', async () => {
    const P = profile.id;
    const acct = [{ platform: 'twitch', id: fan.id }, { platform: 'kick', id: pip.id }];
    const ex = await viewersExport(pool, { accounts: acct, prefix: T.prefix });
    assert.equal(ex.tables[`${T.prefix}viewers_about_you`].length, 2);
    assert.ok(ex.tables[`${T.prefix}viewer_history_about_you`].length > 0);
    const priv = createStreamBotPrivacy({ store, db: pool });
    const out = await priv.exportForAccounts(acct);
    assert.equal(out.tables[`${T.prefix}viewers_about_you`].total, 2);
    const del = await priv.deleteForAccounts([{ platform: 'kick', id: pip.id }]);
    assert.equal(del.deleted[`${T.prefix}viewers`], 1);
    assert.equal(await vs.byAccount(P, 'kick', pip.id), null);
    const own = await viewersExport(pool, { profileId: P, prefix: T.prefix });
    assert.ok(own.tables[`${T.prefix}viewers`].length >= 5);
    const n = await vs.count(P);
    const gone = await viewersDelete(pool, { profileId: P, prefix: T.prefix });
    assert.equal(gone[`${T.prefix}viewers`], n);
    assert.equal(await vs.count(P), 0);
    assert.deepEqual(await viewersExport(pool, { profileId: null, accounts: acct, prefix: 'sbtnone_' }), { tables: {} }, 'no tables: nothing, and no error');
});
