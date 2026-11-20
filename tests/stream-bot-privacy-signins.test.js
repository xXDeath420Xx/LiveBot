import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pool from '../utils/db.js';
import { makeTables, makeProfile, fakeEncryption } from './fixtures/stream-bot-tables.js';
import { createStreamBotPrivacy } from '../core/stream-bot/privacy.js';
import { platformAccountsExport, platformAccountsDelete, revokePlatformTokens, REVOKE_URLS } from '../core/stream-bot/platform-accounts-privacy.js';
import { classifyTable } from '../core/privacy-tables.js';
import { CATEGORIES } from '../dashboard/content/legal/data-inventory.js';

/*
 * H-820: /privacy delete removes the member's own Twitch and Kick sign-ins (stream_platform_accounts, the multicast
 * "Connect" rows) and the multicast destinations made from them, revoking the tokens at Twitch and Kick first; export
 * lists them without tokens or stream keys. Throwaway copies of both tables (no FK, so the explicit delete is what
 * removes the destinations), and a stubbed fetch: nothing reaches Twitch or Kick.
 */

let T;
const ACC = () => `${T.prefix}signin_accounts`;
const DEST = () => `${T.prefix}signin_destinations`;
const enc = (s) => JSON.stringify(fakeEncryption.encrypt(s));
const OWNER = 'sbtest-signin-owner';
const OTHER = 'sbtest-signin-other';

function recorder(responses = {}) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        const u = String(url);
        calls.push({ url: u, body: init?.body ? String(init.body) : '' });
        const r = Object.entries(responses).find(([k]) => u.startsWith(k));
        if (r) return r[1](u, init);
        return new Response(null, { status: 200 });
    };
    return { calls, fetchImpl };
}

async function seed() {
    await pool.query(`DELETE FROM \`${DEST()}\``);
    await pool.query(`DELETE FROM \`${ACC()}\``);
    const add = async (owner, platform, uid, at, rt) => (await pool.query(`INSERT INTO \`${ACC()}\` (owner_discord_id, platform, platform_user_id, platform_username, access_token, refresh_token, scopes, status)
        VALUES (?, ?, ?, ?, ?, ?, 's', 'active')`, [owner, platform, uid, `${platform}_name`, at && enc(at), rt && enc(rt)]))[0].insertId;
    const ids = {
        twitch: await add(OWNER, 'twitch', '900000001', 'TW-AT-SECRET', 'TW-RT-SECRET'),
        kick: await add(OWNER, 'kick', '800000001', 'KK-AT-SECRET', 'KK-RT-SECRET'),
        youtube: await add(OWNER, 'youtube', 'UCsigntest', 'YT-AT', 'YT-RT'),
        other: await add(OTHER, 'twitch', '900000002', 'OTHER-AT', 'OTHER-RT'),
    };
    const dest = async (accountId, platform, name) => pool.query(`INSERT INTO \`${DEST()}\` (stream_key_id, account_id, platform, name, rtmp_url, dest_stream_key) VALUES (1, ?, ?, ?, 'rtmp://ingest.example/app', 'live_KEY_SECRET')`, [accountId, platform, name]);
    await dest(ids.twitch, 'twitch', 'Twitch (mine)');
    await dest(ids.kick, 'kick', 'Kick (mine)');
    await dest(null, 'custom', 'Typed in by hand');
    await dest(ids.other, 'twitch', 'Twitch (theirs)');
    return ids;
}

test.before(async () => {
    T = await makeTables(pool, 'si');
    await pool.query(`CREATE TABLE \`${ACC()}\` (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, owner_discord_id VARCHAR(32) NOT NULL, platform VARCHAR(40) NOT NULL,
        platform_user_id VARCHAR(128), platform_username VARCHAR(190), access_token TEXT, refresh_token TEXT, expires_at DATETIME NULL, scopes VARCHAR(500),
        status VARCHAR(20) NOT NULL DEFAULT 'active', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(`CREATE TABLE \`${DEST()}\` (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, stream_key_id BIGINT UNSIGNED NOT NULL, account_id BIGINT UNSIGNED NULL,
        platform VARCHAR(40) NOT NULL, name VARCHAR(120) NOT NULL, rtmp_url VARCHAR(500) NOT NULL, dest_stream_key VARCHAR(500) NOT NULL DEFAULT '', config_json LONGTEXT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1, priority INT NOT NULL DEFAULT 100, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
});
test.after(async () => {
    await pool.query(`DROP TABLE IF EXISTS \`${DEST()}\``).catch(() => {});
    await pool.query(`DROP TABLE IF EXISTS \`${ACC()}\``).catch(() => {});
    await T.drop();
    await pool.end().catch(() => {});
});

test('export: the Twitch and Kick sign-ins and their destinations, without tokens, ingest addresses or keys', async () => {
    await seed();
    const out = await platformAccountsExport(pool, OWNER, { table: ACC(), destinations: DEST() });
    assert.deepEqual(out.accounts.map((a) => a.platform).sort(), ['kick', 'twitch'], 'YouTube is youtube/privacy.js\'s; the other member is not here');
    assert.deepEqual(out.destinations.map((d) => d.name).sort(), ['Kick (mine)', 'Twitch (mine)'], 'not the hand-typed one, not theirs');
    const text = JSON.stringify(out);
    for (const s of ['SECRET', 'access_token', 'refresh_token', 'rtmp://', 'dest_stream_key']) assert.equal(text.includes(s), false, `${s} not exported`);
    assert.deepEqual(await platformAccountsExport(pool, 'sbtest-nobody', { table: ACC(), destinations: DEST() }), {});
});

test('delete: tokens revoked at Twitch and Kick first, then their destinations and the rows; nothing else touched', async () => {
    await seed();
    const { calls, fetchImpl } = recorder();
    const out = await platformAccountsDelete(pool, OWNER, { table: ACC(), destinations: DEST(), revoke: true, encryption: fakeEncryption, fetchImpl, clientIds: { twitch: 'cid-test' }, clientSecrets: { twitch: 'cs-test' } });
    assert.deepEqual(out, { [DEST()]: 2, [ACC()]: 2 });
    const tw = calls.filter((c) => c.url === REVOKE_URLS.twitch);
    assert.deepEqual(tw.map((c) => Object.fromEntries(new URLSearchParams(c.body))), [{ client_id: 'cid-test', token: 'TW-AT-SECRET' }]);
    const kick = calls.filter((c) => c.url.startsWith(REVOKE_URLS.kick)).map((c) => Object.fromEntries(new URL(c.url).searchParams));
    assert.deepEqual(kick, [{ token: 'KK-RT-SECRET', token_hint_type: 'refresh_token' }, { token: 'KK-AT-SECRET', token_hint_type: 'access_token' }]);
    const [left] = await pool.query(`SELECT owner_discord_id, platform FROM \`${ACC()}\` ORDER BY id`);
    assert.deepEqual(left.map((r) => `${r.owner_discord_id}:${r.platform}`), [`${OWNER}:youtube`, `${OTHER}:twitch`]);
    const [dleft] = await pool.query(`SELECT name FROM \`${DEST()}\` ORDER BY id`);
    assert.deepEqual(dleft.map((r) => r.name), ['Typed in by hand', 'Twitch (theirs)']);
    assert.deepEqual(await platformAccountsDelete(pool, OWNER, { table: ACC(), destinations: DEST() }), {}, 'nothing the second time');
});

test('Twitch: an expired access token is refreshed and the fresh one revoked; failures never stop the delete', async () => {
    const { calls, fetchImpl } = recorder({
        [REVOKE_URLS.twitch]: (u, init) => new Response(null, { status: new URLSearchParams(String(init.body)).get('token') === 'FRESH-AT' ? 200 : 400 }),
        'https://id.twitch.tv/oauth2/token': () => new Response(JSON.stringify({ access_token: 'FRESH-AT', refresh_token: 'FRESH-RT' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    await revokePlatformTokens('twitch', { accessToken: 'OLD-AT', refreshToken: 'RT-1' }, { fetchImpl, clientIds: { twitch: 'cid' }, clientSecrets: { twitch: 'cs' } });
    assert.deepEqual(calls.map((c) => [c.url, new URLSearchParams(c.body).get('token') || new URLSearchParams(c.body).get('grant_type')]), [
        [REVOKE_URLS.twitch, 'OLD-AT'], ['https://id.twitch.tv/oauth2/token', 'refresh_token'], [REVOKE_URLS.twitch, 'FRESH-AT'],
    ]);
    // Unreachable platforms: the rows still go.
    await seed();
    const boom = async () => { throw new Error('offline'); };
    const out = await platformAccountsDelete(pool, OWNER, { table: ACC(), destinations: DEST(), revoke: true, encryption: fakeEncryption, fetchImpl: boom, clientIds: { twitch: 'cid' } });
    assert.deepEqual(out, { [DEST()]: 2, [ACC()]: 2 });
    // No client id: Twitch is skipped, not called with a broken request.
    const r2 = recorder();
    assert.deepEqual(await revokePlatformTokens('twitch', { accessToken: 'X' }, { fetchImpl: r2.fetchImpl, clientIds: { twitch: '' } }), []);
    assert.equal(r2.calls.length, 0);
});

test('/privacy: exportFor lists the sign-ins with no profile; deleteFor uses them for the viewer lookups first, then removes them', async () => {
    await seed();
    const profile = await makeProfile(T.store, 'sbtest-si-streamer');
    // The member, as a viewer, chatted on Kick (800000001, their Kick sign-in) in someone else's channel.
    await T.store.insertEvent(profile.id, { platform: 'kick', type: 'chat', channelId: '1', user: { id: '800000001', login: 'k', name: 'K', roles: [] }, message: 'hi', metadata: {}, occurredAt: new Date() });
    const { calls, fetchImpl } = recorder();
    const p = createStreamBotPrivacy({ store: T.store, db: pool, encryption: fakeEncryption, fetchImpl, signInTables: { table: ACC(), destinations: DEST(), clientIds: { twitch: 'cid' } } });
    const ex = await p.exportFor(OWNER);
    assert.ok(ex, 'exported with no stream bot profile');
    assert.deepEqual(ex.tables.stream_platform_accounts.rows.map((r) => r.platform).sort(), ['kick', 'twitch']);
    assert.equal(ex.tables.stream_destinations_from_sign_ins.total, 2);
    assert.equal(JSON.stringify(ex).includes('SECRET'), false);
    const d = await p.deleteFor(OWNER);
    assert.equal(d.deleted[`${T.prefix}events`], 1, 'their Kick chat went: the sign-in was read before it was deleted');
    assert.equal(d.deleted[ACC()], 2);
    assert.equal(d.deleted[DEST()], 2);
    assert.ok(calls.some((c) => c.url === REVOKE_URLS.twitch) && calls.some((c) => c.url.startsWith(REVOKE_URLS.kick)), 'revoked at both');
    assert.equal(await p.exportFor(OWNER), null, 'nothing left to export (their YouTube row is in the real table only)');
    // Without signInTables, throwaway stores never touch the shared table.
    const plain = createStreamBotPrivacy({ store: T.store, db: pool });
    assert.equal(Object.keys((await plain.deleteFor(OTHER)).deleted).some((t) => t.includes('signin')), false);
});

test('wiring: privacy-manager reads the linked Twitch ids before the stream bot delete; the table is a secret; /legal/data says so', () => {
    const src = fs.readFileSync(new URL('../core/privacy-manager.js', import.meta.url), 'utf8');
    const before = src.indexOf('const linkedTwitchIds');
    assert.ok(before > 0 && before < src.indexOf('streamBotPrivacy().deleteFor(userId)'), 'read before the delete');
    assert.match(src, /linkedTwitchIds \?\?/);
    const sb = fs.readFileSync(new URL('../core/stream-bot/privacy.js', import.meta.url), 'utf8');
    assert.match(sb, /store\.prefix === 'stream_bot_' \? \{\} : signInTables/, 'real tables in production');
    assert.equal(classifyTable('stream_platform_accounts'), 'secret');
    const rows = CATEGORIES.find((c) => c.id === 'stream-bot').rows.map((r) => r.data + ' ' + r.remove);
    assert.ok(rows.some((r) => /Twitch and Kick sign-ins/.test(r) && /revokes the tokens at Twitch and Kick/.test(r)));
    assert.ok(rows.some((r) => /Multicast destinations made from one of those sign-ins/.test(r)));
});
