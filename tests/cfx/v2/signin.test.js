// Greenhouse Tycoon (cfx v2), phase 2: sign-in and real time, over real HTTP on throwaway tables.
//   - Twitch panel: extension JWTs signed here with a TEST secret (never the real one)
//   - Discord: the dashboard's signed assertion
//   - website OAuth (Twitch, Kick) against a stubbed provider: no network, no real app
//   - refresh tokens: rotation, reuse, logout, stale after a link
//   - WebSocket hints, and everything degrading cleanly when a sign-in is not configured
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { setupTestDb, closePool, startApp, errorShape } from './_helpers.js';
import { createAuth } from '../../../services/cfx/http/auth.js';
import { createGame } from '../../../services/cfx/store/game.js';
import { createHints } from '../../../services/cfx/realtime/hints.js';
import { createWsHub } from '../../../services/cfx/realtime/ws.js';
import { allowedOrigins } from '../../../services/cfx/http/security.js';
import { createOAuth } from '../../../services/cfx/integrations/oauth.js';
import { signDiscordAssertion } from '../../../services/cfx/integrations/discord.js';
import { STARTER_KIT, DAY_MS } from '../../../services/cfx/config/game.js';

const EXT_SECRET = crypto.randomBytes(32); // a test secret; the real one never appears in tests
const DASH_SECRET = crypto.randomBytes(32).toString('hex');
const PUBLIC = 'https://certifriedmultitool.com';
let ctx, auth, srv, bare, hints, hub, clock;
const fetchCalls = [];
let providerDown = false;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function fetchStub(url, init = {}) {
    url = String(url);
    fetchCalls.push({ url, init });
    if (providerDown) return json(500, { error: 'down' });
    if (url.startsWith('https://id.twitch.tv/oauth2/token')) return json(200, { access_token: 'tw-access-token' });
    if (url.startsWith('https://api.twitch.tv/helix/users')) return json(200, { data: [{ id: '7654321', login: 'fern_fan', display_name: 'FernFan' }] });
    if (url.startsWith('https://id.kick.com/oauth/token')) return json(200, { access_token: 'kick-access-token' });
    if (url.startsWith('https://api.kick.com/public/v1/users')) return json(200, { data: [{ user_id: 8812, name: 'kick_grower' }] });
    return json(404, {});
}

const config = {
    publicUrl: PUBLIC, publicOrigin: PUBLIC, publicPrefix: '/gh-api', gamePath: '/game', allowDevPlatform: true,
    twitchExt: { clientId: '7k7fn5nym3jx13sdl4d56yxlu0cytp', secret: EXT_SECRET },
    twitchOAuth: { clientId: 'test-twitch-client', clientSecret: 'test-twitch-secret' },
    kickOAuth: { clientId: 'test-kick-client', clientSecret: 'test-kick-secret' },
    dashboardSecret: DASH_SECRET
};

before(async () => {
    clock = Date.UTC(2027, 6, 1, 10, 0, 0);
    ctx = await setupTestDb({ now: () => clock });
    auth = createAuth({ secret: crypto.randomBytes(32).toString('hex'), store: ctx.store });
    hints = createHints();
    const game = createGame({ store: ctx.store, onChange: (a, v) => hints.publish(a, v) });
    srv = await startApp({ store: ctx.store, auth, game, config, oauth: createOAuth({ config, fetchImpl: fetchStub }), rateLimits: false });
    hub = createWsHub({ server: srv.server, auth, hints, origins: allowedOrigins({ publicOrigin: PUBLIC }), authTimeoutMs: 300, logger: { debug() {} } });
    // The same app with nothing configured (no secrets, no OAuth apps).
    bare = await startApp({ store: ctx.store, auth, rateLimits: false });
});

after(async () => {
    try {
        await hub?.close();
        await srv?.close();
        await bare?.close();
        const left = await ctx?.cleanup();
        assert.deepEqual(left, [], 'every ghtest table was dropped');
    } finally {
        await closePool();
    }
});

const rand = (n = 9) => Array.from({ length: n }, (_, i) => String(crypto.randomInt(i === 0 ? 1 : 0, 10))).join('');
const opaque = () => `U${crypto.randomBytes(8).toString('hex')}`;

function extToken(claims, { secret = EXT_SECRET, expiresIn = 600, algorithm = 'HS256' } = {}) {
    return jwt.sign({ channel_id: '11223344', role: 'viewer', pubsub_perms: {}, ...claims }, secret, { algorithm, expiresIn });
}

async function panel(claims) {
    return srv.call('POST', '/auth/twitch-ext', { body: { token: extToken(claims) }, key: false });
}

async function identitiesOf(accountId) {
    const [rows] = await ctx.pool.query(`SELECT platform, platform_user_id, starter_granted_at FROM ${ctx.t.identities} WHERE account_id = ? ORDER BY platform`, [accountId]);
    return rows;
}

describe('Twitch panel: extension JWT', () => {
    test('a logged-in viewer plays on the opaque id; sharing joins the real id to the same save', async () => {
        const u = opaque();
        const first = await panel({ opaque_user_id: u });
        assert.equal(first.status, 200, first.text);
        assert.equal(first.json.platform, 'twitch_opaque');
        assert.equal(first.json.createdAccount, true);
        assert.equal(first.json.starterGranted, true);
        assert.match(first.json.refreshToken, /^ghr_/);
        const userId = rand();
        const shared = await panel({ opaque_user_id: u, user_id: userId });
        assert.equal(shared.status, 200, shared.text);
        assert.equal(shared.json.platform, 'twitch');
        assert.equal(shared.json.accountId, first.json.accountId, 'the same save');
        assert.deepEqual((await identitiesOf(first.json.accountId)).map(r => r.platform), ['twitch', 'twitch_opaque']);
        const acc = await srv.call('GET', '/account', { token: shared.json.token });
        assert.equal(acc.json.account.cash, STARTER_KIT.cash, 'one starter kit');
        // Unsharing later: the opaque id alone still reaches the same save.
        const again = await panel({ opaque_user_id: u });
        assert.equal(again.json.accountId, first.json.accountId);
    });

    test('logged-out (A...) viewers are refused with a clear code and nothing is stored', async () => {
        const a = `A${crypto.randomBytes(8).toString('hex')}`;
        const r = await panel({ opaque_user_id: a });
        errorShape(assert, r, 'TWITCH_SIGNED_OUT');
        assert.equal(r.status, 403);
        const [[{ n }]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${ctx.t.identities} WHERE platform_user_id = ?`, [a]);
        assert.equal(Number(n), 0);
    });

    test("the broadcaster on their own channel plays under their real id without the share prompt", async () => {
        const channel = rand(8);
        const r = await panel({ opaque_user_id: `U${channel}`, role: 'broadcaster', channel_id: channel });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.json.platform, 'twitch');
        const ids = await identitiesOf(r.json.accountId);
        assert.ok(ids.some(i => i.platform === 'twitch' && i.platform_user_id === channel));
    });

    test('forged, expired and malformed tokens are 401; a missing token is a validation error', async () => {
        const u = opaque();
        const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ opaque_user_id: u, channel_id: '1', role: 'viewer', exp: 9999999999 })).toString('base64url')}.`;
        const bad = [
            ['wrong secret', extToken({ opaque_user_id: u }, { secret: crypto.randomBytes(32) })],
            ['expired', extToken({ opaque_user_id: u }, { expiresIn: -120 })],
            ['no exp', jwt.sign({ opaque_user_id: u, channel_id: '1', role: 'viewer' }, EXT_SECRET, { algorithm: 'HS256' })],
            ['HS512', extToken({ opaque_user_id: u }, { algorithm: 'HS512' })],
            ['bad role', extToken({ opaque_user_id: u, role: 'admin' })],
            ['bad channel', extToken({ opaque_user_id: u, channel_id: 'abc' })],
            ['bad opaque', extToken({ opaque_user_id: 'U a b' })],
            ['no opaque', extToken({})],
            ['garbage', 'not.a.token-at-all-really']
        ];
        for (const [label, token] of bad) errorShape(assert, await srv.call('POST', '/auth/twitch-ext', { body: { token }, key: false }), 'UNAUTHORIZED', label);
        errorShape(assert, await srv.call('POST', '/auth/twitch-ext', { body: { token: none }, key: false }), 'UNAUTHORIZED', 'alg none');
        for (const body of [{}, { token: 5 }, { token: null }, { token: 'x'.repeat(5000) }, { token: 'abc', extra: 1 }]) {
            errorShape(assert, await srv.call('POST', '/auth/twitch-ext', { body, key: false }), 'VALIDATION', JSON.stringify(body).slice(0, 40));
        }
    });

    test('saves are never merged: a fresh panel save joins the Twitch save, one with progress is kept apart', async () => {
        // Fresh panel save + Twitch save with progress: the panel id moves over, its empty account is removed.
        const t1 = rand();
        const main = await ctx.store.accounts.signIn({ platform: 'twitch', platformUserId: t1 });
        await ctx.store.ledger.apply({ accountId: main.accountId, key: `progress-${t1}`, reason: 'sell', cash: 10 });
        const u1 = opaque();
        const fresh = await panel({ opaque_user_id: u1 });
        const joined = await panel({ opaque_user_id: u1, user_id: t1 });
        assert.equal(joined.json.accountId, main.accountId);
        assert.equal(joined.json.notice, null);
        const [[gone]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${ctx.t.accounts} WHERE id = ?`, [fresh.json.accountId]);
        assert.equal(Number(gone.n), 0);
        // Both with progress: the Twitch save is used and the panel save is kept.
        const t2 = rand();
        const main2 = await ctx.store.accounts.signIn({ platform: 'twitch', platformUserId: t2 });
        await ctx.store.ledger.apply({ accountId: main2.accountId, key: `progress-${t2}`, reason: 'sell', cash: 10 });
        const u2 = opaque();
        const own = await panel({ opaque_user_id: u2 });
        await ctx.store.ledger.apply({ accountId: own.json.accountId, key: `progress-${u2}`, reason: 'sell', cash: 10 });
        const both = await panel({ opaque_user_id: u2, user_id: t2 });
        assert.equal(both.json.accountId, main2.accountId);
        assert.equal(both.json.notice, 'separate_saves');
        const [[kept]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${ctx.t.accounts} WHERE id = ?`, [own.json.accountId]);
        assert.equal(Number(kept.n), 1);
    });

    test('anti-farming: an unlinked Twitch sign-in starts empty, and the panel id that joins it gets no kit later', async () => {
        const t = rand();
        await ctx.pool.query(
            `INSERT INTO ${ctx.t.identities} (platform, platform_user_id, display_name, created_at, starter_granted_at, unlinked_at) VALUES ('twitch', ?, 'Back', ?, ?, ?)`,
            [t, new Date(clock - 30 * DAY_MS), new Date(clock - 30 * DAY_MS), new Date(clock - 20 * DAY_MS)]);
        const u = opaque();
        const r = await panel({ opaque_user_id: u, user_id: t });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.json.createdAccount, true);
        assert.equal(r.json.starterGranted, false);
        assert.equal((await ctx.store.ledger.balance(r.json.accountId)).cash, 0, 'empty account; the daily reward gets them going');
        const ids = await identitiesOf(r.json.accountId);
        assert.ok(ids.every(i => i.starter_granted_at !== null), 'the panel id is marked too');
        const daily = await srv.call('POST', '/daily', { token: r.json.token, body: {} });
        assert.equal(daily.status, 200);
        assert.ok(daily.json.state.account.cash > 0);
    });

    test('a real id moved in the last 7 days cannot join the panel save: the panel save is used', async () => {
        const t = rand();
        const [ins] = await ctx.pool.query(
            `INSERT INTO ${ctx.t.identities} (platform, platform_user_id, display_name, created_at, starter_granted_at, unlinked_at) VALUES ('twitch', ?, 'Mover', ?, ?, ?)`,
            [t, new Date(clock - DAY_MS), new Date(clock - DAY_MS), new Date(clock - 3600_000)]);
        await ctx.pool.query(`INSERT INTO ${ctx.t.identity_events} (identity_id, account_id, event, created_at) VALUES (?, NULL, 'unlinked', ?)`, [ins.insertId, new Date(clock - 3600_000)]);
        const u = opaque();
        const own = await panel({ opaque_user_id: u });
        const r = await panel({ opaque_user_id: u, user_id: t });
        assert.equal(r.json.accountId, own.json.accountId);
        assert.equal(r.json.platform, 'twitch_opaque');
        assert.equal(r.json.notice, 'link_blocked');
    });
});

describe('Discord through the dashboard', () => {
    test('a signed assertion signs in once; replays, forgeries and stale assertions are refused', async () => {
        const discordId = `1${rand(17)}`;
        const a = signDiscordAssertion({ secret: DASH_SECRET, discordId, displayName: 'Leafy' });
        const r = await srv.call('POST', '/auth/discord', { body: { assertion: a }, key: false });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.json.platform, 'discord');
        const acc = await srv.call('GET', '/account', { token: r.json.token });
        assert.equal(acc.json.account.displayName, 'Leafy');
        errorShape(assert, await srv.call('POST', '/auth/discord', { body: { assertion: a }, key: false }), 'UNAUTHORIZED', 'replay');
        const again = await srv.call('POST', '/auth/discord', { body: { assertion: signDiscordAssertion({ secret: DASH_SECRET, discordId }) }, key: false });
        assert.equal(again.json.accountId, r.json.accountId, 'the same Discord user, the same save');
        const forged = [
            signDiscordAssertion({ secret: crypto.randomBytes(32).toString('hex'), discordId }),
            signDiscordAssertion({ secret: DASH_SECRET, discordId, nowMs: Date.now() - 300_000 }),
            signDiscordAssertion({ secret: DASH_SECRET, discordId: 'abc' }),
            jwt.sign({ jti: crypto.randomBytes(18).toString('base64url') }, DASH_SECRET, { issuer: 'certifried-dashboard', audience: 'cfx2-discord', subject: discordId, expiresIn: 3600 }),
            jwt.sign({ jti: crypto.randomBytes(18).toString('base64url') }, DASH_SECRET, { issuer: 'someone-else', audience: 'cfx2-discord', subject: discordId, expiresIn: 60 }),
            jwt.sign({}, DASH_SECRET, { issuer: 'certifried-dashboard', audience: 'cfx2-discord', subject: discordId, expiresIn: 60 })
        ];
        for (const [i, f] of forged.entries()) errorShape(assert, await srv.call('POST', '/auth/discord', { body: { assertion: f }, key: false }), 'UNAUTHORIZED', `forged ${i}`);
    });
});

describe('website OAuth (stubbed provider)', () => {
    test('Twitch: start redirects with state to the registered callback; the callback hands a one-time ticket', async () => {
        const start = await srv.call('GET', '/auth/twitch/start', { prefix: '/gh-api/api/v2' });
        assert.equal(start.status, 302);
        const loc = new URL(start.headers.get('location'));
        assert.equal(loc.origin, 'https://id.twitch.tv');
        assert.equal(loc.searchParams.get('redirect_uri'), `${PUBLIC}/gh-api/api/v2/auth/twitch/callback`);
        assert.equal(loc.searchParams.get('client_id'), 'test-twitch-client');
        const state = loc.searchParams.get('state');
        const cb = await srv.call('GET', `/auth/twitch/callback?code=abc123&state=${state}`, { prefix: '/gh-api/api/v2' });
        assert.equal(cb.status, 200, cb.text);
        assert.match(cb.headers.get('content-security-policy'), /script-src 'nonce-/);
        assert.ok(!cb.text.includes('tw-access-token'), 'the provider token never reaches the page');
        const ticket = cb.text.match(/"ticket":"([A-Za-z0-9_-]{32})"/)[1];
        const tokens = await srv.call('POST', '/auth/ticket', { body: { ticket }, key: false });
        assert.equal(tokens.status, 200, tokens.text);
        const acc = await srv.call('GET', '/account', { token: tokens.json.token });
        assert.equal(acc.json.account.identities[0].platform, 'twitch');
        assert.equal(acc.json.account.displayName, 'FernFan');
        errorShape(assert, await srv.call('POST', '/auth/ticket', { body: { ticket }, key: false }), 'TICKET_INVALID', 'ticket reuse');
        const replay = await srv.call('GET', `/auth/twitch/callback?code=abc123&state=${state}`, { prefix: '/gh-api/api/v2' });
        assert.equal(replay.status, 400);
        assert.match(replay.text, /SIGNIN_FAILED/);
        for (const q of ['', '?state=x', '?code=a&state[a]=1', `?code=${'%00'.repeat(3)}&state=zz`]) {
            const r = await srv.call('GET', `/auth/twitch/callback${q}`);
            assert.ok(r.status >= 400 && r.status < 500, `${q} -> ${r.status}`);
        }
    });

    test('Kick: PKCE verifier matches the challenge; a refused or unreachable provider is a clean failure', async () => {
        const start = await srv.call('GET', '/auth/kick/start');
        const loc = new URL(start.headers.get('location'));
        assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(loc.searchParams.get('redirect_uri'), `${PUBLIC}/gh-api/api/v2/auth/kick/callback`);
        fetchCalls.length = 0;
        const cb = await srv.call('GET', `/auth/kick/callback?code=kcode&state=${loc.searchParams.get('state')}`);
        assert.equal(cb.status, 200, cb.text);
        const form = new URLSearchParams(String(fetchCalls[0].init.body));
        const challenge = crypto.createHash('sha256').update(form.get('code_verifier')).digest('base64url');
        assert.equal(challenge, loc.searchParams.get('code_challenge'));
        const ticket = cb.text.match(/"ticket":"([A-Za-z0-9_-]{32})"/)[1];
        const tokens = await srv.call('POST', '/auth/ticket', { body: { ticket }, key: false });
        assert.equal(tokens.json.platform, 'kick');

        const denied = new URL((await srv.call('GET', '/auth/kick/start')).headers.get('location')).searchParams.get('state');
        const d = await srv.call('GET', `/auth/kick/callback?error=access_denied&state=${denied}`);
        assert.equal(d.status, 400);
        assert.match(d.text, /SIGNIN_FAILED/);
        providerDown = true;
        try {
            const s2 = new URL((await srv.call('GET', '/auth/twitch/start')).headers.get('location')).searchParams.get('state');
            const down = await srv.call('GET', `/auth/twitch/callback?code=abc&state=${s2}`);
            assert.equal(down.status, 400);
            assert.match(down.text, /SIGNIN_FAILED/);
        } finally {
            providerDown = false;
        }
    });

    test('nothing configured: every sign-in says SIGNIN_UNAVAILABLE (503), never a 500', async () => {
        const unavailable = (r, label) => {
            assert.equal(r.status, 503, `${label} ${r.text}`);
            assert.equal(r.json.error.code, 'SIGNIN_UNAVAILABLE', label);
            assert.equal(typeof r.json.error.message, 'string');
        };
        unavailable(await bare.call('POST', '/auth/twitch-ext', { body: { token: extToken({ opaque_user_id: opaque() }) }, key: false }), 'panel');
        unavailable(await bare.call('POST', '/auth/discord', { body: { assertion: signDiscordAssertion({ secret: DASH_SECRET, discordId: `1${rand(17)}` }) }, key: false }), 'discord');
        const start = await bare.call('GET', '/auth/twitch/start');
        assert.equal(start.status, 503);
        assert.match(start.text, /SIGNIN_UNAVAILABLE/);
        errorShape(assert, await bare.call('POST', '/auth/dev', { body: { userId: 'x1' }, key: false }), 'PLATFORM_NOT_ALLOWED');
    });
});

describe('sessions: refresh tokens', () => {
    test('rotate, two tabs at once, reuse after the grace window revokes the family, logout', async () => {
        const s = (await srv.call('POST', '/auth/dev', { body: { userId: `rt-${rand()}` }, key: false })).json;
        const r1 = await srv.call('POST', '/auth/refresh', { body: { refreshToken: s.refreshToken }, key: false });
        assert.equal(r1.status, 200, r1.text);
        assert.notEqual(r1.json.refreshToken, s.refreshToken);
        assert.equal((await srv.call('GET', '/account', { token: r1.json.token })).status, 200);
        errorShape(assert, await srv.call('POST', '/auth/refresh', { body: { refreshToken: s.refreshToken }, key: false }), 'REFRESH_RACE', 'second tab');
        clock += 11_000;
        errorShape(assert, await srv.call('POST', '/auth/refresh', { body: { refreshToken: s.refreshToken }, key: false }), 'UNAUTHORIZED', 'reuse');
        errorShape(assert, await srv.call('POST', '/auth/refresh', { body: { refreshToken: r1.json.refreshToken }, key: false }), 'UNAUTHORIZED', 'family revoked');

        const t = (await srv.call('POST', '/auth/dev', { body: { userId: `rt-${rand()}` }, key: false })).json;
        assert.equal((await srv.call('POST', '/auth/logout', { body: { refreshToken: t.refreshToken }, key: false })).status, 200);
        errorShape(assert, await srv.call('POST', '/auth/refresh', { body: { refreshToken: t.refreshToken }, key: false }), 'UNAUTHORIZED', 'after logout');
        for (const bad of ['', 'ghr_short', 'x'.repeat(200), 5]) {
            const r = await srv.call('POST', '/auth/refresh', { body: { refreshToken: bad }, key: false });
            errorShape(assert, r, null, `bad ${bad}`);
        }
    });

    test('a link ends older refresh families; the link answer carries new tokens', async () => {
        const main = (await srv.call('POST', '/auth/dev', { body: { userId: `lk-${rand()}` }, key: false })).json;
        const other = (await panel({ opaque_user_id: opaque() })).json;
        // A family issued for an account the identity no longer points at is stale.
        const wrong = await ctx.store.sessions.issue({ accountId: main.accountId, identityId: other.identityId });
        errorShape(assert, await srv.call('POST', '/auth/refresh', { body: { refreshToken: wrong.refreshToken }, key: false }), 'SESSION_STALE');
        const code = (await srv.call('POST', '/account/link-code', { token: main.token, body: {} })).json.code;
        const linked = await srv.call('POST', '/account/link', { token: other.token, body: { code } });
        assert.equal(linked.status, 200, linked.text);
        assert.match(linked.json.refreshToken, /^ghr_/);
        // Its old fresh account was removed by the link, and its refresh tokens with it.
        errorShape(assert, await srv.call('POST', '/auth/refresh', { body: { refreshToken: other.refreshToken }, key: false }), 'UNAUTHORIZED');
        const next = await srv.call('POST', '/auth/refresh', { body: { refreshToken: linked.json.refreshToken }, key: false });
        assert.equal(next.status, 200);
        assert.equal(next.json.accountId, main.accountId);
    });

    test('dev sign-in only from loopback without proxy headers', async () => {
        errorShape(assert, await srv.call('POST', '/auth/dev', { body: { userId: 'x2' }, key: false, headers: { 'x-forwarded-for': '203.0.113.9' } }), 'PLATFORM_NOT_ALLOWED');
        errorShape(assert, await srv.call('POST', '/auth/dev', { body: { userId: 'x3' }, key: false, headers: { 'cf-connecting-ip': '203.0.113.9' } }), 'PLATFORM_NOT_ALLOWED');
    });
});

describe('WebSocket hints', () => {
    const wsUrl = (path = '/gh-api/ws') => `ws://127.0.0.1:${srv.server.address().port}${path}`;
    function next(ws, what = 'message', ms = 3000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`no ${what} within ${ms} ms`)), ms);
            ws.once(what, (...args) => { clearTimeout(timer); resolve(args); });
        });
    }

    test('auth in the first message, then "state changed, version N" after an action', async () => {
        const p = (await srv.call('POST', '/auth/dev', { body: { userId: `ws-${rand()}` }, key: false })).json;
        await srv.call('GET', '/state', { token: p.token }); // today's orders exist, so the next change is the buy alone
        const ws = new WebSocket(wsUrl(), { headers: { origin: PUBLIC } });
        await next(ws, 'open');
        ws.send(JSON.stringify({ type: 'auth', token: p.token }));
        const [readyRaw] = await next(ws);
        const ready = JSON.parse(String(readyRaw));
        assert.equal(ready.type, 'ready');
        const hinted = next(ws); // the hint is sent at commit, before the HTTP answer arrives
        const buy = await srv.call('POST', '/shop/buy', { token: p.token, body: { kind: 'seed', itemId: 1, quantity: 1 } });
        assert.equal(buy.status, 200);
        const [hintRaw] = await hinted;
        const hint = JSON.parse(String(hintRaw));
        assert.equal(hint.type, 'state');
        assert.ok(hint.v > ready.v);
        assert.equal(hint.v, buy.json.state.version);
        ws.close();
        await next(ws, 'close');
    });

    test('bad token, no auth, a foreign origin and an unknown path are refused', async () => {
        const bad = new WebSocket(wsUrl('/ws'));
        await next(bad, 'open');
        bad.send(JSON.stringify({ type: 'auth', token: 'x'.repeat(40) }));
        const [code] = await next(bad, 'close');
        assert.equal(code, 4003);
        const silent = new WebSocket(wsUrl());
        await next(silent, 'open');
        const [code2] = await next(silent, 'close');
        assert.equal(code2, 4003, 'auth timeout');
        const foreign = new WebSocket(wsUrl(), { headers: { origin: 'https://evil.example' } });
        foreign.on('error', () => {});
        const [, res] = await next(foreign, 'unexpected-response');
        assert.equal(res.statusCode, 403);
        foreign.terminate();
        const nowhere = new WebSocket(wsUrl('/elsewhere'));
        await next(nowhere, 'error');
        assert.deepEqual(srv.errorsLogged, []);
    });
});
