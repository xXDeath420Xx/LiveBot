import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pool from '../utils/db.js';
import { makeTables, makeProfile, fakeEncryption } from './fixtures/stream-bot-tables.js';
import { createTokenSources, createTokenValidator, slotOf, VALIDATE_URL, TOKEN_URL } from '../core/twitch-token-validator.js';

/*
 * Hourly Twitch token validation (H-751, core/twitch-token-validator.js): every stored Twitch user token is checked
 * against /oauth2/validate once an hour, on a fixed minute per token, a few at a time; a refused token is refreshed,
 * and a refused refresh marks the grant so its page asks for a reconnect. Twitch is a fake fetch; the tables are
 * throwaway copies (the stream bot fixture plus small role-sync, linked-account, multicast and channel-bot tables).
 */

let T, store, profile;
const tag = crypto.randomBytes(3).toString('hex');
const tables = { roleSync: `ttv${tag}_rsc`, oauth: `ttv${tag}_toa`, platform: `ttv${tag}_spa`, tokes: `ttv${tag}_tpc` };
const fakeTokenEnc = { encryptToken: (s) => `te:${Buffer.from(s).toString('base64')}:x`, decryptToken: (s) => Buffer.from(String(s).split(':')[1], 'base64').toString() };
const J = (s) => JSON.stringify(fakeEncryption.encrypt(s));

test.before(async () => {
    T = await makeTables(pool, 'v');
    store = T.store;
    profile = await makeProfile(store);
    tables.grants = `${T.prefix}twitch_grants`;
    await pool.query(`CREATE TABLE \`${tables.roleSync}\` (guild_id VARCHAR(20) PRIMARY KEY, enabled TINYINT(1) DEFAULT 1, broadcaster_token LONGTEXT, broadcaster_refresh_token LONGTEXT,
        token_expires_at DATETIME, broadcaster_token_status VARCHAR(20) NOT NULL DEFAULT 'active', tier_b_token LONGTEXT, tier_b_refresh_token LONGTEXT, tier_b_token_expires_at DATETIME,
        tier_b_token_status VARCHAR(20) NOT NULL DEFAULT 'active', tier_b_scopes TEXT)`);
    await pool.query(`CREATE TABLE \`${tables.oauth}\` (discord_user_id VARCHAR(20) PRIMARY KEY, access_token TEXT, refresh_token TEXT, expires_at DATETIME, token_status VARCHAR(20) NOT NULL DEFAULT 'active')`);
    await pool.query(`CREATE TABLE \`${tables.platform}\` (id INT PRIMARY KEY AUTO_INCREMENT, platform VARCHAR(40), access_token TEXT, refresh_token TEXT, expires_at DATETIME, status VARCHAR(20) DEFAULT 'active')`);
    await pool.query(`CREATE TABLE \`${tables.tokes}\` (id INT PRIMARY KEY AUTO_INCREMENT, platform VARCHAR(10), access_token TEXT, refresh_token TEXT, expires_at TIMESTAMP NULL, token_updated_at TIMESTAMP NULL, needs_relink TINYINT(1) DEFAULT 0)`);
});
test.after(async () => {
    for (const t of [tables.roleSync, tables.oauth, tables.platform, tables.tokes]) await pool.query(`DROP TABLE IF EXISTS \`${t}\``);
    await T.drop();
    await pool.end().catch(() => {});
});

/** Fake Twitch: tokens starting ok- validate; rt-good refreshes; rt-bad is refused; 5xx- fails. */
function fakeTwitch({ onCall } = {}) {
    let inFlight = 0;
    const seen = { validate: [], refresh: [], maxInFlight: 0 };
    const fetchImpl = async (url, opts = {}) => {
        inFlight++;
        seen.maxInFlight = Math.max(seen.maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        onCall?.(url, opts);
        if (url === VALIDATE_URL) {
            const tok = String(opts.headers.Authorization).replace(/^OAuth /, '');
            seen.validate.push(tok);
            const status = tok.startsWith('ok-') ? 200 : tok.startsWith('5xx-') ? 503 : 401;
            return { status, ok: status === 200, json: async () => ({}) };
        }
        if (url === TOKEN_URL) {
            const rt = new URLSearchParams(opts.body).get('refresh_token');
            seen.refresh.push(rt);
            if (rt.startsWith('rt-good')) return { status: 200, ok: true, json: async () => ({ access_token: `ok-new-${rt}`, refresh_token: `${rt}-2`, expires_in: 14000 }) };
            return { status: 400, ok: false, json: async () => ({ status: 400, message: 'Invalid refresh token' }) };
        }
        return { status: 404, ok: false, json: async () => ({}) };
    };
    return { fetchImpl, seen };
}

test('each token gets a fixed minute, and a full hour spreads them out', () => {
    assert.equal(slotOf('stream_bot_grant:2'), slotOf('stream_bot_grant:2'));
    const counts = new Array(60).fill(0);
    for (let i = 0; i < 6000; i++) { const s = slotOf(`server_analytics:${1000000 + i}`); assert.ok(s >= 0 && s < 60); counts[s]++; }
    assert.ok(Math.max(...counts) < 160 && Math.min(...counts) > 50, `even enough: ${Math.min(...counts)}..${Math.max(...counts)}`);
});

test('outcomes: valid, refreshed and stored, marked when the refresh is refused or missing, untouched on a Twitch error; counts only in the log', async () => {
    const marked = [];
    const saved = [];
    const src = { key: 'x', list: async () => [], save: async (db, id, n) => saved.push([id, n]), mark: async (db, id) => marked.push(id) };
    const logs = [];
    const logger = { debug: (m) => logs.push(m), info: (m) => logs.push(m), warn: (m) => logs.push(m) };
    const { fetchImpl } = fakeTwitch();
    const v = createTokenValidator({ db: null, sources: [src], fetchImpl, logger, clientId: 'cid', clientSecret: 'shh-secret' });
    assert.equal(await v.checkOne(src, { id: '1', access: 'ok-a', refresh: 'rt-good-a' }), 'valid');
    assert.equal(await v.checkOne(src, { id: '2', access: 'dead-b', refresh: 'rt-good-b' }), 'refreshed');
    assert.deepEqual([saved[0][0], saved[0][1].access, saved[0][1].refresh], ['2', 'ok-new-rt-good-b', 'rt-good-b-2']);
    assert.ok(saved[0][1].expiresAt instanceof Date);
    assert.equal(await v.checkOne(src, { id: '3', access: 'dead-c', refresh: 'rt-bad-c' }), 'reauth');
    assert.equal(await v.checkOne(src, { id: '4', access: 'dead-d', refresh: null }), 'reauth');
    assert.equal(await v.checkOne(src, { id: '5', access: '5xx-e', refresh: 'rt-bad-e' }), 'error');
    assert.equal(await v.checkOne(src, { id: '6', access: undefined, refresh: null }), 'unreadable');
    assert.deepEqual(marked, ['3', '4']);
    const envOnly = { key: 'chat_bot_env', list: async () => [] };
    assert.equal(await v.checkOne(envOnly, { id: 'env', access: 'dead-env', refresh: null }), 'invalid');
    await v.runAll();
    for (const l of logs) for (const secret of ['ok-a', 'dead-b', 'rt-good', 'rt-bad', 'shh-secret', 'ok-new']) assert.ok(!l.includes(secret), `no token in "${l}"`);
});

test('a minute checks only its own tokens, at most three at a time; the tick runs each minute once and sums up the hour', async () => {
    const items = Array.from({ length: 400 }, (_, i) => ({ id: String(i), access: `ok-${i}`, refresh: null }));
    const src = { key: 'many', list: async () => items, mark: async () => {} };
    const { fetchImpl, seen } = fakeTwitch();
    const logs = [];
    let clock = Date.parse('2026-11-19T14:59:30Z');
    const v = createTokenValidator({ db: null, sources: [src], fetchImpl, now: () => clock, logger: { debug: () => {}, info: (m) => logs.push(m), warn: (m) => logs.push(m) } });
    const minute = slotOf('many:7');
    const r = await v.runSlot(minute);
    const expected = items.filter((it) => slotOf(`many:${it.id}`) === minute).length;
    assert.equal(r.total, expected);
    assert.equal(r.valid, expected);
    assert.ok(seen.maxInFlight <= 3, `at most 3 in flight (${seen.maxInFlight})`);
    // Every token is checked exactly once over the 60 minutes.
    const seenBefore = seen.validate.length;
    let all = 0;
    for (let m = 0; m < 60; m++) all += (await v.runSlot(m)).total;
    assert.equal(all, items.length);
    assert.equal(seen.validate.length - seenBefore, items.length);
    // tick: once per minute; the hour summary at minute 0 (counts only).
    const first = await v.tick();
    assert.ok(first);
    assert.equal(await v.tick(), null, 'the same minute is not run twice');
    clock = Date.parse('2026-11-19T16:00:05Z');
    await v.tick();
    assert.ok(logs.some((l) => /last hour: \d+ Twitch tokens checked; \d+ valid/.test(l)), 'hour summary');
});

test('the real table adapters: refresh rotates and stores, refused refreshes mark each kind of grant, then it is not checked again', async () => {
    // Stream bot grant (throwaway stream bot tables).
    await store.saveTwitchGrant(profile.id, { twitchUserId: '900000001', twitchLogin: 'maplehollow_tv', accessToken: 'dead-grant', refreshToken: 'rt-good-grant', expiresAt: new Date(), scopes: 'bits:read' });
    // Server grants: guild 1 analytics refreshes, write refused; guild 2 analytics fine.
    await pool.query(`INSERT INTO \`${tables.roleSync}\` (guild_id, broadcaster_token, broadcaster_refresh_token, tier_b_token, tier_b_refresh_token, tier_b_scopes) VALUES (?, ?, ?, ?, ?, 'moderator:manage:banned_users'), (?, ?, ?, NULL, NULL, NULL)`,
        ['111', J('dead-an1'), J('rt-good-an1'), J('dead-wr1'), J('rt-bad-wr1'), '222', J('ok-an2'), J('rt-good-an2')]);
    await pool.query(`INSERT INTO \`${tables.oauth}\` (discord_user_id, access_token, refresh_token) VALUES ('333', ?, NULL)`, [J('dead-link')]);
    await pool.query(`INSERT INTO \`${tables.platform}\` (platform, access_token, refresh_token) VALUES ('twitch', ?, ?), ('kick', ?, ?)`, [J('dead-mc'), J('rt-bad-mc'), J('dead-kick'), J('rt-bad-kick')]);
    await pool.query(`INSERT INTO \`${tables.tokes}\` (platform, access_token, refresh_token) VALUES ('twitch', ?, ?), ('kick', ?, ?)`,
        [fakeTokenEnc.encryptToken('dead-cb'), fakeTokenEnc.encryptToken('rt-good-cb'), fakeTokenEnc.encryptToken('dead-k'), fakeTokenEnc.encryptToken('rt-bad-k')]);

    const sources = createTokenSources({ encryption: fakeEncryption, tokenEncryption: fakeTokenEnc, env: { TWITCH_BOT_OAUTH: 'oauth:ok-bot' }, tables });
    assert.deepEqual(sources.map((s) => s.key), ['stream_bot_grant', 'server_analytics', 'server_write', 'linked_twitch', 'multicast_twitch', 'channel_bot_twitch', 'chat_bot_env']);
    // Other stream bot profiles in the real grant table are not in the throwaway one; only our rows count.
    const { fetchImpl, seen } = fakeTwitch();
    const v = createTokenValidator({ db: pool, sources, fetchImpl });
    const r = await v.runAll();
    assert.deepEqual({ valid: r.valid, refreshed: r.refreshed, reauth: r.reauth, error: r.error, unreadable: r.unreadable },
        { valid: 2, refreshed: 3, reauth: 3, error: 0, unreadable: 0 });
    assert.ok(!seen.validate.includes('dead-kick') && !seen.validate.includes('dead-k'), 'Kick tokens are not sent to Twitch');
    assert.ok(seen.validate.includes('ok-bot'), 'the chat bot token from .env is validated (oauth: prefix removed)');

    const g = await store.getTwitchGrantSecrets(profile.id);
    assert.deepEqual([g.status, g.accessToken, g.refreshToken], ['active', 'ok-new-rt-good-grant', 'rt-good-grant-2']);
    assert.ok(new Date(g.expiresAt).getTime() > Date.now() + 3 * 3600e3);
    const [[g1]] = await pool.query(`SELECT * FROM \`${tables.roleSync}\` WHERE guild_id = '111'`);
    assert.equal(fakeEncryption.decrypt(JSON.parse(g1.broadcaster_token)), 'ok-new-rt-good-an1');
    assert.deepEqual([g1.broadcaster_token_status, g1.tier_b_token_status], ['active', 'needs_reauth']);
    const [[link]] = await pool.query(`SELECT token_status FROM \`${tables.oauth}\` WHERE discord_user_id = '333'`);
    assert.equal(link.token_status, 'needs_reauth', 'no refresh token: marked straight away');
    const [mc] = await pool.query(`SELECT platform, status FROM \`${tables.platform}\` ORDER BY id`);
    assert.deepEqual(mc.map((x) => [x.platform, x.status]), [['twitch', 'needs_reconnect'], ['kick', 'active']]);
    const [cb] = await pool.query(`SELECT platform, access_token, needs_relink FROM \`${tables.tokes}\` ORDER BY id`);
    assert.deepEqual([fakeTokenEnc.decryptToken(cb[0].access_token), cb[0].needs_relink, cb[1].needs_relink], ['ok-new-rt-good-cb', 0, 0]);

    // Marked grants wait for a reconnect: the next pass leaves them out.
    const again = await createTokenValidator({ db: pool, sources, fetchImpl: fakeTwitch().fetchImpl }).runAll();
    assert.equal(again.reauth, 0);
    assert.equal(again.valid, 5, 'the refreshed ones and the fine ones (grant, two analytics, channel bot, chat bot)');
});
