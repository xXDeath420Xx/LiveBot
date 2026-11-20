import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../utils/db.js';
import { makeTables, makeProfile } from './fixtures/stream-bot-tables.js';
import { createStreamBotPrivacy } from '../core/stream-bot/privacy.js';
import { normaliseTwitch, normaliseKick } from '../core/stream-bot/events.js';
import { namedPeople, redactEvent, REMOVED } from '../core/stream-bot/named.js';
import { eventPeopleDdl, musicNameIndexes, backfill } from '../migrations/465_stream_bot_event_people.js';
import { musicDdl, MUSIC_TABLES } from '../migrations/457_stream_bot_music.js';

/*
 * H-783: /privacy and /privacy/viewer also find a viewer where SOMEONE ELSE's stored event names them, on throwaway
 * tables. Fixtures cover each field: a Twitch chat reply (parent and thread), Twitch mention fragments, a Kick reply and
 * a Kick "@name", Kick gift sub recipients (raw and metadata), a Twitch raid's target, a notification cut at 16 KB, and
 * song requests / bans / playlist songs that name a moderator. Export lists them (without who wrote them); delete
 * blanks only the fields naming the viewer, keeps the other person's event and the other people it names, and the
 * lookups go through the indexed event_people table (no scan of `raw`).
 */

let T, store, profile, other;
const TW = '555001';           // the viewer on Twitch: login maplefan_88, display MapleFan_88
const KK = '777001';           // the viewer on Kick: username JuniperSkies, slug juniperskies
const OTHER_TW = '424242';     // someone else, mentioned next to the viewer
const VIEWER_DISCORD = 'sbtest-named-viewer';
const fakeLinks = {
    async query(sql, params) {
        if (/twitch_oauth_accounts/.test(sql)) return [params[0] === VIEWER_DISCORD ? [{ twitch_user_id: TW }] : []];
        if (/stream_platform_accounts/.test(sql)) return [params[0] === VIEWER_DISCORD ? [{ platform: 'kick', platform_user_id: KK }] : []];
        return pool.query(sql, params);
    },
};
const ids = {};

const twChat = (extra) => normaliseTwitch('channel.chat.message', {
    broadcaster_user_id: '900000001', broadcaster_user_login: 'maplehollow_tv', chatter_user_id: '123', chatter_user_login: 'bramble', chatter_user_name: 'Bramble',
    badges: [], ...extra,
});
const kkChat = (extra) => normaliseKick('chat.message.sent', {
    broadcaster: { user_id: 800000001 }, sender: { user_id: 31, username: 'Fern', channel_slug: 'fern', identity: { badges: [] } }, ...extra,
});

const FIXTURES = {
    reply: twChat({ message_id: 'm-reply', message: { text: '@MapleFan_88 agreed', fragments: [{ type: 'mention', text: '@MapleFan_88', mention: { user_id: TW, user_login: 'maplefan_88', user_name: 'MapleFan_88' } }, { type: 'text', text: ' agreed', mention: null }] },
        reply: { parent_message_id: 'p1', parent_message_body: 'my own words here', parent_user_id: TW, parent_user_login: 'maplefan_88', parent_user_name: 'MapleFan_88',
            thread_message_id: 'p1', thread_user_id: TW, thread_user_login: 'maplefan_88', thread_user_name: 'MapleFan_88' } }),
    thread: twChat({ message_id: 'm-thread', message: { text: 'same here', fragments: [{ type: 'text', text: 'same here' }] },
        reply: { parent_message_id: 'p2', parent_message_body: 'not theirs', parent_user_id: '999', parent_user_login: 'someone', parent_user_name: 'Someone',
            thread_message_id: 'p1', thread_user_id: TW, thread_user_login: 'maplefan_88', thread_user_name: 'MapleFan_88' } }),
    mention: twChat({ message_id: 'm-mention', message: { text: 'hi @MapleFan_88 and @OtherOne', fragments: [
        { type: 'text', text: 'hi ' }, { type: 'mention', text: '@MapleFan_88', mention: { user_id: TW, user_login: 'maplefan_88', user_name: 'MapleFan_88' } },
        { type: 'text', text: ' and ' }, { type: 'mention', text: '@OtherOne', mention: { user_id: OTHER_TW, user_login: 'otherone', user_name: 'OtherOne' } }] } }),
    kickReply: kkChat({ message_id: 'k-reply', content: 'yes @JuniperSkies, and @someoneelse too',
        replies_to: { message_id: 'k0', content: 'juniper said this', sender: { user_id: Number(KK), username: 'JuniperSkies', channel_slug: 'juniperskies' } } }),
    kickMention: kkChat({ message_id: 'k-mention', content: 'gg @juniperskies' }),
    giftsRaw: normaliseKick('channel.subscription.gifts', { broadcaster: { user_id: 800000001 }, gifter: { user_id: 32, username: 'Gifty', channel_slug: 'gifty' },
        giftees: [{ user_id: Number(KK), username: 'JuniperSkies', channel_slug: 'juniperskies' }, { user_id: 33, username: 'Other', channel_slug: 'other' }], created_at: '2026-11-19T10:00:00Z' }),
    raid: normaliseTwitch('channel.raid', { from_broadcaster_user_id: '600', from_broadcaster_user_login: 'raider', from_broadcaster_user_name: 'Raider',
        to_broadcaster_user_id: TW, to_broadcaster_user_login: 'maplefan_88', to_broadcaster_user_name: 'MapleFan_88', viewers: 12 }),
    unrelated: twChat({ message_id: 'm-none', message: { text: 'nothing about them', fragments: [{ type: 'text', text: 'nothing about them' }] } }),
};

test.before(async () => {
    T = await makeTables(pool, 'n');
    store = T.store;
    for (const sql of musicDdl(T.prefix)) await pool.query(sql);
    for (const sql of eventPeopleDdl(T.prefix)) await pool.query(sql);
    await musicNameIndexes(pool, T.prefix);
    profile = await makeProfile(store, 'sbtest-named-owner');
    other = await store.ensureProfile('sbtest-named-other', 'Other streamer');
    // The viewer's own events: how identify() learns their logins and display names.
    await store.insertEvent(profile.id, normaliseTwitch('channel.follow', { broadcaster_user_id: '900000001', user_id: TW, user_login: 'maplefan_88', user_name: 'MapleFan_88', followed_at: new Date().toISOString() }));
    await store.insertEvent(other.id, normaliseKick('channel.followed', { broadcaster: { user_id: 800000002 }, follower: { user_id: Number(KK), username: 'JuniperSkies', channel_slug: 'juniperskies' } }));
    for (const [k, ev] of Object.entries(FIXTURES)) ids[k] = await store.insertEvent(k === 'raid' || k === 'kickMention' ? other.id : profile.id, ev);
    // A Kick gift event whose raw was not kept: only metadata.giftees (usernames) names them.
    const metaOnly = { ...FIXTURES.giftsRaw, raw: null, dedupeKey: null, metadata: { count: 1, anonymous: false, giftees: ['JuniperSkies'] } };
    ids.giftsMeta = await store.insertEvent(profile.id, metaOnly);
    // A notification cut at 16 KB (not valid JSON): indexed by hand as the backfill could not parse it.
    const [cut] = await pool.query(`INSERT INTO \`${T.prefix}events\` (profile_id, platform, type, channel_id, actor_id, actor_login, actor_name, message, metadata, raw, occurred_at)
        VALUES (?, 'twitch', 'chat', '900000001', '124', 'pip', 'Pip', 'replying', '{}', ?, NOW(3))`,
    [profile.id, `{"chatter_user_id":"124","reply":{"parent_user_id":"${TW}","parent_user_login":"maplefan_88","parent_user_name":"MapleFan_88","parent_message_body":"tru`]);
    ids.cut = Number(cut.insertId);
    await pool.query(`INSERT INTO \`${T.prefix}event_people\` (event_id, profile_id, platform, platform_user_id, login, role) VALUES (?, ?, 'twitch', ?, 'maplefan_88', 'reply_parent')`, [ids.cut, profile.id, TW]);
    // Song requests where the viewer is the moderator who handled them (by display name only).
    await pool.query(`INSERT INTO \`${T.prefix}music_requests\` (profile_id, platform, viewer_id, viewer_login, viewer_name, source, input, title, track_key, status, decided_by)
        VALUES (?, 'kick', '31', 'fern', 'Fern', 'chat', 'song', 'Fern Song', 'k1', 'queued', 'MapleFan_88'), (?, 'kick', '31', 'fern', 'Fern', 'chat', 'song2', 'Other Song', 'k2', 'denied', 'SomeMod')`, [profile.id, profile.id]);
    await pool.query(`INSERT INTO \`${T.prefix}music_bans\` (profile_id, kind, ref, title, created_by) VALUES (?, 'track', 'r1', 'Banned Song', 'juniperskies')`, [profile.id]);
    const [pl] = await pool.query(`INSERT INTO \`${T.prefix}music_playlists\` (profile_id, name) VALUES (?, 'Chill')`, [profile.id]);
    await pool.query(`INSERT INTO \`${T.prefix}music_playlist_items\` (playlist_id, profile_id, track_key, title, source, added_by) VALUES (?, ?, 't1', 'Added Song', 'spotify', 'MapleFan_88')`, [pl.insertId, profile.id]);
});
test.after(async () => {
    await pool.query(`DROP TABLE IF EXISTS \`${T.prefix}event_people\``);
    for (const t of [...MUSIC_TABLES].reverse()) await pool.query(`DROP TABLE IF EXISTS \`${T.prefix}${t}\``);
    await T.drop();
    await pool.end().catch(() => {});
});

const rowOf = async (id) => (await pool.query(`SELECT * FROM \`${T.prefix}events\` WHERE id = ?`, [id]))[0][0];
const people = async (id) => (await pool.query(`SELECT platform, platform_user_id, login, role FROM \`${T.prefix}event_people\` WHERE event_id = ? ORDER BY id`, [id]))[0];

test('namedPeople: each field, by id where the platform gives one, never the actor', () => {
    const roles = (ev) => namedPeople(ev).map((p) => `${p.role}:${p.userId || ''}:${p.login || ''}`);
    assert.deepEqual(roles(FIXTURES.reply), [`reply_parent:${TW}:maplefan_88`, `mention:${TW}:maplefan_88`], 'thread starter = parent: one row');
    assert.deepEqual(roles(FIXTURES.thread), ['reply_parent:999:someone', `reply_thread:${TW}:maplefan_88`]);
    assert.deepEqual(roles(FIXTURES.mention), [`mention:${TW}:maplefan_88`, `mention:${OTHER_TW}:otherone`]);
    assert.deepEqual(roles(FIXTURES.kickReply), [`reply_parent:${KK}:juniperskies`, 'mention::juniperskies', 'mention::someoneelse']);
    assert.deepEqual(roles(FIXTURES.kickMention), ['mention::juniperskies']);
    assert.deepEqual(roles(FIXTURES.giftsRaw), [`giftee:${KK}:juniperskies`, 'giftee:33:other']);
    assert.deepEqual(roles({ ...FIXTURES.giftsRaw, raw: null, metadata: { giftees: ['JuniperSkies'] } }), ['giftee::juniperskies']);
    assert.deepEqual(roles(FIXTURES.raid), [`raid_target:${TW}:maplefan_88`]);
    assert.deepEqual(roles(FIXTURES.unrelated), []);
    const self = twChat({ chatter_user_id: TW, message: { text: '@MapleFan_88', fragments: [{ type: 'mention', text: '@MapleFan_88', mention: { user_id: TW, user_login: 'maplefan_88' } }] } });
    assert.deepEqual(roles(self), [], 'mentioning yourself is your own event already');
});

test('insertEvent indexes who each event names', async () => {
    assert.deepEqual((await people(ids.reply)).map((p) => p.role), ['reply_parent', 'mention']);
    assert.deepEqual((await people(ids.giftsRaw)).map((p) => p.platform_user_id), [KK, '33']);
    assert.deepEqual((await people(ids.giftsMeta)).map((p) => [p.platform_user_id, p.login]), [[null, 'juniperskies']]);
    assert.deepEqual(await people(ids.unrelated), []);
    // The backfill finds nothing new (every event is indexed already) and the lookups use the indexes.
    assert.equal(await backfill(pool, T.prefix), 0);
    const [plan] = await pool.query(`EXPLAIN SELECT event_id FROM \`${T.prefix}event_people\` WHERE platform = 'twitch' AND platform_user_id = ?`, [TW]);
    assert.match(String(plan[0].possible_keys), /idx_person/);
    const [plan2] = await pool.query(`EXPLAIN SELECT event_id FROM \`${T.prefix}event_people\` WHERE platform = 'kick' AND login IN ('juniperskies') AND platform_user_id IS NULL`);
    assert.match(String(plan2[0].possible_keys), /idx_login/);
});

test('export: other people\'s events that name the viewer, without who wrote them; song requests they handled', async () => {
    const p = createStreamBotPrivacy({ store, db: pool, rowLimit: 1000 });
    const out = await p.exportForAccounts([{ platform: 'twitch', id: TW }, { platform: 'kick', id: KK }]);
    const named = out.tables[`${T.prefix}events_naming_you`];
    assert.ok(named, 'events_naming_you exported');
    const byId = new Map(named.rows.map((r) => [r.eventId, r]));
    for (const k of ['reply', 'thread', 'mention', 'kickReply', 'kickMention', 'giftsRaw', 'giftsMeta', 'raid', 'cut']) assert.ok(byId.has(ids[k]), `${k} exported`);
    assert.ok(!byId.has(ids.unrelated));
    assert.deepEqual(byId.get(ids.reply).namedAs.sort(), ['mention', 'reply_parent']);
    assert.deepEqual(byId.get(ids.thread).namedAs, ['reply_thread']);
    assert.deepEqual(byId.get(ids.raid).namedAs, ['raid_target']);
    assert.deepEqual(byId.get(ids.kickReply).namedAs.sort(), ['mention', 'reply_parent']);
    assert.equal(byId.get(ids.mention).message, 'hi @MapleFan_88 and @OtherOne');
    assert.equal(byId.get(ids.giftsRaw).message, null);
    for (const r of named.rows) for (const k of ['actorId', 'user', 'actor_id', 'raw']) assert.ok(!(k in r), `no ${k}: who wrote it is not exported`);
    const music = out.tables[`${T.prefix}music_named_you`].rows;
    assert.deepEqual(music.map((r) => [r.namedAs, r.title]).sort(), [['added_by', 'Added Song'], ['created_by', 'Banned Song'], ['decided_by', 'Fern Song']]);
    assert.match(out.note, /name you/);
    // Their own events are still exported as before (as the actor), and not twice.
    assert.equal(out.tables[`${T.prefix}events_about_you`].total, 2);
    // /privacy (Discord) finds the same through the linked accounts.
    const viaDiscord = await createStreamBotPrivacy({ store, db: fakeLinks, rowLimit: 1000 }).exportFor(VIEWER_DISCORD);
    assert.equal(viaDiscord.tables[`${T.prefix}events_naming_you`].total, named.total);
});

test('redactEvent: a Twitch reply keeps the other person\'s words and drops the viewer\'s', () => {
    const r = redactEvent({ platform: 'twitch', type: 'chat', message: FIXTURES.reply.message, metadata: '{}', raw: JSON.stringify(FIXTURES.reply.raw) },
        { ids: [TW], logins: [], names: [] });
    const raw = JSON.parse(r.raw);
    assert.equal(r.changed, true);
    assert.deepEqual([raw.reply.parent_user_id, raw.reply.parent_user_login, raw.reply.parent_user_name, raw.reply.parent_message_body], [null, null, REMOVED, REMOVED]);
    assert.equal(r.message, '@[removed] agreed', 'the login read from the matched field goes from the text too');
    assert.equal(raw.chatter_user_name, 'Bramble');
});

test('delete: blanks only the fields naming the viewer; the events and other people stay', async () => {
    const before = (await pool.query(`SELECT COUNT(*) n FROM \`${T.prefix}events\``))[0][0].n;
    const p = createStreamBotPrivacy({ store, db: pool, rowLimit: 1000 });
    const { deleted } = await p.deleteForAccounts([{ platform: 'twitch', id: TW }, { platform: 'kick', id: KK }]);
    assert.equal(deleted[`${T.prefix}events`], 2, 'their own two events are deleted');
    assert.equal(deleted[`${T.prefix}events_naming_you`], 9, 'nine other events redacted');
    assert.equal(deleted[`${T.prefix}music_requests_decided`], 1);
    assert.equal(deleted[`${T.prefix}music_bans_created`], 1);
    assert.equal(deleted[`${T.prefix}music_playlist_items_added`], 1);
    assert.equal((await pool.query(`SELECT COUNT(*) n FROM \`${T.prefix}events\``))[0][0].n, before - 2, 'nobody else\'s event was deleted');

    const reply = await rowOf(ids.reply);
    const rr = JSON.parse(reply.raw);
    assert.deepEqual([rr.reply.parent_user_id, rr.reply.parent_user_login, rr.reply.parent_user_name, rr.reply.parent_message_body], [null, null, REMOVED, REMOVED]);
    assert.deepEqual([rr.reply.thread_user_id, rr.reply.thread_user_name], [null, REMOVED]);
    assert.equal(reply.message, '@[removed] agreed');
    assert.equal(reply.actor_id, '123', 'the author stays');

    const thread = JSON.parse((await rowOf(ids.thread)).raw);
    assert.deepEqual([thread.reply.parent_user_id, thread.reply.parent_message_body, thread.reply.thread_user_id], ['999', 'not theirs', null], 'the other parent stays');

    const mention = await rowOf(ids.mention);
    const mr = JSON.parse(mention.raw);
    assert.equal(mention.message, 'hi @[removed] and @OtherOne');
    assert.deepEqual(mr.message.fragments[1], { type: 'mention', text: '@[removed]', mention: { user_id: null, user_login: null, user_name: REMOVED } });
    assert.equal(mr.message.fragments[3].mention.user_id, OTHER_TW, 'the other person mentioned stays');
    assert.deepEqual((await people(ids.mention)).map((x) => x.platform_user_id), [OTHER_TW], 'their index row goes, the other one stays');

    const kr = await rowOf(ids.kickReply);
    const kraw = JSON.parse(kr.raw);
    assert.deepEqual(kraw.replies_to.sender, { user_id: null, username: REMOVED, channel_slug: null });
    assert.equal(kraw.replies_to.content, REMOVED);
    assert.equal(kr.message, 'yes @[removed], and @someoneelse too');
    assert.equal(kraw.content, 'yes @[removed], and @someoneelse too');
    assert.deepEqual((await people(ids.kickReply)).map((x) => x.login), ['someoneelse']);
    assert.equal((await rowOf(ids.kickMention)).message, 'gg @[removed]');

    const gifts = await rowOf(ids.giftsRaw);
    const graw = JSON.parse(gifts.raw);
    assert.deepEqual(graw.giftees[0], { user_id: null, username: REMOVED, channel_slug: null });
    assert.equal(graw.giftees[1].user_id, 33);
    assert.deepEqual(JSON.parse(gifts.metadata).giftees, [REMOVED, 'Other']);
    assert.deepEqual(JSON.parse((await rowOf(ids.giftsMeta)).metadata).giftees, [REMOVED]);

    const raid = await rowOf(ids.raid);
    const rraw = JSON.parse(raid.raw);
    assert.deepEqual([rraw.to_broadcaster_user_id, rraw.to_broadcaster_user_login, rraw.to_broadcaster_user_name, rraw.from_broadcaster_user_id], [null, null, REMOVED, '600']);

    const cut = (await rowOf(ids.cut)).raw;
    assert.ok(cut.includes('"parent_user_id":null') && cut.includes('"parent_user_login":"[removed]"') && cut.includes('"parent_user_name":"[removed]"'), cut);

    // Nothing left that names them, anywhere in the other events.
    const [rest] = await pool.query(`SELECT id, message, metadata, raw FROM \`${T.prefix}events\``);
    for (const r of rest) {
        const text = `${r.message} ${r.metadata} ${r.raw}`.toLowerCase();
        for (const needle of [TW, KK, 'maplefan_88', 'juniperskies', 'my own words', 'juniper said']) assert.ok(!text.includes(needle), `event ${r.id} still has ${needle}`);
    }
    const [[left]] = await pool.query(`SELECT COUNT(*) n FROM \`${T.prefix}event_people\` WHERE platform_user_id IN (?, ?) OR login IN ('maplefan_88', 'juniperskies')`, [TW, KK]);
    assert.equal(left.n, 0);
    const [music] = await pool.query(`SELECT title, decided_by FROM \`${T.prefix}music_requests\` ORDER BY id`);
    assert.deepEqual(music.map((m) => m.decided_by), [REMOVED, 'SomeMod']);
    assert.equal((await pool.query(`SELECT created_by FROM \`${T.prefix}music_bans\``))[0][0].created_by, REMOVED);
    assert.equal((await pool.query(`SELECT added_by FROM \`${T.prefix}music_playlist_items\``))[0][0].added_by, REMOVED);

    // Run again: nothing more to do, and the export is empty.
    const again = await p.deleteForAccounts([{ platform: 'twitch', id: TW }, { platform: 'kick', id: KK }]);
    assert.equal(again.deleted[`${T.prefix}events_naming_you`] || 0, 0);
    const out = await p.exportForAccounts([{ platform: 'twitch', id: TW }, { platform: 'kick', id: KK }]);
    assert.equal(out.tables[`${T.prefix}events_naming_you`], undefined);
});

test('without migration 465 the store still stores events (the index is skipped quietly)', async () => {
    const T2 = await makeTables(pool, 'm');
    try {
        const p2 = await makeProfile(T2.store, 'sbtest-named-nomig');
        const id = await T2.store.insertEvent(p2.id, FIXTURES.mention);
        assert.ok(id > 0);
        const out = await createStreamBotPrivacy({ store: T2.store, db: pool }).exportForAccounts([{ platform: 'twitch', id: TW }]);
        assert.equal(out.tables[`${T2.prefix}events_naming_you`], undefined);
        const { deleted } = await createStreamBotPrivacy({ store: T2.store, db: pool }).deleteForAccounts([{ platform: 'twitch', id: TW }]);
        assert.equal(deleted[`${T2.prefix}events_naming_you`], undefined);
    } finally { await T2.drop(); }
});
