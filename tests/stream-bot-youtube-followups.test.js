import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewEngine } from '../dashboard/services/view-engine.js';
import * as demo from '../scripts/site-shots/demo-data.mjs';
import { streamBotPages } from '../scripts/site-shots/stream-bot-demo.mjs';
import { overlayDemo } from '../scripts/site-shots/stream-bot-overlays-demo.mjs';
import { youtubeChat, visibleFor } from '../core/stream-bot/overlays/chat.js';
import { alertKeyFor, alertAmount, alertKeysFor, sampleFor, validateConfig, defaultConfig, ALERT_KINDS, CHAT_PLATFORMS } from '../core/stream-bot/overlays/config.js';
import { normaliseYouTubeMessage } from '../core/stream-bot/youtube/normalise.js';
import { formFor } from '../dashboard/routes/stream-bot-overlays.js';
import { validateTimer, timerTargets, TIMER_PLATFORMS, TIMER_WHERE, YOUTUBE_TIMER_HOLD } from '../core/stream-bot/timers.js';
import { runDueTimers } from '../core/stream-bot/timer-job.js';

/*
 * YouTube follow-ups (design §13.10, fix wave 7), all off until the server has GOOGLE_OAUTH_CLIENT_ID / _SECRET:
 *   chat     YouTube liveChatMessages in the Chat overlay (overlays/chat.js youtubeChat: lines, Super Chats, deletions, bans);
 *            the overlay service side is in tests/stream-bot-overlays.test.js, the reader handing messages over in
 *            tests/stream-bot-youtube.test.js; the OBS chat dock already lists YouTube chat events (its hint says so when on)
 *   alerts   Super Chat / Super Sticker, new member, member milestone and gift memberships as alert kinds; the editor lists them
 *            (and the Chat overlay's YouTube choice) only when YouTube is set up
 *   timers   'youtube' and 'everywhere' (Twitch, Kick and YouTube): refused while YouTube is off, need a linked channel, hold
 *            back once the quota guard is at critical, post through io.sendChat; the page explains the 20-unit cost
 * Pure, no database: the job runs on a fake pool and a fake stream bot.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');
const engine = createViewEngine({ viewsDir: views, publicDir: path.join(root, 'dashboard/public'), cache: false });
const common = (theme) => ({
    user: demo.user, uiTheme: theme, uiStyle: 'cards', uiDensity: 'comfortable',
    userPrefs: { pinnedPages: [], recentPages: [], siteStyle: 'cards', theme, dashboardLayout: 'grid', density: 'comfortable' },
    csrfToken: 'stream-bot-test', clientId: demo.BOT_ID,
});
const render = (template, locals, theme = 'dark') => engine.renderFile(path.join(views, `${template}.ejs`), { ...common(theme), ...locals, settings: locals.settings ?? {}, _locals: {} });

const CH = 'UCmApLeHoLLoW00000000001';
const FAN = 'UCfAn0000000000000000001';
const ON = { GOOGLE_OAUTH_CLIENT_ID: 'test-client-id', GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-value' };
const author = (o = {}) => ({ channelId: FAN, displayName: '@Maple.Fan-88', isChatOwner: false, isChatModerator: false, isChatSponsor: false, isVerified: false, ...o });
const item = (id, type, details = {}, a = author()) => ({ id, snippet: { type, publishedAt: '2026-11-20T18:00:00Z', ...details }, authorDetails: a });

test('chat overlay: YouTube lines with role badges, Super Chats highlighted, deletions and bans; the rest is ignored', () => {
    const r = youtubeChat(item('LCC.EhwKGkNKbTEtZ', 'textMessageEvent', { textMessageDetails: { messageText: 'hi from YouTube :wave:' } },
        author({ isChatOwner: true, isChatModerator: true, isChatSponsor: true, isVerified: true })), CH);
    assert.equal(r.kind, 'message');
    assert.equal(r.channelId, CH);
    const m = r.message;
    assert.deepEqual([m.id, m.platform, m.userId, m.login, m.name, m.color, m.action], ['yt:LCC.EhwKGkNKbTEtZ', 'youtube', FAN, 'maple.fan-88', 'Maple.Fan-88', null, null]);
    assert.deepEqual(m.badges.map((b) => [b.kind, b.role, b.title]), [['role', 'broadcaster', 'Owner'], ['role', 'moderator', 'Moderator'], ['role', 'subscriber', 'Member'], ['role', 'verified', 'Verified']]);
    assert.deepEqual(m.parts, [{ t: 'text', v: 'hi from YouTube :wave:' }]);

    const sc = youtubeChat(item('LCC.sc1', 'superChatEvent', { superChatDetails: { amountMicros: '5000000', currency: 'USD', amountDisplayString: '$5.00', userComment: 'gg' } }), CH).message;
    assert.deepEqual([sc.action, sc.parts[0].v, sc.badges.length], ['highlight', '$5.00 gg', 0]);
    assert.equal(youtubeChat(item('LCC.sc2', 'superChatEvent', { superChatDetails: { amountDisplayString: '£2.00' } }), CH).message.parts[0].v, '£2.00', 'no comment: the amount alone');

    assert.deepEqual(youtubeChat(item('LCC.d', 'messageDeletedEvent', { messageDeletedDetails: { deletedMessageId: 'LCC.EhwKGkNKbTEtZ' } }), CH), { kind: 'delete', channelId: CH, id: 'yt:LCC.EhwKGkNKbTEtZ' });
    assert.deepEqual(youtubeChat(item('LCC.b', 'userBannedEvent', { userBannedDetails: { banType: 'temporary', bannedUserDetails: { channelId: FAN } } }), CH), { kind: 'clear_user', channelId: CH, platform: 'youtube', userId: FAN });

    for (const t of ['superStickerEvent', 'newSponsorEvent', 'memberMilestoneChatEvent', 'giftEvent', 'tombstone', 'chatEndedEvent', 'pollDetails']) {
        assert.equal(youtubeChat(item('LCC.x', t), CH), null, `${t} is not a chat line (the alert box shows memberships and stickers)`);
    }
    assert.equal(youtubeChat(item('bad id with spaces', 'textMessageEvent', { textMessageDetails: { messageText: 'x' } }), CH), null);
    assert.equal(youtubeChat(item('LCC.ok', 'textMessageEvent', { textMessageDetails: { messageText: 'x' } }, author({ channelId: 'not-a-channel' })), CH), null);
    assert.equal(youtubeChat(item('LCC.d2', 'userBannedEvent', { userBannedDetails: { bannedUserDetails: { channelId: '<script>' } } }), CH), null);
    assert.equal(youtubeChat(null, CH), null);
    assert.equal(youtubeChat(item('LCC.ok', 'textMessageEvent', {}), null), null, 'no channel: nothing');
    const long = youtubeChat(item('LCC.long', 'textMessageEvent', { textMessageDetails: { messageText: 'x'.repeat(900) } }), CH).message;
    assert.equal(long.parts[0].v.length, 500);

    // Chat overlay settings: YouTube is a platform choice (on by default for new overlays); YouTube handles can carry . and -.
    assert.deepEqual(CHAT_PLATFORMS, ['twitch', 'kick', 'youtube']);
    assert.deepEqual(defaultConfig('chat').platforms, ['twitch', 'kick', 'youtube']);
    const v = validateConfig('chat', { platforms: ['youtube', 'myspace'], hideUsers: '@Maple.Fan-88, nightbot' });
    assert.equal(v.ok, true);
    assert.deepEqual(v.value.platforms, ['youtube']);
    assert.equal(v.value.hideUsers, 'maple.fan-88, nightbot');
    assert.deepEqual(validateConfig('chat', { platforms: [] }).errors, ['Chat: show at least one platform.']);
    assert.equal(visibleFor(m, { platforms: ['twitch', 'kick'] }), false, 'an overlay without YouTube ticked');
    assert.equal(visibleFor(m, { platforms: ['youtube'], hideUsers: 'maple.fan-88' }), false, 'a hidden YouTube viewer');
    assert.equal(visibleFor(m, { platforms: ['youtube'] }), true);
});

test('alert box: Super Chats and Super Stickers, new members, milestones and gift memberships have their own alerts', () => {
    const yt = (type, metadata = {}, o = {}) => ({ platform: 'youtube', type, channelId: CH, user: { id: FAN, login: 'maple.fan-88', name: 'Maple.Fan-88', roles: [] }, amount: null, currency: null, message: null, metadata, ...o });
    assert.equal(alertKeyFor(yt('tip', { kind: 'super_chat' }, { amount: 5 })), 'yt_superchat');
    assert.equal(alertKeyFor(yt('tip', { kind: 'super_sticker' }, { amount: 2 })), 'yt_superchat');
    assert.equal(alertKeyFor(yt('tip', { kind: 'jewels' }, { amount: 50, currency: 'jewels' })), 'tip', 'Jewels stay a tip alert, like Bits-style gifts on tip services');
    assert.equal(alertKeyFor(yt('membership', { kind: 'new', tier: 'Lantern Club' })), 'yt_member');
    assert.equal(alertKeyFor(yt('membership', { kind: 'milestone', months: 6 })), 'yt_milestone');
    assert.equal(alertKeyFor(yt('membership', { kind: 'gift', isGift: true })), null, 'a gifted membership shows once, as Gift memberships');
    assert.equal(alertKeyFor(yt('membership', { kind: 'gift', isGift: true }), { showGiftedSubs: true }), 'yt_member');
    assert.equal(alertKeyFor(yt('gift_sub', { count: 5 }, { amount: 5 })), 'yt_gift');
    assert.equal(alertKeyFor({ ...yt('membership', { kind: 'new' }), platform: 'kofi' }), null, 'tip-service memberships have no alert (as before)');
    assert.equal(alertKeyFor({ ...yt('tip', { kind: 'super_chat' }), test: true }), null, 'automation Test events are not alerts');
    assert.equal(alertAmount('yt_milestone', yt('membership', { kind: 'milestone', months: 6 }, { amount: 6 })), 6);
    assert.equal(alertAmount('yt_gift', yt('gift_sub', { count: 5 }, { amount: 5 })), 5);
    assert.equal(alertAmount('yt_superchat', yt('tip', { kind: 'super_chat' }, { amount: 4.99 })), 4.99);
    assert.equal(alertAmount('yt_member', yt('membership', { kind: 'new' })), 0);
    for (const k of ['yt_superchat', 'yt_member', 'yt_milestone', 'yt_gift']) {
        assert.equal(ALERT_KINDS[k].platform, 'youtube');
        assert.equal(alertKeyFor(sampleFor(k)), k, `${k}: its Test sample shows that alert`);
    }
    assert.equal(ALERT_KINDS.yt_superchat.ttsCapable, true, 'a Super Chat message can be read aloud, like tips');

    // From YouTube's own resources, through the normaliser.
    const norm = (it) => normaliseYouTubeMessage(it, { channelId: CH, broadcastId: 'b1' });
    assert.equal(alertKeyFor(norm(item('s1', 'superChatEvent', { superChatDetails: { amountMicros: '2000000', currency: 'USD', userComment: 'gg' } }))), 'yt_superchat');
    assert.equal(alertKeyFor(norm(item('s2', 'superStickerEvent', { superStickerDetails: { amountMicros: '1000000', currency: 'USD', superStickerMetadata: { altText: 'Cat' } } }))), 'yt_superchat');
    assert.equal(alertKeyFor(norm(item('j1', 'giftEvent', { giftDetails: { jewelsAmount: 10 } }))), 'tip');
    assert.equal(alertKeyFor(norm(item('n1', 'newSponsorEvent', { newSponsorDetails: { memberLevelName: 'Lantern Club' } }))), 'yt_member');
    const ms = norm(item('m1', 'memberMilestoneChatEvent', { memberMilestoneChatDetails: { memberMonth: 12, userComment: 'a year!' } }));
    assert.deepEqual([alertKeyFor(ms), alertAmount('yt_milestone', ms)], ['yt_milestone', 12]);
    const gift = norm(item('g1', 'membershipGiftingEvent', { membershipGiftingDetails: { giftMembershipsCount: 3 } }));
    assert.deepEqual([alertKeyFor(gift), alertAmount('yt_gift', gift)], ['yt_gift', 3]);
    assert.equal(alertKeyFor(norm(item('r1', 'giftMembershipReceivedEvent', { giftMembershipReceivedDetails: { memberLevelName: 'Lantern Club' } }))), null);

    // The editor lists them only once YouTube is set up on the server.
    assert.equal(alertKeysFor().some((k) => k.startsWith('yt_')), false);
    assert.deepEqual(alertKeysFor({ youtube: true }).filter((k) => k.startsWith('yt_')), ['yt_superchat', 'yt_member', 'yt_milestone', 'yt_gift']);
    const off = formFor({});
    const on = formFor(ON);
    assert.deepEqual([off.youtube, off.alertKinds.length, on.youtube, on.alertKinds.length], [false, 13, true, 17]);
    assert.equal(formFor({ ...ON, STREAM_BOT_YOUTUBE: '0' }).youtube, false, 'switched off');
});

test('overlay settings pages: YouTube alerts and the YouTube chat choice only when set up, in Dark, Light and Sand', async () => {
    const offDemo = await overlayDemo({ root });
    const onDemo = await overlayDemo({ root, youtube: true });
    for (const theme of ['dark', 'light', 'sand']) {
        const a = render(onDemo.edit('alerts').template, onDemo.edit('alerts').locals, theme);
        assert.equal((a.match(/data-alert="/g) || []).length, 17, theme);
        for (const k of ['yt_superchat', 'yt_member', 'yt_milestone', 'yt_gift']) assert.match(a, new RegExp(`data-alert="${k}"`));
        assert.match(a, /Super Chat or Super Sticker \(YouTube\)/);
        assert.match(a, /data-cfg="alerts\.yt_superchat\.tts"/, 'read aloud for Super Chats');
        assert.match(a, /The same goes for gifted YouTube memberships\./);
        const ids = [...a.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]);
        assert.deepEqual(ids.filter((x, i) => ids.indexOf(x) !== i), [], `${theme}: ids unique`);
        const c = render(onDemo.edit('chat').template, onDemo.edit('chat').locals, theme);
        assert.match(c, /<label class="sb-check"><input type="checkbox" data-cfg="platforms" data-multi value="youtube"[^>]*> YouTube<\/label>/);
    }
    const a = render(offDemo.edit('alerts').template, offDemo.edit('alerts').locals);
    assert.equal((a.match(/data-alert="/g) || []).length, 13);
    assert.doesNotMatch(a, /\(YouTube\)|gifted YouTube memberships/);
    const c = render(offDemo.edit('chat').template, offDemo.edit('chat').locals);
    assert.match(c, /<label class="sb-check" hidden><input type="checkbox" data-cfg="platforms" data-multi value="youtube"/, 'kept (hidden) so a save does not drop it');
});

test('timers: YouTube and "everywhere" need YouTube set up and linked; "all" stays Twitch and Kick; the quota guard holds YouTube back', () => {
    assert.deepEqual(TIMER_PLATFORMS, ['twitch', 'kick', 'all', 'youtube', 'everywhere']);
    assert.ok(TIMER_PLATFORMS.every((p) => p.length <= 10), 'fits tokes_timers.platforms varchar(10)');
    assert.equal(TIMER_WHERE.everywhere, 'Twitch, Kick and YouTube');
    const base = { messages: 'Follow the channel', intervalMin: 20 };
    assert.deepEqual(validateTimer({ ...base, platforms: 'youtube' }, { linkedPlatforms: ['youtube'] }).errors, ['YouTube is not set up on this server yet, so timers cannot post there.']);
    assert.deepEqual(validateTimer({ ...base, platforms: 'everywhere' }, { linkedPlatforms: ['twitch'], youtube: true }).errors, ['Link a YouTube channel first (Connections).']);
    const ok = validateTimer({ ...base, platforms: 'youtube' }, { linkedPlatforms: ['twitch', 'youtube'], youtube: true });
    assert.deepEqual([ok.ok, ok.value.platforms], [true, 'youtube']);
    assert.equal(validateTimer({ ...base, platforms: 'everywhere' }, { linkedPlatforms: ['youtube'], youtube: true }).ok, true);
    assert.deepEqual(validateTimer({ ...base, platforms: 'kick' }, { linkedPlatforms: ['twitch'], youtube: true }).errors, ['Link a Kick channel first (Connections).']);
    assert.equal(validateTimer({ ...base, platforms: 'youtube' }, { kickPage: true }).value.platforms, null, 'Kick channel page timers stay Kick');

    const channels = [
        { platform: 'twitch', platform_user_id: 900000001, login: 'maplehollow_tv' },
        { platform: 'kick', platform_user_id: '800000001', login: 'maplehollow' },
        { platform: 'youtube', platform_user_id: CH, login: 'maplehollow' },
    ];
    const where = (p, o) => timerTargets(p, channels, o).map((t) => t.platform);
    assert.deepEqual(where('all', { youtube: true }), ['twitch', 'kick'], 'timers made before YouTube do not start spending its quota');
    assert.deepEqual(where(null, { youtube: true }), ['twitch', 'kick']);
    assert.deepEqual(where('everywhere', { youtube: true }), ['twitch', 'kick', 'youtube']);
    assert.deepEqual(where('youtube', { youtube: true }), ['youtube']);
    assert.deepEqual(where('youtube', { youtube: false }), [], 'YouTube off: nothing');
    assert.deepEqual(where('everywhere', { youtube: false }), ['twitch', 'kick']);
    assert.deepEqual(YOUTUBE_TIMER_HOLD, ['critical', 'exhausted']);
    assert.deepEqual(where('everywhere', { youtube: true, youtubeLevel: 'slow' }), ['twitch', 'kick', 'youtube']);
    for (const lv of YOUTUBE_TIMER_HOLD) assert.deepEqual(where('everywhere', { youtube: true, youtubeLevel: lv }), ['twitch', 'kick'], lv);
    assert.deepEqual(timerTargets('twitch', channels)[0], { platform: 'twitch', channelId: '900000001', login: 'maplehollow_tv' });
});

test('timer job: a YouTube timer posts as the channel through io.sendChat; not live is retried quietly; off or critical holds it', async () => {
    const saved = { id: process.env.GOOGLE_OAUTH_CLIENT_ID, secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET, sw: process.env.STREAM_BOT_YOUTUBE };
    const row = { id: 41, channel_id: null, profile_id: 7, name: 'Socials', message: 'Follow {channel.name}', extra_messages: null, rotation: 'rotate', next_index: 0,
        interval_min: 15, is_enabled: 1, only_live: 0, min_chat_lines: 0, automation_id: null, platforms: 'everywhere', last_sent_at: null, send_count: 0 };
    const updates = [];
    const pool = { async query(sql, params) { if (/^\s*SELECT/i.test(sql)) return [[{ ...row }]]; updates.push(params); return [{ affectedRows: 1 }]; } };
    const sent = [];
    const warns = [];
    let level = 'normal';
    let reply = { ok: true };
    let ytLive = true;
    const sb = {
        store: { async getProfile() { return { id: 7, enabled: true }; } },
        io: {
            async channelsFor() { return [{ platform: 'twitch', platform_user_id: '900000001', login: 'maplehollow_tv' }, { platform: 'youtube', platform_user_id: CH, login: 'maplehollow' }]; },
            async sendChat(m) { sent.push([m.platform, m.channelId, m.text]); return m.platform === 'youtube' ? reply : { ok: true }; },
        },
        streamInfo: { async get() { return { live: true }; } },
        render: async (text, ctx) => text.replace('{channel.name}', ctx.channelName),
        ingest: { noteSent() {} },
        youtube: { service: { streamInfo: () => ({ live: ytLive }) }, quota: { level: () => level } },
    };
    const logger = { warn: (...a) => warns.push(a[0]), info() {}, debug() {} };
    const run = () => runDueTimers({ pool, logger, sendKick: async () => true, getStreamBot: async () => sb });
    try {
        delete process.env.STREAM_BOT_YOUTUBE;
        Object.assign(process.env, ON);
        assert.deepEqual(await run(), { due: 1, sent: 1 });
        assert.deepEqual(sent.splice(0), [['twitch', '900000001', 'Follow maplehollow_tv'], ['youtube', CH, 'Follow maplehollow']]);
        row.platforms = 'youtube';
        ytLive = false;
        assert.deepEqual(await run(), { due: 1, sent: 0 });
        assert.deepEqual(sent, [], 'not live on YouTube: no send, checked again next minute');
        assert.deepEqual(warns, [], 'not live on YouTube is not a failure');
        ytLive = true;
        reply = { ok: false, notLive: true, error: 'not live on YouTube' };
        await run();
        assert.deepEqual(sent.splice(0), [['youtube', CH, 'Follow maplehollow']]);
        assert.equal(warns.includes('[KickTimers] YouTube send failed'), false, 'a broadcast that just ended is not a send failure');
        warns.length = 0;
        reply = { ok: false, error: 'Today\'s YouTube allowance is used up.' };
        await run();
        assert.ok(warns.splice(0).includes('[KickTimers] YouTube send failed'));
        sent.length = 0;
        level = 'critical';
        assert.deepEqual(await run(), { due: 1, sent: 0 });
        assert.deepEqual(sent, [], 'held back at critical: no YouTube call');
        level = 'normal';
        delete process.env.GOOGLE_OAUTH_CLIENT_ID;
        assert.deepEqual(await run(), { due: 1, sent: 0 });
        assert.deepEqual(sent, [], 'YouTube not set up: nothing');
    } finally {
        for (const [k, v] of [['GOOGLE_OAUTH_CLIENT_ID', saved.id], ['GOOGLE_OAUTH_CLIENT_SECRET', saved.secret], ['STREAM_BOT_YOUTUBE', saved.sw]]) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
});

test('Timers page and the OBS chat dock: YouTube wording and the quota note only when set up, in Dark, Light and Sand', async () => {
    const pages = await streamBotPages(demo, { root });
    const t = pages['stream-bot-timers'];
    const yt = { dailyUnits: 10000, sendUnits: 20, chatMax: 200 };
    for (const theme of ['dark', 'light', 'sand']) {
        const html = render(t.template, { ...t.locals, youtube: yt }, theme);
        assert.match(html, new RegExp(`<html data-theme="${theme}"`));
        assert.match(html, /<option value="youtube">YouTube<\/option><option value="everywhere">Twitch, Kick and YouTube<\/option>/);
        assert.match(html, /<p class="cf-row-desc" id="sb-t-yt-quota" hidden>Each post on YouTube uses 20 of the 10,000 YouTube units/);
        assert.match(html, /<span id="sb-t-yt-rate"><\/span>/);
        assert.match(html, /YouTube cuts messages at 200 characters/);
        assert.match(html, /aria-describedby="sb-t-yt-quota"/);
        assert.match(html, /on YouTube from your own channel/);
        const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]);
        assert.deepEqual(ids.filter((x, i) => ids.indexOf(x) !== i), [], `${theme}: ids unique`);
    }
    const off = render(t.template, t.locals);
    assert.doesNotMatch(off, /value="youtube"|value="everywhere"|sb-t-yt-quota|YouTube/);

    const dock = (data) => engine.renderFile(path.join(views, 'stream-bot/dock.ejs'), { theme: 'dark', page: 'chat', title: 'Chat', data, settings: {}, _locals: {} });
    assert.match(dock({ events: [], storeChat: false, youtube: true }), /Chat from your Twitch, Kick and YouTube channels shows here/);
    assert.match(dock({ events: [], storeChat: false }), /Chat from your Twitch and Kick channels shows here/);
    const withLine = dock({ events: [{ id: 1, type: 'chat', platform: 'youtube', platformLabel: 'YouTube', user: 'Maple.Fan-88', message: '<b>hi</b>', at: '2026-11-20T18:00:00Z' }], storeChat: true, youtube: true });
    assert.match(withLine, /<span class="dock-meta">YouTube<\/span> <span class="dock-name">Maple\.Fan-88<\/span> <span class="dock-text">&lt;b&gt;hi&lt;\/b&gt;<\/span>/);
});
