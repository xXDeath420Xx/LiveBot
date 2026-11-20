import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PermissionFlagsBits } from 'discord.js';
import { createWatchSessions } from '../core/activities/watch/sessions.js';
import { activityConfig, activityProblem } from '../core/activities/config.js';
import { exchangeCode, checkInstance, signSession, verifySession, verifyProxySignature, ActivityAuthError } from '../core/activities/discord-auth.js';
import { setIntent, takeIntent, _resetIntentsForTests } from '../core/activities/intents.js';
import { watchAvailability, memberRights } from '../core/activities/watch/guild-config.js';
import { allowedOrigins, createActivityMatcher, activityOrigin } from '../services/cfx/http/security.js';

/*
 * Discord Activities (docs/activities.md): Watch Together sessions (the shared clock, who controls, the screen cap,
 * idle end, host handover, the queue), sign-in (code exchange, the instance check, our session token, Discord's proxy
 * signature), /movie's launch intents, the server settings, and Greenhouse's activity host mode (origin and buckets).
 */

const G = '100000000000000001';
const C = '100000000000000002';
const users = { a: { id: '100000000000000011', name: 'Ash' }, b: { id: '100000000000000012', name: 'Birch' }, c: { id: '100000000000000013', name: 'Cedar' } };
const ITEM = (id = 'a'.repeat(32), extra = {}) => ({ id, name: 'Film', type: 'Movie', year: 2020, runtimeSec: 100, mediaSourceId: id, audio: [{ index: 1 }], subtitles: [{ index: 3, label: 'English', text: true }, { index: 4, label: 'PGS', text: false }], ...extra });

function setup({ maxSessions = 2, idleEndSec = 120 } = {}) {
    let t = 1_000_000;
    const log = { started: [], stopped: [] };
    const cfg = { watch: { maxSessions, maxViewers: 3, maxBitrateKbps: 6000, idleEndSec, hostHandoverSec: 60 } };
    const media = {
        startPlayback: async (o) => { log.started.push(o); return { playSessionId: `ps${log.started.length}`, path: `/videos/${o.item.id}/master.m3u8?x=1`, runtimeSec: 100, remux: true }; },
        stopPlayback: async (o) => { log.stopped.push(o.playSessionId); },
    };
    const advanced = [];
    const w = createWatchSessions({ cfg, media, now: () => t, onAdvance: async (s, i) => { advanced.push(i); await w.play(s, { item: ITEM(s.queue[i].itemId), keepQueue: true, queueIndex: i }); } });
    return { w, log, advanced, tick: (ms) => { t += ms; }, now: () => t };
}

const inst = (n) => `i-10000000000000000${n}-gc-${G}-${C}`;

test('the shared clock: play, pause, seek; a late joiner gets the same position', async () => {
    const { w, tick } = setup();
    const s = w.open({ instanceId: inst(1), guildId: G, channelId: C, user: users.a });
    assert.equal(s.hostId, users.a.id, 'whoever opens it hosts');
    const events = [];
    w.join(s, users.a, (type, data) => events.push([type, data]));
    const v = await w.play(s, { item: ITEM() });
    assert.equal(v.media.src, `media/${s.id}/1/index.m3u8`);
    assert.deepEqual(v.media.subtitles.map((x) => x.index), [3], 'only text subtitles are offered per viewer');
    tick(10_000);
    assert.equal(w.effective(s), 10);
    await w.control(s, { action: 'pause' });
    tick(5_000);
    assert.equal(w.effective(s), 10, 'paused: the clock stops');
    await w.control(s, { action: 'seek', position: 42 });
    assert.equal(w.effective(s), 42);
    await w.control(s, { action: 'seek', position: 9999 });
    assert.equal(w.effective(s), 100, 'never past the end');
    await w.control(s, { action: 'seek', position: 50 });
    await w.control(s, { action: 'play' });
    tick(3_000);
    const late = [];
    w.join(s, users.b, (type, data) => late.push([type, data]));
    const st = late.at(-1)[1];
    assert.equal(st.playback.position + (st.serverNow - st.playback.at) / 1000, 53, 'the joiner computes the same position');
    assert.ok(events.length >= 5, 'everyone gets every change');
    await assert.rejects(w.control(s, { action: 'seek', position: 'x' }), /not a time/);
});

test('a new title kills the old stream, picture subtitles are burned only when chosen', async () => {
    const { w, log } = setup();
    const s = w.open({ instanceId: inst(1), guildId: G, channelId: C, user: users.a });
    await w.play(s, { item: ITEM(), burnSubtitleIndex: 3 });
    assert.equal(log.started[0].burnSubtitleIndex, null, 'a text subtitle is never burned');
    await w.play(s, { item: ITEM('b'.repeat(32)), burnSubtitleIndex: 4 });
    assert.equal(log.started[1].burnSubtitleIndex, 4);
    assert.deepEqual(log.stopped, ['ps1'], 'the first transcode was stopped');
    assert.equal(s.media.gen, 2);
    await w.control(s, { action: 'stop' });
    assert.equal(s.media, null);
    assert.deepEqual(log.stopped, ['ps1', 'ps2']);
});

test('the screen cap counts films playing across every server', async () => {
    const { w } = setup({ maxSessions: 1 });
    const s1 = w.open({ instanceId: inst(1), guildId: G, channelId: C, user: users.a });
    const s2 = w.open({ instanceId: inst(2), guildId: G, channelId: C, user: users.b });
    await w.play(s1, { item: ITEM() });
    await assert.rejects(w.play(s2, { item: ITEM() }), (e) => e.code === 'ALL_SCREENS_BUSY' && e.status === 429);
    await w.play(s1, { item: ITEM('b'.repeat(32)) }); // changing the title of a playing session is not a new screen
    await w.control(s1, { action: 'stop' });
    await w.play(s2, { item: ITEM() });
});

test('viewer cap, host handover, idle end', async () => {
    const { w, tick, log } = setup({ idleEndSec: 120 });
    const s = w.open({ instanceId: inst(1), guildId: G, channelId: C, user: users.a });
    const leaveA = w.join(s, users.a, () => {});
    w.join(s, users.b, () => {});
    w.join(s, users.c, () => {});
    assert.throws(() => w.join(s, { id: '100000000000000014', name: 'Dogwood' }, () => {}), (e) => e.code === 'FULL');
    await w.play(s, { item: ITEM() });
    leaveA();
    tick(30_000); await w.tick();
    assert.equal(s.hostId, users.a.id, 'not yet');
    tick(31_000); await w.tick();
    assert.equal(s.hostId, users.b.id, 'the longest-connected viewer hosts');
    const v = w.view(s);
    assert.ok(v.viewers.find((x) => x.id === users.b.id).controller);
    w.report(s, users.c.id, { buffering: true });
    assert.ok(w.view(s).viewers.find((x) => x.id === users.c.id).buffering);
    for (const viewer of s.viewers.values()) viewer.conns.clear();
    s.emptySince = null;
    await w.tick();
    tick(121_000); await w.tick();
    assert.equal(w.get(inst(1)), null, 'ended when empty');
    assert.ok(log.stopped.includes('ps1'), 'and its transcode stopped');
});

test('the queue moves on at the end of a title, and stops at the end of the last', async () => {
    const { w, tick, advanced } = setup();
    const s = w.open({ instanceId: inst(1), guildId: G, channelId: C, user: users.a });
    w.join(s, users.a, () => {});
    const q = [{ itemId: 'a'.repeat(32), label: 'E1' }, { itemId: 'b'.repeat(32), label: 'E2' }];
    await w.play(s, { item: ITEM(), queue: q, queueIndex: 0 });
    tick(100_000); await w.tick();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(advanced, [1]);
    assert.equal(s.queueIndex, 1);
    assert.equal(s.media.itemId, 'b'.repeat(32));
    tick(100_000); await w.tick();
    assert.equal(s.playback.paused, true, 'the end of the queue pauses at the end');
    assert.equal(w.effective(s), 100);
});

test('sign-in: code exchange, the instance check, our session token', async () => {
    const cfg = { appId: '100000000000000999', clientSecret: 'secret-xyz', botToken: 'bot-token', sessionSecret: 's'.repeat(43), sessionTtlSec: 3600 };
    const seen = [];
    const fetchImpl = async (url, init) => {
        seen.push([String(url), init]);
        const json = (status, body) => ({ status, json: async () => body });
        if (String(url).endsWith('/oauth2/token')) {
            const form = new URLSearchParams(init.body);
            return form.get('code') === 'goodcode1234' ? json(200, { access_token: 'at', scope: 'identify', expires_in: 600 }) : json(400, { error: 'invalid_grant' });
        }
        if (String(url).includes('/activity-instances/')) {
            return String(url).includes('ended') ? json(404, {}) : json(200, { users: [users.a.id], location: { kind: 'gc', guild_id: G, channel_id: C } });
        }
        return json(404, {});
    };
    await assert.rejects(exchangeCode({ code: 'bad code!', cfg, fetchImpl }), (e) => e instanceof ActivityAuthError && e.status === 400);
    await assert.rejects(exchangeCode({ code: 'wrongcode123', cfg, fetchImpl }), (e) => e.code === 'CODE_REFUSED');
    const ok = await exchangeCode({ code: 'goodcode1234', cfg, fetchImpl });
    assert.equal(ok.accessToken, 'at');
    assert.ok(!seen.some(([u]) => u.includes('secret-xyz')), 'the client secret never goes in a URL');
    const inst1 = await checkInstance({ instanceId: inst(1), userId: users.a.id, cfg, fetchImpl, waitMs: 1 });
    assert.deepEqual([inst1.guildId, inst1.channelId, inst1.member], [G, C, true]);
    const notIn = await checkInstance({ instanceId: inst(1), userId: users.b.id, cfg, fetchImpl, tries: 2, waitMs: 1 });
    assert.equal(notIn.member, false, 'not listed in the instance');
    await assert.rejects(checkInstance({ instanceId: 'i-1-gc-x', userId: users.a.id, cfg, fetchImpl }), (e) => e.code === 'BAD_INSTANCE');
    const tok = signSession({ user: { ...users.a, avatar: null }, instance: inst1, cfg });
    const s = verifySession(tok, cfg);
    assert.deepEqual([s.userId, s.guildId, s.channelId, s.instanceId], [users.a.id, G, C, inst(1)]);
    assert.equal(verifySession(tok, { ...cfg, sessionSecret: 't'.repeat(43) }), null, 'another secret');
    assert.equal(verifySession(tok, cfg, Math.floor(Date.now() / 1000) + 7200), null, 'expired');
    assert.equal(verifySession(tok.slice(0, -2) + 'xx', cfg), null, 'tampered');
});

test('Discord\'s proxy signature, and Greenhouse\'s activity host mode', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const hex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({ created_at: now, expires_at: now + 60, user_id: users.a.id }));
    const headers = { 'x-signature-ed25519': crypto.sign(null, payload, privateKey).toString('hex'), 'x-signature-timestamp': String(now), 'x-discord-proxy-payload': payload.toString('base64') };
    assert.equal(verifyProxySignature(headers, hex, now), true);
    assert.equal(verifyProxySignature({ ...headers, 'x-signature-timestamp': String(now + 1) }, hex, now), false, 'timestamp must match');
    assert.equal(verifyProxySignature(headers, hex, now + 120), false, 'expired');
    assert.equal(verifyProxySignature(headers, 'ab'.repeat(32), now), false, 'another key');

    const APP = '1409904443125665875';
    assert.equal(activityOrigin(APP), `https://${APP}.discordsays.com`);
    assert.equal(activityOrigin('nope'), null);
    assert.ok(allowedOrigins({ activityAppId: APP }).has(`https://${APP}.discordsays.com`));
    assert.ok(!allowedOrigins({}).has(`https://${APP}.discordsays.com`), 'off without an id');
    const isAct = createActivityMatcher({ appId: APP, publicKey: hex });
    const req = (h) => ({ get: (k) => h[k.toLowerCase()] });
    assert.equal(isAct(req({ origin: `https://${APP}.discordsays.com` })), true);
    assert.equal(isAct(req({ origin: 'https://certifriedmultitool.com' })), false);
    assert.equal(isAct(req(headers)), true, 'Discord\'s signature without an Origin');
    assert.equal(createActivityMatcher({})(req({ origin: `https://${APP}.discordsays.com` })), false);
});

test('/movie intents, the server settings and who may do what', () => {
    _resetIntentsForTests();
    setIntent(G, users.a.id, { kind: 'watch', itemId: 'x' }, 1000);
    assert.equal(takeIntent(G, users.b.id, 1000), null, 'only for the person who picked');
    assert.deepEqual(takeIntent(G, users.a.id, 2000), { kind: 'watch', itemId: 'x' });
    assert.equal(takeIntent(G, users.a.id, 2000), null, 'taken once');
    setIntent(G, users.a.id, { kind: 'watch', itemId: 'x' }, 0);
    assert.equal(takeIntent(G, users.a.id, 11 * 60_000), null, 'expires after 10 minutes');
    assert.equal(setIntent(G, users.a.id, { kind: 'other' }), false);

    const on = { enabled: true, mode: 'activity' };
    assert.equal(watchAvailability({ activityEnabled: true, guildId: G, botInGuild: true, config: on }).ok, true);
    for (const [args, re] of [[{ activityEnabled: false }, /not switched on/], [{ guildId: null }, /DMs/], [{ botInGuild: false }, /not in this server/],
        [{ config: { enabled: false, mode: 'activity' } }, /not turned on Cinema/], [{ config: { enabled: true, mode: 'stream' } }, /Go Live stream/]]) {
        assert.match(watchAvailability({ activityEnabled: true, guildId: G, botInGuild: true, config: on, ...args }).reason, re);
    }
    const member = (perms = [], roles = []) => ({ permissions: { has: (p) => perms.includes(p) }, roles: { cache: { has: (r) => roles.includes(r) } } });
    assert.deepEqual(memberRights(member(), { config: {}, hostRoleId: null }), { start: true, control: false });
    assert.deepEqual(memberRights(member(), { config: {}, hostRoleId: 'h' }), { start: false, control: false }, 'host role set and missing');
    assert.deepEqual(memberRights(member([], ['h']), { config: {}, hostRoleId: 'h' }), { start: true, control: false });
    assert.deepEqual(memberRights(member([], ['c']), { config: { controlRoleId: 'c' }, hostRoleId: 'h' }), { start: true, control: true });
    assert.deepEqual(memberRights(member([PermissionFlagsBits.ManageGuild]), { config: {}, hostRoleId: 'h' }), { start: true, control: true });
    assert.deepEqual(memberRights(null, { config: {} }), { start: false, control: false });

    const cfg = activityConfig({ DISCORD_CLIENT_ID: '1409904443125665875', DASHBOARD_CLIENT_ID: '1409904443125665875', DASHBOARD_CLIENT_SECRET: 'dash', DISCORD_TOKEN: 'bot', SESSION_SECRET: 'abc', WATCH_MAX_SESSIONS: '99' });
    assert.equal(cfg.enabled, false, 'off until ACTIVITIES_ENABLED=1');
    assert.equal(cfg.clientSecret, 'dash', 'the dashboard\'s secret when it is the same application');
    assert.equal(cfg.botToken, 'bot');
    assert.equal(cfg.watch.maxSessions, 20, 'capped');
    assert.ok(cfg.sessionSecret.length >= 32, 'derived from SESSION_SECRET');
    assert.match(activityProblem(cfg), /ACTIVITIES_ENABLED/);
    assert.equal(activityProblem({ ...cfg, enabled: true }), null);
    const other = activityConfig({ DISCORD_CLIENT_ID: '1409904443125665875', ACTIVITY_APP_ID: '1409904443125665999', DASHBOARD_CLIENT_ID: '1409904443125665875', DASHBOARD_CLIENT_SECRET: 'dash', DISCORD_TOKEN: 'bot' });
    assert.equal(other.clientSecret, '', 'another application never borrows the bot\'s secret');
    assert.equal(other.botToken, '');
});
