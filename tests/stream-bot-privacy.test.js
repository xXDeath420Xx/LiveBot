import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pool from '../utils/db.js';
import { makeTables, makeProfile } from './fixtures/stream-bot-tables.js';
import { createStreamBotPrivacy } from '../core/stream-bot/privacy.js';
import { newDeviceToken, hashSecret, tokenHint } from '../core/stream-bot/pairing.js';
import { normaliseTwitch } from '../core/stream-bot/events.js';
import { classifyTable } from '../core/privacy-tables.js';
import { RETENTION_ROWS } from '../migrations/454_stream_bot.js';

/*
 * Stream bot data in /privacy (core/stream-bot/privacy.js, wired into core/privacy-manager.js; design §2.6), on
 * throwaway tables. As a streamer: export has the profile and everything under it with no tokens, hashes or
 * encrypted secrets; delete removes all of it. As a viewer: events and {db:} values tied to a linked Twitch or
 * Kick account are exported and deleted, in every profile. Also: retention rows exist for the logs, and the
 * secret tables are classified as secret.
 */

let T, store, profile, other;
const OWNER = 'sbtest-owner-1';
const VIEWER = 'sbtest-viewer-1';
const fakeDb = {
    async query(sql, params) {
        if (/twitch_oauth_accounts/.test(sql)) return [params[0] === VIEWER ? [{ twitch_user_id: '555001' }] : []];
        if (/stream_platform_accounts/.test(sql)) return [params[0] === VIEWER ? [{ platform: 'kick', platform_user_id: '777001' }] : []];
        return [[]];
    },
};

test.before(async () => {
    T = await makeTables(pool, 'p');
    store = T.store;
    profile = await makeProfile(store, OWNER);
    other = await store.ensureProfile('sbtest-other-1', 'Another streamer');
    await store.linkChannel(other.id, { platform: 'twitch', platformUserId: '900000002', login: 'bramblebyte_live', verifiedVia: 'stream_bot_grant' });
    await store.saveTwitchGrant(profile.id, { twitchUserId: '900000001', twitchLogin: 'maplehollow_tv', accessToken: 'tok-SECRET-access', refreshToken: 'tok-SECRET-refresh', expiresAt: null, scopes: 'bits:read user:read:chat' });
    await store.addTipSource(profile.id, { source: 'streamelements', secret: 'jwt-SECRET-token' });
    const token = newDeviceToken();
    await store.createDevice(profile.id, { kind: 'studio', name: 'Desk PC', tokenHash: hashSecret(token), tokenHint: tokenHint(token), capabilities: ['obs'] });
    const aid = await store.createAutomation(profile.id, { name: 'Thanks', trigger_type: 'follow', actions: [{ type: 'chat.send', platform: 'event', text: 'hi' }] });
    await store.createRun(profile.id, { automationId: aid, automationName: 'Thanks', status: 'ok' });
    await store.variableStore.set(profile.id, 'server', 'deaths', '4');
    // events in both profiles: some by the viewer (Twitch 555001, Kick 777001), one by someone else
    const tw = (bid, uid) => normaliseTwitch('channel.follow', { broadcaster_user_id: bid, user_id: uid, user_login: `u${uid}`, user_name: `U${uid}`, followed_at: new Date().toISOString() });
    await store.insertEvent(profile.id, tw('900000001', '555001'));
    await store.insertEvent(profile.id, tw('900000001', '123'));
    await store.insertEvent(other.id, tw('900000002', '555001'));
    await store.insertEvent(other.id, { platform: 'kick', type: 'chat', channelId: '1', user: { id: '777001', login: 'v', name: 'V', roles: [] }, message: 'hi', metadata: {}, occurredAt: new Date() });
    await store.variableStore.set(other.id, 'twitch:555001', 'points', '10');
});
test.after(async () => {
    await T.drop();
    await pool.end().catch(() => {});
});

test('streamer export: everything under the profile, no secrets anywhere', async () => {
    const p = createStreamBotPrivacy({ store, db: fakeDb, rowLimit: 1000 });
    const out = await p.exportFor(OWNER);
    const t = (n) => out.tables[`${T.prefix}${n}`];
    assert.equal(t('profiles').rows[0].ownerDiscordId, OWNER);
    assert.equal(t('channels').rows.length, 2);
    assert.equal(t('twitch_grants').rows[0].twitch_login, 'maplehollow_tv');
    assert.equal(t('tip_sources').rows[0].source, 'streamelements');
    assert.equal(t('automations').rows[0].name, 'Thanks');
    assert.equal(t('devices').rows[0].name, 'Desk PC');
    assert.equal(t('variables').rows[0].key_name, 'deaths');
    assert.equal(t('runs').rows.length, 1);
    assert.equal(t('events').rows.length, 2);
    const text = JSON.stringify(out);
    for (const secret of ['tok-SECRET', 'jwt-SECRET', 'token_hash', 'access_token', 'refresh_token']) assert.equal(text.includes(secret), false, `${secret} not exported`);
    const [[dev]] = await pool.query(`SELECT token_hash FROM \`${T.prefix}devices\` WHERE profile_id = ?`, [profile.id]);
    assert.equal(text.includes(dev.token_hash), false, 'no device hash');
    const [[src]] = await pool.query(`SELECT secret FROM \`${T.prefix}tip_sources\` WHERE profile_id = ?`, [profile.id]);
    assert.equal(text.includes(src.secret), false, 'no encrypted tip token');
    assert.match(out.note, /never included/);
});

test('viewer export: events about them and their values, from any streamer', async () => {
    const p = createStreamBotPrivacy({ store, db: fakeDb });
    const out = await p.exportFor(VIEWER);
    const events = out.tables[`${T.prefix}events_about_you`].rows;
    assert.equal(events.length, 3, 'two Twitch follows (two channels) and one Kick chat');
    assert.ok(events.every((e) => ['555001', '777001'].includes(e.user.id)));
    assert.equal(out.tables[`${T.prefix}values_for_you`].rows[0].key_name, 'points');
    assert.equal(await p.exportFor('sbtest-nobody'), null);
});

test('H-772: a viewer signed in with Twitch or Kick (no CertiFried account) gets only their own viewer rows, from every streamer', async () => {
    const p = createStreamBotPrivacy({ store, db: fakeDb });
    const out = await p.exportForAccounts([{ platform: 'twitch', id: '555001' }, { platform: 'kick', id: '777001' }]);
    assert.equal(out.tables[`${T.prefix}events_about_you`].rows.length, 3);
    assert.equal(out.tables[`${T.prefix}values_for_you`].rows[0].key_name, 'points');
    assert.ok(!Object.keys(out.tables).some((t) => /profiles|devices|grants|tip_sources|automations|runs/.test(t)), 'never a streamer profile');
    assert.deepEqual(Object.keys((await p.exportForAccounts([{ platform: 'kick', id: '555001' }])).tables), [], 'the platform matters: a Twitch id is not a Kick id');

    const tw = normaliseTwitch('channel.follow', { broadcaster_user_id: '900000002', user_id: '444001', user_login: 'u444', user_name: 'U444', followed_at: new Date().toISOString() });
    await store.insertEvent(other.id, tw);
    await store.variableStore.set(profile.id, 'twitch:444001', 'points', '3');
    const d = await p.deleteForAccounts([{ platform: 'twitch', id: '444001' }]);
    assert.deepEqual([d.deleted[`${T.prefix}events`], d.deleted[`${T.prefix}variables`]], [1, 1]);
    assert.deepEqual((await p.deleteForAccounts([{ platform: 'twitch', id: '444001' }])).deleted, {}, 'nothing the second time');
    assert.ok(await store.getProfile(profile.id), 'streamers untouched');
});

test('delete: the viewer\'s rows go from every profile; the streamer\'s whole profile goes', async () => {
    const p = createStreamBotPrivacy({ store, db: fakeDb });
    const v = await p.deleteFor(VIEWER);
    assert.equal(v.deleted[`${T.prefix}events`], 3);
    assert.equal(v.deleted[`${T.prefix}variables`], 1);
    const [[{ n: left }]] = await pool.query(`SELECT COUNT(*) AS n FROM \`${T.prefix}events\``);
    assert.equal(Number(left), 1, 'only the other person\'s event remains');

    const s = await p.deleteFor(OWNER);
    for (const name of ['profiles', 'channels', 'twitch_grants', 'tip_sources', 'automations', 'runs', 'devices', 'variables', 'events']) {
        assert.ok(s.deleted[`${T.prefix}${name}`] >= 1, `${name} deleted`);
        const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM \`${T.prefix}${name}\` WHERE ${name === 'profiles' ? 'id' : 'profile_id'} = ?`, [profile.id]);
        assert.equal(Number(n), 0, `${name} empty for the profile`);
    }
    assert.ok(await store.getProfile(other.id), 'other streamers untouched');
    assert.deepEqual(await p.deleteFor(OWNER), { deleted: {} }, 'nothing left the second time');
});

test('wired into /privacy, secret tables classified, retention rows for the logs', () => {
    const src = fs.readFileSync(new URL('../core/privacy-manager.js', import.meta.url), 'utf8');
    assert.match(src, /streamBotPrivacy\(\)\.exportFor\(userId\)/);
    assert.match(src, /streamBotPrivacy\(\)\.deleteFor\(userId\)/);
    for (const t of ['stream_bot_twitch_grants', 'stream_bot_tip_sources', 'stream_bot_devices', 'stream_bot_pairing_codes']) assert.equal(classifyTable(t), 'secret', t);
    const byTable = Object.fromEntries(RETENTION_ROWS.map(([t, c, d]) => [t, [c, d]]));
    assert.deepEqual(byTable.stream_bot_events, ['created_at', 90]);
    assert.deepEqual(byTable.stream_bot_runs, ['started_at', 30]);
    assert.ok(byTable.stream_bot_dispatch_queue && byTable.stream_bot_pairing_codes && byTable.stream_bot_variables);
});
