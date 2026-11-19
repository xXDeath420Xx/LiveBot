// Greenhouse Tycoon (phase 3): players rename themselves (POST /api/v2/account/name).
//   - the validator (lib/validate.js playerName): 2-24 characters, letters, digits, spaces and . _ ' -,
//     at least one letter, control and formatting characters removed
//   - the word rules (lib/name-filter.js): the slur floor, the theme rule, names that pass for staff or brand
//   - at most once every 7 days (the first rename has no wait); the same name again changes nothing
//   - the state and the account view say when the next rename is allowed; another account is not touched
//   - Twitch panel players start as "Grower"
// The theme words this file tests are written backwards, so the source scan in domain.test.js stays clean.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setupTestDb, closePool, startApp, errorShape } from './_helpers.js';
import { createAuth } from '../../../services/cfx/http/auth.js';
import { createGame } from '../../../services/cfx/store/game.js';
import { playerName } from '../../../services/cfx/lib/validate.js';
import { nameProblem } from '../../../services/cfx/lib/name-filter.js';
import { NAMES, DAY_MS } from '../../../services/cfx/config/game.js';
import { GameError } from '../../../services/cfx/lib/errors.js';

const rev = (s) => s.split('').reverse().join('');
let ctx;
let srv;
let clock;

before(async () => {
    clock = Date.UTC(2027, 2, 1, 12, 0, 0);
    ctx = await setupTestDb({ now: () => clock });
    const auth = createAuth({ secret: crypto.randomBytes(32).toString('hex'), store: ctx.store });
    const game = createGame({ store: ctx.store });
    const config = {
        publicUrl: 'https://certifriedmultitool.com', publicOrigin: 'https://certifriedmultitool.com', publicPrefix: '/gh-api', gamePath: '/greenhouse',
        allowDevPlatform: true, twitchExt: { clientId: '7k7fn5nym3jx13sdl4d56yxlu0cytp', secret: null }, twitchOAuth: {}, kickOAuth: {}, dashboardSecret: ''
    };
    srv = await startApp({ store: ctx.store, auth, game, config, rateLimits: false });
});

after(async () => {
    await srv?.close();
    const left = await ctx?.cleanup();
    await closePool();
    assert.deepEqual(left, []);
});

async function signIn(name = 'Starter') {
    const r = await srv.call('POST', '/auth/dev', { body: { userId: `r-${crypto.randomBytes(5).toString('hex')}`, name }, key: false });
    assert.equal(r.status, 200, r.text);
    return r.json;
}

describe('the validator and the word rules', () => {
    test('playerName cleans and checks the shape', () => {
        assert.equal(playerName('  Leafy   Lu  '), 'Leafy Lu');
        assert.equal(playerName('Zoë the 2nd'), 'Zoë the 2nd');
        assert.equal(playerName("O'Brien-Smith"), "O'Brien-Smith");
        assert.equal(playerName('Ivy​\u0007'), 'Ivy');
        for (const bad of ['a', 'x'.repeat(25), '1234', '<b>bold</b>', 'semi;colon', '   ', 42, null, ['Leafy'], 'x'.repeat(500)]) {
            assert.throws(() => playerName(bad), (e) => e instanceof GameError && e.code === 'VALIDATION', JSON.stringify(bad));
        }
    });

    test('theme words, leet spellings, staff and brand names are refused; ordinary names pass', () => {
        for (const n of [rev('deeW'), rev('gniK deeW'), 'w33d', rev('hsuK'), 'B.l.a.c.k Market', rev('gnikomS ppaJ'), `${42 * 10} Club`]) {
            assert.equal(nameProblem(n), 'theme', n);
        }
        for (const n of ['Admin', 'The Moderator', 'CertiFried', 'Certifried Fan', 'Twitch', 'Official Grower']) {
            assert.equal(nameProblem(n), 'reserved', n);
        }
        for (const n of ['Fern Fan', 'Potter', 'Sweetheart', 'Wedding Planner', 'Supportive Sam', 'Grower', 'Moss Kicker', 'Spotted Leaf']) {
            assert.equal(nameProblem(n), null, n);
        }
    });
});

describe('POST /account/name', () => {
    test('renames once, then waits 7 days; the same name changes nothing', async () => {
        const s = await signIn('First Name');
        const ok = await srv.call('POST', '/account/name', { token: s.token, body: { name: '  Fern   Fan ' } });
        assert.equal(ok.status, 200, ok.text);
        assert.equal(ok.json.displayName, 'Fern Fan');
        assert.equal(ok.json.changed, true);
        assert.equal(ok.json.renameAvailableAtMs, clock + NAMES.RENAME_COOLDOWN_MS);

        const st = await srv.call('GET', '/state', { token: s.token });
        assert.equal(st.json.state.account.displayName, 'Fern Fan');
        assert.equal(st.json.state.account.renameAvailableAtMs, clock + NAMES.RENAME_COOLDOWN_MS);
        const acc = await srv.call('GET', '/account', { token: s.token });
        assert.equal(acc.json.account.renameAvailableAtMs, clock + NAMES.RENAME_COOLDOWN_MS);

        const same = await srv.call('POST', '/account/name', { token: s.token, body: { name: 'Fern Fan' } });
        assert.equal(same.status, 200);
        assert.equal(same.json.changed, false);

        const again = await srv.call('POST', '/account/name', { token: s.token, body: { name: 'Moss Maker' } });
        errorShape(assert, again, 'NAME_COOLDOWN');
        assert.equal(again.json.error.details.retryAtMs, clock + NAMES.RENAME_COOLDOWN_MS);

        clock += 7 * DAY_MS;
        const later = await srv.call('POST', '/account/name', { token: s.token, body: { name: 'Moss Maker' } });
        assert.equal(later.status, 200, later.text);
        assert.equal(later.json.displayName, 'Moss Maker');
        const st2 = await srv.call('GET', '/state', { token: s.token });
        assert.equal(st2.json.state.account.displayName, 'Moss Maker');
    });

    test('a rename bumps the state version, so other devices refetch', async () => {
        const s = await signIn('Version Check');
        const before = (await srv.call('GET', '/state', { token: s.token })).json.state;
        await srv.call('POST', '/account/name', { token: s.token, body: { name: 'Version Two' } });
        const poll = await srv.call('GET', `/state?v=${before.etag}`, { token: s.token });
        assert.equal(poll.status, 200, 'not 304: the name changed');
        assert.equal(poll.json.state.version, before.version + 1);
    });

    test('refused names: shape, theme, slurs, reserved; nothing changes and no wait starts', async () => {
        const s = await signIn('Keeps Name');
        const bad = [
            [{ name: 'x' }, 'VALIDATION'],
            [{ name: '<script>' }, 'VALIDATION'],
            [{ name: 12 }, 'VALIDATION'],
            [{}, 'VALIDATION'],
            [{ name: 'Fine', extra: 1 }, 'VALIDATION'],
            [{ name: rev('niaG deeW') }, 'NAME_NOT_ALLOWED'],
            [{ name: 'Admin' }, 'NAME_NOT_ALLOWED'],
            [{ name: rev('reggin') }, 'NAME_NOT_ALLOWED']
        ];
        for (const [body, code] of bad) {
            const r = await srv.call('POST', '/account/name', { token: s.token, body });
            errorShape(assert, r, code, JSON.stringify(body));
        }
        const st = await srv.call('GET', '/state', { token: s.token });
        assert.equal(st.json.state.account.displayName, 'Keeps Name');
        assert.equal(st.json.state.account.renameAvailableAtMs, null);
        const ok = await srv.call('POST', '/account/name', { token: s.token, body: { name: 'Allowed Now' } });
        assert.equal(ok.status, 200);
    });

    test('needs a session and an Idempotency-Key; only renames the caller', async () => {
        const a = await signIn('Alpha');
        const b = await signIn('Bravo');
        errorShape(assert, await srv.call('POST', '/account/name', { body: { name: 'Nobody' } }), 'UNAUTHORIZED');
        errorShape(assert, await srv.call('POST', '/account/name', { token: a.token, body: { name: 'No Key' }, key: false }), 'IDEMPOTENCY_KEY_REQUIRED');
        await srv.call('POST', '/account/name', { token: a.token, body: { name: 'Alpha Two' } });
        const sb = await srv.call('GET', '/state', { token: b.token });
        assert.equal(sb.json.state.account.displayName, 'Bravo');
    });

    test('Twitch panel players start as Grower', async () => {
        const r = await ctx.store.accounts.signInTwitchPanel({ opaqueId: `U${crypto.randomBytes(6).toString('hex')}` });
        const [rows] = await ctx.pool.query(`SELECT display_name FROM ${ctx.t.accounts} WHERE id = ?`, [r.accountId]);
        assert.equal(rows[0].display_name, 'Grower');
        const shared = await ctx.store.accounts.signInTwitchPanel({ opaqueId: `U${crypto.randomBytes(6).toString('hex')}`, userId: String(900_000_000 + crypto.randomInt(1e6)) });
        const [rows2] = await ctx.pool.query(`SELECT display_name FROM ${ctx.t.accounts} WHERE id = ?`, [shared.accountId]);
        assert.equal(rows2[0].display_name, 'Grower');
    });
});
