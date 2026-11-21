import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pool from '../utils/db.js';
import { makeTables, makeProfile, fakeEncryption } from './fixtures/stream-bot-tables.js';
import { overlaysDdl, OVERLAY_TABLES } from '../migrations/459_stream_bot_overlays.js';
import {
    OVERLAY_TYPES, ALERT_KEYS, ALERT_KINDS, alertKeyFor, alertAmount, sampleFor, defaultConfig, validateConfig, goalIncrement, LIMITS, TWITCH_NEEDS,
} from '../core/stream-bot/overlays/config.js';
import {
    jarAmount, trainIncrement, hypeView, twitchPollView, predictionView, chatPollView, creditsFrom, labelLine, labelText, money, blockedText, sampleFrames, RECONNECT_TEXT,
} from '../core/stream-bot/overlays/widgets.js';
import { createChatPolls } from '../core/stream-bot/control/chat-polls.js';
import { createThirdPartyEmotes, splitEmotes } from '../core/stream-bot/overlays/emotes.js';
import { createImageProxy } from '../core/stream-bot/overlays/images.js';
import { createOverlayStore } from '../core/stream-bot/overlays/store.js';
import { createOverlayService } from '../core/stream-bot/overlays/service.js';
import { twitchFeatures, viewerCounts } from '../core/stream-bot/overlays/index.js';
import { normaliseTwitch, describeEvent, eventType } from '../core/stream-bot/events.js';
import { TWITCH_FEATURES } from '../core/stream-bot/scopes.js';
import { KICK_EVENT_TYPES } from '../services/certifried-bot/kick-event-subscriptions.js';
import { subscriberEvent } from '../core/stream-bot/youtube/normalise.js';
import { createYouTubeApi } from '../core/stream-bot/youtube/api.js';
import { createYouTubeService } from '../core/stream-bot/youtube/service.js';
import { createQuotaGuard } from '../core/stream-bot/youtube/quota.js';
import { QUOTA_COST } from '../core/stream-bot/youtube/config.js';

/*
 * The overlay widgets and the alert additions of 2026-11-20 (core/stream-bot/overlays widgets.js, emotes.js, service.js;
 * events.js watch streaks, charity and Kicks; YouTube subscribers):
 *   events    channel.chat.notification watch streaks and charity donations, YouTube subscribers (Kick kicks.gifted is
 *             core/stream-bot/control's; the alert box, tip jar and credits use its event)
 *   alerts    each new kind is picked for its event, its Test sample shows it, its amount feeds variations
 *   rules     tip jar amounts, sub train counts, hype and poll views, credits, labels, "Reconnect Twitch to enable"
 *   emotes    7TV, BTTV and FFZ lists read from their APIs (faked here), channel before global, served through images.js
 *   service   on throwaway tables (sbtw…_) with fake pages: every widget's hello, live updates, Test frames, chat polls,
 *             tip jar persistence and reset, labels and credits from the event log, viewer counts
 *   youtube   subscriptions.list myRecentSubscribers while live: the first answer only records, later new ones are follows
 * Nothing reaches Twitch, Kick, YouTube, 7TV, BTTV, FFZ or OBS.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let T, store, ostore, profile;
const clock = { t: Date.parse('2026-11-20T20:00:00Z') };
const now = () => clock.t;
const page = () => ({ sent: [], send(e, d) { this.sent.push([e, JSON.parse(JSON.stringify(d))]); return true; }, close() { this.closed = true; }, last(e) { return [...this.sent].reverse().find((x) => x[0] === e)?.[1]; }, all(e) { return this.sent.filter((x) => x[0] === e).map((x) => x[1]); } });
const fan = { id: '100000001', login: 'maplefan_88', name: 'MapleFan_88', roles: [] };
const ev = (o) => ({ channelId: '900000001', user: fan, amount: null, currency: null, message: null, metadata: {}, occurredAt: new Date(now()), dedupeKey: null, ...o });

test.before(async () => {
    T = await makeTables(pool, 'w');
    for (const sql of overlaysDdl(T.prefix)) await pool.query(sql);
    store = T.store;
    ostore = createOverlayStore({ db: pool, prefix: T.prefix, encryption: fakeEncryption });
    profile = await makeProfile(store);
});
test.after(async () => {
    for (const t of [...OVERLAY_TABLES].reverse()) await pool.query(`DROP TABLE IF EXISTS \`${T.prefix}${t}\``);
    await T.drop();
    await pool.end();
});

// ── events ─────────────────────────────────────────────────────────────────────────────────

test('Twitch chat notices: watch streaks and charity donations become events; other notices and shared chat do not', () => {
    const base = { broadcaster_user_id: '900000001', chatter_user_id: '100000001', chatter_user_login: 'maplefan_88', chatter_user_name: 'MapleFan_88', chatter_is_anonymous: false, badges: [{ set_id: 'subscriber' }], message_id: 'm-1', message: { text: 'five!' } };
    const w = normaliseTwitch('channel.chat.notification', { ...base, notice_type: 'watch_streak', watch_streak: { streak_count: 5, channel_points_awarded: 450 } });
    assert.deepEqual([w.type, w.amount, w.currency, w.message, w.metadata.points, w.user.name, w.user.roles, w.dedupeKey], ['watch_streak', 5, 'streams', 'five!', 450, 'MapleFan_88', ['subscriber'], 'tw:notice:m-1']);
    const c = normaliseTwitch('channel.chat.notification', { ...base, message_id: 'm-2', notice_type: 'charity_donation', charity_donation: { charity_name: 'Food Bank', amount: { value: 550, decimal_place: 2, currency: 'USD' } } });
    assert.deepEqual([c.type, c.amount, c.currency, c.metadata.charity], ['charity', 5.5, 'USD', 'Food Bank']);
    assert.equal(normaliseTwitch('channel.chat.notification', { ...base, notice_type: 'sub', sub: {} }), null, 'subs have their own subscription');
    assert.equal(normaliseTwitch('channel.chat.notification', { ...base, notice_type: 'watch_streak', watch_streak: { streak_count: 3 }, source_broadcaster_user_id: '42' }), null, 'shared chat from another channel');
    const anon = normaliseTwitch('channel.chat.notification', { ...base, chatter_is_anonymous: true, notice_type: 'charity_donation', charity_donation: { amount: { value: 1000, decimal_place: 2, currency: 'EUR' } } });
    assert.equal(anon.user, null);
    assert.equal(describeEvent(w), 'MapleFan_88 is on a 5-stream watch streak');
    assert.equal(describeEvent(c), 'MapleFan_88 gave 5.5 USD to Food Bank');
    assert.ok(TWITCH_FEATURES.find((f) => f.key === 'chat').events.includes('watch_streak'), 'covered by the chat scopes');
    // Hype trains carry their end time; polls and predictions theirs.
    assert.equal(normaliseTwitch('channel.hype_train.progress', { broadcaster_user_id: '1', level: 2, total: 10, goal: 20, progress: 5, expires_at: '2026-11-20T20:05:00Z' }).metadata.expiresAt, '2026-11-20T20:05:00Z');
    assert.equal(normaliseTwitch('channel.poll.begin', { broadcaster_user_id: '1', id: 'p', title: 'Q', choices: [], ends_at: '2026-11-20T20:01:00Z' }).metadata.endsAt, '2026-11-20T20:01:00Z');
});

test('Kick kicks.gifted is subscribed for every Kick channel; follows can come from YouTube', () => {
    assert.ok(KICK_EVENT_TYPES.some((e) => e.name === 'kicks.gifted' && e.version === 1));
    assert.ok(eventType('watch_streak') && eventType('charity'));
    assert.deepEqual(eventType('follow').platforms, ['twitch', 'kick', 'youtube']);
});

// ── alerts ─────────────────────────────────────────────────────────────────────────────────

test('alert box: watch streak, charity, Kicks, YouTube subscriber and Super Sticker have their own alerts', () => {
    assert.equal(alertKeyFor(ev({ platform: 'twitch', type: 'watch_streak', amount: 5, metadata: { streak: 5 } })), 'watch_streak');
    assert.equal(alertKeyFor(ev({ platform: 'twitch', type: 'charity', amount: 5 })), 'charity');
    assert.equal(alertKeyFor(ev({ platform: 'kick', type: 'kicks.gifted', amount: 100 })), 'kicks', 'the control module\'s Kicks event');
    assert.equal(alertKeyFor(ev({ platform: 'youtube', type: 'follow' })), 'yt_subscriber');
    assert.equal(alertKeyFor(ev({ platform: 'youtube', type: 'tip', metadata: { kind: 'super_sticker' } })), 'yt_sticker');
    assert.equal(alertKeyFor(ev({ platform: 'kick', type: 'watch_streak' })), null);
    assert.equal(alertAmount('watch_streak', ev({ type: 'watch_streak', amount: 7, metadata: { streak: 7 } })), 7);
    assert.equal(alertAmount('kicks', ev({ type: 'kicks.gifted', amount: 250 })), 250);
    for (const k of ALERT_KEYS) assert.equal(alertKeyFor(sampleFor(k)), k, `${k}: its Test sample shows that alert`);
    assert.equal(ALERT_KINDS.kicks.ttsCapable, true);
    assert.equal(goalIncrement('followers', ev({ platform: 'youtube', type: 'follow' })), 1, 'YouTube subscribers count towards a follower goal');
});

// ── widget settings and rules ──────────────────────────────────────────────────────────────

test('widget settings: defaults validate, bad values are clamped or named, and each widget names what it needs from Twitch', () => {
    for (const t of ['train', 'tipjar', 'credits', 'emotewall', 'poll', 'labels', 'viewers']) {
        assert.ok(OVERLAY_TYPES.some((x) => x.type === t && /^CertiFried /.test(x.sourceName)), t);
        const v = validateConfig(t, defaultConfig(t));
        assert.equal(v.ok, true, `${t}: ${v.errors}`);
    }
    const jar = validateConfig('tipjar', { target: 0, sources: [], size: 5000, bitsPerUnit: -3 });
    assert.equal(jar.ok, false);
    assert.match(jar.errors.join(' '), /target must be 1 or more/);
    assert.match(jar.errors.join(' '), /at least one thing/);
    assert.deepEqual([jar.value.size, jar.value.bitsPerUnit, jar.value.sources.length], [900, 1, 4]);
    assert.equal(validateConfig('labels', { items: ['nope'] }).ok, false);
    assert.deepEqual(validateConfig('labels', { items: ['top_cheer', 'latest_tip', 'evil'] }).value.items, ['latest_tip', 'top_cheer']);
    assert.equal(validateConfig('emotewall', { size: 1, max: 999, platforms: ['twitch'] }).value.size, 24);
    assert.equal(validateConfig('credits', { sections: [] }).ok, false);
    assert.equal(validateConfig('train', { subTrainSec: 1 }).value.subTrainSec, 10);
    assert.equal(validateConfig('chat', {}).value.thirdParty, true, 'chat shows 7TV, BTTV and FFZ by default');
    assert.equal(LIMITS.overlays, 30);
    assert.deepEqual(TWITCH_NEEDS, { train: ['hype'], poll: ['poll', 'prediction'] });
});

test('tip jar, sub train, hype train and polls follow their rules; test events never count', () => {
    const cfg = defaultConfig('tipjar');
    assert.equal(jarAmount(cfg, ev({ platform: 'streamelements', type: 'tip', amount: 5 })), 5);
    assert.equal(jarAmount(cfg, ev({ platform: 'twitch', type: 'cheer', amount: 250 })), 2.5);
    assert.equal(jarAmount(cfg, ev({ platform: 'twitch', type: 'bits.used', amount: 100, metadata: { kind: 'cheer' } })), 0, 'cheers count once, as cheer');
    assert.equal(jarAmount(cfg, ev({ platform: 'twitch', type: 'bits.used', amount: 100, metadata: { kind: 'power_up' } })), 1);
    assert.equal(jarAmount(cfg, ev({ platform: 'kick', type: 'kicks.gifted', amount: 500 })), 5);
    assert.equal(jarAmount(cfg, ev({ platform: 'youtube', type: 'tip', amount: 2, metadata: { kind: 'super_chat' } })), 2);
    assert.equal(jarAmount(cfg, ev({ platform: 'youtube', type: 'tip', amount: 50, metadata: { kind: 'jewels' } })), 0, 'Jewels are not money');
    assert.equal(jarAmount({ ...cfg, sources: ['tips'] }, ev({ platform: 'twitch', type: 'cheer', amount: 500 })), 0);
    assert.equal(jarAmount(cfg, ev({ platform: 'streamelements', type: 'tip', amount: 5, test: true })), 0);
    assert.equal(trainIncrement(ev({ type: 'sub', metadata: {} })), 1);
    assert.equal(trainIncrement(ev({ type: 'sub', metadata: { isGift: true } })), 0);
    assert.equal(trainIncrement(ev({ type: 'gift_sub', amount: 5, metadata: { count: 5 } })), 5);
    assert.equal(trainIncrement(ev({ platform: 'youtube', type: 'membership', metadata: { kind: 'new' } })), 1);
    assert.equal(trainIncrement(ev({ type: 'follow' })), 0);
    assert.deepEqual(hypeView(ev({ type: 'hype_train.end', amount: 3, metadata: { level: 3 } })), { level: 3, progress: 0, goal: 0, total: 0, expiresAt: null, active: false });
    const p = twitchPollView(ev({ type: 'poll.end', metadata: { id: 'p1', title: 'Q', choices: [{ title: 'A', votes: 3 }, { title: 'B', votes: 1 }], winner: 'A' } }));
    assert.deepEqual([p.status, p.winner, p.options.length], ['ended', 'A', 2]);
    assert.equal(predictionView(ev({ type: 'prediction.lock', metadata: { outcomes: [] } })).status, 'locked');
    const c = chatPollView(ev({ type: 'poll.begin', metadata: { id: 'c', title: 'Q', chat: true, choices: [{ title: 'A', votes: 0 }, { title: 'B', votes: 0 }] } }), Date.parse('2026-11-20T20:01:00Z'));
    assert.deepEqual([c.kind, c.status, c.endsAt], ['chat', 'active', '2026-11-20T20:01:00.000Z']);
    assert.equal(chatPollView(ev({ type: 'poll.end', metadata: { id: 'c', chat: true, choices: [], winner: null } }), 1).endsAt, null);
});

test('credits, labels, money and "Reconnect Twitch to enable"', () => {
    const rows = [
        { type: 'follow', name: 'Wren' }, { type: 'follow', name: 'wren' }, { type: 'sub', name: 'Hazel', metadata: { isGift: true } }, { type: 'resub', name: 'MapleFan_88' },
        { type: 'gift_sub', name: 'Juniper', amount: 5, metadata: { count: 5 } }, { type: 'gift_sub', name: 'Juniper', amount: 1, metadata: { count: 1 } },
        { type: 'raid', name: 'BrambleByte_Live', amount: 42, metadata: { viewers: 42 } }, { type: 'cheer', name: 'MapleFan_88', amount: 100 }, { type: 'cheer', name: 'MapleFan_88', amount: 400 },
        { type: 'tip', name: 'Hazel', amount: 5, currency: 'usd', metadata: {} }, { type: 'kicks.gifted', name: 'Pipsqueak', amount: 100 }, { type: 'tip', name: 'Gem', amount: 50, metadata: { kind: 'jewels' } },
    ];
    const c = creditsFrom(rows, ['Pipsqueak']);
    const by = Object.fromEntries(c.map((s) => [s.key, s.names]));
    assert.deepEqual(by.followers.map((n) => n.name), ['Wren'], 'one name once');
    assert.deepEqual(by.subs.map((n) => n.name), ['MapleFan_88'], 'gift recipients are not in subs');
    assert.deepEqual(by.gifters, [{ name: 'Juniper', note: '6 gifts' }]);
    assert.deepEqual(by.raiders, [{ name: 'BrambleByte_Live', note: '42 viewers' }]);
    assert.deepEqual(by.cheerers, [{ name: 'MapleFan_88', note: '500 Bits' }]);
    assert.deepEqual(by.tippers.map((n) => n.name).sort(), ['Hazel', 'Pipsqueak'], 'Jewels are not tips');
    assert.deepEqual(by.mods, [{ name: 'Pipsqueak', note: '' }]);
    assert.deepEqual(creditsFrom(rows, [], ['raiders']).map((s) => s.key), ['raiders'], 'only ticked sections');
    assert.equal(money(5, 'USD', '$'), '$5.00');
    assert.equal(money(5, 'EUR', '$'), '5.00 EUR');
    assert.equal(money(12.5, null, '$'), '$12.50');
    assert.equal(labelText(labelLine('latest_tip', { name: 'Hazel', amount: 5, currency: 'USD' })), 'Hazel (5.00 USD)');
    assert.equal(labelText(labelLine('top_cheer', { name: 'MapleFan_88', amount: 1000 })), 'MapleFan_88 (1,000 Bits)');
    assert.equal(labelText(null, 'None yet'), 'None yet');
    assert.equal(blockedText('train', defaultConfig('train'), new Set(['chat'])), RECONNECT_TEXT);
    assert.equal(blockedText('train', { ...defaultConfig('train'), showHype: false }, new Set()), null, 'only a ticked Twitch part');
    assert.equal(blockedText('poll', defaultConfig('poll'), new Set(['poll', 'prediction'])), null);
    assert.equal(blockedText('poll', defaultConfig('poll'), null), null, 'no Twitch channel: nothing to reconnect');
    assert.equal(RECONNECT_TEXT, 'Reconnect Twitch to enable');
    for (const t of ['train', 'tipjar', 'credits', 'emotewall', 'poll', 'labels', 'viewers', 'events', 'chat']) assert.ok(sampleFrames(t, defaultConfig(t), now()).length, `${t} has a Test`);
});

// ── 7TV, BTTV, FFZ ─────────────────────────────────────────────────────────────────────────

function fakeEmoteApis(calls) {
    const json = (o, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(o) });
    return async (url) => {
        calls.push(url);
        if (url === 'https://7tv.io/v3/users/twitch/96189264') return json({ emote_set: { emotes: [{ id: '01FCY771D800007PQ2DF3GDTN6', name: 'RainTime' }, { id: 'bad id!', name: 'Broken' }] } });
        if (url === 'https://7tv.io/v3/emote-sets/global') return json({ emotes: [{ id: '01F6MZGCNG000255K4X1K0NSYQ', name: 'EZ' }, { id: '01AAAAAAAAAAAAAAAAAAAAAAAA', name: 'RainTime' }] });
        if (url.startsWith('https://api.betterttv.net/3/cached/users/twitch/')) return json({ channelEmotes: [{ id: '56e9f494fff3cc5c35e5287e', code: 'catJAM' }], sharedEmotes: [] });
        if (url === 'https://api.betterttv.net/3/cached/emotes/global') return json([{ id: '54fa8f1401e468494b85b537', code: ':tf:' }]);
        if (url.startsWith('https://api.frankerfacez.com/v1/room/id/')) return json({ sets: { 1266215: { emoticons: [{ id: 9, name: 'ZrehplaR' }] } } });
        if (url === 'https://api.frankerfacez.com/v1/set/global') return json({ default_sets: [3], sets: { 3: { emoticons: [{ id: 25, name: 'LilZ' }] }, 99: { emoticons: [{ id: 26, name: 'Hidden' }] } } });
        return json({}, 404);
    };
}

test('7TV, BTTV and FFZ: the channel and global lists, channel first, cached; split into emote parts', async () => {
    const calls = [];
    let t = 0;
    const e = createThirdPartyEmotes({ fetchImpl: fakeEmoteApis(calls), now: () => t });
    const map = await e.forChannel('96189264');
    assert.equal(map.get('RainTime').src, 'img/7tv-emote/01FCY771D800007PQ2DF3GDTN6', 'the channel emote wins over a global one with the same name');
    assert.deepEqual([map.get('catJAM').src, map.get(':tf:').src, map.get('ZrehplaR').src, map.get('LilZ').src, map.get('EZ').provider],
        ['img/bttv-emote/56e9f494fff3cc5c35e5287e', 'img/bttv-emote/54fa8f1401e468494b85b537', 'img/ffz-emote/9', 'img/ffz-emote/25', '7tv']);
    assert.equal(map.has('Broken'), false, 'ids are checked');
    assert.equal(map.has('Hidden'), false, 'only FFZ default global sets');
    const n = calls.length;
    await e.forChannel('96189264');
    assert.equal(calls.length, n, 'cached');
    t += 31 * 60_000;
    await e.forChannel('96189264');
    assert.equal(calls.length, n * 2, 'read again after 30 minutes');
    const failing = createThirdPartyEmotes({ fetchImpl: async () => { throw new Error('down'); } });
    assert.equal((await failing.forChannel('1')).size, 0, 'a failure is an empty list, never an error');
    const parts = splitEmotes([{ t: 'text', v: 'gg catJAM  nice EZ' }, { t: 'emote', src: 'img/tw-emote/25', alt: 'Kappa' }], map);
    assert.deepEqual(parts, [{ t: 'text', v: 'gg ' }, { t: 'emote', src: 'img/bttv-emote/56e9f494fff3cc5c35e5287e', alt: 'catJAM' }, { t: 'text', v: '  nice ' },
        { t: 'emote', src: 'img/7tv-emote/01F6MZGCNG000255K4X1K0NSYQ', alt: 'EZ' }, { t: 'emote', src: 'img/tw-emote/25', alt: 'Kappa' }]);
    assert.equal(splitEmotes(parts, new Map()), parts);
});

test('emote images for 7TV, BTTV and FFZ come only from their image hosts', async () => {
    const urls = [];
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const fetchImpl = async (u) => { urls.push(u); return { ok: true, url: u, headers: { get: (h) => (h === 'content-type' ? 'image/webp' : '4') }, arrayBuffer: async () => png }; };
    const img = createImageProxy({ fetchImpl });
    assert.ok(await img.get('7tv-emote', ['01FCY771D800007PQ2DF3GDTN6']));
    assert.ok(await img.get('bttv-emote', ['56e9f494fff3cc5c35e5287e']));
    assert.ok(await img.get('ffz-emote', ['9']));
    assert.equal(await img.get('bttv-emote', ['../../etc']), null);
    assert.equal(await img.get('ffz-emote', ['9x']), null);
    assert.deepEqual(urls, ['https://cdn.7tv.app/emote/01FCY771D800007PQ2DF3GDTN6/2x.webp', 'https://cdn.betterttv.net/emote/56e9f494fff3cc5c35e5287e/2x', 'https://cdn.frankerfacez.com/emote/9/2']);
    const evil = createImageProxy({ fetchImpl: async (u) => ({ ok: true, url: 'https://evil.example/x.png', headers: { get: () => 'image/png' }, arrayBuffer: async () => png }) });
    assert.equal(await evil.get('7tv-emote', ['01FCY771D800007PQ2DF3GDTN6']), null, 'a redirect off the host is refused');
});

// ── the live service ───────────────────────────────────────────────────────────────────────

test('widgets in the live service: hello, live updates, Test frames, chat polls, the tip jar kept and emptied, emote wall', async () => {
    const pid = profile.id;
    const make = async (type, config = {}) => (await ostore.create(pid, { type, name: type, config })).overlay;
    const train = await make('train', { subTrainMin: 2, subTrainSec: 60 });
    const jar = await make('tipjar', { target: 50 });
    const poll = await make('poll');
    const wall = await make('emotewall', { perMessage: 3 });
    const viewers = await make('viewers');
    const calls = [];
    let svc = null;
    const said = [];
    const cp = createChatPolls({ raise: (p, e) => { svc.onEvent(p, e); }, say: async (p, platforms, text) => { said.push(text); }, now });
    svc = createOverlayService({
        store: { ...store, listChannels: async () => [{ platform: 'twitch', platform_user_id: '96189264' }], profilesForChannel: async () => [{ profileId: pid }] }, ostore, now, timers: false,
        twitchFeatures: async () => new Set(['chat']), viewerCounts: async () => ({ live: true, total: 7, platforms: { twitch: { live: true, viewers: 7 } } }),
        emotes: createThirdPartyEmotes({ fetchImpl: fakeEmoteApis(calls) }), chatPolls: () => cp,
    });
    const P = {};
    for (const o of [train, jar, poll, wall, viewers]) { P[o.type] = page(); await svc.attach(o, P[o.type]); }
    assert.equal(P.train.last('hello').state.blocked, 'Reconnect Twitch to enable', 'no hype train scope');
    assert.equal(P.poll.last('hello').state.blocked, 'Reconnect Twitch to enable');
    assert.deepEqual(P.viewers.last('hello').state.counts.total, 7);
    assert.equal(P.tipjar.last('hello').state.total, 0);

    // Sub train: shows from the second sub; a gift of five counts five.
    await svc.onEvent(pid, ev({ platform: 'twitch', type: 'sub', metadata: {} }));
    assert.equal(P.train.all('train').length, 0, 'one sub is not a train yet');
    await svc.onEvent(pid, ev({ platform: 'kick', type: 'gift_sub', amount: 5, metadata: { count: 5 } }));
    assert.equal(P.train.last('train').sub.count, 6);
    await svc.onEvent(pid, ev({ platform: 'twitch', type: 'hype_train.progress', amount: 2, metadata: { level: 2, progress: 10, goal: 20 } }));
    assert.equal(P.train.last('train').hype.level, 2);

    // Tip jar: tips and Bits, kept in the overlay's state, emptied when the stream goes live.
    await svc.onEvent(pid, ev({ platform: 'streamelements', type: 'tip', amount: 5, currency: 'USD' }));
    await svc.onEvent(pid, ev({ platform: 'twitch', type: 'cheer', amount: 300 }));
    await svc.onEvent(pid, ev({ platform: 'streamelements', type: 'tip', amount: 100, test: true }));
    assert.deepEqual([P.tipjar.last('tipjar').total, P.tipjar.last('tipjar').add.amount, P.tipjar.last('tipjar').label], [8, 3, '$8']);
    await new Promise((r) => setTimeout(r, 2300));
    assert.equal(Number((await ostore.get(pid, jar.id)).state.total), 8, 'written to the overlay state');
    await svc.onEvent(pid, ev({ platform: 'twitch', type: 'stream.online' }));
    assert.equal(P.tipjar.last('tipjar').total, 0, 'empty when the stream goes live');
    await svc.onEvent(pid, ev({ platform: 'kick', type: 'kicks.gifted', amount: 200 }));
    assert.equal((await svc.resetJar(pid, jar.id)).ok, true);
    assert.equal(P.tipjar.last('tipjar').total, 0);

    // Twitch polls, and a CertiFried chat poll (core/stream-bot/control/chat-polls.js) started from the dashboard and voted in chat.
    await svc.onEvent(pid, ev({ platform: 'twitch', type: 'poll.begin', metadata: { id: 'p1', title: 'Pizza?', choices: [{ title: 'Yes', votes: 0 }, { title: 'No', votes: 0 }] } }));
    assert.equal(P.poll.last('poll').twitch.title, 'Pizza?');
    assert.equal((await svc.chatPoll(pid, { action: 'start', title: '', options: ['a', 'b'] })).ok, false);
    assert.match((await svc.chatPoll(pid, { action: 'start', title: 'Q', options: ['only one'] })).error, /2 to 6 answers/);
    const started = await svc.chatPoll(pid, { action: 'start', title: 'Which boss?', options: 'Witch\nMaple\n', durationSec: 30 });
    assert.equal(started.ok, true);
    assert.match(said[0], /^Poll: Which boss\? Vote with !vote/, 'the bot asks in chat');
    const shown = P.poll.last('poll').chat;
    assert.deepEqual([shown.kind, shown.title, shown.status, shown.options.length, shown.endsAt], ['chat', 'Which boss?', 'active', 2, new Date(now() + 30_000).toISOString()]);
    assert.match((await svc.chatPoll(pid, { action: 'start', title: 'Again', options: ['a', 'b'] })).error, /^A chat poll is already running/);
    const vote = (id, platform, text) => cp.onChat(pid, { type: 'chat', platform, user: { id, login: id, name: id }, message: text });
    vote('u1', 'twitch', '!vote 1'); vote('u2', 'twitch', '!vote 2'); vote('u3', 'kick', '!vote 2'); vote('u1', 'twitch', '!vote 2'); vote('u4', 'youtube', 'hello');
    assert.equal((await svc.chatPoll(pid, { action: 'end' })).ok, true);
    await new Promise((r) => setImmediate(r));
    const ended = P.poll.last('poll').chat;
    assert.deepEqual([ended.status, ended.winner, ended.options.map((o) => o.votes), ended.endsAt], ['ended', 'Maple', [0, 3], null]);
    assert.equal((await svc.chatPoll(pid, { action: 'end' })).ok, false, 'nothing running');
    assert.equal((await createOverlayService({ store, ostore, timers: false }).chatPoll(pid, { action: 'end' })).error, 'Chat polls start after the next CertiFried restart.');

    // Emote wall: Twitch emotes and 7TV / BTTV / FFZ ones from the text, at most perMessage.
    await svc.onChat('twitch', { kind: 'message', channelId: '96189264', message: { id: 'tw:9', platform: 'twitch', userId: 'u9', login: 'u9', name: 'u9', badges: [{ kind: 'role', role: 'moderator' }], parts: [{ t: 'text', v: 'RainTime catJAM ' }, { t: 'emote', src: 'img/tw-emote/25', alt: 'Kappa' }, { t: 'text', v: ' LilZ EZ' }], at: now() } });
    assert.deepEqual(P.emotewall.last('emotes').list, ['img/7tv-emote/01FCY771D800007PQ2DF3GDTN6', 'img/bttv-emote/56e9f494fff3cc5c35e5287e', 'img/tw-emote/25']);
    assert.ok(svc._state.mods.get(pid).has('u9'), 'a moderator seen in chat, for the credits');

    // Test buttons: invented frames, nothing counted.
    assert.equal((await svc.testWidget(pid, jar.id)).sent, 1);
    assert.equal(P.tipjar.last('tipjar').test, true);
    assert.equal((await svc.testWidget(pid, 999999)).sent, 0);
    svc.close();
});

test('labels and credits from the event log; a label as plain text', async () => {
    const pid = profile.id;
    const at = (m) => new Date(now() - m * 60_000);
    const put = (o) => store.insertEvent(pid, { channelId: '1', user: null, amount: null, currency: null, message: null, metadata: {}, raw: null, dedupeKey: null, ...o });
    await put({ platform: 'twitch', type: 'cheer', user: { name: 'OldBig', login: 'oldbig' }, amount: 9000, occurredAt: at(600) });
    await put({ platform: 'twitch', type: 'stream.online', occurredAt: at(120) });
    await put({ platform: 'twitch', type: 'follow', user: { name: 'Wren', login: 'wren' }, occurredAt: at(100) });
    await put({ platform: 'twitch', type: 'resub', user: { name: 'MapleFan_88', login: 'maplefan_88' }, amount: 7, occurredAt: at(95) });
    await put({ platform: 'twitch', type: 'sub', user: { name: 'Gifted', login: 'gifted' }, metadata: { isGift: true }, occurredAt: at(90) });
    await put({ platform: 'streamelements', type: 'tip', user: { name: 'Hazel' }, amount: 5, currency: 'USD', occurredAt: at(80) });
    await put({ platform: 'twitch', type: 'cheer', user: { name: 'Juniper', login: 'juniper' }, amount: 1000, occurredAt: at(70) });
    await put({ platform: 'twitch', type: 'raid', user: { name: 'BrambleByte_Live' }, amount: 42, metadata: { viewers: 42 }, occurredAt: at(60) });
    await put({ platform: 'twitch', type: 'chat', user: { name: 'ModMolly', login: 'modmolly', roles: ['moderator'] }, message: 'hi', occurredAt: at(50) });
    const labels = (await ostore.create(pid, { type: 'labels', name: 'Labels' })).overlay;
    const credits = (await ostore.create(pid, { type: 'credits', name: 'Credits' })).overlay;
    const svc = createOverlayService({ store, ostore, now, timers: false });
    const L = page();
    await svc.attach(labels, L);
    assert.deepEqual(L.last('hello').state.values, {
        latest_follower: { name: 'Wren', detail: '' }, latest_sub: { name: 'MapleFan_88', detail: '' }, latest_tip: { name: 'Hazel', detail: '5.00 USD' }, top_cheer: { name: 'Juniper', detail: '1,000 Bits' },
    }, 'a gifted sub is not the latest sub; top cheer is from this stream');
    assert.equal(await svc.labelText(labels, 'latest_tip'), 'Hazel (5.00 USD)');
    assert.equal(await svc.labelText(labels, 'nope'), null);
    const all = await svc.labelValues({ ...labels, config: { ...labels.config, topCheerScope: 'all' } });
    assert.equal(all.top_cheer.name, 'OldBig', 'all time');
    await put({ platform: 'kick', type: 'follow', user: { name: 'Pipsqueak', login: 'pipsqueak' }, occurredAt: new Date(now()) });
    await svc.onEvent(pid, ev({ platform: 'kick', type: 'follow', user: { name: 'Pipsqueak' } }));
    assert.equal(L.last('labels').values.latest_follower.name, 'Pipsqueak', 'pushed when a follow arrives');
    const C = page();
    await svc.attach(credits, C);
    const sec = Object.fromEntries(C.last('hello').state.sections.map((s) => [s.key, s.names.map((n) => n.name)]));
    assert.deepEqual(sec.followers, ['Pipsqueak', 'Wren'].sort((a, b) => a.localeCompare(b)));
    assert.deepEqual(sec.raiders, ['BrambleByte_Live']);
    assert.deepEqual(sec.cheerers, ['Juniper'], 'only this stream');
    assert.deepEqual(sec.mods, ['ModMolly'], 'moderators from the kept chat');
    svc.close();
});

test('twitchFeatures and viewerCounts read the grants and stream info they are given', async () => {
    const fakeStore = { listChannels: async () => [{ platform: 'twitch', platform_user_id: '96189264' }, { platform: 'kick', platform_user_id: '2031209' }],
        getTwitchGrant: async () => ({ twitch_user_id: '96189264', status: 'active', scopes: ['channel:read:hype_train', 'channel:manage:polls', 'user:read:chat', 'user:bot'] }) };
    const fakePool = { query: async () => [[]] };
    const f = await twitchFeatures({ store: fakeStore, pool: fakePool, profileId: 1 });
    assert.ok(f.has('hype') && f.has('poll') && f.has('chat'), 'manage:polls covers reading polls');
    assert.equal(f.has('prediction'), false);
    assert.equal(await twitchFeatures({ store: { listChannels: async () => [] }, pool: fakePool, profileId: 1 }), null);
    const v = await viewerCounts({ store: fakeStore, profileId: 1, streamInfo: { get: async ({ platform }) => (platform === 'twitch' ? { live: true, viewers: 12 } : { live: false, viewers: 99 }) } });
    assert.deepEqual(v, { live: true, total: 12, platforms: { twitch: { live: true, viewers: 12 }, kick: { live: false, viewers: 0 } } });
});

// ── YouTube subscribers ────────────────────────────────────────────────────────────────────

test('YouTube subscribers: subscriptions.list while live; the first answer only records, later new ones become follows', async () => {
    assert.equal(QUOTA_COST['subscriptions.list'], 1);
    const CH = 'UCfT-6lCUZzY8gTE_FqIe8uA';
    const sub = (id, name) => ({ subscriberSnippet: { channelId: id, title: name }, snippet: { publishedAt: '2026-11-20T20:00:00Z' } });
    let subs = [sub('UCaaaaaaaaaaaaaaaaaaaaaa', 'Old Friend')];
    const requests = [];
    const fetchImpl = async (u) => {
        requests.push(u);
        const url = new URL(u);
        if (url.pathname.endsWith('/subscriptions')) return { ok: true, status: 200, json: async () => ({ items: subs }) };
        if (url.pathname.endsWith('/liveBroadcasts')) return { ok: true, status: 200, json: async () => ({ items: [{ id: 'b1', snippet: { liveChatId: 'chat1', channelId: CH, title: 'Live' }, status: {} }] }) };
        return { ok: true, status: 200, json: async () => ({ items: [] }) };
    };
    let t = Date.parse('2026-11-20T20:00:00Z');
    const quota = createQuotaGuard({ dailyUnits: 10000, now: () => t });
    const api = createYouTubeApi({ fetchImpl, quota });
    assert.deepEqual(await api.recentSubscribers('tok', 1), [{ channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', name: 'Old Friend', at: '2026-11-20T20:00:00Z' }]);
    assert.match(requests.at(-1), /myRecentSubscribers=true/);
    api.streamChat = (tok, chat, page, { signal }) => new Promise((r) => signal?.addEventListener?.('abort', () => r({ items: [] })));
    const events = [];
    const db = { query: async (sql) => (/FROM `[^`]*channels` c JOIN/.test(sql) ? [[{ profile_id: 7, platform_user_id: CH, login: 'owner', display_name: 'Owner', owner_discord_id: '1' }]] : [[]]) };
    const svc = createYouTubeService({ db, store: { prefix: 'stream_bot_' }, ingest: { youtube: async (e) => { events.push(e); } }, api, auth: { token: async () => ({ accessToken: 'tok', scopes: [] }) }, quota, now: () => t, sleep: async () => {} });
    await svc.tick();
    t += 60_000;
    await svc.tick();
    assert.deepEqual(events.map((e) => e.type), ['stream.online'], 'live; the subscribers already there are not news');
    subs = [sub('UCbbbbbbbbbbbbbbbbbbbbbb', 'New Fan'), ...subs];
    t += 61_000;
    await svc.tick();
    const f = events.filter((e) => e.type === 'follow');
    assert.equal(f.length, 1);
    assert.deepEqual([f[0].platform, f[0].user.name, f[0].user.id, f[0].dedupeKey], ['youtube', 'New Fan', 'UCbbbbbbbbbbbbbbbbbbbbbb', `yt:subscribe:${CH}:UCbbbbbbbbbbbbbbbbbbbbbb`]);
    assert.equal(alertKeyFor(f[0]), 'yt_subscriber');
    assert.equal(subscriberEvent({ channelId: CH, subscriber: { channelId: 'UCcccccccccccccccccccccc', name: 'X' } }).type, 'follow');
    await svc.stop();
});

// ── routes and pages ───────────────────────────────────────────────────────────────────────

test('routes: widget Test, chat polls and the tip jar need a session; the plain-text label is keyed and rate limited', () => {
    const src = read('dashboard/routes/stream-bot-overlays.js');
    assert.match(src, /router\.post\('\/stream\/bot\/api\/overlays\/:id\/chat-poll', needApi,/);
    assert.match(src, /router\.post\('\/stream\/bot\/api\/overlays\/:id\/tipjar', needApi,/);
    assert.match(src, /router\.get\('\/stream\/bot\/overlay\/:type\/:key\/text\/:label', skipOther, fileLimiter,/);
    assert.match(src, /req\.params\.type !== 'chat' && req\.params\.type !== 'emotewall'/, 'emote images for chat and the emote wall only');
    assert.match(src, /ov\.service\.testWidget\(profile\.id, o\.id\)/);
    const edit = read('dashboard/views/stream-bot/overlay-edit.ejs');
    for (const id of ['sbo-cpoll-start', 'sbo-cpoll-end', 'sbo-jar-reset']) assert.ok(edit.includes(`id="${id}"`), id);
    assert.match(edit, /data-test-widget/);
    const ui = read('dashboard/public/js/stream-bot-overlays.js');
    assert.match(ui, /api \+ '\/chat-poll'/);
    assert.match(ui, /api \+ '\/tipjar'/);
    const all = edit + read('dashboard/public/js/stream-bot-overlay.js');
    assert.doesNotMatch(all, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'no emoji in the UI chrome');
});
