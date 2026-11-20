import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { default: pool } = await import('../utils/db.js');
const { createLastfmAuth, signParams, sameLastfmName, LastfmAuthError } = await import('../utils/services/lastfm-auth.js');
const { handleVerifyButton, verifiedLastfmName, VERIFY_PREFIX } = await import('../handlers/music/lastfm.js');
const { up: up473 } = await import('../migrations/473_lastfm_verified.js');

/*
 * Fix wave 7 (the H-817 caveat): /music lastfm link did not check that the Last.fm account belongs to the member, so
 * Dedicated Scrobbler could be claimed with someone else's account. Now Last.fm's web auth verifies it
 * (utils/services/lastfm-auth.js: auth.getToken, the member approves on last.fm, auth.getSession names the account),
 * the Verify button (handlers/music/lastfm.js) records the verified name (migration 473), and Dedicated Scrobbler is
 * awarded only for a verified link. Last.fm is never called here (fetch is stubbed); the database is a stub.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test.after(async () => { await pool.end().catch(() => {}); });

function fakeFetch(responses) {
    const calls = [];
    const fn = async (url, init) => {
        const body = Object.fromEntries(new URLSearchParams(String(init.body)));
        calls.push({ url, method: init.method, body });
        const r = responses[body.method];
        return { json: async () => (typeof r === 'function' ? r(body) : r) };
    };
    fn.calls = calls;
    return fn;
}

test('signing: sorted name+value pairs, format and callback left out, then the secret, md5', () => {
    const params = { method: 'auth.getSession', api_key: 'k123', token: 't456', format: 'json', callback: 'x' };
    const expected = crypto.createHash('md5').update('api_keyk123methodauth.getSessiontokent456' + 's3cret', 'utf8').digest('hex');
    assert.equal(signParams(params, 's3cret'), expected);
    assert.ok(sameLastfmName('MapleHollow', ' maplehollow '));
    assert.ok(!sameLastfmName('maplehollow', 'bramble'));
    assert.ok(!sameLastfmName('maplehollow', null));
});

test('auth: token, approve URL, session name; Last.fm errors become reasons; nothing without key and secret', async () => {
    const fetchImpl = fakeFetch({
        'auth.getToken': { token: 'fakeLastfmTokenForTests000000000' },
        'auth.getSession': (b) => (b.token === 'fakeLastfmTokenForTests000000000'
            ? { session: { name: 'MapleHollow', key: 'SESSION-KEY-SECRET', subscriber: 0 } }
            : { error: 15, message: 'This token has expired' }),
    });
    const auth = createLastfmAuth({ apiKey: 'k123', secret: 's3cret', fetchImpl });
    assert.equal(auth.configured(), true);
    const token = await auth.getToken();
    assert.equal(token, 'fakeLastfmTokenForTests000000000');
    const first = fetchImpl.calls[0];
    assert.equal(first.method, 'POST');
    assert.equal(first.body.format, 'json');
    assert.equal(first.body.api_sig, signParams({ method: 'auth.getToken', api_key: 'k123' }, 's3cret'));
    assert.ok(!JSON.stringify(fetchImpl.calls).includes('s3cret'), 'the shared secret is never sent');
    const url = new URL(auth.approveUrl(token));
    assert.equal(url.origin + url.pathname, 'https://www.last.fm/api/auth/');
    assert.equal(url.searchParams.get('token'), token);
    assert.equal(await auth.getSession(token), 'MapleHollow', 'only the name comes back, never the session key');
    await assert.rejects(auth.getSession('ffffffffffffffffffffffffffffffff'), (e) => e instanceof LastfmAuthError && e.reason === 'expired');
    await assert.rejects(auth.getSession('bad token!'), (e) => e.reason === 'expired', 'a malformed token is refused before any call');

    const pending = createLastfmAuth({ apiKey: 'k', secret: 's', fetchImpl: fakeFetch({ 'auth.getSession': { error: 14, message: 'Unauthorized Token' } }) });
    await assert.rejects(pending.getSession('fakeLastfmTokenForTests000000000'), (e) => e.reason === 'not_approved');
    const down = createLastfmAuth({ apiKey: 'k', secret: 's', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    await assert.rejects(down.getToken(), (e) => e.reason === 'failed');
    const none = createLastfmAuth({ apiKey: 'k', secret: '', fetchImpl: async () => { throw new Error('must not be called'); } });
    assert.equal(none.configured(), false);
    await assert.rejects(none.getToken(), (e) => e.reason === 'unconfigured');
});

function fakeDb({ row = null, noColumns = false } = {}) {
    const calls = [];
    return {
        calls,
        async execute(sql, params) {
            calls.push({ sql, params });
            if (noColumns && /verified_/.test(sql)) { const e = new Error("Unknown column 'verified_username'"); e.code = 'ER_BAD_FIELD_ERROR'; throw e; }
            if (/^SELECT/.test(sql.trim())) return [row ? [row] : []];
            return [{ affectedRows: 1 }];
        },
    };
}

function fakeInteraction(customId, userId = '400000000000000001') {
    const log = [];
    return {
        log, customId, user: { id: userId, bot: false }, guildId: '400000000000000999',
        async reply(p) { log.push(['reply', p]); },
        async deferUpdate() { log.push(['deferUpdate']); },
        async editReply(p) { log.push(['editReply', p]); },
    };
}

const TOKEN = 'fakeLastfmTokenForTests000000000';
const stubAuth = (result) => ({ async getSession() { if (result instanceof Error) throw result; return result; } });

test('verified link: read from verified_username (case-insensitive); unverified, missing or before migration 473 = null', async () => {
    assert.equal(await verifiedLastfmName(fakeDb({ row: { lastfm_username: 'MapleHollow', verified_username: 'maplehollow' } }), '1'), 'MapleHollow');
    assert.equal(await verifiedLastfmName(fakeDb({ row: { lastfm_username: 'someone_else', verified_username: 'maplehollow' } }), '1'), null, 'relinked to another name: unverified');
    assert.equal(await verifiedLastfmName(fakeDb({ row: { lastfm_username: 'MapleHollow', verified_username: null } }), '1'), null, 'existing links stay unverified');
    assert.equal(await verifiedLastfmName(fakeDb(), '1'), null);
    assert.equal(await verifiedLastfmName(fakeDb({ noColumns: true }), '1'), null, 'migration 473 not applied yet');
});

test('Verify button: only the member who linked; not yet approved keeps the buttons; expired removes them', async () => {
    const awards = [];
    const award = (...a) => { awards.push(a); return Promise.resolve(null); };
    const other = fakeInteraction(`${VERIFY_PREFIX}400000000000000001:${TOKEN}`, '400000000000000002');
    await handleVerifyButton(other, { auth: stubAuth('x'), db: fakeDb(), award });
    assert.equal(other.log[0][0], 'reply');
    assert.equal(other.log[0][1].ephemeral, true);

    const early = fakeInteraction(`${VERIFY_PREFIX}400000000000000001:${TOKEN}`);
    const db1 = fakeDb();
    await handleVerifyButton(early, { auth: stubAuth(new LastfmAuthError('not_approved')), db: db1, award });
    const [, p1] = early.log.at(-1);
    assert.match(p1.content, /Open Last\.fm/);
    assert.equal('components' in p1, false, 'the buttons stay so they can press Verify again');
    assert.equal(db1.calls.length, 0);

    const late = fakeInteraction(`${VERIFY_PREFIX}400000000000000001:${TOKEN}`);
    await handleVerifyButton(late, { auth: stubAuth(new LastfmAuthError('expired')), db: fakeDb(), award });
    assert.deepEqual(late.log.at(-1)[1].components, []);
    assert.equal(awards.length, 0, 'nothing awarded without a verified account');
});

test('Verify button: the approving account is recorded as verified and Dedicated Scrobbler is counted from it', async () => {
    const awards = [];
    const award = (ctx, key, opts) => { awards.push([key, opts]); return Promise.resolve(null); };
    const ix = fakeInteraction(`${VERIFY_PREFIX}400000000000000001:${TOKEN}`);
    const db = fakeDb({ row: { lastfm_username: 'typo_name' } });
    await handleVerifyButton(ix, { auth: stubAuth('MapleHollow'), db, award, playcount: async (n) => (n === 'MapleHollow' ? 12345 : 0) });
    const write = db.calls.find((c) => /INSERT INTO lastfm_accounts/.test(c.sql));
    assert.match(write.sql, /verified_username = VALUES\(verified_username\), verified_at = NOW\(\)/);
    assert.deepEqual(write.params, ['400000000000000001', 'MapleHollow', 'MapleHollow']);
    assert.equal(awards.length, 1);
    assert.equal(awards[0][0], 'scrobbler');
    assert.equal(await awards[0][1].total(), 12345, 'counted from the verified account');
    const [, done] = ix.log.at(-1);
    assert.match(done.content, /Verified: \*\*MapleHollow\*\*/);
    assert.match(done.content, /instead of \*\*typo_name\*\*/, 'says the link moved to the approving account');
    assert.deepEqual(done.components, []);
    assert.ok(!JSON.stringify(ix.log).includes('SESSION-KEY'), 'no session key anywhere');

    // Before migration 473: the link still follows the verified account; nothing breaks.
    const ix2 = fakeInteraction(`${VERIFY_PREFIX}400000000000000001:${TOKEN}`);
    const db2 = fakeDb({ noColumns: true });
    await handleVerifyButton(ix2, { auth: stubAuth('MapleHollow'), db: db2, award, playcount: async () => 1 });
    assert.ok(db2.calls.some((c) => /INSERT INTO lastfm_accounts \(discord_id, lastfm_username\) VALUES/.test(c.sql)));
    assert.match(ix2.log.at(-1)[1].content, /Verified/);
});

test('link and profile award Dedicated Scrobbler only for a verified link; the button is routed; docs say so', () => {
    const h = src('handlers/music/lastfm.js');
    const link = h.slice(h.indexOf('export async function handleLink'), h.indexOf('export async function handleVerifyButton'));
    assert.match(link, /if \(await verifiedLastfmName\(pool, interaction\.user\.id\)[^\n]*\{\n\s+awardAchievement\(interaction, 'scrobbler'/);
    assert.equal((link.match(/'scrobbler'/g) || []).length, 1, 'link awards the scrobbler only in the verified branch');
    assert.match(link, /counts only Last\.fm accounts verified as yours/);
    const profile = h.slice(h.indexOf('export async function handleProfile'));
    assert.match(profile, /sameLastfmName\(await verifiedLastfmName\(pool, targetUser\.id\)[^\n]*\{\n\s+awardAchievement\(interaction, 'scrobbler'/);
    assert.match(src('interactions/handlerRegistry.js'), /'lastfm_verify:': handleLastfmVerify,/);
    assert.match(src('dashboard/content/guides/achievements.js'), /\*\*Dedicated Scrobbler\*\* \(10,000 scrobbles on a Last\.fm account verified as yours/);
    assert.match(src('dashboard/content/legal/data-inventory.js'), /Your Last\.fm link: [^']*session key is never stored/);
});

test('migration 473: adds the two columns only when missing, nothing without the table', async () => {
    const run = async (state) => {
        const sql = [];
        const db = {
            async execute(q, params) {
                sql.push(q);
                if (/information_schema\.tables/.test(q)) return [[{ n: state.table ? 1 : 0 }]];
                if (/information_schema\.columns/.test(q)) return [[{ n: state.columns.includes(params[1]) ? 1 : 0 }]];
                return [{}];
            },
        };
        await up473(db);
        return sql.filter((q) => /^ALTER/.test(q));
    };
    assert.deepEqual(await run({ table: false, columns: [] }), []);
    const both = await run({ table: true, columns: [] });
    assert.equal(both.length, 2);
    assert.match(both[0], /ADD COLUMN verified_username VARCHAR\(255\) NULL/);
    assert.match(both[1], /ADD COLUMN verified_at DATETIME NULL/);
    assert.deepEqual(await run({ table: true, columns: ['verified_username', 'verified_at'] }), [], 'safe to re-run');
});
