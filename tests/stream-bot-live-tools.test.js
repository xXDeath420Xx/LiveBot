import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import pool from '../utils/db.js';
import { makeTables, makeProfile } from './fixtures/stream-bot-tables.js';
import { newDockKey, DOCK_CHAT, DOCK_CHANNEL } from '../core/stream-bot/dock.js';
import { hashSecret, tokenHint } from '../core/stream-bot/pairing.js';
import { createHelix, HelixError } from '../core/stream-bot/helix.js';
import { createKickApi } from '../core/stream-bot/kick-api.js';
import { GrantError } from '../core/stream-bot/twitch-auth.js';
import { scopeSatisfied, STREAM_BOT_SCOPES, FORBIDDEN_SCOPES } from '../core/stream-bot/scopes.js';
import { createLiveTools, MOD_RECONNECT, NOT_CREATED_MESSAGE } from '../core/stream-bot/live-tools.js';
import { createDockRouter } from '../dashboard/routes/stream-bot-dock.js';
import { createLiveRouter } from '../dashboard/routes/stream-bot-live.js';
import { createViewEngine } from '../dashboard/services/view-engine.js';

/*
 * Audit 2026-11-20 items 10 to 12: chat send and moderation from the dock, the title and category editor, and the channel
 * point redemption queue.
 *   Helix and Kick wrappers   request shapes against a fake fetch (ban, timeout, categories, redemptions)
 *   scopes                    the grant asks for the ban scope, never follows or revenue
 *   dock routes               401 without a key, 403 without the capability (a key made before chat gains nothing),
 *                             403 for a profile with no linked channel, rate limits, delete/timeout/ban, the Twitch
 *                             "Reconnect Twitch to allow moderation" state, title and category
 *   session routes            401 without a session, another user's redemption or device is refused, the Recreate
 *                             under CertiFried explanation, rate limit, dock key switches
 * Throwaway tables; real http servers on 127.0.0.1; no call leaves this machine.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');
const ALL = STREAM_BOT_SCOPES.slice();
const WITHOUT_BAN = ALL.filter((s) => s !== 'moderator:manage:banned_users');
let T, store, profile, other, bare;
const closers = [];

test.before(async () => {
    T = await makeTables(pool, 'lt');
    store = T.store;
    profile = await makeProfile(store);
    other = await store.ensureProfile(`sblt${String(Date.now()).slice(-9)}`, 'Elsewhere');   // no channels linked
    bare = other;
});
test.after(async () => {
    for (const c of closers) await c().catch(() => {});
    await T.drop();
    const [rows] = await pool.query('SHOW TABLES LIKE ?', [`${T.prefix}%`]);
    assert.equal(rows.length, 0, 'throwaway tables dropped');
    await pool.end().catch(() => {});
});

async function grant(p, scopes) {
    await store.saveTwitchGrant(p.id, { twitchUserId: '900000001', twitchLogin: 'maplehollow_tv', accessToken: 'at-fake', refreshToken: 'rt-fake', expiresAt: new Date(Date.now() + 3600e3), scopes: scopes.join(' ') });
}

/** A fake Helix transport: records every request, answers from `reply(call)`. */
function fakeHelix(scopes, reply = () => ({ status: 204 })) {
    const calls = [];
    const auth = {
        async token(profileId, { need = [] } = {}) {
            const have = new Set(scopes);
            const missing = need.filter((s) => !scopeSatisfied(have, s));
            if (missing.length) throw new GrantError('missing_scope', `The Stream bot grant does not include ${missing.join(', ')}.`, { missing });
            return { token: 'tok-secret', userId: '900000001', login: 'maplehollow_tv', scopes };
        },
    };
    const fetchImpl = async (url, init) => {
        const u = new URL(url);
        const call = { method: init.method, path: u.pathname.replace('/helix', ''), query: Object.fromEntries(u.searchParams), body: init.body ? JSON.parse(init.body) : null };
        calls.push(call);
        const r = reply(call) || { status: 204 };
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} };
    };
    return { helix: createHelix({ auth, fetchImpl, clientId: 'cid' }), calls };
}

function fakeKick(reply = () => ({ status: 200, body: { data: [{ id: 5, name: 'Just Chatting' }] } })) {
    const calls = [];
    const kick = createKickApi({
        resolveChannel: async () => ({ token: 'kick-secret', scopes: ['chat:write', 'channel:write', 'moderation:ban', 'moderation:chat_message:manage', 'user:read', 'events:subscribe', 'channel:read'], hasToken: true, defenderEnabled: true }),
        fetchImpl: async (url, init) => {
            const u = new URL(url);
            calls.push({ method: init.method, path: u.pathname.replace('/public/v1', ''), query: Object.fromEntries(u.searchParams), body: init.body ? JSON.parse(init.body) : null });
            const r = reply(calls.at(-1));
            return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} };
        },
    });
    return { kick, calls };
}

async function serve(app) {
    const s = http.createServer(app);
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const close = () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); });
    closers.push(close);
    return { base: `http://127.0.0.1:${s.address().port}`, close };
}

async function dockKey(p, caps = []) {
    const key = newDockKey();
    const id = await store.createDevice(p.id, { kind: 'dock', name: 'OBS docks', tokenHash: hashSecret(key), tokenHint: tokenHint(key), capabilities: ['dock', 'of:1', ...caps] });
    return { key, id };
}

async function dockApp({ sb, limits }) {
    const eng = createViewEngine({ viewsDir: views, publicDir: path.join(root, 'dashboard/public'), cache: false });
    const a = express();
    a.engine('ejs', (f, o, cb) => { try { cb(null, eng.renderFile(f, o)); } catch (e) { cb(e); } });
    a.set('views', views);
    a.set('view engine', 'ejs');
    a.use('/', createDockRouter({ getSb: async () => ({ store, feed: { subscribe: () => () => {} }, engine: {}, ...sb }), limits }));
    return serve(a);
}

const post = (base, p, key, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Dock-Key': key } : {}) }, body: JSON.stringify(body) });
const get = (base, p, key) => fetch(`${base}${p}`, { headers: key ? { 'X-Dock-Key': key } : {} });

// ── wrappers and scopes ─────────────────────────────────────────────────────────────────────

test('Helix: a timeout and a ban are POST /moderation/bans with the grant user as moderator; the ban scope is required', async () => {
    const { helix, calls } = fakeHelix(ALL);
    await helix.banUser(profile.id, { userId: '4242', seconds: 600, reason: 'spam' });
    await helix.banUser(profile.id, { userId: '4242' });
    assert.deepEqual(calls[0], { method: 'POST', path: '/moderation/bans', query: { broadcaster_id: '900000001', moderator_id: '900000001' }, body: { data: { user_id: '4242', duration: 600, reason: 'spam' } } });
    assert.deepEqual(calls[1].body, { data: { user_id: '4242' } }, 'no duration means a permanent ban');
    await assert.rejects(() => helix.banUser(profile.id, { userId: 'x; DROP' }), (e) => e.code === 'bad_user');
    await assert.rejects(() => helix.banUser(profile.id, { userId: '1', seconds: 99999999 }), (e) => e.code === 'bad_duration');
    const old = fakeHelix(WITHOUT_BAN);
    await assert.rejects(() => old.helix.banUser(profile.id, { userId: '1' }), (e) => e.code === 'missing_scope' && e.missing[0] === 'moderator:manage:banned_users');
    assert.equal(old.calls.length, 0, 'nothing was sent to Twitch');
});

test('Helix: category search, redemption list and update use the documented endpoints and send only the grant user as broadcaster', async () => {
    const { helix, calls } = fakeHelix(ALL, (c) => (c.path === '/search/categories' ? { status: 200, body: { data: [{ id: '1', name: 'Just Chatting' }] } }
        : c.method === 'GET' ? { status: 200, body: { data: [{ id: 'red-1', status: 'UNFULFILLED' }] } } : { status: 200, body: { data: [] } }));
    assert.deepEqual(await helix.searchCategories(profile.id, 'just'), [{ id: '1', name: 'Just Chatting' }]);
    assert.deepEqual(await helix.searchCategories(profile.id, 'j'), [], 'one character is not searched');
    assert.deepEqual(await helix.listRedemptions(profile.id, 'rw-1'), [{ id: 'red-1', status: 'UNFULFILLED' }]);
    await helix.updateRedemption(profile.id, { rewardId: 'rw-1', redemptionId: 'red-1', status: 'CANCELED' });
    const patch = calls.at(-1);
    assert.equal(patch.method, 'PATCH');
    assert.equal(patch.path, '/channel_points/custom_rewards/redemptions');
    assert.deepEqual(patch.query, { id: 'red-1', broadcaster_id: '900000001', reward_id: 'rw-1' });
    assert.deepEqual(patch.body, { status: 'CANCELED' });
    await assert.rejects(() => helix.updateRedemption(profile.id, { rewardId: 'a', redemptionId: 'b', status: 'DELETED' }), (e) => e.code === 'bad_status');
});

test('scopes: the grant asks for the ban scope and still never follows or revenue', () => {
    assert.ok(STREAM_BOT_SCOPES.includes('moderator:manage:banned_users'));
    assert.ok(STREAM_BOT_SCOPES.includes('channel:manage:redemptions'));
    for (const s of FORBIDDEN_SCOPES) assert.equal(STREAM_BOT_SCOPES.includes(s), false);
    assert.equal(STREAM_BOT_SCOPES.some((s) => /follows|revenue|payout|subscriptions:read|^analytics:/.test(s)), false);
});

// ── dock routes ─────────────────────────────────────────────────────────────────────────────

test('dock chat: 401 without a key, 403 on a key without the chat capability, and a key made earlier gains nothing', async () => {
    await grant(profile, ALL);
    const { helix, calls } = fakeHelix(ALL);
    const app = await dockApp({ sb: { helix, kick: fakeKick().kick, io: { sendChat: async () => ({ ok: true }) } } });
    const old = await dockKey(profile);                       // as issued today: dock + of:<id>, nothing else
    const body = { platform: 'twitch', text: 'hello' };
    assert.equal((await post(app.base, '/stream/bot/dock/api/chat', null, body)).status, 401);
    assert.equal((await post(app.base, '/stream/bot/dock/api/chat', `sbk_${'Z'.repeat(22)}`, body)).status, 401);
    const off = await post(app.base, '/stream/bot/dock/api/chat', old.key, body);
    assert.equal(off.status, 403);
    assert.equal((await off.json()).error, 'capability_off');
    assert.equal((await post(app.base, '/stream/bot/dock/api/moderate', old.key, { platform: 'twitch', action: 'delete', messageId: 'abc' })).status, 403);
    assert.equal((await post(app.base, '/stream/bot/dock/api/channel', old.key, { platform: 'twitch', title: 'x' })).status, 403);
    assert.equal((await get(app.base, '/stream/bot/dock/api/categories?platform=twitch&q=just', old.key)).status, 403);
    assert.equal(calls.length, 0, 'no Twitch call was made for any refused request');
    const page = await (await fetch(`${app.base}/stream/bot/dock/chat?key=${old.key}`)).text();
    assert.doesNotMatch(page, /dock-send/, 'the input row is not rendered for a key without chat');
});

test('dock chat: sends as the streamer on Twitch, through the existing Kick path on Kick; only the profile\'s own channels', async () => {
    await grant(profile, ALL);
    const { helix, calls } = fakeHelix(ALL, (c) => (c.path === '/chat/messages' ? { status: 200, body: { data: [{ is_sent: true, message_id: 'm1' }] } } : { status: 204 }));
    const sent = [];
    const app = await dockApp({ sb: { helix, kick: fakeKick().kick, io: { sendChat: async (m) => { sent.push(m); return { ok: true }; } } } });
    const k = await dockKey(profile, [DOCK_CHAT]);
    const tw = await post(app.base, '/stream/bot/dock/api/chat', k.key, { platform: 'twitch', text: '  hi chat  ' });
    assert.equal(tw.status, 200);
    assert.deepEqual(calls[0].body, { broadcaster_id: '900000001', sender_id: '900000001', message: 'hi chat' });
    const kk = await post(app.base, '/stream/bot/dock/api/chat', k.key, { platform: 'kick', text: 'hello kick' });
    assert.equal(kk.status, 200);
    assert.deepEqual([sent[0].platform, sent[0].channelId, sent[0].text, sent[0].profileId], ['kick', '800000001', 'hello kick', profile.id]);
    assert.equal((await post(app.base, '/stream/bot/dock/api/chat', k.key, { platform: 'twitch', text: '   ' })).status, 400);
    assert.equal((await post(app.base, '/stream/bot/dock/api/chat', k.key, { platform: 'twitch', text: 'x'.repeat(501) })).status, 400);
    assert.equal((await post(app.base, '/stream/bot/dock/api/chat', k.key, { platform: 'youtube', text: 'x' })).status, 400);
    // The other profile has the capability but no linked channel: refused, and nothing is sent for it.
    const before = calls.length;
    const o = await dockKey(bare, [DOCK_CHAT]);
    const refused = await post(app.base, '/stream/bot/dock/api/chat', o.key, { platform: 'twitch', text: 'hi' });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error, 'no_channel');
    assert.equal(calls.length, before);
});

test('dock chat: a Kick send that fails says why', async () => {
    const app = await dockApp({ sb: { helix: fakeHelix(ALL).helix, kick: fakeKick().kick, io: { sendChat: async () => ({ ok: false, error: 'sign in to Kick again' }) } } });
    const k = await dockKey(profile, [DOCK_CHAT]);
    const r = await post(app.base, '/stream/bot/dock/api/chat', k.key, { platform: 'kick', text: 'hi' });
    assert.equal(r.status, 409);
    assert.match((await r.json()).message, /sign in to Kick again/);
});

test('dock chat rate limit: 20 a minute by default, per key and IP', async () => {
    const app = await dockApp({ sb: { helix: fakeHelix(ALL).helix, kick: fakeKick().kick, io: { sendChat: async () => ({ ok: true }) } }, limits: { chat: 3, mod: 2, channel: 2 } });
    const k = await dockKey(profile);                          // refused with 403, but still counted by the limiter
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await post(app.base, '/stream/bot/dock/api/chat', k.key, { platform: 'twitch', text: 'x' })).status);
    assert.deepEqual(codes, [403, 403, 403, 429]);
    const m = [];
    for (let i = 0; i < 3; i++) m.push((await post(app.base, '/stream/bot/dock/api/moderate', k.key, { platform: 'twitch', action: 'delete', messageId: 'a' })).status);
    assert.deepEqual(m, [403, 403, 429]);
    const c = [];
    for (let i = 0; i < 3; i++) c.push((await post(app.base, '/stream/bot/dock/api/channel', k.key, { platform: 'twitch', title: 'x' })).status);
    assert.deepEqual(c, [403, 403, 429]);
    const src = fs.readFileSync(path.join(root, 'dashboard/routes/stream-bot-dock.js'), 'utf8');
    assert.match(src, /chat: 20/, 'the default chat limit is 20 a minute');
});

test('dock moderation: delete, timeout and ban go to Helix and Kick; a missing ban scope says "Reconnect Twitch to allow moderation"', async () => {
    await grant(profile, ALL);
    const full = fakeHelix(ALL);
    const kick = fakeKick();
    const app = await dockApp({ sb: { helix: full.helix, kick: kick.kick, io: { sendChat: async () => ({ ok: true }) } } });
    const k = await dockKey(profile, [DOCK_CHAT]);
    const mod = (b) => post(app.base, '/stream/bot/dock/api/moderate', k.key, b);
    assert.equal((await mod({ platform: 'twitch', action: 'delete', messageId: 'msg-1' })).status, 200);
    assert.deepEqual([full.calls[0].method, full.calls[0].path, full.calls[0].query.message_id], ['DELETE', '/moderation/chat', 'msg-1']);
    assert.equal((await mod({ platform: 'twitch', action: 'timeout', userId: '777', seconds: 600 })).status, 200);
    assert.deepEqual(full.calls[1].body, { data: { user_id: '777', duration: 600 } });
    assert.equal((await mod({ platform: 'twitch', action: 'ban', userId: '777' })).status, 200);
    assert.deepEqual(full.calls[2].body, { data: { user_id: '777' } });
    assert.equal((await mod({ platform: 'twitch', action: 'ban', userId: '900000001' })).status, 400, 'never your own account');
    assert.equal((await mod({ platform: 'twitch', action: 'ban', userId: 'abc' })).status, 400);
    assert.equal((await mod({ platform: 'twitch', action: 'delete', messageId: '../../x' })).status, 400);
    assert.equal((await mod({ platform: 'twitch', action: 'nuke', userId: '1' })).status, 400);
    assert.equal((await mod({ platform: 'kick', action: 'delete', messageId: 'abc-123' })).status, 200);
    assert.deepEqual([kick.calls[0].method, kick.calls[0].path], ['DELETE', '/chat/abc-123']);
    assert.equal((await mod({ platform: 'kick', action: 'timeout', userId: '55', seconds: 600 })).status, 200);
    assert.deepEqual([kick.calls[1].path, kick.calls[1].body], ['/moderation/bans', { broadcaster_user_id: 800000001, user_id: 55, duration: 10 }]);
    assert.equal((await mod({ platform: 'kick', action: 'ban', userId: '55' })).status, 200);
    assert.deepEqual(kick.calls[2].body, { broadcaster_user_id: 800000001, user_id: 55 });

    // The ban scope is missing from this grant: the call is refused before Twitch, with the reconnect words; delete still works.
    await grant(profile, WITHOUT_BAN);
    const old = fakeHelix(WITHOUT_BAN);
    const app2 = await dockApp({ sb: { helix: old.helix, kick: kick.kick, io: { sendChat: async () => ({ ok: true }) } } });
    const miss = await post(app2.base, '/stream/bot/dock/api/moderate', k.key, { platform: 'twitch', action: 'ban', userId: '777' });
    assert.equal(miss.status, 409);
    const mb = await miss.json();
    assert.equal(mb.message, MOD_RECONNECT);
    assert.equal(mb.scope, 'moderator:manage:banned_users');
    assert.equal(old.calls.length, 0);
    assert.equal((await post(app2.base, '/stream/bot/dock/api/moderate', k.key, { platform: 'twitch', action: 'delete', messageId: 'm' })).status, 200);
    // The chat dock shows the reconnect words and no timeout or ban buttons are offered for Twitch lines.
    const page = await (await fetch(`${app2.base}/stream/bot/dock/chat?key=${k.key}`)).text();
    assert.match(page, /Reconnect Twitch to allow moderation/);
    assert.match(page, /id="dock-send"/);
    const tools = createLiveTools({ store, helix: old.helix, kick: kick.kick, sendChat: async () => ({ ok: true }) });
    assert.deepEqual(await tools.modAbilities(profile), { connected: true, delete: true, ban: false });
    await grant(profile, ALL);
    assert.deepEqual(await tools.modAbilities(profile), { connected: true, delete: true, ban: true });
});

test('dock title and category: needs the channel capability; Twitch and Kick; category autocomplete', async () => {
    await grant(profile, ALL);
    const tw = fakeHelix(ALL, (c) => (c.path === '/search/categories' ? { status: 200, body: { data: [{ id: '509658', name: 'Just Chatting' }, { id: '1', name: 'Just Dance' }] } }
        : c.path === '/games' ? { status: 200, body: { data: [{ id: '509658', name: 'Just Chatting' }] } } : { status: 204 }));
    const kick = fakeKick((c) => (c.path === '/categories' ? { status: 200, body: { data: [{ id: 5, name: 'Just Chatting' }] } } : { status: 204 }));
    const forgotten = [];
    const streamInfo = { get: async ({ platform }) => ({ live: false, title: `${platform} title`, category: 'Old category' }), forget: (p, id) => forgotten.push(`${p}:${id}`) };
    const app = await dockApp({ sb: { helix: tw.helix, kick: kick.kick, streamInfo, io: { sendChat: async () => ({ ok: true }) } } });
    const k = await dockKey(profile, [DOCK_CHANNEL]);
    const r = await post(app.base, '/stream/bot/dock/api/channel', k.key, { platform: 'twitch', title: 'New title', category: 'Just Chatting' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, platform: 'twitch', title: 'New title', category: 'Just Chatting' });
    const patches = tw.calls.filter((c) => c.method === 'PATCH');
    assert.deepEqual(patches.map((c) => c.body), [{ title: 'New title' }, { game_id: '509658' }]);
    assert.equal((await post(app.base, '/stream/bot/dock/api/channel', k.key, { platform: 'kick', title: 'Kick title', category: 'Just Chatting' })).status, 200);
    assert.deepEqual(kick.calls.filter((c) => c.method === 'PATCH').map((c) => c.body), [{ stream_title: 'Kick title' }, { category_id: 5 }]);
    assert.deepEqual(forgotten, ['twitch:900000001', 'kick:800000001']);
    assert.equal((await post(app.base, '/stream/bot/dock/api/channel', k.key, { platform: 'twitch' })).status, 400);
    assert.equal((await post(app.base, '/stream/bot/dock/api/channel', k.key, { platform: 'twitch', title: 'x'.repeat(141) })).status, 400);
    const cats = await (await get(app.base, '/stream/bot/dock/api/categories?platform=twitch&q=just', k.key)).json();
    assert.deepEqual(cats.categories.map((c) => c.name), ['Just Chatting', 'Just Dance']);
    const kc = await (await get(app.base, '/stream/bot/dock/api/categories?platform=kick&q=just', k.key)).json();
    assert.deepEqual(kc.categories, [{ id: '5', name: 'Just Chatting' }]);
    const info = await (await get(app.base, '/stream/bot/dock/api/channel', k.key)).json();
    assert.deepEqual(info.channels.map((c) => [c.platform, c.title]), [['twitch', 'twitch title'], ['kick', 'kick title']]);
    assert.equal((await get(app.base, '/stream/bot/dock/api/channel')).status, 401);
    const page = await (await fetch(`${app.base}/stream/bot/dock/controls?key=${k.key}&theme=sand`)).text();
    assert.match(page, /Title and category/);
    assert.match(page, /data-channel-form="twitch"/);
    const off = await dockKey(profile);
    const offPage = await (await fetch(`${app.base}/stream/bot/dock/controls?key=${off.key}`)).text();
    assert.match(offPage, /Editing is off for this dock key/);
    assert.match(offPage, /data-channel-form="twitch" novalidate hidden>/, 'forms are hidden when the key lacks the capability');
});

// ── session routes ──────────────────────────────────────────────────────────────────────────

async function liveApp({ sb, limits }) {
    const a = express();
    a.use((req, res, next) => {
        const u = req.headers['x-test-user'];
        req.isAuthenticated = () => !!u;
        req.user = u ? { id: u, username: 'tester' } : null;
        next();
    });
    a.use('/', createLiveRouter({ getSb: async () => ({ store, ...sb }), limits }));
    return serve(a);
}
const sess = (base, method, p, user, body) => fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(user ? { 'X-Test-User': user } : {}) }, body: body ? JSON.stringify(body) : undefined });

async function redemption(p, { id, reward = 'rw-1', title = 'Sound alert', status = 'unfulfilled', minutesAgo = 5 } = {}) {
    return store.insertEvent(p.id, { platform: 'twitch', type: 'redemption', channelId: '900000001', user: { id: '31', login: 'fan', name: 'Fan' }, amount: 500, currency: 'points', message: 'play it',
        metadata: { reward: title, rewardId: reward, redemptionId: id, status }, occurredAt: new Date(Date.now() - minutesAgo * 60_000), dedupeKey: `red-${p.id}-${id}` });
}

test('session routes: 401 without a session on every route', async () => {
    const app = await liveApp({ sb: { helix: fakeHelix(ALL).helix, kick: fakeKick().kick, io: { sendChat: async () => ({ ok: true }) } } });
    for (const [m, p] of [['GET', '/stream/bot/api/channel/info'], ['GET', '/stream/bot/api/channel/categories?platform=twitch&q=ab'], ['POST', '/stream/bot/api/channel/update'],
        ['GET', '/stream/bot/api/redemptions'], ['POST', '/stream/bot/api/redemptions/update'], ['POST', '/stream/bot/api/devices/dock-access']]) {
        assert.equal((await sess(app.base, m, p, null, m === 'POST' ? {} : undefined)).status, 401, `${m} ${p}`);
    }
});

test('redemptions: listed from the event log with their live state; a reward CertiFried did not create is marked and links to Recreate', async () => {
    await grant(profile, ALL);
    await redemption(profile, { id: 'red-open', reward: 'rw-mine', title: 'Mine' });
    await redemption(profile, { id: 'red-closed', reward: 'rw-mine', title: 'Mine', minutesAgo: 30 });
    await redemption(profile, { id: 'red-foreign', reward: 'rw-foreign', title: 'Made elsewhere' });
    await redemption(profile, { id: 'red-old', reward: 'rw-mine', title: 'Mine', minutesAgo: 60 * 24 * 9 });
    const tw = fakeHelix(ALL, (c) => {
        if (c.method === 'GET' && c.query.reward_id === 'rw-mine') return { status: 200, body: { data: [{ id: 'red-open', status: 'UNFULFILLED' }] } };
        if (c.method === 'GET') return { status: 403, body: { message: 'The ID in reward_id was created by a different client' } };
        if (c.method === 'PATCH' && c.query.reward_id === 'rw-foreign') return { status: 403, body: { message: 'forbidden' } };
        return { status: 204 };
    });
    const app = await liveApp({ sb: { helix: tw.helix, kick: fakeKick().kick, io: { sendChat: async () => ({ ok: true }) } } });
    const user = profile.ownerDiscordId;
    const r = await (await sess(app.base, 'GET', '/stream/bot/api/redemptions', user)).json();
    const by = Object.fromEntries(r.rows.map((x) => [x.redemptionId, x]));
    assert.equal(by['red-open'].state, 'pending');
    assert.equal(by['red-open'].manageable, true);
    assert.equal(by['red-closed'].state, 'done');
    assert.equal(by['red-foreign'].state, 'unknown');
    assert.equal(by['red-foreign'].manageable, false);
    assert.equal(by['red-old'], undefined, 'older than 7 days is not listed');
    assert.equal(r.importUrl, '/stream/bot/import');
    assert.equal(r.needScope, null);

    // Fulfil and Refund
    const ok = await sess(app.base, 'POST', '/stream/bot/api/redemptions/update', user, { rewardId: 'rw-mine', redemptionId: 'red-open', action: 'fulfil' });
    assert.equal(ok.status, 200);
    const patch = tw.calls.find((c) => c.method === 'PATCH');
    assert.deepEqual([patch.query.id, patch.query.reward_id, patch.body], ['red-open', 'rw-mine', { status: 'FULFILLED' }]);
    assert.equal((await sess(app.base, 'POST', '/stream/bot/api/redemptions/update', user, { rewardId: 'rw-mine', redemptionId: 'red-open', action: 'refund' })).status, 200);
    assert.equal(tw.calls.filter((c) => c.method === 'PATCH').at(-1).body.status, 'CANCELED');
    // A reward made elsewhere: the explanation and the link, not a bare error.
    const foreign = await sess(app.base, 'POST', '/stream/bot/api/redemptions/update', user, { rewardId: 'rw-foreign', redemptionId: 'red-foreign', action: 'fulfil' });
    assert.equal(foreign.status, 409);
    const fb = await foreign.json();
    assert.equal(fb.error, 'not_created_by_certifried');
    assert.equal(fb.message, NOT_CREATED_MESSAGE);
    assert.equal(fb.importUrl, '/stream/bot/import');
    assert.equal((await sess(app.base, 'POST', '/stream/bot/api/redemptions/update', user, { rewardId: 'rw-mine', redemptionId: 'red-open', action: 'explode' })).status, 400);
});

test('redemptions: another user cannot act on this channel\'s redemption (403), and a grant without the scope says so', async () => {
    const tw = fakeHelix(ALL);
    const app = await liveApp({ sb: { helix: tw.helix, kick: fakeKick().kick, io: { sendChat: async () => ({ ok: true }) } } });
    const before = tw.calls.length;
    // `other` has its own profile but no such redemption in its own log
    const r = await sess(app.base, 'POST', '/stream/bot/api/redemptions/update', other.ownerDiscordId, { rewardId: 'rw-mine', redemptionId: 'red-open', action: 'refund' });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'not_yours');
    assert.equal(tw.calls.length, before, 'nothing reached Twitch');
    const list = await (await sess(app.base, 'GET', '/stream/bot/api/redemptions', other.ownerDiscordId)).json();
    assert.deepEqual(list.rows, [], 'another profile sees none of this channel\'s redemptions');
    // a grant made before channel:manage:redemptions
    const noScope = fakeHelix(ALL.filter((s) => !/redemptions/.test(s)));
    const app2 = await liveApp({ sb: { helix: noScope.helix, kick: fakeKick().kick, io: { sendChat: async () => ({ ok: true }) } } });
    const l2 = await (await sess(app2.base, 'GET', '/stream/bot/api/redemptions', profile.ownerDiscordId)).json();
    assert.equal(l2.needScope, 'channel:manage:redemptions');
    assert.equal(noScope.calls.length, 0);
});

test('session rate limits: redemption actions and channel edits', async () => {
    const app = await liveApp({ sb: { helix: fakeHelix(ALL).helix, kick: fakeKick().kick, io: { sendChat: async () => ({ ok: true }) } }, limits: { redeem: 2, edit: 2 } });
    const user = other.ownerDiscordId;
    const r = [];
    for (let i = 0; i < 3; i++) r.push((await sess(app.base, 'POST', '/stream/bot/api/redemptions/update', user, { rewardId: 'a', redemptionId: 'b', action: 'fulfil' })).status);
    assert.deepEqual(r, [403, 403, 429]);
    const e = [];
    for (let i = 0; i < 3; i++) e.push((await sess(app.base, 'POST', '/stream/bot/api/channel/update', user, { platform: 'twitch', title: 'x' })).status);
    assert.deepEqual(e, [403, 403, 429], 'a profile with no linked channel is refused (403) before the limit');
});

test('title and category from the Overview page: own channels only, autocomplete, errors explained', async () => {
    await grant(profile, ALL);
    const tw = fakeHelix(ALL, (c) => (c.path === '/search/categories' ? { status: 200, body: { data: [{ id: '1', name: 'Minecraft' }] } } : { status: 204 }));
    const streamInfo = { get: async () => ({ live: true, title: 'Now', category: 'Minecraft' }), forget() {} };
    const app = await liveApp({ sb: { helix: tw.helix, kick: fakeKick().kick, streamInfo, io: { sendChat: async () => ({ ok: true }) } } });
    const user = profile.ownerDiscordId;
    const info = await (await sess(app.base, 'GET', '/stream/bot/api/channel/info', user)).json();
    assert.deepEqual(info.channels.map((c) => [c.platform, c.title, c.category]), [['twitch', 'Now', 'Minecraft'], ['kick', 'Now', 'Minecraft']]);
    assert.deepEqual((await (await sess(app.base, 'GET', '/stream/bot/api/channel/categories?platform=twitch&q=mine', user)).json()).categories, [{ id: '1', name: 'Minecraft' }]);
    assert.equal((await sess(app.base, 'POST', '/stream/bot/api/channel/update', user, { platform: 'twitch', title: 'Hello' })).status, 200);
    // the other user has no channels: refused, not routed to someone else's channel
    assert.equal((await sess(app.base, 'POST', '/stream/bot/api/channel/update', other.ownerDiscordId, { platform: 'twitch', title: 'Hijack' })).status, 403);
    assert.deepEqual((await (await sess(app.base, 'GET', '/stream/bot/api/channel/info', other.ownerDiscordId)).json()).channels, []);
    // Twitch refuses: the message comes through without the token
    const bad = fakeHelix(ALL, () => ({ status: 400, body: { message: 'The title is not allowed' } }));
    const app2 = await liveApp({ sb: { helix: bad.helix, kick: fakeKick().kick, io: { sendChat: async () => ({ ok: true }) } } });
    const r = await sess(app2.base, 'POST', '/stream/bot/api/channel/update', user, { platform: 'twitch', title: 'x' });
    assert.equal(r.status, 409);
    const txt = JSON.stringify(await r.json());
    assert.match(txt, /not allowed/);
    assert.doesNotMatch(txt, /tok-secret/);
});

test('dock key switches: only the owner\'s own dock keys, only chat and channel, off by default', async () => {
    const app = await liveApp({ sb: { helix: fakeHelix(ALL).helix, kick: fakeKick().kick, io: { sendChat: async () => ({ ok: true }) } } });
    const k = await dockKey(profile);
    const mine = profile.ownerDiscordId;
    assert.equal(((await store.getDevice(profile.id, k.id)).capabilities).includes(DOCK_CHAT), false, 'a new key has no chat');
    const on = await (await sess(app.base, 'POST', '/stream/bot/api/devices/dock-access', mine, { id: k.id, chat: true, channel: false })).json();
    assert.deepEqual([on.ok, on.chat, on.channel], [true, true, false]);
    assert.deepEqual((await store.getDevice(profile.id, k.id)).capabilities, ['dock', 'of:1', 'chat'], 'the dock marks stay');
    const both = await (await sess(app.base, 'POST', '/stream/bot/api/devices/dock-access', mine, { id: k.id, chat: true, channel: true })).json();
    assert.deepEqual([both.chat, both.channel], [true, true]);
    await sess(app.base, 'POST', '/stream/bot/api/devices/dock-access', mine, { id: k.id });
    assert.deepEqual((await store.getDevice(profile.id, k.id)).capabilities, ['dock', 'of:1'], 'off again');
    // another user cannot change this key
    const wrong = await sess(app.base, 'POST', '/stream/bot/api/devices/dock-access', other.ownerDiscordId, { id: k.id, chat: true });
    assert.equal(wrong.status, 404);
    assert.deepEqual((await store.getDevice(profile.id, k.id)).capabilities, ['dock', 'of:1']);
    // not a dock key
    const studio = await store.createDevice(profile.id, { kind: 'studio', name: 'PC', tokenHash: hashSecret('x'.repeat(20)), tokenHint: 'xxxx', capabilities: [] });
    assert.equal((await sess(app.base, 'POST', '/stream/bot/api/devices/dock-access', mine, { id: studio, chat: true })).status, 400);
});

// ── wiring ──────────────────────────────────────────────────────────────────────────────────

test('wiring: server.js mounts the live router and exempts only the key-authenticated dock writes; no router.use; literal paths', () => {
    const srv = fs.readFileSync(path.join(root, 'dashboard/server.js'), 'utf8');
    assert.match(srv, /import\('\.\/routes\/stream-bot-live\.js'\)/);
    const exempt = (srv.match(/'\/stream\/bot\/dock\/[^']*',/g) || []).join('');
    assert.equal(exempt, "'/stream/bot/dock/api/run','/stream/bot/dock/api/chat','/stream/bot/dock/api/moderate','/stream/bot/dock/api/channel',");
    assert.doesNotMatch(srv.match(/exempt[\s\S]{0,4000}/i)?.[0] || '', /stream\/bot\/api\/(redemptions|channel)/, 'the session routes keep CSRF');
    for (const f of ['stream-bot-live.js', 'stream-bot-dock.js']) {
        const src = fs.readFileSync(path.join(root, 'dashboard/routes', f), 'utf8');
        assert.doesNotMatch(src, /router\.use\(/, `${f}: router.use would apply to every route on the router`);
        assert.doesNotMatch(src, /router\.(get|post|put|delete)\('[^']*\/:/, `${f}: literal routes only`);
        for (const m of src.matchAll(/logger\.\w+\(([^;]*)\);/g)) assert.doesNotMatch(m[1], /\bkey\b\s*[,}]|token/i, 'keys and tokens are never logged');
    }
    const live = fs.readFileSync(path.join(root, 'core/stream-bot/live-tools.js'), 'utf8');
    assert.doesNotMatch(live, /gql\.twitch|user:read:follows/, 'Helix only');
});
