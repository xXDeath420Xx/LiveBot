import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../utils/db.js';
import { makeTables, makeProfile } from './fixtures/stream-bot-tables.js';
import { createGrantAuth, GrantError } from '../core/stream-bot/twitch-auth.js';
import { createHelix } from '../core/stream-bot/helix.js';
import { createKickApi } from '../core/stream-bot/kick-api.js';
import { createStreamActions, targetChannels } from '../core/stream-bot/stream-actions.js';
import { createStreamInfo, formatUptime, streamValues, pickInfoChannel } from '../core/stream-bot/stream-info.js';
import { observeVariables, variableChangedEvent, COUNTER_MAX_DEPTH } from '../core/stream-bot/counters.js';
import { createEngine } from '../core/stream-bot/engine.js';
import { createRenderer, templateWarnings } from '../core/stream-bot/render.js';
import { createLimiter, triggerMatches, validateTrigger, checkConditions } from '../core/stream-bot/conditions.js';
import { validateActions, countSteps, actionType, ACTION_TYPES } from '../core/stream-bot/actions.js';
import { createIngest } from '../core/stream-bot/ingest.js';
import { createFeed } from '../core/stream-bot/feed.js';
import { createStudioServices } from '../core/stream-bot/studio.js';
import { normaliseTwitch, sampleEvent, describeEvent, eventType } from '../core/stream-bot/events.js';
import { STREAM_BOT_SCOPES, FORBIDDEN_SCOPES, reapproveNeeded, coverage } from '../core/stream-bot/scopes.js';

/*
 * The stream bot gaps build (design §7): the Stream bot grant's token refresh, the Helix and Kick calls behind the
 * stream actions, the actions themselves (dry run, outputs for later steps, Twitch-only), If steps and arguments,
 * {stream.*}, Power-up / Counter changed / Studio connected triggers and the counter loop guard. Twitch and Kick are
 * fake fetches: nothing here talks to a real channel. Throwaway tables (sbtg…_) for the grant and the engine.
 */

let T, store, profile;
const clock = { t: Date.parse('2026-11-19T12:00:00Z') };
const now = () => clock.t;

test.before(async () => {
    T = await makeTables(pool, 'g');
    store = T.store;
    profile = await makeProfile(store);
});
test.after(async () => {
    await T.drop();
    await pool.end().catch(() => {});
});

/** A fake fetch: routes 'METHOD path' (path without query) to a handler; records every call. */
function fakeFetch(routes) {
    const calls = [];
    const fn = async (url, opts = {}) => {
        const u = new URL(url);
        const key = `${opts.method || 'GET'} ${u.origin}${u.pathname}`;
        const call = { key, url: u, opts, body: opts.body ? (String(opts.headers?.['Content-Type'] || '').includes('json') ? JSON.parse(opts.body) : String(opts.body)) : null };
        calls.push(call);
        const h = routes[key];
        const r = h ? await h(call, calls) : { status: 404, body: { message: `no route ${key}` } };
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => (r.body === undefined ? null : r.body) };
    };
    fn.calls = calls;
    return fn;
}

const TOKEN_URL = 'POST https://id.twitch.tv/oauth2/token';
const H = (p) => `https://api.twitch.tv/helix${p}`;

async function grant({ expiresInMs = 4 * 3600e3, scopes = STREAM_BOT_SCOPES.filter((s) => s !== 'moderator:manage:chat_messages'), access = 'at-old', refresh = 'rt-old' } = {}) {
    await store.saveTwitchGrant(profile.id, { twitchUserId: '900000001', twitchLogin: 'maplehollow_tv', accessToken: access, refreshToken: refresh, expiresAt: new Date(Date.now() + expiresInMs), scopes: scopes.join(' ') });
}

// ── token refresh ───────────────────────────────────────────────────────────────────────────

test('the grant token is refreshed before use, both tokens rotate, and a fresh one is not refreshed again', async () => {
    await grant({ expiresInMs: 5 * 60e3 });
    const logs = [];
    const logger = { info: (...a) => logs.push(JSON.stringify(a)), warn: (...a) => logs.push(JSON.stringify(a)), debug: () => {} };
    const fetchImpl = fakeFetch({ [TOKEN_URL]: () => ({ status: 200, body: { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 14000, scope: STREAM_BOT_SCOPES } }) });
    const auth = createGrantAuth({ store, fetchImpl, clientId: 'cid', clientSecret: 'csecret', logger });
    const [a, b] = await Promise.all([auth.token(profile.id), auth.token(profile.id)]);
    assert.equal(a.token, 'at-new'); assert.equal(b.token, 'at-new');
    assert.equal(fetchImpl.calls.length, 1, 'concurrent callers share one refresh');
    const sent = new URLSearchParams(fetchImpl.calls[0].body);
    assert.deepEqual([sent.get('grant_type'), sent.get('refresh_token')], ['refresh_token', 'rt-old']);
    const g = await store.getTwitchGrantSecrets(profile.id);
    assert.deepEqual([g.accessToken, g.refreshToken, g.status], ['at-new', 'rt-new', 'active']);
    assert.ok(new Date(g.expiresAt).getTime() > Date.now() + 3 * 3600e3);
    assert.ok(g.scopes.includes('moderator:manage:chat_messages'), 'scopes follow what Twitch says the token has');
    await auth.token(profile.id);
    assert.equal(fetchImpl.calls.length, 1, 'a fresh token is used as is');
    for (const line of logs) for (const secret of ['at-old', 'rt-old', 'at-new', 'rt-new', 'csecret']) assert.ok(!line.includes(secret), 'no token or secret in the log');
});

test('a refused refresh token marks the grant needs_reauth; later calls fail fast; a Twitch outage keeps the current token', async () => {
    await grant({ expiresInMs: 60e3 });
    const refused = fakeFetch({ [TOKEN_URL]: () => ({ status: 400, body: { status: 400, message: 'Invalid refresh token' } }) });
    const auth = createGrantAuth({ store, fetchImpl: refused });
    await assert.rejects(auth.token(profile.id), (e) => e instanceof GrantError && e.code === 'needs_reauth' && !/rt-old|at-old/.test(e.message));
    assert.equal((await store.getTwitchGrant(profile.id)).status, 'needs_reauth');
    await assert.rejects(auth.token(profile.id), (e) => e.code === 'needs_reauth');
    assert.equal(refused.calls.length, 1, 'no second refresh attempt');

    await grant({ expiresInMs: 5 * 60e3 });   // reconnect: active again
    const down = fakeFetch({ [TOKEN_URL]: () => ({ status: 503, body: { message: 'unavailable' } }) });
    const t = await createGrantAuth({ store, fetchImpl: down }).token(profile.id);
    assert.equal(t.token, 'at-old', 'still valid: used while Twitch is down');
    assert.equal((await store.getTwitchGrant(profile.id)).status, 'active');
});

test('a grant without a needed scope says what to re-approve; no grant says connect', async () => {
    await grant();
    const auth = createGrantAuth({ store, fetchImpl: fakeFetch({}) });
    await assert.rejects(auth.token(profile.id, { need: ['moderator:manage:chat_messages'] }), (e) => e.code === 'missing_scope' && /Re-approve/.test(e.message));
    const ok = await auth.token(profile.id, { need: ['channel:read:polls'] });   // manage satisfies read
    assert.equal(ok.userId, '900000001');
    await assert.rejects(auth.token(999999), (e) => e.code === 'no_grant');
});

// ── Helix ───────────────────────────────────────────────────────────────────────────────────

function helixWith(routes, opts = {}) {
    const fetchImpl = fakeFetch(routes);
    const auth = opts.auth || { token: async (pid, o = {}) => ({ token: o.force ? 'tok-2' : 'tok-1', userId: '900000001', login: 'maplehollow_tv', scopes: STREAM_BOT_SCOPES }) };
    return { helix: createHelix({ auth, fetchImpl, clientId: 'cid' }), fetchImpl };
}

test('Helix: clip, title, category by name, ad, raid, announcement, shoutout, chat delete and clear', async () => {
    const { helix, fetchImpl } = helixWith({
        [`POST ${H('/clips')}`]: () => ({ status: 202, body: { data: [{ id: 'BraveClip', edit_url: 'https://clips.twitch.tv/BraveClip/edit' }] } }),
        [`PATCH ${H('/channels')}`]: () => ({ status: 204 }),
        [`GET ${H('/games')}`]: (c) => ({ status: 200, body: { data: c.url.searchParams.get('name') === 'Just Chatting' ? [{ id: '509658', name: 'Just Chatting' }] : [] } }),
        [`GET ${H('/search/categories')}`]: () => ({ status: 200, body: { data: [{ id: '1', name: 'Hades II' }, { id: '2', name: 'Hades' }] } }),
        [`POST ${H('/channels/commercial')}`]: () => ({ status: 200, body: { data: [{ length: 60, retry_after: 480, message: '' }] } }),
        [`GET ${H('/users')}`]: (c) => ({ status: 200, body: { data: [{ id: '700', login: c.url.searchParams.get('login'), display_name: 'Bramble' }] } }),
        [`POST ${H('/raids')}`]: () => ({ status: 200, body: { data: [{}] } }),
        [`POST ${H('/chat/announcements')}`]: () => ({ status: 204 }),
        [`POST ${H('/chat/shoutouts')}`]: () => ({ status: 204 }),
        [`DELETE ${H('/moderation/chat')}`]: () => ({ status: 204 }),
    });
    const clip = await helix.createClip(1);
    assert.deepEqual(clip, { id: 'BraveClip', url: 'https://clips.twitch.tv/BraveClip', editUrl: 'https://clips.twitch.tv/BraveClip/edit' });
    const first = fetchImpl.calls[0];
    assert.equal(first.url.searchParams.get('broadcaster_id'), '900000001');
    assert.equal(first.opts.headers['Client-Id'], 'cid'); assert.equal(first.opts.headers.Authorization, 'Bearer tok-1');

    await helix.setTitle(1, 'New title');
    assert.deepEqual(fetchImpl.calls.at(-1).body, { title: 'New title' });
    assert.deepEqual(await helix.setCategory(1, 'Just Chatting'), { id: '509658', name: 'Just Chatting' });
    assert.deepEqual(fetchImpl.calls.at(-1).body, { game_id: '509658' });
    assert.deepEqual(await helix.setCategory(1, 'hades'), { id: '2', name: 'Hades' }, 'search: the exact name wins over the first hit');

    assert.deepEqual(await helix.startAd(1, 60), { length: 60, retryAfter: 480, message: '' });
    assert.deepEqual(fetchImpl.calls.at(-1).body, { broadcaster_id: '900000001', length: 60 });
    const raid = await helix.startRaid(1, '@BrambleByte');
    assert.equal(raid.id, '700');
    assert.deepEqual([fetchImpl.calls.at(-1).url.searchParams.get('from_broadcaster_id'), fetchImpl.calls.at(-1).url.searchParams.get('to_broadcaster_id')], ['900000001', '700']);
    await assert.rejects(helix.startRaid(1, 'not a name!'), /not a Twitch user name/);

    await helix.announce(1, { message: 'Hydrate', color: 'purple' });
    assert.deepEqual(fetchImpl.calls.at(-1).body, { message: 'Hydrate', color: 'purple' });
    assert.equal(fetchImpl.calls.at(-1).url.searchParams.get('moderator_id'), '900000001');
    await helix.shoutout(1, 'bramble');
    assert.equal(fetchImpl.calls.at(-1).url.searchParams.get('to_broadcaster_id'), '700');
    await helix.deleteChat(1, 'msg-1');
    assert.equal(fetchImpl.calls.at(-1).url.searchParams.get('message_id'), 'msg-1');
    await helix.deleteChat(1);
    assert.equal(fetchImpl.calls.at(-1).url.searchParams.has('message_id'), false, 'no message id clears all of chat');
});

test('Helix: polls and predictions end and resolve the running one; a 401 refreshes once; errors carry Twitch\'s message', async () => {
    let polls = 0;
    const { helix, fetchImpl } = helixWith({
        [`POST ${H('/polls')}`]: (c) => ({ status: 200, body: { data: [{ id: 'p1', title: c.body.title }] } }),
        [`GET ${H('/polls')}`]: () => ({ status: 200, body: { data: [{ id: 'p1', title: 'Next game?', status: polls++ ? 'TERMINATED' : 'ACTIVE' }] } }),
        [`PATCH ${H('/polls')}`]: () => ({ status: 200, body: { data: [{}] } }),
        [`POST ${H('/predictions')}`]: () => ({ status: 200, body: { data: [{ id: 'pr1', title: 'Boss?' }] } }),
        [`GET ${H('/predictions')}`]: () => ({ status: 200, body: { data: [{ id: 'pr1', title: 'Boss?', status: 'LOCKED', outcomes: [{ id: 'o1', title: 'Yes' }, { id: 'o2', title: 'No' }] }] } }),
        [`PATCH ${H('/predictions')}`]: () => ({ status: 200, body: { data: [{}] } }),
        [`GET ${H('/streams')}`]: (c) => (c.opts.headers.Authorization === 'Bearer tok-1' ? { status: 401, body: { message: 'Invalid OAuth token' } } : { status: 200, body: { data: [] } }),
        [`GET ${H('/channels')}`]: () => ({ status: 200, body: { data: [{ title: 'Chill', game_name: 'Hades' }] } }),
        [`POST ${H('/clips')}`]: () => ({ status: 404, body: { message: 'Clipping is not possible for an offline channel.' } }),
    });
    assert.equal((await helix.createPoll(1, { title: 'Next game?', choices: ['A', 'B'], duration: 60 })).id, 'p1');
    assert.deepEqual(fetchImpl.calls.at(-1).body, { broadcaster_id: '900000001', title: 'Next game?', choices: [{ title: 'A' }, { title: 'B' }], duration: 60 });
    await helix.endPoll(1, { show: true });
    assert.deepEqual(fetchImpl.calls.at(-1).body, { broadcaster_id: '900000001', id: 'p1', status: 'TERMINATED' });
    await assert.rejects(helix.endPoll(1), /no poll running/);

    await helix.createPrediction(1, { title: 'Boss?', outcomes: ['Yes', 'No'], window: 120 });
    assert.equal(fetchImpl.calls.at(-1).body.prediction_window, 120);
    await helix.endPrediction(1, { action: 'resolve', winner: 'no' });
    assert.deepEqual(fetchImpl.calls.at(-1).body, { broadcaster_id: '900000001', id: 'pr1', status: 'RESOLVED', winning_outcome_id: 'o2' });
    await assert.rejects(helix.endPrediction(1, { action: 'resolve', winner: 'Maybe' }), /No outcome called "Maybe"/);
    assert.equal((await helix.endPrediction(1, { action: 'lock' })).already, true);

    const info = await helix.streamInfo(1);
    assert.deepEqual(info, { live: false, title: 'Chill', category: 'Hades', viewers: 0, startedAt: null });
    const streams = fetchImpl.calls.filter((c) => c.key.endsWith('/streams'));
    assert.deepEqual(streams.map((c) => c.opts.headers.Authorization), ['Bearer tok-1', 'Bearer tok-2'], 'one retry with a refreshed token');
    await assert.rejects(helix.createClip(1), (e) => e.status === 404 && /offline channel/.test(e.message));
});

// ── Kick ────────────────────────────────────────────────────────────────────────────────────

test('Kick: title and category need channel:write, delete a message, read stream info with the app token', async () => {
    const K = (p) => `https://api.kick.com/public/v1${p}`;
    const fetchImpl = fakeFetch({
        [`PATCH ${K('/channels')}`]: () => ({ status: 204 }),
        [`GET ${K('/categories')}`]: () => ({ status: 200, body: { data: [{ id: 15, name: 'Just Chatting' }] } }),
        [`DELETE ${K('/chat/0b6c1d6e-0000-4000-8000-000000000001')}`]: () => ({ status: 204 }),
        [`GET ${K('/channels')}`]: () => ({ status: 200, body: { data: [{ stream_title: 'Hi', category: { name: 'Slots' }, stream: { is_live: true, viewer_count: 12, start_time: '2026-11-19T10:00:00Z' } }] } }),
    });
    let scopes = ['chat:write', 'moderation:chat_message:manage'];
    const kick = createKickApi({ resolveChannel: async () => ({ broadcasterId: '800000001', token: 'kick-tok', scopes }), appToken: async () => 'app-tok', fetchImpl });
    await assert.rejects(kick.setTitle('800000001', 'New'), (e) => e.code === 'missing_scope' && /channel:write/.test(e.message));
    scopes = [...scopes, 'channel:write'];
    await kick.setTitle('800000001', 'New');
    assert.deepEqual(fetchImpl.calls.at(-1).body, { stream_title: 'New' });
    assert.deepEqual(await kick.setCategory('800000001', 'just chatting'), { id: 15, name: 'Just Chatting' });
    assert.deepEqual(fetchImpl.calls.at(-1).body, { category_id: 15 });
    await kick.deleteMessage('800000001', '0b6c1d6e-0000-4000-8000-000000000001');
    assert.equal(fetchImpl.calls.at(-1).opts.headers.Authorization, 'Bearer kick-tok');
    const info = await kick.streamInfo('800000001');
    assert.deepEqual(info, { live: true, title: 'Hi', category: 'Slots', viewers: 12, startedAt: '2026-11-19T10:00:00Z' });
    assert.equal(fetchImpl.calls.at(-1).opts.headers.Authorization, 'Bearer app-tok');
});

// ── the actions ─────────────────────────────────────────────────────────────────────────────

function fakeClients() {
    const did = [];
    const rec = (name) => async (...a) => { did.push([name, ...a]); return {}; };
    const helix = {
        createClip: async () => { did.push(['clip']); return { id: 'C1', url: 'https://clips.twitch.tv/C1' }; },
        setTitle: rec('twitch.title'), setCategory: async (p, n) => { did.push(['twitch.category', n]); return { id: '1', name: 'Just Chatting' }; },
        startAd: async (p, l) => { did.push(['ad', l]); return { length: l, retryAfter: 480 }; }, startRaid: async (p, l) => { did.push(['raid', l]); return { id: '7', name: l }; },
        createPoll: async (p, o) => { did.push(['poll', o]); return { id: 'P1', title: o.title }; }, endPoll: async () => ({ id: 'P1', title: 'Q' }),
        createPrediction: async (p, o) => { did.push(['prediction', o]); return { id: 'PR1', title: o.title }; }, endPrediction: async (p, o) => { did.push(['pred.end', o]); return { id: 'PR1', title: 'Q' }; },
        announce: rec('announce'), shoutout: async (p, l) => { did.push(['shoutout', l]); return { name: l }; }, deleteChat: rec('twitch.delete'),
    };
    const kick = { setTitle: rec('kick.title'), setCategory: async (c, n) => { did.push(['kick.category', n]); return { id: 15, name: n }; }, deleteMessage: rec('kick.delete') };
    const said = [];
    const actions = createStreamActions({ helix, kick, sendChat: async (m) => { said.push(m); return { ok: true }; }, shoutoutText: async (t) => `📣 Big shoutout to @${t}!` });
    return { actions, did, said };
}

const channels = [{ platform: 'twitch', platform_user_id: '900000001', login: 'maplehollow_tv' }, { platform: 'kick', platform_user_id: '800000001', login: 'maplehollow' }];
const ctxOf = (ev, extra = {}) => ({ profile: { id: 1 }, ev, render: async (t) => String(t ?? '').replace('{arg1}', 'bramble'), dryRun: false, channels, ...extra });

test('stream actions: a dry run sends nothing; clip outputs; title on both platforms; Kick shoutout is the !so line; delete needs a chat message', async () => {
    const { actions, did, said } = fakeClients();
    const chatEv = { platform: 'kick', type: 'chat', channelId: '800000001', metadata: { messageId: 'k-1' } };
    const dry = await actions.run({ type: 'stream.clip' }, ctxOf(chatEv, { dryRun: true }));
    assert.equal(dry.status, 'dry'); assert.equal(did.length, 0);
    const clip = await actions.run({ type: 'stream.clip' }, ctxOf(chatEv));
    assert.deepEqual([clip.status, clip.vars['clip.url']], ['ok', 'https://clips.twitch.tv/C1']);
    const title = await actions.run({ type: 'stream.title', platform: 'all', title: 'Speedruns' }, ctxOf(chatEv));
    assert.equal(title.status, 'ok');
    assert.deepEqual(did.filter((d) => /title/.test(d[0])).map((d) => d[0]), ['twitch.title', 'kick.title']);
    const so = await actions.run({ type: 'stream.shoutout', platform: 'event', target: '{arg1}' }, ctxOf(chatEv));
    assert.equal(so.status, 'ok');
    assert.deepEqual([said[0].platform, said[0].channelId, said[0].text], ['kick', '800000001', '📣 Big shoutout to @bramble!']);
    const del = await actions.run({ type: 'chat.delete' }, ctxOf(chatEv));
    assert.equal(del.status, 'ok'); assert.deepEqual(did.at(-1), ['kick.delete', '800000001', 'k-1']);
    const notChat = await actions.run({ type: 'chat.delete' }, ctxOf({ platform: 'twitch', type: 'follow', metadata: {} }));
    assert.equal(notChat.status, 'skipped');
    const poll = await actions.run({ type: 'stream.poll', title: 'Next?', choices: 'A\n\nB\nC', duration: 60 }, ctxOf(chatEv));
    assert.deepEqual([poll.status, poll.vars['poll.id']], ['ok', 'P1']);
    assert.deepEqual(did.find((d) => d[0] === 'poll')[1].choices, ['A', 'B', 'C']);
    assert.equal((await actions.run({ type: 'stream.prediction_end', action: 'resolve', winner: '' }, ctxOf(chatEv))).status, 'skipped');
    const failing = createStreamActions({ helix: { createClip: async () => { throw new GrantError('missing_scope', 'The Stream bot grant does not include clips:edit.'); } }, kick: {}, sendChat: async () => ({ ok: true }) });
    const f = await failing.run({ type: 'stream.clip' }, ctxOf(chatEv));
    assert.deepEqual([f.status, f.detail], ['failed', 'The Stream bot grant does not include clips:edit.']);
    assert.deepEqual(targetChannels('event', { platform: 'test' }, channels), [], 'a test event names no platform');
});

test('the catalogue marks Twitch-only actions, and validation catches bad polls, ifs and arguments', () => {
    for (const t of ['stream.clip', 'stream.ad', 'stream.raid', 'stream.poll', 'stream.prediction', 'stream.announce', 'chat.clear']) assert.deepEqual(actionType(t).platforms, ['twitch'], t);
    for (const t of ['stream.title', 'stream.category', 'stream.shoutout', 'chat.delete']) assert.deepEqual(actionType(t).platforms, ['twitch', 'kick'], t);
    assert.ok(ACTION_TYPES.filter((a) => a.executor === 'stream').every((a) => a.target === 'server'));
    const bad = validateActions([
        { type: 'stream.poll', title: 'Q', choices: 'only one', duration: 5 },
        { type: 'args.set', name: 'Bad Name!', value: 'x' },
        { type: 'if', check: { type: 'cooldown', seconds: 5 }, then: [], else: [] },
        { type: 'stream.prediction_end', action: 'resolve', winner: '' },
    ]);
    assert.ok(bad.errors.some((e) => /2 to 5 choices/.test(e)));
    assert.ok(bad.errors.some((e) => /15 to 1800 seconds/.test(e)));
    assert.ok(bad.errors.some((e) => /argument name/.test(e)));
    assert.ok(bad.errors.some((e) => /pick what to check/.test(e)));
    assert.ok(bad.errors.some((e) => /winning outcome/.test(e)));
    const nested = [{ type: 'if', check: { type: 'role', roles: ['moderator'] }, then: [{ type: 'chat.clear' }, { type: 'random', branches: [{ actions: [{ type: 'stream.clip' }] }, { actions: [] }] }], else: [{ type: 'chat.delete' }] }];
    assert.equal(countSteps(nested), 5);
    assert.deepEqual(validateActions(nested).errors, []);
    const deep = { type: 'if', check: { type: 'role', roles: ['vip'] }, then: [{ type: 'chat.clear' }], else: [] };
    assert.ok(validateActions([{ ...deep, then: [{ ...deep, then: [{ ...deep, then: [{ ...deep }] }] }] }]).errors.some((e) => /nested at most 3 deep/.test(e)));
});

// ── engine: If, arguments, outputs, {stream.*} ──────────────────────────────────────────────

function engineWith({ streamAction, streamInfo } = {}) {
    const said = [];
    const io = {
        channelsFor: (id) => store.listChannels(id),
        sendChat: async (m) => { said.push(m); return { ok: true }; },
        postDiscord: async () => ({ ok: true }), postWebhook: async () => ({ status: 204 }), dispatch: async () => ({ id: 'd', status: 'queued' }),
        streamAction, streamInfo,
    };
    const render = createRenderer({ variableStore: store.variableStore });
    return { engine: createEngine({ store, render, io, now, sleep: async () => {}, limiter: createLimiter({ now }) }), said };
}

async function automation(a) {
    const id = await store.createAutomation(profile.id, { enabled: true, trigger_config: {}, conditions: [], ...a });
    return store.getAutomation(profile.id, id);
}

test('If steps branch on an event detail (one of a list), arguments and clip links reach later steps', async () => {
    const { engine, said } = engineWith({ streamAction: async (step) => ({ status: 'ok', detail: 'clip made', vars: { 'clip.url': 'https://clips.twitch.tv/C9', 'clip.id': 'C9' } }) });
    const a = await automation({
        name: 'Scene check', trigger_type: 'chat', trigger_config: { match: { mode: 'command', text: 'scene' } },
        actions: [
            { type: 'args.set', name: 'mood', value: '{arg1}' },
            { type: 'if', check: { type: 'metadata', path: 'args.mood', op: 'in', value: 'Hype | GG' },
                then: [{ type: 'stream.clip' }, { type: 'chat.send', platform: 'event', text: 'Clipped: {clip.url} ({args.mood})' }],
                else: [{ type: 'chat.send', platform: 'event', text: 'No clip for {args.mood}{args.unset}' }] },
        ],
    });
    const chat = (text) => normaliseTwitch('channel.chat.message', { broadcaster_user_id: '900000001', chatter_user_id: '5', chatter_user_login: 'juniper', chatter_user_name: 'Juniper', message_id: `m${Math.random()}`, message: { text }, badges: [] });
    const [r1] = await engine.handleEvent(profile, chat('!scene gg'), null);
    assert.equal(r1.status, 'ok');
    assert.equal(said.at(-1).text, 'Clipped: https://clips.twitch.tv/C9 (gg)');
    const run = await store.getRun(profile.id, r1.runId);
    assert.deepEqual(run.steps.map((s) => [s.at, s.type]), [['1', 'args.set'], ['2', 'if'], ['2.1.1', 'stream.clip'], ['2.1.2', 'chat.send']]);
    const [r2] = await engine.handleEvent(profile, chat('!scene sad'), null);
    assert.equal(r2.status, 'ok');
    assert.equal(said.at(-1).text, 'No clip for sad', 'an unset argument renders empty');
    await store.deleteAutomation(profile.id, a.id);
});

test('{stream.*} is read only when a message uses it; stream actions without the executor fail clearly', async () => {
    let reads = 0;
    const { engine, said } = engineWith({ streamInfo: async () => { reads++; return { live: true, title: 'Boss rush', category: 'Hades', viewers: 42, startedAt: new Date(clock.t - 125 * 60e3).toISOString() }; } });
    const a = await automation({ name: 'Uptime', trigger_type: 'follow', actions: [
        { type: 'chat.send', platform: 'event', text: 'Hi {user.name}' },
        { type: 'chat.send', platform: 'event', text: '{stream.title} / {stream.category} / {stream.viewers}' },
        { type: 'stream.clip' },
    ] });
    const ev = normaliseTwitch('channel.follow', { broadcaster_user_id: '900000001', user_id: '9', user_login: 'a', user_name: 'A' });
    const [r] = await engine.handleEvent(profile, ev, null);
    assert.equal(reads, 1);
    assert.equal(said.at(-1).text, 'Boss rush / Hades / 42');
    assert.equal(r.status, 'partial');
    assert.match((await store.getRun(profile.id, r.runId)).steps[2].detail, /not available/);
    assert.equal(formatUptime(new Date(Date.now() - 125 * 60e3).toISOString()), '2h 05m');
    assert.equal(streamValues({ live: false, title: 'x' })['stream.uptime'], 'offline');
    assert.deepEqual(pickInfoChannel({ platform: 'studio' }, [{ platform: 'kick', platform_user_id: '8' }, { platform: 'twitch', platform_user_id: '9' }]), { platform: 'twitch', channelId: '9' });
    assert.deepEqual(templateWarnings('{stream.uptime} {args.points} {clip.url} {counter.value} {powerup}'), []);
    await store.deleteAutomation(profile.id, a.id);
});

test('stream info is cached for a minute per channel and shared by concurrent readers', async () => {
    let n = 0;
    const t = { v: 0 };
    const info = createStreamInfo({ now: () => t.v, fetchers: { twitch: async () => { n++; return { live: true, title: 'x' }; } } });
    await Promise.all([info.get({ platform: 'twitch', channelId: '1' }), info.get({ platform: 'twitch', channelId: '1' })]);
    t.v = 59_000; await info.get({ platform: 'twitch', channelId: '1' });
    assert.equal(n, 1);
    t.v = 61_000; await info.get({ platform: 'twitch', channelId: '1' });
    assert.equal(n, 2);
    info.forget('twitch', '1'); await info.get({ platform: 'twitch', channelId: '1' });
    assert.equal(n, 3);
});

// ── triggers ────────────────────────────────────────────────────────────────────────────────

test('Power-up or Bits used: channel.bits.use normalised, filtered by kind; Counter changed filtered by name and scope', () => {
    const ev = normaliseTwitch('channel.bits.use', { broadcaster_user_id: '900000001', user_id: '5', user_login: 'juniper', user_name: 'Juniper', bits: 100, type: 'power_up',
        power_up: { type: 'message_effect', emote: null, message_effect_id: 'cosmic' }, message: { text: 'gg', fragments: [] } });
    assert.deepEqual([ev.type, ev.amount, ev.currency, ev.metadata.kind, ev.metadata.powerUp, ev.message], ['bits.used', 100, 'bits', 'power_up', 'message_effect', 'gg']);
    assert.equal(describeEvent(ev), 'Juniper used 100 bits on a message effect');
    const auto = (cfg) => ({ trigger_type: 'bits.used', trigger_config: cfg });
    assert.equal(triggerMatches(auto({ bitsKind: 'message_effect' }), ev), true);
    assert.equal(triggerMatches(auto({ bitsKind: 'celebration' }), ev), false);
    assert.equal(triggerMatches(auto({ bitsKind: 'cheer' }), ev), false);
    assert.equal(triggerMatches(auto({ bitsKind: 'power_up' }), ev), true);
    assert.deepEqual(validateTrigger('bits.used', { bitsKind: 'nonsense' }).value, { bitsKind: 'any' });

    const changed = variableChangedEvent({ key: 'deaths', owner: 'server', value: '13', oldValue: '12', depth: 1 });
    assert.deepEqual([changed.platform, changed.amount, changed.metadata.change, changed.metadata.scope], ['bot', 13, 1, 'channel']);
    const vauto = (cfg) => ({ trigger_type: 'variable.changed', trigger_config: cfg });
    assert.equal(triggerMatches(vauto({ key: 'deaths', scope: 'channel' }), changed), true);
    assert.equal(triggerMatches(vauto({ key: 'wins' }), changed), false);
    assert.equal(triggerMatches(vauto({ scope: 'viewer' }), changed), false);
    assert.ok(validateTrigger('variable.changed', { key: 'Bad Key!' }).errors.length);
    const viewer = variableChangedEvent({ key: 'points', owner: 'twitch:55', value: 'x', oldValue: '', depth: 1 });
    assert.deepEqual([viewer.metadata.scope, viewer.user.id, viewer.amount], ['viewer', '55', null]);
    for (const t of ['bits.used', 'variable.changed', 'studio.connected']) assert.ok(sampleEvent(t), `${t} has a Test sample`);
    assert.equal(checkConditions([{ type: 'metadata', path: 'scene', op: 'in', value: 'START|BRB|Stream Ending' }], { metadata: { scene: 'brb' } }).ok, true);
    assert.equal(eventType('studio.connected').platforms[0], 'studio');
});

test('counter changes raise events with old and new values, and a loop stops after three in a row', async () => {
    const seen = [];
    const observed = observeVariables(store.variableStore, { onChange: (c) => seen.push(c) });
    await observed.set(profile.id, 'server', 'goal', 'cake');
    await observed.set(profile.id, 'server', 'goal', 'cake');   // unchanged: no event
    await observed.incr(profile.id, 'server', 'goal_n', 5);
    await observed.del(profile.id, 'server', 'goal');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen.map((c) => [c.key, c.oldValue ?? null, c.value, c.depth]), [['goal', null, 'cake', 1], ['goal_n', '0', '5', 1], ['goal', 'cake', '', 1]]);

    // Real engine and ingest: an automation that bumps the counter it listens to.
    const box = {};
    const vstore = observeVariables(store.variableStore, { onChange: (c) => box.ingest.internal(c.profileId, variableChangedEvent(c)) });
    const vstoreHolder = { ...store, variableStore: vstore };
    const render = createRenderer({ variableStore: vstore });
    const io = { channelsFor: (id) => store.listChannels(id), sendChat: async () => ({ ok: true }) };
    const engine = createEngine({ store: vstoreHolder, render, io, now: () => Date.now(), sleep: async () => {}, limiter: createLimiter() });
    box.ingest = createIngest({ store, engine, feed: createFeed() });
    const start = await automation({ name: 'Death', trigger_type: 'follow', actions: [{ type: 'variable.increment', scope: 'channel', key: 'loopy', by: 1 }] });
    const loop = await automation({ name: 'Again', trigger_type: 'variable.changed', trigger_config: { key: 'loopy' }, actions: [{ type: 'chat.send', platform: 'twitch', text: '{counter.name}: {counter.old} to {counter.value}' }, { type: 'variable.increment', scope: 'channel', key: 'loopy', by: 1 }] });
    await engine.handleEvent(profile, normaliseTwitch('channel.follow', { broadcaster_user_id: '900000001', user_id: '77', user_login: 'b', user_name: 'B' }), null);
    for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 20)); if ((await store.variableStore.get(profile.id, 'server', 'loopy')) === String(1 + COUNTER_MAX_DEPTH)) break; }
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await store.variableStore.get(profile.id, 'server', 'loopy'), String(1 + COUNTER_MAX_DEPTH), 'one bump from the follow and three from the loop');
    const runs = await store.listRuns(profile.id, { automationId: loop.id });
    assert.equal(runs.length, COUNTER_MAX_DEPTH);
    assert.ok(runs.every((r) => r.status === 'ok'));
    const events = await store.listEvents(profile.id, { type: 'variable.changed' });
    assert.equal(events.length, 0, 'counter events are not stored in the event log');
    await store.deleteAutomation(profile.id, start.id);
    await store.deleteAutomation(profile.id, loop.id);
});

test('CertiFried Studio connected: one event per device per minute, overlays ignored', async () => {
    const got = [];
    let t = 1_000_000;
    const studio = createStudioServices({ store, engine: {}, ingest: { internal: async (pid, ev) => got.push([pid, ev]) }, now: () => t });
    const conn = { kind: 'studio', profileId: profile.id, deviceId: 3, name: 'Streaming PC', client: 'certifried-studio 0.2.2' };
    assert.equal(await studio.onConnect(conn), true);
    assert.equal(await studio.onConnect(conn), false, 'a reconnect within a minute is not a new event');
    t += 61_000;
    assert.equal(await studio.onConnect(conn), true);
    assert.equal(await studio.onConnect({ ...conn, kind: 'overlay', deviceId: 4 }), false);
    assert.equal(got.length, 2);
    assert.deepEqual([got[0][1].type, got[0][1].platform, got[0][1].metadata.device, got[0][1].metadata.version], ['studio.connected', 'studio', 'Streaming PC', '0.2.2']);
});

// ── the grant's scopes ──────────────────────────────────────────────────────────────────────

test('the grant asks for chat moderation and shoutouts, still never follows or revenue; old grants are told what re-approving adds', () => {
    assert.ok(STREAM_BOT_SCOPES.includes('moderator:manage:chat_messages'));
    assert.ok(STREAM_BOT_SCOPES.includes('moderator:manage:shoutouts'));
    for (const s of FORBIDDEN_SCOPES) assert.equal(STREAM_BOT_SCOPES.includes(s), false);
    assert.equal(STREAM_BOT_SCOPES.some((s) => /follows|^analytics:|revenue|payout|subscriptions:read|user:read:subscriptions/.test(s)), false);
    const old = 'bits:read channel:edit:commercial channel:manage:broadcast channel:manage:polls channel:manage:predictions channel:manage:raids channel:manage:redemptions channel:read:ads channel:read:hype_train channel:read:redemptions channel:read:subscriptions clips:edit moderator:manage:announcements moderator:read:followers user:bot user:read:chat'.split(' ');
    assert.deepEqual(reapproveNeeded(old), ['Clear chat, Delete messages', 'Shoutouts']);
    assert.deepEqual(reapproveNeeded(STREAM_BOT_SCOPES), []);
    const cov = coverage({ streamBot: old });
    assert.equal(cov.find((f) => f.key === 'chatmod').covered, false);
    assert.equal(cov.find((f) => f.key === 'manage').covered, true);
    assert.ok(cov.find((f) => f.key === 'cheer').events.includes('bits.used'));
});
