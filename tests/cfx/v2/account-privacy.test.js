// Greenhouse Tycoon (cfx v2): the website's "Your data" routes (register H-641).
//   GET  /api/v2/account/export   the save's export as a JSON download (3 an hour)
//   POST /api/v2/account/delete   { confirm: 'DELETE' }: the save and every sign-in linked to it, one transaction,
//                                 the session and refresh tokens end with it (5 attempts an hour)
// Checked: auth, the review save refused, the dev sign-in refused, the confirmation, the Idempotency-Key, the data
// really gone (and other saves untouched), sessions revoked, the rate limits, the log lines, and the privacy
// module's { accountId } guard. A real HTTP server on 127.0.0.1:<random port> over throwaway ghtest_ tables.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setupTestDb, closePool, quietLogger, startApp, errorShape } from './_helpers.js';
import { createAuth } from '../../../services/cfx/http/auth.js';
import { createPrivacy, createPersonPrivacy, SaveChangedError } from '../../../services/cfx/privacy/index.js';
import { DELETE_CONFIRM } from '../../../services/cfx/http/routes/account.js';
import { ACCOUNT_TABLES } from '../../../services/cfx/store/schema.js';

let ctx, auth, srv, limited;
const infos = [];
const logger = { ...quietLogger, info: (msg, meta) => infos.push({ msg, meta }) };
const uid = (platform = 'twitch') => (platform === 'discord'
    ? `1${String(crypto.randomInt(1e9, 9e9))}${String(crypto.randomInt(1e6, 9e6))}` // a 17-digit snowflake
    : String(crypto.randomInt(1e8, 9e8)));
let crossSeq = 0;

before(async () => {
    ctx = await setupTestDb();
    auth = createAuth({ secret: crypto.randomBytes(32).toString('hex'), store: ctx.store });
    srv = await startApp({ store: ctx.store, auth, logger, rateLimits: false });
});

after(async () => {
    try {
        await srv?.close();
        await limited?.close();
        const left = await ctx?.cleanup();
        assert.deepEqual(left, [], 'every ghtest table of this run was dropped');
        const [legacy] = await ctx.pool.query(
            `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE ?`,
            [`${ctx.prefix.replace(/_/g, '\\_')}%`]);
        assert.equal(Number(legacy[0].n), 0, 'nothing left under this run prefix (including the legacy_ sub-prefix)');
    } finally {
        await closePool();
    }
});

async function q(sql, params = []) {
    const [rows] = await ctx.pool.query(sql, params);
    return rows;
}

/** A player on platform with a session token and a refresh token (what a sign-in returns). */
async function player(platform, name = 'Grower') {
    const id = uid(platform);
    const s = await ctx.store.accounts.signIn({ platform, platformUserId: id, displayName: name });
    const tokens = await auth.issue({ accountId: s.accountId, identityId: s.identityId });
    return { ...s, platform, platformUserId: id, ...tokens };
}

/** Another sign-in linked to the save (as a link code would leave it), with its own refresh token. */
async function linkSignIn(accountId, platform) {
    const id = uid(platform);
    const r = await q(`INSERT INTO ${ctx.t.identities} (account_id, platform, platform_user_id, display_name, linked_at) VALUES (?, ?, ?, 'Linked', NOW(3))`,
        [accountId, platform, id]);
    const identityId = Number(r.insertId);
    await q(`INSERT INTO ${ctx.t.identity_events} (identity_id, account_id, event) VALUES (?, ?, 'linked')`, [identityId, accountId]);
    const tokens = await auth.issue({ accountId, identityId });
    return { identityId, platformUserId: id, ...tokens };
}

/** Rows in the save's tables plus a hybrid it bred first. */
async function seed(p) {
    const t = ctx.t;
    await ctx.store.ledger.apply({ accountId: p.accountId, key: `seed:${p.accountId}:1`, reason: 'test', cash: 300, items: [{ kind: 'seed', itemId: 1, delta: 2 }] });
    await q(`INSERT INTO ${t.link_codes} (account_id, code_hash, created_by_identity, expires_at) VALUES (?, ?, ?, NOW(3) + INTERVAL 10 MINUTE)`,
        [p.accountId, crypto.randomBytes(32).toString('hex'), p.identityId]);
    await q(`INSERT INTO ${t.notifications} (account_id, kind) VALUES (?, 'quest')`, [p.accountId]);
    const v = await q(`INSERT INTO ${t.varieties} (parent_a, parent_b, name, rarity, grow_ms, base_yield, base_price, first_bred_by) VALUES (?, ?, 'Test cross', 2, 1000, 2, 10, ?)`,
        [1, 100 + (++crossSeq), p.accountId]);
    return { varietyId: Number(v.insertId) };
}

const signInRows = async (ids) => q(`SELECT id FROM ${ctx.t.identities} WHERE id IN (?)`, [ids]);
const sessionRows = async (ids) => q(`SELECT id FROM ${ctx.t.sessions} WHERE identity_id IN (?)`, [ids]);
const refs = (accountId) => createPrivacy({ db: ctx.pool, t: ctx.t }).countReferences(accountId);

describe('auth', () => {
    test('both routes need a session', async () => {
        errorShape(assert, await srv.call('GET', '/account/export'), 'UNAUTHORIZED', 'export, no token');
        errorShape(assert, await srv.call('POST', '/account/delete', { body: { confirm: DELETE_CONFIRM } }), 'UNAUTHORIZED', 'delete, no token');
        errorShape(assert, await srv.call('GET', '/account/export', { token: 'x'.repeat(40) }), 'UNAUTHORIZED', 'export, bad token');
        errorShape(assert, await srv.call('POST', '/account/delete', { token: 'x'.repeat(40), body: { confirm: DELETE_CONFIRM } }), 'UNAUTHORIZED', 'delete, bad token');
    });

    test('the dev sign-in (tests only) is not a person the privacy module knows: refused, nothing deleted', async () => {
        const p = await player('dev');
        errorShape(assert, await srv.call('GET', '/account/export', { token: p.token }), 'PLATFORM_NOT_ALLOWED', 'export');
        errorShape(assert, await srv.call('POST', '/account/delete', { token: p.token, body: { confirm: DELETE_CONFIRM } }), 'PLATFORM_NOT_ALLOWED', 'delete');
        assert.ok(await refs(p.accountId) > 0);
    });
});

describe('the review save', () => {
    test('refuses both, and stays as it is', async () => {
        const who = await ctx.store.review.ensure();
        const token = auth.sign({ accountId: who.accountId, identityId: who.identityId });
        const before = await refs(who.accountId);
        errorShape(assert, await srv.call('GET', '/account/export', { token }), 'REVIEW_ACCOUNT', 'export');
        errorShape(assert, await srv.call('POST', '/account/delete', { token, body: { confirm: DELETE_CONFIRM } }), 'REVIEW_ACCOUNT', 'delete');
        assert.equal((await signInRows([who.identityId])).length, 1, 'review sign-in kept');
        assert.equal(await refs(who.accountId), before, 'review save unchanged');
    });
});

describe('GET /account/export', () => {
    test('the save, every linked sign-in, hashes redacted, as a download; nothing of other saves', async () => {
        const me = await player('twitch', 'Exporter');
        const kick = await linkSignIn(me.accountId, 'kick');
        const { varietyId } = await seed(me);
        const other = await player('discord', 'Bystander');
        await seed(other);
        infos.length = 0;

        const res = await srv.call('GET', '/account/export', { token: me.token });
        assert.equal(res.status, 200, res.text.slice(0, 200));
        assert.match(res.headers.get('content-type'), /^application\/json/);
        assert.match(res.headers.get('content-disposition'), /^attachment; filename="greenhouse-tycoon-data-\d{4}-\d{2}-\d{2}\.json"$/);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const x = res.json;
        assert.equal(x.greenhouse_account_id, me.accountId);
        assert.deepEqual(x.sign_in, { platform: 'twitch', platformUserId: me.platformUserId });
        assert.deepEqual(x.greenhouse_sign_ins.map(s => s.platform).sort(), ['kick', 'twitch']);
        assert.ok(x.greenhouse_sign_ins.some(s => s.platformUserId === kick.platformUserId));
        assert.equal(x.old_game_players, 0, 'no old game tables under the test prefix');
        const T = (name) => x.tables[ctx.t[name]];
        assert.equal(T('accounts').rows[0].id, me.accountId);
        assert.equal(T('accounts').rows[0].display_name, 'Exporter');
        assert.ok(T('ledger').rows.length >= 1);
        assert.ok(T('varieties').rows.some(r => r.id === varietyId), 'hybrid bred first');
        assert.equal(T('identities').rows.length, 2);
        assert.ok(T('sessions').rows.length >= 2, 'both sign-ins have a refresh family');
        for (const r of T('sessions').rows) assert.equal(r.token_hash, '[redacted]');
        for (const r of T('link_codes').rows) assert.equal(r.code_hash, '[redacted]');
        for (const [name, s] of Object.entries(x.tables)) {
            assert.equal(typeof s.total, 'number', name);
            assert.equal(s.truncated, false, name);
            for (const r of s.rows) {
                if ('account_id' in r && r.account_id != null) assert.equal(Number(r.account_id), me.accountId, `${name} row of another save`);
            }
        }
        assert.ok(!res.text.includes(other.platformUserId), 'nothing of the other player');
        const line = infos.find(i => i.msg === '[cfx2] privacy export');
        assert.ok(line, 'logged');
        assert.equal(line.meta.accountId, me.accountId);
        assert.ok(line.meta.rows > 0);
        assert.ok(!JSON.stringify(line.meta).includes(me.platformUserId), 'the log line names the save, not the platform id');
        // Read only: the save is all still there.
        assert.ok(await refs(me.accountId) > 0);
    });

    test('export is read-only and needs no Idempotency-Key', async () => {
        const me = await player('kick');
        const a = await srv.call('GET', '/account/export', { token: me.token });
        const b = await srv.call('GET', '/account/export', { token: me.token });
        assert.equal(a.status, 200);
        assert.equal(b.status, 200);
        assert.deepEqual(Object.keys(a.json.tables).sort(), Object.keys(b.json.tables).sort());
    });
});

describe('POST /account/delete', () => {
    test('the confirmation is required and must be the word DELETE', async () => {
        const me = await player('twitch', 'Careful');
        await seed(me);
        const before = await refs(me.accountId);
        errorShape(assert, await srv.call('POST', '/account/delete', { token: me.token, body: {} }), 'VALIDATION', 'missing');
        errorShape(assert, await srv.call('POST', '/account/delete', { token: me.token, body: { confirm: 1 } }), 'VALIDATION', 'not text');
        errorShape(assert, await srv.call('POST', '/account/delete', { token: me.token, body: { confirm: DELETE_CONFIRM, extra: true } }), 'VALIDATION', 'unknown key');
        for (const word of ['', 'delete', 'Delete', 'DELETE!', 'Careful', 'yes']) {
            const r = await srv.call('POST', '/account/delete', { token: me.token, body: { confirm: word } });
            errorShape(assert, r, word === '' ? 'DELETE_CONFIRM_REQUIRED' : 'DELETE_CONFIRM_REQUIRED', `"${word}"`);
            assert.equal(r.status, 400);
            assert.equal(r.json.error.message, 'Type DELETE to confirm.');
        }
        assert.equal(await refs(me.accountId), before, 'nothing deleted');
    });

    test('needs an Idempotency-Key like every POST', async () => {
        const me = await player('kick');
        errorShape(assert, await srv.call('POST', '/account/delete', { token: me.token, body: { confirm: DELETE_CONFIRM }, key: false }), 'IDEMPOTENCY_KEY_REQUIRED');
        assert.ok(await refs(me.accountId) > 0, 'nothing deleted');
    });

    test('deletes the save and every linked sign-in, ends the sessions; a retry deletes nothing more', async () => {
        const me = await player('twitch', 'Leaving');
        const kick = await linkSignIn(me.accountId, 'kick');
        const disc = await linkSignIn(me.accountId, 'discord');
        const { varietyId } = await seed(me);
        const other = await player('kick', 'Staying');
        await seed(other);
        const otherBefore = await refs(other.accountId);
        const ids = [me.identityId, kick.identityId, disc.identityId];
        assert.equal((await sessionRows(ids)).length, 3, 'three refresh families before');
        assert.equal((await srv.call('GET', '/state', { token: me.token })).status, 200, 'session works before');
        infos.length = 0;

        const key = `h641-delete-${crypto.randomBytes(6).toString('hex')}`;
        const res = await srv.call('POST', '/account/delete', { token: me.token, body: { confirm: ` ${DELETE_CONFIRM} ` }, key });
        assert.equal(res.status, 200, res.text.slice(0, 300));
        assert.equal(res.json.deleted, true);
        assert.equal(res.json.signedOut, true);
        assert.ok(res.json.rows > 0);
        assert.deepEqual(res.json.signIns.sort(), ['discord', 'kick', 'twitch']);

        // Data gone: no row anywhere references the save; the sign-ins and their sessions are gone.
        assert.equal(await refs(me.accountId), 0);
        for (const name of ACCOUNT_TABLES) {
            assert.equal((await q(`SELECT COUNT(*) AS n FROM ${ctx.t[name]} WHERE account_id = ?`, [me.accountId]))[0].n, 0, name);
        }
        assert.deepEqual(await signInRows(ids), []);
        assert.deepEqual(await sessionRows(ids), []);
        assert.equal((await q(`SELECT COUNT(*) AS n FROM ${ctx.t.identity_events} WHERE identity_id IN (?)`, [ids]))[0].n, 0);
        const v = await q(`SELECT first_bred_by FROM ${ctx.t.varieties} WHERE id = ?`, [varietyId]);
        assert.equal(v.length, 1, 'the hybrid stays in the shared catalogue');
        assert.equal(v[0].first_bred_by, null, 'without the save');

        // Sessions ended: the session token is stale, every refresh token of the save is refused.
        errorShape(assert, await srv.call('GET', '/state', { token: me.token }), 'SESSION_STALE', 'old session token');
        errorShape(assert, await srv.call('GET', '/account/export', { token: me.token }), 'SESSION_STALE', 'export afterwards');
        for (const rt of [me.refreshToken, kick.refreshToken, disc.refreshToken]) {
            errorShape(assert, await srv.call('POST', '/auth/refresh', { body: { refreshToken: rt }, key: false }), 'UNAUTHORIZED', 'refresh token');
        }

        // A retry with the same Idempotency-Key (the answer was lost) finds the session ended and changes nothing.
        errorShape(assert, await srv.call('POST', '/account/delete', { token: me.token, body: { confirm: DELETE_CONFIRM }, key }), 'SESSION_STALE', 'retry');
        assert.equal(await refs(other.accountId), otherBefore, 'the other save is untouched');
        assert.equal((await signInRows([other.identityId])).length, 1);

        const line = infos.find(i => i.msg === '[cfx2] privacy delete');
        assert.ok(line, 'logged');
        assert.equal(line.meta.accountId, me.accountId);
        assert.deepEqual([...line.meta.signIns].sort(), ['discord', 'kick', 'twitch']);
        assert.ok(line.meta.deleted > 0);
        assert.ok(!JSON.stringify(line.meta).includes(me.platformUserId), 'the log line names the save, not the platform id');

        // The same platform id can start over with a fresh save.
        const again = await ctx.store.accounts.signIn({ platform: 'twitch', platformUserId: me.platformUserId, displayName: 'Back' });
        assert.notEqual(again.accountId, me.accountId);
    });

    test('a session whose sign-in moved to another save is stale and deletes nothing', async () => {
        const a = await player('twitch');
        const b = await player('discord');
        // The Twitch sign-in is moved onto save b (as a link would); the old token still names save a.
        await q(`UPDATE ${ctx.t.identities} SET account_id = NULL WHERE id = ?`, [b.identityId]);
        await q(`UPDATE ${ctx.t.identities} SET account_id = ? WHERE id = ?`, [b.accountId, a.identityId]);
        errorShape(assert, await srv.call('POST', '/account/delete', { token: a.token, body: { confirm: DELETE_CONFIRM } }), 'SESSION_STALE');
        assert.ok(await refs(b.accountId) > 0, 'save b untouched');
    });
});

describe('privacy module guard', () => {
    test('exportFor / deleteFor with { accountId } refuse a sign-in on another save', async () => {
        const privacy = createPersonPrivacy({ db: ctx.pool, prefix: ctx.prefix, legacyPrefix: `${ctx.prefix}legacy_` });
        const me = await player('kick');
        const key = { platform: 'kick', platformUserId: me.platformUserId };
        await assert.rejects(privacy.exportFor(key, { accountId: me.accountId + 999 }), SaveChangedError);
        await assert.rejects(privacy.deleteFor(key, { accountId: me.accountId + 999 }), (err) => err.code === 'SAVE_CHANGED');
        assert.ok(await refs(me.accountId) > 0, 'nothing deleted');
        const ok = await privacy.exportFor(key, { accountId: me.accountId });
        assert.equal(ok.accountId, me.accountId);
    });
});

describe('rate limits (default limits)', () => {
    test('3 exports and 5 delete attempts an hour per save, then 429 with Retry-After', async () => {
        limited = await startApp({ store: ctx.store, auth, logger });
        const me = await player('twitch');
        for (let i = 0; i < 3; i++) assert.equal((await limited.call('GET', '/account/export', { token: me.token })).status, 200, `export ${i + 1}`);
        const r = await limited.call('GET', '/account/export', { token: me.token });
        errorShape(assert, r, 'RATE_LIMITED', 'fourth export');
        assert.ok(Number(r.headers.get('retry-after')) > 60, 'retry in minutes, not seconds');
        for (let i = 0; i < 5; i++) errorShape(assert, await limited.call('POST', '/account/delete', { token: me.token, body: { confirm: 'no' } }), 'DELETE_CONFIRM_REQUIRED', `attempt ${i + 1}`);
        errorShape(assert, await limited.call('POST', '/account/delete', { token: me.token, body: { confirm: DELETE_CONFIRM } }), 'RATE_LIMITED', 'sixth attempt');
        assert.ok(await refs(me.accountId) > 0, 'nothing deleted');
        // Another save has its own budget.
        const other = await player('kick');
        assert.equal((await limited.call('GET', '/account/export', { token: other.token })).status, 200);
    });
});
