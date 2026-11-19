import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pool from '../utils/db.js';
import { makeTables, makeProfile } from './fixtures/stream-bot-tables.js';
import { timersTestDdl } from '../migrations/456_stream_bot_timers.js';
import {
    validateTimer, pickMessage, fireTimer, timerMessages, renderPlain, createTimerStore, noteChatLine, chatLinesSince, resetChatLines, _resetAllChatLines, timerView,
} from '../core/stream-bot/timers.js';
import { createIngest } from '../core/stream-bot/ingest.js';
import { createFeed } from '../core/stream-bot/feed.js';
import { normaliseKick } from '../core/stream-bot/events.js';
import { createStreamBotPrivacy } from '../core/stream-bot/privacy.js';

/*
 * Timers (core/stream-bot/timers.js, migration 456): the existing timer table and minute job, extended with Twitch,
 * more than one message, "only while live", "only after N chat lines", running an automation and template
 * variables. Sending is faked; the SQL runs on throwaway copies of tokes_timers and tokes_channels.
 */

let T, store, profile, timersTable, channelsTable, timers;

test.before(async () => {
    T = await makeTables(pool, 't');
    store = T.store;
    profile = await makeProfile(store);
    const tag = crypto.randomBytes(3).toString('hex');
    timersTable = `sbtimer${tag}_timers`;
    channelsTable = `sbtimer${tag}_channels`;
    await pool.query(timersTestDdl(timersTable));
    await pool.query(`CREATE TABLE \`${channelsTable}\` (id INT PRIMARY KEY AUTO_INCREMENT, platform VARCHAR(10), channel_id VARCHAR(100), channel_name VARCHAR(100), is_enabled TINYINT(1) DEFAULT 1, defender_enabled TINYINT(1) DEFAULT 0)`);
    timers = createTimerStore({ db: pool, table: timersTable, channelsTable });
});
test.after(async () => {
    await pool.query(`DROP TABLE IF EXISTS \`${timersTable}\``);
    await pool.query(`DROP TABLE IF EXISTS \`${channelsTable}\``);
    await T.drop();
    await pool.end().catch(() => {});
});

test('validation: messages or an automation, interval and chat-line bounds, Kick channel page timers stay Kick-only', () => {
    const ok = validateTimer({ name: ' Socials ', messages: 'Follow on X\n\nJoin the Discord {channel.name}', rotation: 'random', intervalMin: '15', onlyLive: true, minChatLines: '10', platforms: 'twitch' },
        { automationIds: new Set([4]), linkedPlatforms: ['twitch', 'kick'] });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.value, { name: 'Socials', message: 'Follow on X', extraMessages: ['Join the Discord {channel.name}'], rotation: 'random', intervalMin: 15, onlyLive: true, minChatLines: 10, automationId: null, platforms: 'twitch', enabled: true });
    assert.ok(validateTimer({ messages: '', intervalMin: 30 }).errors.some((e) => /Enter a message, or pick an automation/.test(e)));
    assert.ok(validateTimer({ messages: 'x', intervalMin: 0 }).errors.some((e) => /1 to 1440 minutes/.test(e)));
    assert.ok(validateTimer({ messages: 'x', intervalMin: 5, minChatLines: 5000 }).errors.some((e) => /0 to 1000/.test(e)));
    assert.ok(validateTimer({ messages: 'x'.repeat(501), intervalMin: 5 }).errors.some((e) => /500 characters/.test(e)));
    assert.ok(validateTimer({ messages: 'x', intervalMin: 5, automationId: 99 }, { automationIds: new Set([4]) }).errors.some((e) => /Pick one of your automations/.test(e)));
    assert.equal(validateTimer({ automationId: 4, intervalMin: 5 }, { automationIds: new Set([4]) }).value.automationId, 4);
    assert.ok(validateTimer({ messages: 'x', intervalMin: 5, platforms: 'kick' }, { linkedPlatforms: ['twitch'] }).errors.some((e) => /Link a Kick channel/.test(e)));
    const kickPage = validateTimer({ messages: 'x', intervalMin: 5, automationId: 4, platforms: 'twitch' }, { kickPage: true, automationIds: new Set([4]) });
    assert.deepEqual([kickPage.value.automationId, kickPage.value.platforms], [null, null]);
});

test('messages take turns or come at random; {{channel_name}} and {stream.*} render without a profile', async () => {
    const t = { message: 'one', extra_messages: JSON.stringify(['two', 'three']), rotation: 'rotate', next_index: 0 };
    assert.deepEqual(timerMessages(t), ['one', 'two', 'three']);
    const seq = [];
    for (let i = 0; i < 4; i++) { const p = pickMessage(t); seq.push(p.text); t.next_index = p.nextIndex; }
    assert.deepEqual(seq, ['one', 'two', 'three', 'one']);
    assert.equal(pickMessage({ ...t, rotation: 'random' }, () => 0.99).text, 'three');
    const text = await renderPlain('Hi {{channel_name}}, live for {stream.uptime} playing {stream.category}', { channelName: 'maplehollow', info: { live: true, category: 'Hades', startedAt: new Date(Date.now() - 65 * 60e3).toISOString() } });
    assert.equal(text, 'Hi maplehollow, live for 1h 05m playing Hades');
});

test('a due timer posts only where it is live and enough chat has happened, then counts start again', async () => {
    _resetAllChatLines();
    const sent = [];
    const deps = (over = {}) => ({
        targets: [{ platform: 'twitch', channelId: '900000001', login: 'maplehollow_tv' }, { platform: 'kick', channelId: '800000001', login: 'maplehollow' }],
        streamInfo: async (p) => (p === 'twitch' ? { live: true } : { live: false }),
        render: async (text, target) => text.replace('{channel.name}', target.login),
        send: async (m) => { sent.push(m); return true; },
        runAutomation: async () => ({ status: 'running' }),
        ...over,
    });
    const t = { id: 1, message: 'Hello {channel.name}', extra_messages: '["Second"]', rotation: 'rotate', next_index: 0, only_live: 1, min_chat_lines: 3 };
    let r = await fireTimer(t, deps());
    assert.equal(r.sent, false);
    assert.match(r.detail, /twitch: 0 of 3 chat lines; kick: not live/);
    for (let i = 0; i < 3; i++) noteChatLine('twitch', '900000001');
    r = await fireTimer(t, deps());
    assert.equal(r.sent, true);
    assert.deepEqual(sent.map((m) => [m.platform, m.text]), [['twitch', 'Hello maplehollow_tv']]);
    assert.equal(r.nextIndex, 1);
    assert.equal(chatLinesSince('twitch', '900000001'), 0, 'posting starts the count again');
    // Not live anywhere: nothing, and the message does not advance.
    r = await fireTimer({ ...t, next_index: 1, min_chat_lines: 0 }, deps({ streamInfo: async () => null }));
    assert.deepEqual([r.sent, r.nextIndex], [false, 1]);
    // A failed send does not count as posted.
    r = await fireTimer({ ...t, only_live: 0, min_chat_lines: 0 }, deps({ send: async () => false }));
    assert.equal(r.sent, false);
    // Runs an automation instead of posting.
    let ran = null;
    r = await fireTimer({ ...t, only_live: 0, min_chat_lines: 0, automation_id: 12 }, deps({ runAutomation: async (target) => { ran = target; return { status: 'running' }; } }));
    assert.deepEqual([r.sent, ran.platform], [true, 'twitch']);
    resetChatLines('twitch', '900000001');
});

test('chat lines are counted from viewers only (not the bot\'s own echo)', async () => {
    _resetAllChatLines();
    const ingest = createIngest({ store, engine: { handleEvent: async () => [] }, feed: createFeed(), onChatLine: noteChatLine });
    const kickChat = (text, id) => ({ broadcaster: { user_id: 800000001 }, sender: { user_id: 5, username: 'viewer', channel_slug: 'viewer', identity: { badges: [] } }, content: text, message_id: id });
    await ingest.kick('chat.message.sent', kickChat('hello', 'a1'));
    await ingest.kick('chat.message.sent', kickChat('hi there', 'a2'));
    ingest.noteSent('kick', '800000001', 'Follow the socials!');
    await ingest.kick('chat.message.sent', kickChat('Follow the socials!', 'a3'));
    assert.equal(chatLinesSince('kick', '800000001'), 2);
    assert.ok(normaliseKick('chat.message.sent', kickChat('x', 'a4')));
    // Channels with no stream bot profile still count (Kick channel page timers use the same counts).
    await ingest.kick('chat.message.sent', { ...kickChat('yo', 'b1'), broadcaster: { user_id: 777 } });
    assert.equal(chatLinesSince('kick', '777'), 1);
});

test('SQL: stream bot timers and the Kick channel page timers of linked Kick channels; ownership; due; privacy', async () => {
    const other = await store.ensureProfile(`sbtest-other-${crypto.randomBytes(2).toString('hex')}`, 'Other');
    await pool.query(`INSERT INTO \`${channelsTable}\` (platform, channel_id, channel_name, is_enabled, defender_enabled) VALUES ('kick', '800000001', 'maplehollow', 1, 1), ('kick', '555', 'someoneelse', 1, 1), ('kick', '556', 'offbot', 1, 0)`);
    const [chs] = await pool.query(`SELECT id, channel_id FROM \`${channelsTable}\``);
    const chId = (cid) => chs.find((c) => c.channel_id === cid).id;
    await pool.query(`INSERT INTO \`${timersTable}\` (channel_id, message, interval_min) VALUES (?, 'Kick page timer', 30), (?, 'Not yours', 30), (?, 'Defender off', 30)`, [chId('800000001'), chId('555'), chId('556')]);
    const v = validateTimer({ name: 'Socials', messages: 'a\nb', intervalMin: 10, platforms: 'all' }).value;
    const id = await timers.create(profile.id, v, 'discord-1');
    await timers.create(other.id, validateTimer({ messages: 'theirs', intervalMin: 10 }).value);

    const mine = await timers.listForProfile(profile.id, ['800000001']);
    assert.deepEqual(mine.own.map((r) => timerView(r).messages), [['a', 'b']]);
    assert.deepEqual(mine.kick.map((r) => [timerView(r).kind, timerView(r).channelName, r.message]), [['kick_page', 'maplehollow', 'Kick page timer']]);
    assert.ok(await timers.getForProfile(profile.id, id, ['800000001']));
    const [[notMine]] = await pool.query(`SELECT id FROM \`${timersTable}\` WHERE message = 'Not yours'`);
    assert.equal(await timers.getForProfile(profile.id, notMine.id, ['800000001']), null, 'a Kick page timer of a channel not linked to you');
    const [[theirs]] = await pool.query(`SELECT id FROM \`${timersTable}\` WHERE message = 'theirs'`);
    assert.equal(await timers.getForProfile(profile.id, theirs.id, ['800000001']), null, 'another profile\'s timer');

    await timers.update(id, { ...v, extraMessages: ['b', 'c'], onlyLive: true, minChatLines: 4 }, {});
    const row = await timers.getForProfile(profile.id, id, []);
    assert.deepEqual([timerView(row).messages, timerView(row).onlyLive, timerView(row).minChatLines], [['a', 'b', 'c'], true, 4]);

    const due = await timers.due();
    const msgs = due.map((r) => r.message).sort();
    assert.deepEqual(msgs, ['Kick page timer', 'Not yours', 'a', 'theirs'], 'Kick page timers need Kick Defender on; stream bot timers always come');
    await timers.markSent(id, 2);
    assert.equal((await timers.due()).some((r) => Number(r.id) === id), false, 'not due again until its interval has passed');
    assert.equal(Number((await timers.getForProfile(profile.id, id, [])).next_index), 2);

    const privacy = createStreamBotPrivacy({ store, db: pool, timersTable });
    const out = await privacy.exportFor(profile.ownerDiscordId);
    assert.deepEqual(out.tables[`${store.prefix}timers`].rows.map((r) => r.name), ['Socials']);
    const del = await privacy.deleteFor(profile.ownerDiscordId);
    assert.equal(del.deleted[`${store.prefix}timers`], 1);
    const [[left]] = await pool.query(`SELECT COUNT(*) AS n FROM \`${timersTable}\` WHERE profile_id = ?`, [profile.id]);
    assert.equal(Number(left.n), 0);
});
