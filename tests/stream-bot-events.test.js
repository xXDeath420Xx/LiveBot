import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
    EVENT_TYPES, normaliseTwitch, normaliseKick, normaliseTip, sampleEvent, publicEvent, describeEvent, twitchRoles, kickRoles, isEventType,
} from '../core/stream-bot/events.js';
import { createTipFeeds, parseEngineIo3 } from '../core/stream-bot/tip-feeds.js';
import { STREAM_BOT_SCOPES, FORBIDDEN_SCOPES, coverage, TWITCH_FEATURES } from '../core/stream-bot/scopes.js';

/*
 * Stream bot event normalisation (core/stream-bot/events.js, design §2.2): every Twitch EventSub type the feed
 * takes, every Kick webhook type, every tip source; the Test button's samples; the StreamElements and Streamlabs
 * socket protocols (fake sockets); and the Stream bot grant's scope rules (no user:read:follows, no revenue scopes).
 */

const B = '900000001';
const tw = (type, e) => normaliseTwitch(type, { broadcaster_user_id: B, broadcaster_user_login: 'maplehollow_tv', ...e });

test('Twitch: follow, sub, resub, gift subs, cheer, raid, redemption', () => {
    let ev = tw('channel.follow', { user_id: '1', user_login: 'MapleFan_88', user_name: 'MapleFan_88', followed_at: '2026-11-19T10:00:00Z' });
    assert.equal(ev.platform, 'twitch'); assert.equal(ev.type, 'follow'); assert.equal(ev.channelId, B);
    assert.deepEqual(ev.user, { id: '1', login: 'maplefan_88', name: 'MapleFan_88', roles: [] });
    assert.equal(ev.occurredAt.toISOString(), '2026-11-19T10:00:00.000Z');
    assert.ok(ev.dedupeKey.startsWith('tw:follow:'));

    ev = tw('channel.subscribe', { user_id: '2', user_login: 'a', user_name: 'A', tier: '2000', is_gift: true });
    assert.equal(ev.type, 'sub'); assert.equal(ev.metadata.tier, '2000'); assert.equal(ev.metadata.isGift, true); assert.deepEqual(ev.user.roles, ['subscriber']);

    ev = tw('channel.subscription.message', { user_id: '3', user_login: 'b', user_name: 'B', tier: '1000', cumulative_months: 7, streak_months: 3, message: { text: 'seven!' } });
    assert.equal(ev.type, 'resub'); assert.equal(ev.amount, 7); assert.equal(ev.currency, 'months'); assert.equal(ev.message, 'seven!'); assert.equal(ev.metadata.streak, 3);

    ev = tw('channel.subscription.gift', { user_id: '4', user_login: 'c', user_name: 'C', total: 5, tier: '1000', cumulative_total: 40, is_anonymous: false });
    assert.equal(ev.type, 'gift_sub'); assert.equal(ev.amount, 5); assert.equal(ev.currency, 'subs'); assert.equal(ev.metadata.count, 5);
    ev = tw('channel.subscription.gift', { user_id: null, total: 1, tier: '1000', is_anonymous: true });
    assert.equal(ev.user, null); assert.equal(ev.metadata.anonymous, true);

    ev = tw('channel.cheer', { user_id: '5', user_login: 'd', user_name: 'D', bits: 500, message: 'Cheer500 go', is_anonymous: false });
    assert.equal(ev.type, 'cheer'); assert.equal(ev.amount, 500); assert.equal(ev.currency, 'bits'); assert.equal(ev.message, 'Cheer500 go');

    ev = normaliseTwitch('channel.raid', { from_broadcaster_user_id: '6', from_broadcaster_user_login: 'bramblebyte_live', from_broadcaster_user_name: 'BrambleByte_Live', to_broadcaster_user_id: B, viewers: 42 }, 'channel.raid');
    assert.equal(ev.type, 'raid'); assert.equal(ev.channelId, B); assert.equal(ev.amount, 42); assert.equal(ev.user.login, 'bramblebyte_live');
    assert.equal(normaliseTwitch('channel.raid', { from_broadcaster_user_id: B, to_broadcaster_user_id: '6', viewers: 3 }, 'channel.raid:out'), null, 'outgoing raids are not events');

    ev = tw('channel.channel_points_custom_reward_redemption.add', { id: 'r1', user_id: '7', user_login: 'e', user_name: 'E', user_input: 'play it', status: 'unfulfilled', reward: { id: 'rw', title: 'Sound alert', cost: 500 }, redeemed_at: '2026-11-19T10:01:00Z' });
    assert.equal(ev.type, 'redemption'); assert.equal(ev.amount, 500); assert.equal(ev.currency, 'points'); assert.equal(ev.metadata.reward, 'Sound alert'); assert.equal(ev.message, 'play it'); assert.equal(ev.dedupeKey, 'tw:redeem:r1');
});

test('Twitch: hype train, polls, predictions, ad break, online/offline, chat', () => {
    let ev = tw('channel.hype_train.begin', { id: 'h', level: 1, total: 1200, goal: 1800 });
    assert.equal(ev.type, 'hype_train.begin'); assert.equal(ev.metadata.level, 1); assert.equal(ev.amount, 1);
    assert.equal(tw('channel.hype_train.progress', { level: 2 }).type, 'hype_train.progress');
    assert.equal(tw('channel.hype_train.end', { level: 3 }).type, 'hype_train.end');

    ev = tw('channel.poll.end', { id: 'p', title: 'Next game?', status: 'completed', choices: [{ title: 'Celeste', votes: 30 }, { title: 'Hades', votes: 21 }] });
    assert.equal(ev.type, 'poll.end'); assert.equal(ev.metadata.winner, 'Celeste'); assert.equal(ev.message, 'Next game?');
    assert.equal(tw('channel.poll.begin', { id: 'p', title: 'x', choices: [] }).type, 'poll.begin');
    assert.equal(tw('channel.poll.progress', { id: 'p', title: 'x', choices: [] }).dedupeKey, null, 'progress repeats, so no dedupe key');

    ev = tw('channel.prediction.end', { id: 'q', title: 'Boss?', status: 'resolved', winning_outcome_id: 'o2', outcomes: [{ id: 'o1', title: 'Yes' }, { id: 'o2', title: 'No' }] });
    assert.equal(ev.type, 'prediction.end'); assert.equal(ev.metadata.winner, 'No');
    for (const s of ['begin', 'progress', 'lock']) assert.equal(tw(`channel.prediction.${s}`, { id: 'q', title: 'x', outcomes: [] }).type, `prediction.${s}`);

    ev = tw('channel.ad_break.begin', { duration_seconds: 90, is_automatic: true, started_at: '2026-11-19T10:02:00Z' });
    assert.equal(ev.type, 'ad_break'); assert.equal(ev.amount, 90); assert.equal(ev.metadata.automatic, true);

    assert.equal(tw('stream.online', { id: 's1', type: 'live', started_at: '2026-11-19T09:00:00Z' }).type, 'stream.online');
    assert.equal(tw('stream.offline', {}).type, 'stream.offline');

    ev = tw('channel.chat.message', { chatter_user_id: '8', chatter_user_login: 'maplefan_88', chatter_user_name: 'MapleFan_88', message_id: 'm1', message: { text: '!hello there' },
        badges: [{ set_id: 'moderator' }, { set_id: 'subscriber' }, { set_id: 'vip' }] });
    assert.equal(ev.type, 'chat'); assert.equal(ev.message, '!hello there'); assert.deepEqual(ev.user.roles.sort(), ['moderator', 'subscriber', 'vip']); assert.equal(ev.dedupeKey, 'tw:chat:m1');

    assert.equal(tw('channel.ban', { user_id: '1' }), null, 'types the stream bot does not take');
    assert.equal(normaliseTwitch('channel.follow', null), null);
});

test('Kick: chat, follow, sub, renewal, gifts, live status', () => {
    const base = { broadcaster: { user_id: 800000001, channel_slug: 'maplehollow' } };
    let ev = normaliseKick('chat.message.sent', { ...base, message_id: 'k1', content: '!so bramble', sender: { user_id: 11, username: 'Juniper', channel_slug: 'juniper', identity: { badges: [{ type: 'moderator' }, { type: 'subscriber' }] } } });
    assert.equal(ev.platform, 'kick'); assert.equal(ev.type, 'chat'); assert.equal(ev.channelId, '800000001'); assert.equal(ev.message, '!so bramble');
    assert.deepEqual(ev.user.roles, ['moderator', 'subscriber']); assert.equal(ev.user.login, 'juniper'); assert.equal(ev.dedupeKey, 'kk:chat:k1');

    ev = normaliseKick('channel.followed', { ...base, follower: { user_id: 12, username: 'Rowan' } });
    assert.equal(ev.type, 'follow'); assert.equal(ev.user.name, 'Rowan');
    ev = normaliseKick('channel.subscription.new', { ...base, subscriber: { user_id: 13, username: 'Sorrel' }, duration: 1, created_at: '2026-11-19T10:00:00Z' });
    assert.equal(ev.type, 'sub'); assert.deepEqual(ev.user.roles, ['subscriber']);
    ev = normaliseKick('channel.subscription.renewal', { ...base, subscriber: { user_id: 13, username: 'Sorrel' }, duration: 4 });
    assert.equal(ev.type, 'resub'); assert.equal(ev.amount, 4); assert.equal(ev.currency, 'months');
    ev = normaliseKick('channel.subscription.gifts', { ...base, gifter: { user_id: 14, username: 'Bramble' }, giftees: [{ username: 'a' }, { username: 'b' }, { username: 'c' }] });
    assert.equal(ev.type, 'gift_sub'); assert.equal(ev.amount, 3); assert.deepEqual(ev.metadata.giftees, ['a', 'b', 'c']);
    ev = normaliseKick('channel.subscription.gifts', { ...base, gifter: { is_anonymous: true }, giftees: [{ username: 'a' }] });
    assert.equal(ev.user, null); assert.equal(ev.metadata.anonymous, true);
    assert.equal(normaliseKick('livestream.status.updated', { ...base, is_live: true, title: 'Maple day', started_at: '2026-11-19T09:00:00Z' }).type, 'stream.online');
    assert.equal(normaliseKick('livestream.status.updated', { ...base, is_live: false }).type, 'stream.offline');
    assert.equal(normaliseKick('channel.followed', { follower: {} }), null, 'no broadcaster');
    assert.equal(normaliseKick('kicks.gifted', base), null);
});

test('tips: StreamElements, Streamlabs, Ko-fi, Buy Me a Coffee, Throne, Fourthwall', () => {
    let ev = normaliseTip('streamelements', { _id: 'se1', data: { donation: { user: { username: 'Juniper' }, amount: 5, currency: 'USD', message: 'coffee' } } });
    assert.deepEqual([ev.platform, ev.type, ev.amount, ev.currency, ev.message, ev.user.name, ev.dedupeKey], ['streamelements', 'tip', 5, 'USD', 'coffee', 'Juniper', 'se:se1']);

    ev = normaliseTip('streamlabs', { type: 'donation', message: [{ id: 77, name: 'Rowan', amount: '12.50', currency: 'EUR', message: 'hi' }] });
    assert.deepEqual([ev.type, ev.amount, ev.currency, ev.user.name, ev.dedupeKey], ['tip', 12.5, 'EUR', 'Rowan', 'sl:77']);
    assert.equal(normaliseTip('streamlabs', { type: 'follow', message: [{}] }), null, 'only donations');

    const kofi = { messageId: 'k1', type: 'Donation', fromName: 'Sorrel', message: 'thanks', amount: 3, currency: 'USD', email: 'x@example.invalid', verificationToken: 'secret', isPublic: true };
    ev = normaliseTip('kofi', kofi);
    assert.deepEqual([ev.type, ev.amount, ev.user.name, ev.dedupeKey], ['tip', 3, 'Sorrel', 'kofi:k1']);
    assert.equal(ev.raw.email, undefined, 'no email in the stored payload'); assert.equal(ev.raw.verificationToken, undefined);
    assert.equal(normaliseTip('kofi', { ...kofi, isPublic: false }).user.name, 'Anonymous', 'private Ko-fi tips stay anonymous');
    assert.equal(normaliseTip('kofi', { ...kofi, isPublic: false }).message, null);
    assert.equal(normaliseTip('kofi', { ...kofi, type: 'Subscription', isSubscription: true }).type, 'membership');
    assert.equal(normaliseTip('kofi', { ...kofi, type: 'Shop Order' }).type, 'merch_order');

    const now = Date.parse('2026-11-19T12:00:00Z');
    ev = normaliseTip('bmac', { id: '55', type: 'supporter', name: 'Bramble', amountNum: 10, currency: 'USD', note: 'yo', createdOn: '2026-11-19 11:50:00', hidden: false }, { now });
    assert.deepEqual([ev.type, ev.amount, ev.user.name, ev.dedupeKey], ['tip', 10, 'Bramble', 'bmac:supporter:55']);
    assert.equal(normaliseTip('bmac', { id: '56', type: 'supporter', amountNum: 1, createdOn: '2026-11-18 09:00:00' }, { now }), null, 'old items are not new events');
    assert.equal(normaliseTip('bmac', { id: '57', type: 'subscription', amountNum: 5, createdOn: '2026-11-19 11:59:00' }, { now }).type, 'membership');

    ev = normaliseTip('throne', { event_type: 'gift_purchased', event_id: 't1', data: { creator_username: 'maplehollow', gifter_username: 'Juniper', item_name: 'Headset', price: 4999, currency: 'USD', message: 'for streams' } });
    assert.deepEqual([ev.type, ev.amount, ev.user.name, ev.metadata.kind, ev.metadata.item], ['tip', 49.99, 'Juniper', 'gift', 'Headset']);
    assert.equal(normaliseTip('throne', { event_type: 'gift_crowdfunded', event_id: 't2', data: { price: 1000 } }).user, null);
    assert.equal(normaliseTip('throne', { event_type: 'contribution_purchased', event_id: 't3', data: { amount: 500, gifter_username: 'Anonymous' } }).user.name, 'Anonymous');
    assert.equal(normaliseTip('throne', { event_type: 'wishlist_updated', data: {} }), null);

    ev = normaliseTip('fourthwall', { type: 'DONATION', id: 'f1', data: { username: 'Rowan', message: 'hi', amounts: { total: { value: 7, currency: 'USD' } }, email: 'r@example.invalid' } });
    assert.deepEqual([ev.type, ev.amount, ev.currency, ev.user.name], ['tip', 7, 'USD', 'Rowan']);
    assert.equal(JSON.stringify(ev.raw).includes('example.invalid'), false, 'no email kept');
    ev = normaliseTip('fourthwall', { type: 'ORDER_PLACED', id: 'f2', data: { email: 'b@example.invalid', billing: { address: { name: 'Real Name' } }, amounts: { total: { value: 28, currency: 'USD' } }, offers: [{}, {}] } });
    assert.equal(ev.type, 'merch_order'); assert.equal(ev.user.name, 'Supporter', 'never the buyer name or address'); assert.equal(ev.metadata.items, 2);
    assert.equal(JSON.stringify(ev).includes('Real Name'), false);
    assert.equal(normaliseTip('fourthwall', { type: 'SUBSCRIPTION_PURCHASED', id: 'f3', data: { amounts: { total: { value: 5, currency: 'USD' } } } }).type, 'membership');
    assert.equal(normaliseTip('fourthwall', { type: 'PRODUCT_UPDATED', data: {} }), null);
    assert.equal(normaliseTip('nope', {}), null);
});

test('every event type has a sample the Test button can fire, and helpers behave', () => {
    for (const t of EVENT_TYPES) {
        const ev = sampleEvent(t.type, { channelId: B });
        assert.ok(ev, t.type);
        assert.equal(ev.type, t.type); assert.equal(ev.test, true);
        assert.ok(t.platforms.includes(ev.platform) || ev.platform === 'test', `${t.type}: sample platform`);
        const pub = publicEvent(ev, 9);
        assert.equal(pub.id, 9); assert.equal('raw' in pub, false, 'no raw payload to browsers');
        assert.equal(typeof describeEvent(ev), 'string');
    }
    const ov = sampleEvent('cheer', { overrides: { amount: '1000', userName: 'Juniper', roles: ['vip', 'nope'] } });
    assert.equal(ov.amount, 1000); assert.equal(ov.user.name, 'Juniper'); assert.deepEqual(ov.user.roles, ['vip']);
    assert.equal(sampleEvent('nope'), null);
    assert.ok(isEventType('chat')); assert.ok(!isEventType('ban'));
    assert.deepEqual(twitchRoles([{ set_id: 'broadcaster' }, { set_id: 'founder' }]), ['broadcaster', 'subscriber']);
    assert.deepEqual(kickRoles([{ type: 'vip' }]), ['vip']);
    assert.equal(describeEvent({ type: 'cheer', user: { name: 'A' }, amount: 100 }), 'A cheered 100 bits');
});

test('the Stream bot grant: no user:read:follows, no revenue scopes; coverage per grant', () => {
    for (const s of FORBIDDEN_SCOPES) assert.equal(STREAM_BOT_SCOPES.includes(s), false, `${s} is never requested`);
    assert.equal(STREAM_BOT_SCOPES.some((s) => /^analytics:|revenue|payout/.test(s)), false);
    assert.equal(new Set(STREAM_BOT_SCOPES).size, STREAM_BOT_SCOPES.length);
    const full = coverage({ streamBot: STREAM_BOT_SCOPES });
    for (const f of full) assert.equal(f.covered, true, `${f.key} covered by the stream bot grant`);
    const none = coverage({});
    assert.deepEqual(none.filter((f) => f.covered).map((f) => f.key).sort(), ['online', 'raid']);
    // manage satisfies read (polls via channel:manage:polls), split grants still count
    const split = coverage({ serverAnalytics: ['user:read:chat'], serverWrite: ['user:bot', 'channel:manage:polls'] });
    assert.equal(split.find((f) => f.key === 'chat').covered, true);
    assert.deepEqual(split.find((f) => f.key === 'poll').by, ['serverWrite']);
    assert.ok(TWITCH_FEATURES.every((f) => f.none || f.need.length));
});

// ── tip sockets (fake WebSocket) ────────────────────────────────────────────────────────────

class FakeWS extends EventEmitter {
    static all = [];
    constructor(url) { super(); this.url = url; this.sent = []; FakeWS.all.push(this); setImmediate(() => this.emit('open')); }
    send(s) { this.sent.push(s); }
    close() { this.emit('close'); }
}

function fakeStore(rows) {
    const status = [];
    return { status, socketTipSources: async () => rows, setTipSourceStatus: async (id, s, e) => { status.push([id, s, e || null]); }, touchTipSource: async () => {} };
}

test('Engine.IO 3 frames parse', () => {
    assert.equal(parseEngineIo3('0{"sid":"x","pingInterval":25000}').data.pingInterval, 25000);
    assert.equal(parseEngineIo3('40').kind, 'connect');
    assert.equal(parseEngineIo3('3').kind, 'pong');
    assert.deepEqual(parseEngineIo3('42["event",{"type":"donation"}]'), { kind: 'event', name: 'event', data: { type: 'donation' } });
    assert.equal(parseEngineIo3('44"bad token"').kind, 'error');
    assert.equal(parseEngineIo3('42[not json').kind, 'unknown');
});

test('StreamElements and Streamlabs sockets: subscribe, ingest tips, reject bad tokens', async () => {
    FakeWS.all = [];
    const got = [];
    const store = fakeStore([
        { id: 1, profileId: 5, source: 'streamelements', token: 'aaa.bbb.ccc' },
        { id: 2, profileId: 5, source: 'streamlabs', token: 'sltoken_1234567890abcdef' },
    ]);
    const feeds = createTipFeeds({ store, ingest: { tipForSource: (row, p) => got.push([row.source, normaliseTip(row.source, p)]) }, WebSocket: FakeWS, refreshMs: 3_600_000 });
    await feeds.start();
    await new Promise((r) => setImmediate(r));
    const [se, sl] = FakeWS.all;
    assert.equal(se.url, 'wss://astro.streamelements.com');
    const sub = JSON.parse(se.sent[0]);
    assert.deepEqual([sub.type, sub.data.topic, sub.data.token, sub.data.token_type], ['subscribe', 'channel.tips', 'aaa.bbb.ccc', 'jwt']);
    assert.ok(sl.url.startsWith('wss://sockets.streamlabs.com/socket.io/') && sl.url.includes('EIO=3') && sl.url.endsWith('token=sltoken_1234567890abcdef'));

    se.emit('message', JSON.stringify({ type: 'response', nonce: sub.nonce, data: { message: 'ok' } }));
    se.emit('message', JSON.stringify({ type: 'message', topic: 'channel.tips', data: { _id: 'se9', donation: { user: { username: 'Juniper' }, amount: 2, currency: 'USD' } } }));
    sl.emit('message', '0{"sid":"a","pingInterval":25000,"pingTimeout":60000}');
    sl.emit('message', '40');
    sl.emit('message', '42["event",{"type":"donation","message":[{"id":1,"name":"Rowan","amount":"4","currency":"USD"}]}]');
    sl.emit('message', '42["event",{"type":"follow","message":[{"name":"x"}]}]');
    assert.deepEqual(got.map(([s, e]) => [s, e.amount, e.user.name]), [['streamelements', 2, 'Juniper'], ['streamlabs', 4, 'Rowan']]);
    assert.ok(store.status.some(([id, s]) => id === 1 && s === 'listening'));
    assert.ok(store.status.some(([id, s]) => id === 2 && s === 'listening'));

    se.emit('message', JSON.stringify({ type: 'response', error: 'err_unauthorized', data: { message: 'invalid token' } }));
    assert.ok(store.status.some(([id, s]) => id === 1 && s === 'token_rejected'));
    const before = FakeWS.all.length;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(FakeWS.all.length, before, 'a rejected token is not retried');
    feeds.stop();
});
