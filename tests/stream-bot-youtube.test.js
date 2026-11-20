import './fixtures/test-log-dir.js';
/*
 * Stream bot, YouTube Live (H-741, design §13). The YouTube API is always a fake here; nothing calls Google.
 *
 *   pure      the normaliser (every liveChatMessage kind), describeEvent, the config switch and scopes, the quota guard
 *             (levels, the ban refusal, the Pacific day and reset), the streamed-JSON parser
 *   api       streamList over a fake streaming body, error elements, quota charging, insert / delete / ban bodies
 *   auth      the token from stream_platform_accounts: cached, refreshed and written back, invalid_grant, other channel, scope
 *   service   on throwaway tables (migration 470's DDL): going live, the backlog skipped, first words, a Super Chat, offlineAt,
 *             the live row kept for a restart and resumed, sending (and "not live"), delete, time-out, the guard
 *   engine    chat.send to YouTube through the wrapped io, "All" skipping a YouTube channel that is not live, chat.timeout
 *   viewers   YouTube chatters, Super Chats and memberships on the viewer records
 *   import    Streamer.bot YouTube triggers and sub-actions, a command that also answered on YouTube
 *   privacy   /privacy export and delete of the YouTube tables; the /privacy/viewer YouTube sign-in
 *   pages     the Connections page with YouTube on and off, escaped
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import pool from '../utils/db.js';
import { makeTables, makeProfile, fakeEncryption } from './fixtures/stream-bot-tables.js';
import { youtubeDdl, RETENTION_ROWS } from '../migrations/470_stream_bot_youtube.js';
import { viewersDdl } from '../migrations/464_stream_bot_viewers.js';
import { youtubeBotConfig, canRead, canWrite, BOT_SCOPES, VIEWER_SCOPES, YT_SCOPE, QUOTA_COST, DISABLED_TEXT } from '../core/stream-bot/youtube/config.js';
import { createQuotaGuard, quotaTable, pacificDay, nextPacificMidnight } from '../core/stream-bot/youtube/quota.js';
import { normaliseYouTubeMessage, broadcastEvent, ytRoles } from '../core/stream-bot/youtube/normalise.js';
import { createYouTubeApi, createArrayStreamParser, YouTubeError } from '../core/stream-bot/youtube/api.js';
import { createYouTubeAuth, YouTubeAuthError } from '../core/stream-bot/youtube/auth.js';
import { createYouTubeService } from '../core/stream-bot/youtube/service.js';
import { registerYouTubeActions, wireYouTube, youtubeServiceRef } from '../core/stream-bot/youtube/register.js';
import { youtubeExport, youtubeDelete, youtubeAccountDelete } from '../core/stream-bot/youtube/privacy.js';
import { describeEvent, eventType, PLATFORMS, publicEvent } from '../core/stream-bot/events.js';
import * as actionsMod from '../core/stream-bot/actions.js';
import { createEngine } from '../core/stream-bot/engine.js';
import { createRenderer } from '../core/stream-bot/render.js';
import { createLimiter } from '../core/stream-bot/conditions.js';
import { createViewerStore } from '../core/stream-bot/viewers/store.js';
import { createViewerService } from '../core/stream-bot/viewers/service.js';
import { parseStreamerbot } from '../core/stream-bot/import/streamerbot.js';
import { buildPlan } from '../core/stream-bot/import/mapper.js';
import { GAPS, INTEGRATIONS } from '../core/stream-bot/import/catalog.js';
import { createViewerSignIn } from '../core/stream-bot/viewer-signin.js';
import { sessionAccounts } from '../dashboard/routes/privacy-viewer.js';
import { youtubePanel, PLATFORM_LABEL } from '../dashboard/services/stream-bot-view.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CH = 'UCmApLeHoLLoW00000000001';
const FAN = 'UCfAnOfMaPlE000000000001';
const T0 = Date.parse('2026-11-20T20:00:00Z');

const author = (over = {}) => ({ channelId: FAN, displayName: '@MapleFan88', isChatOwner: false, isChatModerator: false, isChatSponsor: false, isVerified: false, ...over });
const msg = (id, type, snippet = {}, a = author(), at = new Date(T0).toISOString()) => ({ kind: 'youtube#liveChatMessage', id, snippet: { type, publishedAt: at, ...snippet }, authorDetails: a });

let T = null;
test.after(async () => {
    if (T) {
        for (const t of ['youtube_quota', 'youtube_live', 'viewer_history', 'viewers']) await pool.query(`DROP TABLE IF EXISTS \`${T.prefix}${t}\``).catch(() => {});
        await T.drop().catch(() => {});
    }
    await pool.end().catch(() => {});
});

// ── pure ────────────────────────────────────────────────────────────────────────────────────

test('normaliser: chat with roles and first words, Super Chat, Super Sticker, Jewels, memberships, gifts; the rest are not events', () => {
    const seen = new Set();
    const isFirst = (id) => (seen.has(id) ? false : (seen.add(id), true));
    const ctx = { channelId: CH, broadcastId: 'bc1', isFirst };
    const c1 = normaliseYouTubeMessage(msg('m1', 'textMessageEvent', { textMessageDetails: { messageText: '!hello there' } }, author({ isChatModerator: true, isChatSponsor: true })), ctx);
    assert.equal(c1.platform, 'youtube');
    assert.equal(c1.type, 'chat');
    assert.equal(c1.channelId, CH);
    assert.deepEqual(c1.user, { id: FAN, login: 'maplefan88', name: '@MapleFan88', roles: ['moderator', 'subscriber'] });
    assert.equal(c1.message, '!hello there');
    assert.equal(c1.metadata.firstWords, true);
    assert.equal(c1.dedupeKey, 'yt:chat:m1');
    assert.equal(normaliseYouTubeMessage(msg('m2', 'textMessageEvent', { displayMessage: 'again' }), ctx).metadata.firstWords, false);
    assert.equal(c1.raw.authorDetails.profileImageUrl, undefined, 'no picture addresses are kept');

    const sc = normaliseYouTubeMessage(msg('s1', 'superChatEvent', { superChatDetails: { amountMicros: '5000000', currency: 'USD', amountDisplayString: '$5.00', userComment: 'Love the stream', tier: 2 } }), ctx);
    assert.deepEqual([sc.type, sc.amount, sc.currency, sc.message, sc.metadata.kind, sc.metadata.display], ['tip', 5, 'USD', 'Love the stream', 'super_chat', '$5.00']);
    assert.equal(describeEvent(sc), '@MapleFan88 sent a Super Chat (5 USD)');
    const st = normaliseYouTubeMessage(msg('s2', 'superStickerEvent', { superStickerDetails: { amountMicros: '1990000', currency: 'EUR', superStickerMetadata: { altText: 'Dancing corgi' } } }), ctx);
    assert.deepEqual([st.amount, st.currency, st.metadata.kind, st.metadata.sticker], [1.99, 'EUR', 'super_sticker', 'Dancing corgi']);
    assert.equal(describeEvent(st), '@MapleFan88 sent a Super Sticker (1.99 EUR)');
    const jw = normaliseYouTubeMessage(msg('j1', 'giftEvent', { giftDetails: { jewelsAmount: 50, giftName: 'Rose' } }), ctx);
    assert.deepEqual([jw.type, jw.amount, jw.currency, jw.metadata.kind], ['tip', 50, 'jewels', 'jewels']);
    assert.equal(describeEvent(jw), '@MapleFan88 sent 50 jewels');

    const nm = normaliseYouTubeMessage(msg('n1', 'newSponsorEvent', { newSponsorDetails: { memberLevelName: 'Leaf', isUpgrade: false } }), ctx);
    assert.deepEqual([nm.type, nm.metadata.kind, nm.metadata.tier, nm.user.roles], ['membership', 'new', 'Leaf', ['subscriber']]);
    assert.equal(describeEvent(nm), '@MapleFan88 became a member (Leaf)');
    const ms = normaliseYouTubeMessage(msg('n2', 'memberMilestoneChatEvent', { memberMilestoneChatDetails: { memberMonth: 6, memberLevelName: 'Leaf', userComment: 'Half a year!' } }), ctx);
    assert.deepEqual([ms.type, ms.amount, ms.currency, ms.message, ms.metadata.kind, ms.metadata.months], ['membership', 6, 'months', 'Half a year!', 'milestone', 6]);
    assert.equal(describeEvent(ms), '@MapleFan88 has been a member for 6 months (Leaf)');
    const gf = normaliseYouTubeMessage(msg('g1', 'membershipGiftingEvent', { membershipGiftingDetails: { giftMembershipsCount: 5, giftMembershipsLevelName: 'Leaf' } }), ctx);
    assert.deepEqual([gf.type, gf.amount, gf.currency, gf.metadata.count], ['gift_sub', 5, 'subs', 5]);
    assert.equal(describeEvent(gf), '@MapleFan88 gifted 5 memberships');
    const gr = normaliseYouTubeMessage(msg('g2', 'giftMembershipReceivedEvent', { giftMembershipReceivedDetails: { memberLevelName: 'Leaf', gifterChannelId: 'UCgIfTeR0000000000000001' } }), ctx);
    assert.deepEqual([gr.type, gr.metadata.kind, gr.metadata.isGift, gr.metadata.gifterChannelId], ['membership', 'gift', true, 'UCgIfTeR0000000000000001']);
    for (const t of ['tombstone', 'userBannedEvent', 'chatEndedEvent', 'sponsorOnlyModeStartedEvent', 'pollDetails']) assert.equal(normaliseYouTubeMessage(msg('x', t), ctx), null, t);
    assert.deepEqual(ytRoles({ isChatOwner: true }), ['broadcaster']);

    const on = broadcastEvent('stream.online', { channelId: CH, broadcastId: 'bc1', title: 'Cozy farming', startedAt: '2026-11-20T19:59:00Z' });
    assert.deepEqual([on.type, on.dedupeKey, on.message, on.metadata.broadcastId], ['stream.online', 'yt:online:bc1', 'Cozy farming', 'bc1']);
    assert.equal(broadcastEvent('stream.offline', { channelId: CH, broadcastId: 'bc1' }).dedupeKey, 'yt:offline:bc1');
    // The generic types now take YouTube.
    assert.ok(PLATFORMS.includes('youtube'));
    for (const t of ['chat', 'tip', 'membership', 'gift_sub', 'stream.online', 'stream.offline']) assert.ok(eventType(t).platforms.includes('youtube'), t);
    assert.equal(PLATFORM_LABEL.youtube, 'YouTube');
});

test('config: on only with the Google client; one scope that reads and writes; quota prices', () => {
    assert.deepEqual(youtubeBotConfig({}), { enabled: false, reason: 'no_client', clientId: null, clientSecret: null, dailyUnits: 10000 });
    const on = youtubeBotConfig({ GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'sec', YOUTUBE_STREAM_BOT_DAILY_UNITS: '50000' });
    assert.deepEqual([on.enabled, on.dailyUnits], [true, 50000]);
    assert.equal(youtubeBotConfig({ GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'sec', STREAM_BOT_YOUTUBE: '0' }).reason, 'switched_off');
    assert.deepEqual(BOT_SCOPES, [YT_SCOPE.forceSsl]);
    assert.deepEqual(VIEWER_SCOPES, [YT_SCOPE.readonly]);
    assert.ok(canRead(BOT_SCOPES) && canWrite(BOT_SCOPES) && canWrite([YT_SCOPE.full]));
    assert.ok(canRead([YT_SCOPE.readonly]) && !canWrite([YT_SCOPE.readonly]));
    assert.deepEqual([QUOTA_COST['liveChatMessages.streamList'], QUOTA_COST['liveChatMessages.insert'], QUOTA_COST['liveChatBans.insert'], QUOTA_COST['liveBroadcasts.list']], [5, 20, 200, 1]);
    assert.ok(DISABLED_TEXT.no_client && DISABLED_TEXT.switched_off);
});

test('quota guard: levels, the ban refusal at critical, exhausted, the Pacific day and reset, persistence', async () => {
    let now = Date.parse('2026-11-20T07:59:00Z');   // 23:59 on the 19th in Los Angeles
    assert.equal(pacificDay(now), '2026-11-19');
    assert.equal(new Date(nextPacificMidnight(now)).toISOString(), '2026-11-20T08:00:00.000Z');
    assert.equal(new Date(nextPacificMidnight(Date.parse('2026-07-01T12:00:00Z'))).toISOString(), '2026-07-02T07:00:00.000Z', 'summer time');
    const written = [];
    const g = createQuotaGuard({ dailyUnits: 1000, now: () => now, persist: { add: async (d, rows) => { written.push([d, rows]); }, load: async () => [] } });
    assert.equal(g.level(), 'normal');
    for (let i = 0; i < 120; i++) g.spend('liveChatMessages.streamList', 7);   // 600
    assert.equal(g.level(), 'slow');
    assert.equal(g.gapMs(), 20000);
    for (let i = 0; i < 50; i++) g.spend('liveChatMessages.streamList', 7);    // 850
    assert.equal(g.level(), 'critical');
    assert.deepEqual(g.allow('liveChatBans.insert'), { ok: false, level: 'critical', reason: 'critical' });
    assert.equal(g.allow('liveChatMessages.insert').ok, true);
    const st = g.status(7);
    assert.deepEqual([st.used, st.profileUnits, st.profileCalls, st.level], [850, 850, 170, 'critical']);
    await g.flush();
    assert.deepEqual(written[0], ['2026-11-19', [{ profileId: 7, units: 850, calls: 170 }]]);
    g.markExhausted();
    assert.equal(g.spend('liveBroadcasts.list', 7).ok, false);
    now += 2 * 60_000;   // past midnight Pacific: a new day
    assert.equal(g.level(), 'normal');
    assert.equal(g.status().used, 0);
    // A restart reads what the day already spent.
    const g2 = createQuotaGuard({ dailyUnits: 1000, now: () => now, persist: { add: async () => {}, load: async (d) => (d === '2026-11-20' ? [{ profileId: 7, units: 700, calls: 140 }] : []) } });
    await g2.load();
    assert.deepEqual([g2.status(7).used, g2.level()], [700, 'slow']);
});

test('streamed JSON: elements split anywhere, brackets and escaped quotes inside strings', () => {
    const p = createArrayStreamParser();
    const text = '[{"a":"x]}\\"[{","n":1},\n{"b":[1,2,{"c":"}"}]}\n]';
    const out = [];
    for (let i = 0; i < text.length; i += 3) out.push(...p.push(text.slice(i, i + 3)));
    assert.deepEqual(out, [{ a: 'x]}"[{', n: 1 }, { b: [1, 2, { c: '}' }] }]);
    assert.equal(p.bad, 0);
});

// ── api ─────────────────────────────────────────────────────────────────────────────────────

function streamBody(chunks) {
    return new ReadableStream({ start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close(); } });
}

test('api: streamList delivers responses as they arrive; errors, quota charging and the write bodies', async () => {
    const calls = [];
    const quota = createQuotaGuard({ dailyUnits: 10000 });
    let next = null;
    const fetchImpl = async (url, init = {}) => { calls.push({ url: String(url), init }); return next(String(url), init); };
    const api = createYouTubeApi({ fetchImpl, quota });
    const r1 = { kind: 'youtube#liveChatMessageListResponse', nextPageToken: 'p1', items: [msg('m1', 'textMessageEvent', { textMessageDetails: { messageText: 'hi' } })] };
    const r2 = { nextPageToken: 'p2', items: [], pollingIntervalMillis: 1500 };
    next = () => new Response(streamBody(['[', JSON.stringify(r1).slice(0, 40), JSON.stringify(r1).slice(40), ',\n', JSON.stringify(r2), ']']), { status: 200 });
    const got = [];
    const out = await api.streamChat('TOKEN-A', 'chat1', 'p0', { profileId: 7, onResponse: (el) => got.push(el) });
    assert.deepEqual([got.length, got[0].items[0].id, out.nextPageToken, out.responses, out.pollingIntervalMillis], [2, 'm1', 'p2', 2, 1500]);
    const u = new URL(calls[0].url);
    assert.deepEqual([u.pathname, u.searchParams.get('liveChatId'), u.searchParams.get('pageToken')], ['/youtube/v3/liveChat/messages/stream', 'chat1', 'p0']);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer TOKEN-A');
    assert.equal(quota.status(7).used, 5);

    next = () => new Response(streamBody(['[{"error":{"code":403,"message":"x","errors":[{"reason":"liveChatEnded"}]}}]']), { status: 200 });
    await assert.rejects(api.streamChat('TOKEN-A', 'chat1', null, {}), (e) => e instanceof YouTubeError && e.reason === 'liveChatEnded');
    next = () => new Response(JSON.stringify([{ error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } }]), { status: 403 });
    await assert.rejects(api.streamChat('TOKEN-A', 'chat1', null, {}), (e) => e.reason === 'quotaExceeded' && !String(e.message).includes('TOKEN-A'));
    assert.equal(quota.level(), 'exhausted', 'quotaExceeded from Google stops every call until the reset');
    await assert.rejects(api.activeBroadcasts('TOKEN-A', 7), (e) => e.reason === 'quotaGuardExhausted');

    const q2 = createQuotaGuard({ dailyUnits: 10000 });
    const api2 = createYouTubeApi({ fetchImpl, quota: q2 });
    next = () => new Response(JSON.stringify({ id: 'sent1' }), { status: 200 });
    await api2.sendMessage('TOKEN-B', 'chat1', 'x'.repeat(250), 7);
    const sent = calls.at(-1);
    assert.equal(sent.init.method, 'POST');
    assert.deepEqual(JSON.parse(sent.init.body), { snippet: { liveChatId: 'chat1', type: 'textMessageEvent', textMessageDetails: { messageText: 'x'.repeat(200) } } });
    next = () => new Response(null, { status: 204 });
    assert.equal(await api2.deleteMessage('TOKEN-B', 'm1', 7), true);
    assert.equal(new URL(calls.at(-1).url).searchParams.get('id'), 'm1');
    next = () => new Response(JSON.stringify({ id: 'ban1' }), { status: 200 });
    await api2.ban('TOKEN-B', 'chat1', FAN, 300, 7);
    assert.deepEqual(JSON.parse(calls.at(-1).init.body).snippet, { liveChatId: 'chat1', type: 'temporary', bannedUserDetails: { channelId: FAN }, banDurationSeconds: 300 });
    await api2.ban('TOKEN-B', 'chat1', FAN, null, 7);
    assert.equal(JSON.parse(calls.at(-1).init.body).snippet.type, 'permanent');
    assert.equal(q2.status(7).used, 20 + 20 + 200 + 200);
    next = () => new Response(JSON.stringify({ items: [{ id: 'bc1', snippet: { title: 'Cozy', liveChatId: 'chat1', channelId: CH, actualStartTime: '2026-11-20T19:59:00Z' }, status: { lifeCycleStatus: 'live' } }] }), { status: 200 });
    assert.deepEqual((await api2.activeBroadcasts('TOKEN-B', 7))[0], { id: 'bc1', title: 'Cozy', chatId: 'chat1', channelId: CH, startedAt: '2026-11-20T19:59:00Z', endedAt: null, lifeCycle: 'live', privacy: null });
    const lb = new URL(calls.at(-1).url);
    assert.equal(lb.searchParams.get('broadcastStatus'), 'active');
});

// ── auth ────────────────────────────────────────────────────────────────────────────────────

function fakeAccountsDb(row) {
    const updates = [];
    return {
        updates,
        row,
        async query(sql, params) {
            if (/^SELECT/.test(sql.trim())) return [row ? [{ ...row }] : []];
            updates.push({ sql, params });
            if (/SET status = 'needs_reconnect'/.test(sql)) row.status = 'needs_reconnect';
            if (/SET access_token = \?/.test(sql)) { row.access_token = params[0]; row.expires_at = params[1]; }
            return [{ affectedRows: 1 }];
        },
    };
}
const enc = (s) => JSON.stringify(fakeEncryption.encrypt(s));

test('auth: the stored token while fresh, a refresh written back, invalid_grant, another channel, the write scope', async () => {
    let now = T0;
    const row = { id: 4, platform_user_id: CH, access_token: enc('AT-1'), refresh_token: enc('RT-1'), expires_at: new Date(T0 + 30 * 60_000), scopes: YT_SCOPE.forceSsl, status: 'active' };
    const db = fakeAccountsDb(row);
    let tokenCalls = 0;
    let answer = () => new Response(JSON.stringify({ access_token: 'AT-2', expires_in: 3599, scope: YT_SCOPE.forceSsl }), { status: 200 });
    const auth = createYouTubeAuth({ db, encryption: fakeEncryption, clientId: 'cid', clientSecret: 'csec', now: () => now, fetchImpl: async (url, init) => { tokenCalls++; assert.match(String(init.body), /grant_type=refresh_token/); return answer(); } });
    assert.equal((await auth.token({ ownerId: '111', channelId: CH })).accessToken, 'AT-1');
    now += 26 * 60_000;   // 4 minutes left: refreshed
    const [a, b] = await Promise.all([auth.token({ ownerId: '111', channelId: CH }), auth.token({ ownerId: '111', channelId: CH })]);
    assert.deepEqual([a.accessToken, b.accessToken, tokenCalls], ['AT-2', 'AT-2', 1], 'one refresh for every waiting caller');
    assert.equal(fakeEncryption.decrypt(JSON.parse(db.row.access_token)), 'AT-2', 'written back encrypted');
    await assert.rejects(auth.token({ ownerId: '111', channelId: 'UCsomeoneElse0000000000x' }), (e) => e instanceof YouTubeAuthError && e.code === 'other_channel');
    answer = () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    await assert.rejects(auth.token({ ownerId: '111', channelId: CH }, { force: true }), (e) => e.code === 'needs_reconnect' && !/RT-1|AT-/.test(e.message));
    assert.equal(db.row.status, 'needs_reconnect');
    assert.deepEqual((await auth.status({ ownerId: '111', channelId: CH })).state, 'needs_reconnect');
    const ro = createYouTubeAuth({ db: fakeAccountsDb({ ...row, status: 'active', scopes: YT_SCOPE.readonly }), encryption: fakeEncryption, clientId: 'c', clientSecret: 's', now: () => T0 });
    assert.ok((await ro.token({ ownerId: '1', channelId: CH })).accessToken);
    await assert.rejects(ro.token({ ownerId: '1', channelId: CH }, { write: true }), (e) => e.code === 'scope');
    const none = createYouTubeAuth({ db: fakeAccountsDb(null), encryption: fakeEncryption, clientId: 'c', clientSecret: 's' });
    await assert.rejects(none.token({ ownerId: '1', channelId: CH }), (e) => e.code === 'missing');
});

// ── service (throwaway tables) ──────────────────────────────────────────────────────────────

function fakeYouTube() {
    const f = {
        broadcasts: [], streams: [], sent: [], deleted: [], bans: [], videos: new Map(), streamCalls: 0, listCalls: 0,
        async activeBroadcasts() { return f.broadcasts; },
        async video(tok, id) { return f.videos.get(id) || null; },
        async listChat() { f.listCalls++; return { items: [], nextPageToken: 'L1', pollingIntervalMillis: 2000 }; },
        async streamChat(tok, chatId, pageToken, { onResponse, signal }) {
            f.streamCalls++;
            const step = f.streams.shift();
            if (!step) { await new Promise((r) => signal?.addEventListener('abort', r, { once: true })); throw new YouTubeError(0, 'stopped'); }
            if (step.error) throw step.error;
            for (const el of step.responses || []) await onResponse(el);
            return { responses: (step.responses || []).length, nextPageToken: step.responses?.at(-1)?.nextPageToken || pageToken, offlineAt: step.offlineAt || null };
        },
        async sendMessage(tok, chatId, text) { f.sent.push({ chatId, text }); return { id: 'x' }; },
        async deleteMessage(tok, id) { f.deleted.push(id); return true; },
        async ban(tok, chatId, user, seconds) { f.bans.push({ chatId, user, seconds }); return { id: 'b' }; },
    };
    return f;
}
const fakeIngest = () => {
    const i = { events: [], sent: [], raw: [], async youtube(ev) { i.events.push(ev); return 1; }, noteSent(p, c, t) { i.sent.push([p, c, t]); }, youtubeRaw(item, ch) { i.raw.push([item.id, ch]); } };
    return i;
};
// Waits are cut short but still yield to timers and I/O (an always-resolved promise would starve them).
const quickSleep = (ms, signal) => new Promise((r) => { const t = setTimeout(r, Math.min(ms, 2)); signal?.addEventListener?.('abort', () => { clearTimeout(t); r(); }, { once: true }); });
async function settle(svc) {
    for (let k = 0; k < 200; k++) {
        if ([...svc._channels.values()].every((c) => !c.reader)) return;
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('reader did not finish');
}

test('service: goes live, skips the backlog, first words, a Super Chat, ends on offlineAt, keeps the row; send, delete, time out', async () => {
    T = await makeTables(pool, 'yt');
    for (const sql of youtubeDdl(T.prefix)) await pool.query(sql);
    const profile = await makeProfile(T.store);
    await T.store.linkChannel(profile.id, { platform: 'youtube', platformUserId: CH, login: 'maplehollow', displayName: 'Maple Hollow', verifiedVia: 'stream_platform_accounts' });
    let now = T0;
    const yt = fakeYouTube();
    const ingest = fakeIngest();
    const quota = createQuotaGuard({ dailyUnits: 10000, now: () => now });
    const auth = { async token() { return { accessToken: 'tok', scopes: [YT_SCOPE.forceSsl] }; } };
    const svc = createYouTubeService({ db: pool, store: T.store, ingest, api: yt, auth, quota, now: () => now, sleep: quickSleep });
    await svc.reload(true);
    const ch = svc._channels.get(`${profile.id}:${CH}`);
    assert.ok(ch, 'the linked YouTube channel is read from the tables');
    ch.nextCheckAt = now;
    await svc.tick();
    assert.equal(ingest.events.length, 0, 'not live: nothing');
    assert.equal(svc.streamInfo({ profileId: profile.id, channelId: CH }).live, false);

    yt.broadcasts = [{ id: 'bc1', title: 'Cozy farming', chatId: 'chat1', channelId: CH, startedAt: new Date(T0).toISOString() }];
    const at = (s) => new Date(now + s * 1000).toISOString();
    yt.streams.push({ responses: [{ nextPageToken: 'p1', items: [
        msg('old', 'textMessageEvent', { textMessageDetails: { messageText: 'from yesterday' } }, author(), new Date(now - 3600_000).toISOString()),
        msg('m1', 'textMessageEvent', { textMessageDetails: { messageText: 'first!' } }, author(), at(1)),
        msg('m2', 'textMessageEvent', { textMessageDetails: { messageText: 'second' } }, author(), at(2)),
        msg('s1', 'superChatEvent', { superChatDetails: { amountMicros: '2000000', currency: 'USD', userComment: 'gg' } }, author(), at(3)),
    ] }] });
    yt.streams.push({ responses: [{ nextPageToken: 'p2', items: [] }], offlineAt: at(60) });
    svc.hint(profile.id);
    assert.ok(ch.nextCheckAt <= now && ch.burstUntil > now, 'a hint checks now and keeps checking every minute');
    await svc.tick();
    await settle(svc);
    assert.deepEqual(ingest.events.map((e) => e.type), ['stream.online', 'chat', 'chat', 'tip', 'stream.offline']);
    assert.deepEqual(ingest.raw, [['m1', CH], ['m2', CH], ['s1', CH]], 'the Chat overlay gets each message before it is normalised, not the skipped backlog (§13.10)');
    assert.deepEqual(ingest.events.filter((e) => e.type === 'chat').map((e) => [e.message, e.metadata.firstWords]), [['first!', true], ['second', false]]);
    assert.equal(ingest.events[3].amount, 2);
    assert.equal(ingest.events[0].dedupeKey, 'yt:online:bc1');
    const [rows] = await pool.query(`SELECT status, broadcast_id, ended_at FROM \`${T.prefix}youtube_live\` WHERE profile_id = ?`, [profile.id]);
    assert.deepEqual([rows[0].status, rows[0].broadcast_id, !!rows[0].ended_at], ['offline', 'bc1', true]);
    const st = svc.status(profile.id);
    assert.deepEqual([st.channels.length, st.channels[0].live, st.channels[0].messages, st.quota.limit], [1, false, 3, 10000]);

    // Live again: actions need the live chat; "not live" is said plainly.
    assert.deepEqual(await svc.sendChat({ profileId: profile.id, channelId: CH, text: 'hello' }), { ok: false, notLive: true, error: 'not live on YouTube (a YouTube chat exists only during a live broadcast)' });
    yt.broadcasts = [{ id: 'bc2', title: 'Round two', chatId: 'chat2', channelId: CH, startedAt: new Date(now).toISOString() }];
    ch.nextCheckAt = now;
    await svc.tick();
    assert.equal(ch.live, true);
    assert.deepEqual(await svc.sendChat({ profileId: profile.id, channelId: CH, text: 'hello YouTube' }), { ok: true });
    assert.deepEqual(yt.sent.at(-1), { chatId: 'chat2', text: 'hello YouTube' });
    assert.deepEqual(ingest.sent.at(-1), ['youtube', CH, 'hello YouTube'], 'echo guard told first');
    const chatEv = { platform: 'youtube', type: 'chat', channelId: CH, user: { id: FAN, name: '@MapleFan88', roles: [] }, metadata: { messageId: 'm9' } };
    assert.equal((await svc.deleteMessage(profile.id, chatEv)).status, 'ok');
    assert.deepEqual(yt.deleted, ['m9']);
    assert.equal((await svc.deleteMessage(profile.id, chatEv, { dryRun: true })).status, 'dry');
    assert.equal((await svc.moderate(profile.id, chatEv, { seconds: 300 })).status, 'ok');
    assert.deepEqual(yt.bans.at(-1), { chatId: 'chat2', user: FAN, seconds: 300 });
    assert.equal((await svc.moderate(profile.id, { ...chatEv, user: { id: CH, roles: ['broadcaster'] } }, {})).status, 'skipped');
    quota.markExhausted();
    assert.equal((await svc.sendChat({ profileId: profile.id, channelId: CH, text: 'x' })).ok, false, 'nothing is sent once the allowance is used up');
    assert.equal(svc.streamInfo({ profileId: profile.id, channelId: CH }).live, true);

    // A restart while live resumes from the saved row after checking the video.
    await svc.stop();
    const [saved] = await pool.query(`SELECT status, live_chat_id FROM \`${T.prefix}youtube_live\` WHERE profile_id = ?`, [profile.id]);
    assert.deepEqual([saved[0].status, saved[0].live_chat_id], ['live', 'chat2']);
    const yt2 = fakeYouTube();
    yt2.videos.set('bc2', { id: 'bc2', live: true, chatId: 'chat2', viewers: 31, title: 'Round two' });
    const ingest2 = fakeIngest();
    const svc2 = createYouTubeService({ db: pool, store: T.store, ingest: ingest2, api: yt2, auth, quota: createQuotaGuard({ dailyUnits: 10000, now: () => now }), now: () => now, sleep: quickSleep });
    await svc2.tick();
    const ch2 = svc2._channels.get(`${profile.id}:${CH}`);
    assert.deepEqual([ch2.live, ch2.chatId, ch2.viewers, ingest2.events.length], [true, 'chat2', 31, 0], 'resumed without a second "went live"');
    await svc2.stop();
});

// ── engine and actions ──────────────────────────────────────────────────────────────────────

test('engine: chat.send reaches YouTube through the wrapped io; "All" skips a YouTube channel that is not live; time-out and ban', async () => {
    // Its own channels: makeProfile's Twitch and Kick ids belong to the first profile (one profile per channel).
    const profile = await T.store.ensureProfile('yt-engine-owner', 'All Test');
    await T.store.linkChannel(profile.id, { platform: 'twitch', platformUserId: '900000777', login: 'alltest_tv', displayName: 'alltest_tv', verifiedVia: 'stream_bot_grant' });
    await T.store.linkChannel(profile.id, { platform: 'kick', platformUserId: '800000777', login: 'alltest', displayName: 'alltest', verifiedVia: 'stream_platform_accounts' });
    await T.store.linkChannel(profile.id, { platform: 'youtube', platformUserId: 'UCaLlTeSt000000000000001', login: 'alltest', displayName: 'All Test', verifiedVia: 'stream_platform_accounts' });
    const calls = [];
    const live = new Set();
    const svc = {
        async sendChat(m) { calls.push(['yt', m.text]); return live.has(m.channelId) ? { ok: true } : { ok: false, notLive: true, error: 'not live on YouTube' }; },
        async deleteMessage() { return { status: 'ok', detail: 'deleted' }; },
        async moderate(pid, ev, o) { calls.push(['mod', o.seconds]); return { status: o.dryRun ? 'dry' : 'ok', detail: 'done' }; },
        hint(pid) { calls.push(['hint', pid]); },
    };
    // The importer (mapper.js, imported above) registered chat.timeout and chat.ban first; they still find the service through
    // the one shared reference, which the running bot fills in (attachYouTube).
    assert.equal(registerYouTubeActions(actionsMod).length, 0, 'already registered by the importer');
    youtubeServiceRef.current = svc;
    const channels = await T.store.listChannels(profile.id);
    const box = {
        io: { channelsFor: async () => channels, sendChat: async (m) => { calls.push([m.platform, m.text]); return { ok: true }; }, streamAction: async () => ({ status: 'ok', detail: 'twitch' }) },
        feed: { publish: () => true },
    };
    wireYouTube(box);
    const engine = createEngine({ store: T.store, render: createRenderer({ variableStore: T.store.variableStore }), io: box.io, limiter: createLimiter({ now: () => Date.now() }), now: () => Date.now() });
    const ev = { platform: 'youtube', type: 'chat', channelId: 'UCaLlTeSt000000000000001', user: { id: FAN, login: 'maplefan88', name: '@MapleFan88', roles: [] }, message: '!hi', amount: null, metadata: { messageId: 'mm' }, occurredAt: new Date() };
    const auto = (actions) => ({ id: 9101, name: 'YT', enabled: true, trigger_type: 'chat', trigger_config: { platforms: ['youtube'], match: { mode: 'command', text: '!hi' } }, conditions: [], actions });
    let r = await engine.runAutomation(profile, auto([{ type: 'chat.send', platform: 'all', text: 'hello all' }]), ev, { source: 'event' });
    assert.equal(r.status, 'ok', JSON.stringify(r.steps));
    assert.match(r.steps[0].detail, /youtube\/alltest: not live on YouTube/);
    assert.deepEqual(calls.filter((c) => c[1] === 'hello all').map((c) => c[0]).sort(), ['kick', 'twitch', 'yt']);
    live.add('UCaLlTeSt000000000000001');
    r = await engine.runAutomation(profile, auto([{ type: 'chat.send', platform: 'event', text: 'hi {user.name}' }, { type: 'chat.delete' }, { type: 'chat.timeout', seconds: '600' }, { type: 'chat.ban' }]), ev, { source: 'event' });
    assert.equal(r.status, 'ok', JSON.stringify(r.steps));
    assert.deepEqual(calls.filter((c) => c[0] === 'yt').at(-1), ['yt', 'hi @MapleFan88']);
    assert.deepEqual(calls.filter((c) => c[0] === 'mod').map((c) => c[1]), [600, null]);
    const v = actionsMod.validateActions([{ type: 'chat.timeout', seconds: '7' }, { type: 'chat.send', platform: 'youtube', text: 'x' }]);
    assert.deepEqual([v.ok, v.value[0].seconds, v.value[1].platform], [true, '300', 'youtube']);
    assert.deepEqual(actionsMod.actionType('chat.timeout').platforms, ['youtube']);
    box.feed.publish(profile.id, { platform: 'twitch', type: 'stream.online' });
    box.feed.publish(profile.id, { platform: 'youtube', type: 'stream.online' });
    box.feed.publish(profile.id, { platform: 'studio', type: 'obs.stream_started' });
    assert.equal(calls.filter((c) => c[0] === 'hint').length, 2, 'Twitch going live and Studio starting the stream hint; YouTube itself does not');
    youtubeServiceRef.current = null;
    const off = await engine.runAutomation(profile, auto([{ type: 'chat.ban' }]), ev, { source: 'event' });
    assert.equal(off.steps[0].detail, 'YouTube is not set up on this server', 'switched off: said plainly');
});

// ── viewers ─────────────────────────────────────────────────────────────────────────────────

test('viewers: YouTube chatters, Super Chats and memberships on the viewer records', async () => {
    for (const sql of viewersDdl(T.prefix)) await pool.query(sql);
    const profile = await makeProfile(T.store);
    const vs = createViewerStore({ db: pool, prefix: T.prefix });
    const svc = createViewerService({ db: pool, store: T.store, vstore: vs });
    const ctx = { channelId: CH, broadcastId: 'b' };
    const send = (item) => svc.onEvent(profile.id, publicEvent(normaliseYouTubeMessage(item, ctx)));
    await send(msg('v1', 'textMessageEvent', { textMessageDetails: { messageText: 'hello' } }));
    await send(msg('v2', 'superChatEvent', { superChatDetails: { amountMicros: '3500000', currency: 'USD' } }));
    await send(msg('v3', 'newSponsorEvent', { newSponsorDetails: { memberLevelName: 'Leaf' } }));
    const row = await vs.byAccount(profile.id, 'youtube', FAN);
    assert.ok(row, 'a YouTube viewer record');
    assert.deepEqual([row.messages, row.tips, row.tipAmounts.USD, row.subs, row.login], [1, 1, 3.5, 1, 'maplefan88']);
});

// ── import ──────────────────────────────────────────────────────────────────────────────────

test('import: Streamer.bot YouTube triggers, sub-actions and a command that also answered on YouTube', () => {
    const files = new Map(Object.entries({
        'actions.json': { version: 24, actions: [
            { id: 'y1', name: 'Welcome first chatters', enabled: true, triggers: [{ id: 't1', type: 4016, enabled: true }], subActions: [{ id: 's1', type: 4001, text: 'Welcome %user%!', index: 0 }] },
            { id: 'y2', name: 'Super Chat thanks', enabled: true, triggers: [{ id: 't2', type: 4006, min: 5, enabled: true }], subActions: [{ id: 's2', type: 4001, text: 'Thank you %user%!', index: 0 }] },
            { id: 'y3', name: 'New member', enabled: true, triggers: [{ id: 't3', type: 4008, enabled: true }], subActions: [{ id: 's3', type: 4001, text: 'Welcome to the club', index: 0 }] },
            { id: 'y4', name: 'Spam guard', enabled: true, triggers: [{ id: 't4', type: 4003, enabled: true }], subActions: [{ id: 's4', type: 4009, duration: 280, index: 0 }, { id: 's5', type: 4008, index: 1 }] },
            { id: 'y5', name: 'Poll watcher', enabled: true, triggers: [{ id: 't5', type: 4028, enabled: true }], subActions: [{ id: 's6', type: 4001, text: 'Vote!', index: 0 }] },
            { id: 'y6', name: 'Socials', enabled: true, triggers: [{ id: 't6', type: 401, commandId: 'c1', enabled: true }], subActions: [{ id: 's7', type: 10, text: 'Find me at maplehollow.example', index: 0 }] },
        ] },
        'commands.json': { version: 7, commands: [{ id: 'c1', name: 'Socials', command: '!socials', enabled: true, mode: 0, location: 0, sources: 1 | 1024, permittedGroups: [] }] },
    }).map(([k, v]) => [k, Buffer.from(JSON.stringify(v))]));
    const b = parseStreamerbot({ files });
    const auto = (name) => b.automations.find((a) => a.name === name);
    assert.deepEqual(auto('Welcome first chatters').trigger, { type: 'chat', config: { platforms: ['youtube'], match: { mode: 'regex', text: '.', caseSensitive: false } }, conditions: [{ type: 'metadata', path: 'firstWords', op: 'eq', value: 'true' }] });
    assert.deepEqual(auto('Welcome first chatters').actions, [{ type: 'chat.send', platform: 'youtube', text: 'Welcome {user.name}!' }]);
    assert.deepEqual(auto('Super Chat thanks').trigger.conditions, [{ type: 'metadata', path: 'kind', op: 'eq', value: 'super_chat' }, { type: 'amount', min: 5, max: null }]);
    assert.equal(auto('Super Chat thanks').trigger.type, 'tip');
    assert.deepEqual([auto('New member').trigger.type, auto('New member').trigger.conditions[0].value], ['membership', 'new']);
    assert.deepEqual(auto('Spam guard').actions, [{ type: 'chat.timeout', seconds: '300' }, { type: 'chat.ban' }]);
    assert.ok(b.dropped.some((d) => d.name === 'Poll watcher' && d.gap === 'trigger.youtube_other'));
    assert.deepEqual(b.commands[0].platforms, ['twitch', 'youtube']);
    assert.equal(GAPS['trigger.youtube'].phase, 'done');
    assert.equal(INTEGRATIONS.youtube.have, true);

    const plan = buildPlan([b], { channels: [{ platform: 'twitch', platformUserId: '1', login: 'maple' }, { platform: 'youtube', platformUserId: CH, login: 'maplehollow' }],
        channelBots: [{ id: 11, platform: 'twitch', channelId: '1' }], builtins: new Set() });
    const item = (name) => plan.items.find((i) => i.name === name) || plan.items.find((i) => String(i.name || '').includes(name));
    for (const n of ['Welcome first chatters', 'Super Chat thanks', 'New member', 'Spam guard']) {
        assert.equal(item(n).target?.system, 'automation', `${n}: ${JSON.stringify(item(n).why)}`);
        assert.equal(item(n).target.draft.enabled, false, 'imported switched off');
    }
    const socials = item('!socials');
    assert.equal(socials.target.system, 'automation', 'a command that also answered on YouTube is an automation (no channel bot there)');
    assert.deepEqual(socials.target.draft.trigger_config.platforms, ['twitch', 'youtube']);
    assert.ok(socials.why.some((w) => /YouTube/.test(w)));
});

// ── privacy ─────────────────────────────────────────────────────────────────────────────────

test('privacy: the YouTube tables export and delete with the profile; the sign-in row is removed; the migration and retention', async () => {
    const profile = await makeProfile(T.store);
    await pool.query(`INSERT INTO \`${T.prefix}youtube_live\` (profile_id, channel_id, broadcast_id, live_chat_id, page_token, status) VALUES (?, ?, 'b9', 'c9', 'p9', 'offline')`, [profile.id, CH]);
    const q = quotaTable(pool, T.prefix);
    await q.add('2026-11-20', [{ profileId: profile.id, units: 55, calls: 11 }]);
    await q.add('2026-11-20', [{ profileId: profile.id, units: 5, calls: 1 }]);
    assert.deepEqual((await q.load('2026-11-20')).find((r) => Number(r.profileId) === profile.id), { profileId: profile.id, units: 60, calls: 12 });
    const out = await youtubeExport(pool, profile.id, T.prefix);
    assert.deepEqual([out.youtube_live[0].broadcast_id, out.youtube_live[0].page_token, out.youtube_quota[0].units], ['b9', undefined, 60], 'no page token or chat id in the export');
    assert.deepEqual(await youtubeDelete(pool, profile.id, T.prefix), { [`${T.prefix}youtube_live`]: 1, [`${T.prefix}youtube_quota`]: 1 });
    // The sign-in row (a throwaway copy of stream_platform_accounts): kept while multicast uses it, else revoked and removed.
    const acc = `${T.prefix}accounts`;
    const dest = `${T.prefix}destinations`;
    await pool.query(`CREATE TABLE \`${acc}\` (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, owner_discord_id VARCHAR(32), platform VARCHAR(40), access_token TEXT, refresh_token TEXT)`);
    await pool.query(`CREATE TABLE \`${dest}\` (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, account_id BIGINT UNSIGNED)`);
    try {
        const [ins] = await pool.query(`INSERT INTO \`${acc}\` (owner_discord_id, platform, access_token, refresh_token) VALUES ('555', 'youtube', ?, ?)`, [enc('AT'), enc('RT-9')]);
        await pool.query(`INSERT INTO \`${dest}\` (account_id) VALUES (?)`, [ins.insertId]);
        const revoked = [];
        const fetchImpl = async (url, init) => { revoked.push(String(init.body)); return new Response(null, { status: 200 }); };
        assert.deepEqual(await youtubeAccountDelete(pool, '555', { onlyUnused: true, revoke: true, encryption: fakeEncryption, fetchImpl, table: acc, destinations: dest }), {}, 'multicast still uses it');
        await pool.query(`DELETE FROM \`${dest}\``);
        assert.deepEqual(await youtubeAccountDelete(pool, '555', { onlyUnused: true, revoke: true, encryption: fakeEncryption, fetchImpl, table: acc, destinations: dest }), { [acc]: 1 });
        assert.deepEqual(revoked, ['token=RT-9']);
    } finally {
        await pool.query(`DROP TABLE IF EXISTS \`${acc}\``);
        await pool.query(`DROP TABLE IF EXISTS \`${dest}\``);
    }
    assert.deepEqual(RETENTION_ROWS.map((r) => [r[0], r[1], r[2]]), [['stream_bot_youtube_quota', 'updated_at', 30]]);
    const mig = fs.readFileSync(path.join(ROOT, 'migrations/470_stream_bot_youtube.js'), 'utf8');
    assert.match(mig, /CREATE TABLE IF NOT EXISTS/);
    assert.match(mig, /INSERT IGNORE INTO data_retention_policy/);
    assert.match(mig, /if \(!\(await tableExists\(db, 'stream_bot_profiles'\)\)\) return;/, 'does nothing without the stream bot');
});

test('/privacy/viewer: the YouTube sign-in asks youtube.readonly, reads the channel, revokes the token; sessions accept channel ids', async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        if (String(url).startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'VIEWER-AT', expires_in: 3599 }), { status: 200 });
        if (String(url).startsWith('https://www.googleapis.com/youtube/v3/channels')) return new Response(JSON.stringify({ items: [{ id: FAN, snippet: { title: 'Maple Fan', customUrl: '@MapleFan88' } }] }), { status: 200 });
        return new Response(null, { status: 200 });
    };
    const si = createViewerSignIn({ creds: { youtube: { clientId: 'gid', clientSecret: 'gsec' } }, baseUrl: 'https://example.test', fetchImpl });
    assert.equal(si.configured('youtube'), true);
    assert.equal(createViewerSignIn({ creds: {}, baseUrl: 'https://example.test' }).configured('youtube'), false);
    const s = si.start('youtube');
    const u = new URL(s.url);
    assert.deepEqual([u.origin + u.pathname, u.searchParams.get('scope'), u.searchParams.get('prompt'), u.searchParams.get('code_challenge_method'), u.searchParams.get('redirect_uri')],
        ['https://accounts.google.com/o/oauth2/v2/auth', YT_SCOPE.readonly, 'select_account', 'S256', 'https://example.test/privacy/viewer/youtube/callback']);
    const who = await si.finish('youtube', { code: 'abc', state: s.state }, { provider: 'youtube', state: s.state, verifier: s.verifier, at: Date.now() });
    assert.deepEqual(who, { platform: 'youtube', id: FAN, login: 'maplefan88', name: 'Maple Fan' });
    assert.match(String(calls[0].init.body), /code_verifier=/);
    assert.equal(calls[1].init.headers.Authorization, 'Bearer VIEWER-AT');
    assert.equal(String(calls[2].url), 'https://oauth2.googleapis.com/revoke');
    assert.equal(String(calls[2].init.body), 'token=VIEWER-AT');
    const now = Date.now();
    const sess = { privacyViewer: { accounts: [{ platform: 'youtube', id: FAN, at: now }, { platform: 'youtube', id: '12345', at: now }, { platform: 'twitch', id: '12345', at: now }] } };
    assert.deepEqual(sessionAccounts(sess, now).map((a) => `${a.platform}:${a.id}`), [`youtube:${FAN}`, 'twitch:12345']);
});

// ── pages ───────────────────────────────────────────────────────────────────────────────────

test('Connections page: YouTube on (live state, allowance, check button) and off (why), escaped', async () => {
    const view = path.join(ROOT, 'dashboard/views/stream-bot/connections.ejs');
    const base = {
        user: { id: '1', username: 'maple' }, active: 'connections', pageTitle: 'Connections', profile: { id: 7, displayName: 'Maple' }, notice: null, linkable: [], grant: null, reapprove: [],
        scopes: [], tipSources: [], tipOptions: { kofi: [], fourthwall: [], throne: null, bmac: false }, botSettings: { storeChat: false, webhookAllowHosts: [] }, csrfToken: 't',
        channels: [{ id: 3, platform: 'youtube', platformLabel: 'YouTube', login: 'maplehollow', displayName: 'Maple <Hollow>', channelId: CH, verifiedVia: 'stream_platform_accounts', linkedAt: new Date(T0).toISOString(),
            health: { ok: true, youtube: { signIn: 'ok', scopes: [YT_SCOPE.forceSsl] } } }],
    };
    const status = { channels: [{ channelId: CH, live: false, title: '<script>x</script>', lastCheckAt: new Date(T0).toISOString(), lastMessageAt: null, error: 'Live chat is turned off <b>', transport: null }],
        quota: { used: 3420, limit: 10000, share: 0.342, level: 'normal', explanation: 'Chat is read continuously.', resetAt: new Date(T0 + 3600_000).toISOString(), profileUnits: 3420 } };
    const on = await ejs.renderFile(view, { ...base, youtube: youtubePanel({ config: { enabled: true }, service: { status: () => status } }, 7) }, { async: false, views: [path.join(ROOT, 'dashboard/views')] });
    assert.match(on, /YouTube sign-in<\/dt><dd>Working/);
    assert.match(on, /data-youtube-check/);
    assert.match(on, /34% of the 10,000 units/);
    assert.match(on, /href="\/stream\/connect\/youtube\?for=bot">Sign in with another YouTube channel/);
    assert.ok(on.includes('Maple &lt;Hollow&gt;') && on.includes('Live chat is turned off &lt;b&gt;') && !on.includes('<b>'), 'escaped');
    const off = await ejs.renderFile(view, { ...base, youtube: youtubePanel(null, 7) }, { async: false, views: [path.join(ROOT, 'dashboard/views')] });
    assert.ok(off.includes(DISABLED_TEXT.no_client));
    assert.match(off, /Not available yet/);
    assert.doesNotMatch(off, /data-youtube-check|href="\/stream\/connect\/youtube/);
});
