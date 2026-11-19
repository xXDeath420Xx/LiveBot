// Greenhouse Tycoon (cfx v2), audit B3 test 3: API contract tests, plus the account-linking rules, the
// privacy delete and the job lock. A real HTTP server on 127.0.0.1:<random port> over throwaway tables
// (prefix ghtest_<random>_, dropped in after()). Every POST gets schema-violation cases; no bad input
// may produce a 500, and every error has the shape { error: { code, message } }.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { setupTestDb, closePool, quietLogger } from './_helpers.js';
import { createAuth } from '../../../services/cfx/http/auth.js';
import { createApp } from '../../../services/cfx/http/app.js';
import { createStore } from '../../../services/cfx/store/index.js';
import { createPrivacy } from '../../../services/cfx/privacy/index.js';
import { STARTER_KIT, LINKING, DAY_MS } from '../../../services/cfx/config/game.js';
import { GameError } from '../../../services/cfx/lib/errors.js';

let ctx, server, base, auth, clock;
const secret = crypto.randomBytes(32).toString('hex');
const errorsLogged = [];

before(async () => {
    clock = Date.now();
    ctx = await setupTestDb({ now: () => clock });
    auth = createAuth({ secret, store: ctx.store });
    const logger = { ...quietLogger, error: (msg, meta) => errorsLogged.push({ msg, meta }) };
    server = http.createServer(createApp({ store: ctx.store, auth, logger }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/api/v2`;
});

after(async () => {
    try {
        await new Promise(r => (server ? server.close(() => r()) : r()));
        const left = await ctx?.cleanup();
        assert.deepEqual(left, [], 'every ghtest table was dropped');
    } finally {
        await closePool();
    }
});

let keySeq = 0;
const nextKey = () => `test-key-${Date.now()}-${++keySeq}`;

async function call(method, path, { token, body, raw, headers = {}, key = true } = {}) {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (key && method !== 'GET') h['idempotency-key'] = typeof key === 'string' ? key : nextKey();
    let payload;
    if (raw !== undefined) {
        payload = raw;
        if (!h['content-type']) h['content-type'] = 'application/json';
    } else if (body !== undefined) {
        payload = JSON.stringify(body);
        h['content-type'] = 'application/json';
    }
    const res = await fetch(base + path, { method, headers: h, body: payload });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
}

function assertErrorShape(res, expectedCode, label = '') {
    assert.ok(res.status >= 400 && res.status < 500, `${label} status ${res.status} (${res.text.slice(0, 200)})`);
    assert.ok(res.json && typeof res.json.error === 'object', `${label} has an error object`);
    assert.equal(typeof res.json.error.code, 'string', label);
    assert.equal(typeof res.json.error.message, 'string', label);
    assert.ok(res.json.error.message.length > 0, label);
    if (expectedCode) assert.equal(res.json.error.code, expectedCode, label);
}

/** Sign in through the store (phase 2 adds the HTTP sign-in routes) and mint a session token. */
async function player(platform, platformUserId, displayName = 'Tester') {
    const s = await ctx.store.accounts.signIn({ platform, platformUserId, displayName });
    return { ...s, token: auth.sign({ accountId: s.accountId, identityId: s.identityId }) };
}

const uid = () => String(crypto.randomInt(1e9, 9e9));
const snowflake = () => `1${String(crypto.randomInt(1e9, 9e9))}${String(crypto.randomInt(1e6, 9e6))}`;

describe('contract: health, auth and the error shape', () => {
    test('health needs no session', async () => {
        const r = await call('GET', '/health');
        assert.equal(r.status, 200);
        assert.deepEqual(r.json, { ok: true, service: 'Greenhouse Tycoon', version: 2 });
    });

    test('missing, malformed, forged and expired tokens are 401', async () => {
        const p = await player('dev', `auth-${uid()}`);
        const forged = createAuth({ secret: 'x'.repeat(40), store: ctx.store }).sign({ accountId: p.accountId, identityId: p.identityId });
        const jwt = (await import('jsonwebtoken')).default;
        const expired = jwt.sign({ acc: p.accountId }, secret, { subject: String(p.identityId), issuer: 'cfx2', audience: 'cfx2-game', expiresIn: -10 });
        const wrongAudience = jwt.sign({ acc: p.accountId }, secret, { subject: String(p.identityId), issuer: 'cfx2', audience: 'someone-else', expiresIn: 600 });
        for (const [label, headers] of [
            ['none', {}],
            ['not bearer', { authorization: `Token ${p.token}` }],
            ['garbage', { authorization: 'Bearer not-a-real-token-at-all-really' }],
            ['forged', { authorization: `Bearer ${forged}` }],
            ['expired', { authorization: `Bearer ${expired}` }],
            ['wrong audience', { authorization: `Bearer ${wrongAudience}` }],
            ['alg none', { authorization: `Bearer ${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: String(p.identityId), acc: p.accountId })).toString('base64url')}.` }]
        ]) {
            const r = await call('GET', '/account', { headers });
            assertErrorShape(r, 'UNAUTHORIZED', label);
            assert.equal(r.status, 401);
        }
    });

    test('a token naming another account is stale', async () => {
        const p = await player('dev', `stale-${uid()}`);
        const q = await player('dev', `stale2-${uid()}`);
        const wrong = auth.sign({ accountId: q.accountId, identityId: p.identityId });
        assertErrorShape(await call('GET', '/account', { token: wrong }), 'SESSION_STALE');
    });

    test('unknown routes are 404 with the error shape', async () => {
        const p = await player('dev', `nf-${uid()}`);
        assertErrorShape(await call('GET', '/nope', { token: p.token }), 'NOT_FOUND');
        assertErrorShape(await call('POST', '/account/nope', { token: p.token, body: {} }), 'NOT_FOUND');
    });

    test('GET /account: starter kit and the current sign-in', async () => {
        const p = await player('discord', snowflake(), 'Fern\u0000Fan');
        const r = await call('GET', '/account', { token: p.token });
        assert.equal(r.status, 200);
        const a = r.json.account;
        assert.equal(a.id, p.accountId);
        assert.equal(a.cash, STARTER_KIT.cash);
        assert.equal(a.displayName, 'FernFan');
        assert.equal(a.identities.length, 1);
        assert.equal(a.identities[0].current, true);
        assert.equal(a.identities[0].platform, 'discord');
        assert.equal(JSON.stringify(r.json).includes('platform_user_id'), false, 'platform ids are not exposed');
    });
});

describe('contract: every POST refuses bad input without a 500', () => {
    const LONG = 'x'.repeat(9 * 1024);
    const posts = [
        { path: '/account/link-code', good: {} },
        { path: '/account/link', good: { code: 'ABCDEFGH' }, fields: { code: [123, null, '', 'short', 'x'.repeat(40), ['ABCDEFGH'], { a: 1 }, true] } },
        { path: '/account/unlink', good: { identityId: 1 }, fields: { identityId: [-1, 0, 1.5, '5', 'NaN', 1e20, true, null, [], {}, 2 ** 53] } }
    ];

    test('missing or malformed Idempotency-Key', async () => {
        const p = await player('dev', `idem-${uid()}`);
        for (const { path, good } of posts) {
            assertErrorShape(await call('POST', path, { token: p.token, body: good, key: false }), 'IDEMPOTENCY_KEY_REQUIRED', path);
            for (const bad of ['short', 'has space key', 'x'.repeat(65), 'emoji-\u{1F331}-key']) {
                const r = await call('POST', path, { token: p.token, body: good, headers: { 'idempotency-key': encodeURIComponent(bad) === bad ? bad : 'a b c d e f' }, key: false });
                assertErrorShape(r, 'IDEMPOTENCY_KEY_REQUIRED', `${path} ${bad}`);
            }
        }
    });

    test('malformed JSON, non-object bodies, unknown fields, oversized bodies', async () => {
        const p = await player('dev', `body-${uid()}`);
        for (const { path, good } of posts) {
            assertErrorShape(await call('POST', path, { token: p.token, raw: '{"code": ' }), 'BAD_JSON', `${path} truncated`);
            assertErrorShape(await call('POST', path, { token: p.token, raw: "{'a':1}" }), 'BAD_JSON', `${path} single quotes`);
            for (const raw of ['[]', '"text"', '42', 'null', 'true']) {
                const r = await call('POST', path, { token: p.token, raw });
                assertErrorShape(r, null, `${path} ${raw}`);
                assert.ok(['VALIDATION', 'BAD_JSON'].includes(r.json.error.code), `${path} ${raw} -> ${r.json.error.code}`);
            }
            assertErrorShape(await call('POST', path, { token: p.token, body: { ...good, extra: 1 } }), 'VALIDATION', `${path} unknown field`);
            assertErrorShape(await call('POST', path, { token: p.token, raw: `{"__proto__":{"admin":true}}` }), 'VALIDATION', `${path} __proto__`);
            const big = await call('POST', path, { token: p.token, body: { pad: LONG } });
            assertErrorShape(big, 'PAYLOAD_TOO_LARGE', `${path} 9 KB`);
            assert.equal(big.status, 413);
        }
    });

    test('wrong types and out-of-range values for every field', async () => {
        const p = await player('dev', `fields-${uid()}`);
        for (const { path, good, fields = {} } of posts) {
            for (const [field, values] of Object.entries(fields)) {
                for (const value of values) {
                    const r = await call('POST', path, { token: p.token, body: { ...good, [field]: value } });
                    assertErrorShape(r, null, `${path} ${field}=${JSON.stringify(value)}`);
                    assert.ok(['VALIDATION', 'LINK_CODE_INVALID'].includes(r.json.error.code), `${path} ${field}=${JSON.stringify(value)} -> ${r.json.error.code}`);
                }
                const missing = { ...good };
                delete missing[field];
                assertErrorShape(await call('POST', path, { token: p.token, body: missing }), 'VALIDATION', `${path} without ${field}`);
            }
        }
    });

    test('no request so far produced a 500 or an unhandled error', () => {
        assert.deepEqual(errorsLogged, []);
    });
});

describe('accounts: sign-in rules', () => {
    test('20 concurrent first sign-ins of one identity make one account and one starter kit', async () => {
        const puid = uid();
        const results = await Promise.all(Array.from({ length: 20 }, () =>
            ctx.store.accounts.signIn({ platform: 'twitch', platformUserId: puid, displayName: 'Racer' })));
        assert.equal(new Set(results.map(r => r.accountId)).size, 1);
        assert.equal(results.filter(r => r.createdAccount).length, 1);
        const accountId = results[0].accountId;
        const [[{ n }]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${ctx.t.ledger} WHERE account_id = ? AND reason = 'starter'`, [accountId]);
        assert.equal(Number(n), 1);
        assert.equal((await ctx.store.ledger.balance(accountId)).cash, STARTER_KIT.cash);
        const inv = await ctx.store.ledger.inventory(accountId);
        assert.deepEqual(inv.map(i => [i.itemId, i.quantity]), STARTER_KIT.seeds.map(s => [s.varietyId, s.quantity]));
        const [plots] = await ctx.pool.query(`SELECT slot FROM ${ctx.t.plots} WHERE account_id = ? ORDER BY slot`, [accountId]);
        assert.deepEqual(plots.map(p => p.slot), [1, 2]);
    });

    test('platform id formats: anonymous Twitch A-ids, bad snowflakes and the dev platform are refused', async () => {
        const isCode = (c) => (e) => e instanceof GameError && e.code === c;
        await assert.rejects(ctx.store.accounts.signIn({ platform: 'twitch_opaque', platformUserId: 'A1234567' }), isCode('VALIDATION'));
        await assert.rejects(ctx.store.accounts.signIn({ platform: 'discord', platformUserId: '123' }), isCode('VALIDATION'));
        await assert.rejects(ctx.store.accounts.signIn({ platform: 'twitch', platformUserId: '12a' }), isCode('VALIDATION'));
        await assert.rejects(ctx.store.accounts.signIn({ platform: 'myspace', platformUserId: '1' }), isCode('VALIDATION'));
        const prod = createStore({ db: ctx.pool, prefix: ctx.prefix, allowDevPlatform: false });
        await assert.rejects(prod.accounts.signIn({ platform: 'dev', platformUserId: 'x1' }), isCode('PLATFORM_NOT_ALLOWED'));
        const ok = await ctx.store.accounts.signIn({ platform: 'twitch_opaque', platformUserId: 'UaBc123' });
        assert.ok(ok.accountId > 0);
    });
});

describe('accounts: linking and unlinking', () => {
    test('link a fresh sign-in onto a main account, then the rules around it', async () => {
        const main = await player('discord', snowflake(), 'Main');
        const tw = await player('twitch', uid(), 'Main on Twitch');

        // Main creates a code; the Twitch sign-in redeems it.
        const created = await call('POST', '/account/link-code', { token: main.token, body: {} });
        assert.equal(created.status, 201);
        assert.match(created.json.code, /^[A-Z2-9]{8}$/);
        const spaced = `${created.json.code.slice(0, 4).toLowerCase()}-${created.json.code.slice(4)}`;
        const linked = await call('POST', '/account/link', { token: tw.token, body: { code: spaced } });
        assert.equal(linked.status, 200, linked.text);
        assert.equal(linked.json.accountId, main.accountId);
        assert.equal(linked.json.changed, true);
        assert.equal(linked.json.removedAccountId, tw.accountId, 'the fresh Twitch account was removed');
        const [[gone]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${ctx.t.accounts} WHERE id = ?`, [tw.accountId]);
        assert.equal(Number(gone.n), 0);

        // The old Twitch token is stale; the new one works and sees both sign-ins.
        assertErrorShape(await call('GET', '/account', { token: tw.token }), 'SESSION_STALE');
        const view = await call('GET', '/account', { token: linked.json.token });
        assert.equal(view.status, 200);
        assert.deepEqual(view.json.account.identities.map(i => i.platform).sort(), ['discord', 'twitch']);
        assert.equal(view.json.account.cash, STARTER_KIT.cash, 'only the main starter kit; saves are not merged');

        // A used code cannot be used again.
        const k = await player('kick', uid());
        assertErrorShape(await call('POST', '/account/link', { token: k.token, body: { code: created.json.code } }), 'LINK_CODE_INVALID');

        // A second Discord sign-in cannot join an account that already has Discord.
        const code2 = (await call('POST', '/account/link-code', { token: main.token, body: {} })).json.code;
        const d2 = await player('discord', snowflake());
        assertErrorShape(await call('POST', '/account/link', { token: d2.token, body: { code: code2 } }), 'PLATFORM_ALREADY_LINKED');

        // A Kick sign-in whose own account has progress cannot be moved (saves are never merged).
        await ctx.store.ledger.apply({ accountId: k.accountId, key: 'kick-progress-1', reason: 'sell', cash: 5 });
        assertErrorShape(await call('POST', '/account/link', { token: k.token, body: { code: code2 } }), 'SOURCE_HAS_PROGRESS');
        const [[still]] = await ctx.pool.query(`SELECT used_at FROM ${ctx.t.link_codes} WHERE account_id = ? ORDER BY id DESC LIMIT 1`, [main.accountId]);
        assert.equal(still.used_at, null, 'a refused redeem does not use up the code');

        // Unlinking: never the sign-in in use, only sign-ins on this account, and not within the cooldown.
        const newMain = linked.json.token;
        const twIdentity = view.json.account.identities.find(i => i.platform === 'twitch').id;
        const dIdentity = view.json.account.identities.find(i => i.platform === 'discord').id;
        assertErrorShape(await call('POST', '/account/unlink', { token: main.token, body: { identityId: dIdentity } }), 'CANNOT_UNLINK_CURRENT');
        assertErrorShape(await call('POST', '/account/unlink', { token: main.token, body: { identityId: k.identityId } }), 'IDENTITY_NOT_ON_ACCOUNT');
        const cool = await call('POST', '/account/unlink', { token: main.token, body: { identityId: twIdentity } });
        assertErrorShape(cool, 'LINK_COOLDOWN');
        assert.ok(cool.json.error.details.retryAt > clock);

        // Eight days later the unlink works; the unlinked Twitch sign-in then starts an empty account,
        // without a second starter kit.
        clock += 8 * DAY_MS;
        const un = await call('POST', '/account/unlink', { token: main.token, body: { identityId: twIdentity } });
        assert.equal(un.status, 200, un.text);
        assertErrorShape(await call('GET', '/account', { token: newMain }), 'SESSION_STALE');
        const again = await ctx.store.accounts.signIn({ platform: 'twitch', platformUserId: (await identityPuid(twIdentity)), displayName: 'Back' });
        assert.equal(again.createdAccount, true);
        assert.equal(again.starterGranted, false);
        assert.equal((await ctx.store.ledger.balance(again.accountId)).cash, 0);

        // ...and cannot hop straight back: it was unlinked less than 7 days ago.
        const code3 = (await call('POST', '/account/link-code', { token: main.token, body: {} })).json.code;
        const back = auth.sign({ accountId: again.accountId, identityId: twIdentity });
        assertErrorShape(await call('POST', '/account/link', { token: back, body: { code: code3 } }), 'LINK_COOLDOWN');
    });

    test('codes expire, at most 3 wait at once, and 10 wrong codes lock redeeming for an hour', async () => {
        const main = await player('kick', uid());
        const codes = [];
        for (let i = 0; i < LINKING.MAX_ACTIVE_CODES; i++) codes.push((await call('POST', '/account/link-code', { token: main.token, body: {} })).json.code);
        assertErrorShape(await call('POST', '/account/link-code', { token: main.token, body: {} }), 'LINK_CODE_LIMIT');

        const fresh = await player('discord', snowflake());
        clock += LINKING.CODE_TTL_MS + 1000;
        assertErrorShape(await call('POST', '/account/link', { token: fresh.token, body: { code: codes[0] } }), 'LINK_CODE_INVALID');
        assert.equal((await call('POST', '/account/link-code', { token: main.token, body: {} })).status, 201, 'expired codes free a slot');

        const guesser = await player('twitch', uid());
        for (let i = 0; i < LINKING.MAX_FAILED_CODES_PER_HOUR - 1; i++) {
            assertErrorShape(await call('POST', '/account/link', { token: guesser.token, body: { code: 'ZZZZZZZZ' } }), 'LINK_CODE_INVALID');
        }
        assertErrorShape(await call('POST', '/account/link', { token: guesser.token, body: { code: 'not valid!' } }), 'LINK_CODE_INVALID');
        const locked = await call('POST', '/account/link', { token: guesser.token, body: { code: 'ZZZZZZZZ' } });
        assertErrorShape(locked, 'LINK_TOO_MANY_ATTEMPTS');
        assert.equal(locked.status, 429);
        clock += 61 * 60 * 1000;
        assertErrorShape(await call('POST', '/account/link', { token: guesser.token, body: { code: 'ZZZZZZZZ' } }), 'LINK_CODE_INVALID', 'an hour later it may try again');
    });

    test('two sign-ins racing for one code: exactly one wins', async () => {
        const main = await player('dev', `race-main-${uid()}`);
        const code = (await call('POST', '/account/link-code', { token: main.token, body: {} })).json.code;
        const a = await player('twitch', uid());
        const b = await player('kick', uid());
        const [ra, rb] = await Promise.all([
            call('POST', '/account/link', { token: a.token, body: { code } }),
            call('POST', '/account/link', { token: b.token, body: { code } })
        ]);
        assert.deepEqual([ra.status, rb.status].sort(), [200, 400]);
        const loser = ra.status === 400 ? ra : rb;
        assertErrorShape(loser, 'LINK_CODE_INVALID');
    });
});

async function identityPuid(identityId) {
    const [[row]] = await ctx.pool.query(`SELECT platform_user_id FROM ${ctx.t.identities} WHERE id = ?`, [identityId]);
    return row.platform_user_id;
}

describe('privacy and jobs (store level)', () => {
    test('export lists the account data; delete leaves no row referencing the account', async () => {
        const privacy = createPrivacy({ db: ctx.pool, t: ctx.t });
        const main = await player('discord', snowflake());
        const other = await player('twitch', uid());
        const code = (await call('POST', '/account/link-code', { token: main.token, body: {} })).json.code;
        await call('POST', '/account/link', { token: other.token, body: { code } });
        await ctx.store.ledger.apply({ accountId: main.accountId, key: 'privacy-sale-1', reason: 'sell', cash: 25 });

        const exp = await privacy.exportAccount(main.accountId);
        assert.equal(exp.accounts.length, 1);
        assert.equal(exp.identities.length, 2);
        assert.ok(exp.ledger.length >= 2);
        assert.ok(exp.identity_events.length >= 3);

        const identityIds = exp.identities.map(i => i.id);
        await privacy.deleteAccount(main.accountId);
        assert.equal(await privacy.countReferences(main.accountId), 0);
        const [[ids]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${ctx.t.identities} WHERE id IN (?)`, [identityIds]);
        const [[evs]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${ctx.t.identity_events} WHERE identity_id IN (?)`, [identityIds]);
        assert.equal(Number(ids.n) + Number(evs.n), 0);
    });

    test('job lock: a second holder is refused until the first releases; runs are recorded', async () => {
        const release = await ctx.store.jobRuns.acquire('lock-test');
        assert.equal(typeof release, 'function');
        assert.equal(await ctx.store.jobRuns.acquire('lock-test'), null);
        await release();
        const again = await ctx.store.jobRuns.acquire('lock-test');
        assert.equal(typeof again, 'function');
        await again();
        await ctx.store.jobRuns.record('lock-test', { status: 'ok', startedAt: Date.now() - 5, finishedAt: Date.now(), durationMs: 5 });
        await ctx.store.jobRuns.record('lock-test', { status: 'error', startedAt: Date.now(), finishedAt: Date.now(), durationMs: 1, error: 'x'.repeat(400) });
        const [row] = (await ctx.store.jobRuns.list()).filter(r => r.name === 'lock-test');
        assert.equal(Number(row.runs), 2);
        assert.equal(Number(row.failures), 1);
        assert.equal(row.last_status, 'error');
        assert.equal(row.last_error.length, 255);
    });

    test('kill switch stored in config', async () => {
        assert.equal(await ctx.store.flags.jobDisabled('link-code-sweep'), false);
        await ctx.store.flags.set('jobs.disabled', ['link-code-sweep'], 'test');
        assert.equal(await ctx.store.flags.jobDisabled('link-code-sweep'), true);
        assert.equal(await ctx.store.flags.jobDisabled('other'), false);
        await ctx.store.flags.set('jobs.disabled', true, 'test');
        assert.equal(await ctx.store.flags.jobDisabled('other'), true);
    });

    test('the schema check sees all 24 tables', async () => {
        await ctx.store.assertSchema();
    });

    test('no request in this file produced a 500 or an unhandled error', () => {
        assert.deepEqual(errorsLogged, []);
    });
});
