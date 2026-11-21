import './fixtures/test-log-dir.js';
/*
 * Google OAuth verification fixes (2026-11-21), the parts that need no database:
 *
 *   rewards    YouTube viewers earn no points (follow, membership, gifted memberships, watch time), the points commands, the
 *              store, points games, raffles and media share answer YouTube chat that they are Twitch and Kick only, the
 *              automation Give / Set points steps skip YouTube, the line-up gives YouTube members no priority, the
 *              seeded community commands leave YouTube out of points features, an import drops points steps from
 *              YouTube-only automations
 *   scopes     only youtube.force-ssl and youtube.readonly can be asked for; the multicast connect no longer asks for the
 *              broad youtube scope; no source file names another Google scope
 *   gate       YouTube linking before approval: owner and listed reviewers only, fails closed, one switch to open it
 *   retention  `<table>__youtube` policy rows resolve to fixed conditions; migration 480's rows are all 30 days
 *   pages      Connections in review, the viewer page of a YouTube viewer, /privacy's Google user data section
 *
 * The database half (the viewer store refusing YouTube points, linking, imports, the scoped sweep) is in
 * tests/youtube-no-rewards-db.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { noRewards, POINTS_PLATFORMS, youtubeOnlyTrigger, dropRewardSteps, YT_POINTS_REPLY, YT_POINTS_NOTE } from '../core/stream-bot/youtube/policy.js';
import { createViewerService } from '../core/stream-bot/viewers/service.js';
import { withDefaults } from '../core/stream-bot/viewers/settings.js';
import { viewerActions } from '../core/stream-bot/viewers/register.js';
import { createShop } from '../core/stream-bot/community/shop.js';
import { createGames } from '../core/stream-bot/community/games.js';
import { createMediaShare } from '../core/stream-bot/community/media.js';
import { commandDrafts } from '../core/stream-bot/community/seed.js';
import { buildPlan } from '../core/stream-bot/import/mapper.js';
import * as actionsMod from '../core/stream-bot/actions.js';
import { YT_SCOPE, ALLOWED_GOOGLE_SCOPES, LEGACY_FULL_SCOPE, assertAllowedScopes, BOT_SCOPES, VIEWER_SCOPES, canWrite } from '../core/stream-bot/youtube/config.js';
import { getAuthUrl } from '../dashboard/services/platforms/youtube.js';
import { VIEWER_PROVIDERS } from '../core/stream-bot/viewer-signin.js';
import { createYouTubeGate, IN_REVIEW_TEXT, OWNER_DISCORD_ID, MAX_REVIEWERS } from '../core/stream-bot/youtube/gate.js';
import { resolvePolicy, SCOPED_GUARDS, sweepGuard } from '../jobs/retention-sweeper.js';
import { RETENTION_ROWS } from '../migrations/480_youtube_google_verification.js';
import { youtubePanel, connectionNotice } from '../dashboard/services/stream-bot-view.js';
import { personView } from '../dashboard/services/stream-bot-viewers-view.js';
import { reviewNotice } from '../dashboard/routes/youtube-review.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const FAN = 'UCfAnOfMaPlE000000000001';
const CH = 'UCmApLeHoLLoW00000000001';

// ── a viewer service on fakes: records every points change ──────────────────────────────────

function fakeViewers({ settings = {} } = {}) {
    const changes = [];
    const bulk = [];
    const rows = new Map();
    let next = 1;
    const rowFor = (platform, u) => {
        const k = `${platform}:${u.id}`;
        if (!rows.has(k)) rows.set(k, { id: next++, platform, platformUserId: String(u.id), login: u.login || null, name: u.name || null, roles: u.roles || [], personId: null, rankName: null });
        return rows.get(k);
    };
    const vstore = {
        async available() { return true; },
        async addStats(pid, platform, u) { return rowFor(platform, u); },
        async seen(pid, platform, users) { return users.map((u) => ({ row: rowFor(platform, u), beforeMinutes: 0 })); },
        async addTip() {},
        async changePoints(pid, id, amount) { changes.push({ id, amount }); return { ok: true, change: amount, before: 0, balance: amount, targetId: id }; },
        async addPointsBulk(pid, awards) { bulk.push(...awards.entries()); return awards.size; },
        async personTotals(pid, ids) { return new Map(ids.map((i) => [i, { watch: 0, messages: 0, points: 0, rankName: null }])); },
        async byAccount(pid, platform, id) { return rows.get(`${platform}:${id}`) || null; },
        async person() { return { primary: {}, points: 500, totals: { watchMinutes: 0, messages: 0 } }; },
        async get(pid, id) { return [...rows.values()].find((r) => r.id === id) || null; },
        async byLogin() { return null; },
        async setRank() {},
        async addHistory() {},
    };
    const store = { async getProfile() { return { settings: { viewers: settings } }; }, async setSettingsKey() {} };
    const svc = createViewerService({ db: null, store, vstore, streamInfo: { async get() { return { live: true }; } } });
    return { svc, changes, bulk, vstore };
}
const yt = (type, extra = {}) => ({ platform: 'youtube', type, channelId: CH, user: { id: FAN, login: 'maplefan88', name: 'MapleFan88', roles: [] }, amount: null, metadata: {}, occurredAt: new Date().toISOString(), ...extra });
const tw = (type, extra = {}) => ({ platform: 'twitch', type, channelId: '1', user: { id: '77', login: 'leaf', name: 'Leaf', roles: [] }, amount: null, metadata: {}, occurredAt: new Date().toISOString(), ...extra });

test('policy: YouTube only, the steps that give points, the YouTube-only triggers', () => {
    assert.equal(noRewards('youtube'), true);
    assert.equal(noRewards('twitch'), false);
    assert.deepEqual(POINTS_PLATFORMS, ['twitch', 'kick']);
    assert.ok(youtubeOnlyTrigger('chat', { platforms: ['youtube'] }));
    assert.ok(!youtubeOnlyTrigger('chat', { platforms: ['twitch', 'youtube'] }), 'a trigger that also fires on Twitch keeps its steps (they are skipped at run time on YouTube)');
    assert.ok(youtubeOnlyTrigger('membership', {}), 'membership: YouTube is its only viewer platform');
    assert.ok(youtubeOnlyTrigger('membership', { platforms: ['youtube', 'kofi'] }));
    assert.ok(!youtubeOnlyTrigger('membership', { platforms: ['kofi'] }));
    const d = dropRewardSteps([{ type: 'points.add', amount: '50' }, { type: 'chat.send', text: 'hi' }, { type: 'random', branches: [{ weight: 1, actions: [{ type: 'points.set', amount: '1' }, { type: 'points.remove', amount: '1' }] }] }]);
    assert.equal(d.removed, 2);
    assert.deepEqual(d.actions.map((s) => s.type), ['chat.send', 'random']);
    assert.deepEqual(d.actions[1].branches[0].actions.map((s) => s.type), ['points.remove'], 'taking points stays');
    assert.match(YT_POINTS_REPLY, /Twitch and Kick only/);
    assert.match(YT_POINTS_NOTE, /do not earn or spend points/);
});

test('viewers: a YouTube subscriber, member, gifter and chatter earn no points; Twitch still does', async () => {
    const { svc, changes, bulk } = fakeViewers({ settings: { earn: { follow: 50, sub: 250, giftPerSub: 100, points: 10, minutes: 5 } } });
    const s = withDefaults({ earn: { follow: 50, sub: 250 } });
    assert.ok(s.earn.follow > 0 && s.earn.sub > 0, 'bonuses are on, so a missing bonus is the YouTube rule');
    await svc.onEvent(1, yt('follow'));
    await svc.onEvent(1, yt('membership', { metadata: { kind: 'new' } }));
    await svc.onEvent(1, yt('membership', { metadata: { kind: 'milestone', months: 6 } }));
    await svc.onEvent(1, yt('gift_sub', { amount: 5, metadata: { count: 5 } }));
    await svc.onEvent(1, yt('chat', { message: 'hello' }));
    assert.deepEqual(changes, [], 'no points change for anything on YouTube');
    await svc.onEvent(1, tw('follow'));
    assert.equal(changes.length, 1, 'a Twitch follow still earns the follow bonus');
    assert.equal(changes[0].amount, 50);
    // Watch time: a live YouTube channel's chatters are counted, with no points.
    svc._active.set('1:youtube', new Map([[FAN, { at: Date.now(), id: FAN, login: 'maplefan88', name: 'MapleFan88', roles: ['subscriber'] }]]));
    const st = await svc.sampleProfile(1, [{ platform: 'youtube', platform_user_id: CH, login: 'maplehollow' }]);
    assert.equal(st.channels[0].counted, 1, 'the YouTube chatter is counted');
    assert.equal(st.channels[0].points, 0, 'and earns nothing');
    assert.deepEqual(bulk, []);
});

test('viewers: the points commands answer YouTube chat that points are Twitch and Kick only', async () => {
    const { svc, changes } = fakeViewers();
    for (const c of ['points', 'top', 'give', 'gamble', 'addpoints', 'removepoints']) {
        const r = await svc.commands.run({ id: 1 }, c, { ev: yt('chat', { user: { id: FAN, login: 'maplefan88', name: 'MapleFan88', roles: ['moderator'] } }), input: '@leaf 100' });
        assert.equal(r.reply, YT_POINTS_REPLY, c);
    }
    assert.deepEqual(changes, []);
    const tv = await svc.templateValues({ ev: yt('chat'), profileId: 1, template: '{user.points}' });
    assert.equal(tv['user.points'], '0', '{user.points} is 0 on YouTube');
});

test('automations: Give points and Set points skip a YouTube event; Take points still runs', async () => {
    const { svc, changes } = fakeViewers();
    const ref = { current: svc };
    const acts = Object.fromEntries(viewerActions(ref).map((a) => [a.type, a]));
    const ctx = { profile: { id: 1 }, ev: yt('follow'), render: async (t) => t, automation: { name: 'New subscriber' } };
    for (const type of ['points.add', 'points.set']) {
        const r = await acts[type].execute({ who: 'event', viewer: '', amount: '50' }, ctx);
        assert.equal(r.status, 'skipped', type);
        assert.match(r.detail, /YouTube viewers cannot be given points/);
    }
    assert.deepEqual(changes, []);
    const named = await acts['points.add'].execute({ who: 'named', viewer: 'maplefan88', amount: '50' }, { ...ctx, ev: tw('chat') });
    assert.notEqual(named.status, 'ok', 'no named YouTube viewer is found from Twitch chat, so nothing is given');
    const take = await acts['points.remove'].execute({ who: 'event', viewer: '', amount: '5' }, ctx);
    assert.equal(take.status, 'ok', 'taking points away is allowed');
    assert.match(acts['points.add'].fields.find((f) => f.name === 'amount').hint, /Skipped for YouTube viewers/);
});

test('community: the store, points games, raffles and media share answer YouTube that they are Twitch and Kick only', async () => {
    const touched = [];
    const trap = new Proxy({}, { get: (_, k) => (k === 'then' ? undefined : async () => { touched.push(String(k)); return null; }) });
    const shop = createShop({ cstore: trap, store: trap, viewersRef: { current: null } });
    for (const c of ['list', 'redeem']) assert.equal((await shop.run({ id: 1 }, c, { ev: yt('chat'), input: '1' })).reply, YT_POINTS_REPLY, `store ${c}`);
    assert.deepEqual(touched, [], 'nothing in the store is read for a YouTube viewer');
    const games = createGames({ store: { async getSettingsKey() { return null; }, async setSettingsKey() {} }, viewersRef: { current: null }, timers: false });
    for (const c of ['slots', 'duel', 'heist', 'ticket', 'raffle', 'accept']) assert.equal((await games.run({ id: 1 }, c, { ev: yt('chat'), input: '100' })).reply, YT_POINTS_REPLY, `games ${c}`);
    const media = createMediaShare({ store: { async getSettingsKey() { return { open: true }; } }, cstore: { async available() { return true; } }, timers: false });
    const m = await media.request({ id: 1 }, { input: 'https://youtu.be/dQw4w9WgXcQ', viewer: { platform: 'youtube', id: FAN, login: 'maplefan88', name: 'MapleFan88' }, via: 'chat' });
    assert.equal(m.ok, false);
    assert.equal(m.reply, YT_POINTS_REPLY);
    media.close();
    games.close();
});

test('community seeds: points features are Twitch and Kick; quotes, the line-up and speech keep YouTube', () => {
    const plat = (group, name) => commandDrafts(group).find((d) => d.name === name).trigger_config.platforms;
    for (const [g, n] of [['store', 'Store: !redeem'], ['store', 'Store: !store'], ['games', 'Games: !slots'], ['games', 'Games: !ticket'], ['games', 'Games: !raffle'], ['games', 'Games: !heist'], ['media', 'Media share: !media']]) {
        assert.deepEqual(plat(g, n), ['twitch', 'kick'], n);
    }
    for (const [g, n] of [['games', 'Games: !join'], ['quotes', 'Quotes: !quote'], ['tts', 'Text to speech: !tts']]) assert.ok(plat(g, n).includes('youtube'), n);
});

test('import: points steps are left out of automations only YouTube starts, and kept elsewhere', () => {
    const { svc } = fakeViewers();
    for (const a of viewerActions({ current: svc })) actionsMod.registerActionType(a);
    const bundle = { source: 'streamerbot', automations: [
        { sourceId: 'm1', name: 'New member', trigger: { type: 'membership', config: { platforms: ['youtube'] }, conditions: [] },
            actions: [{ type: 'points.add', who: 'event', viewer: '', amount: '250' }, { type: 'chat.send', platform: 'youtube', text: 'Welcome {user.name}!' }] },
        { sourceId: 'f1', name: 'New follower', trigger: { type: 'follow', config: { platforms: ['twitch'] }, conditions: [] },
            actions: [{ type: 'points.add', who: 'event', viewer: '', amount: '50' }] },
    ] };
    const plan = buildPlan([bundle], { channels: [{ platform: 'twitch', platformUserId: '1', login: 'maple' }, { platform: 'youtube', platformUserId: CH, login: 'maplehollow' }], channelBots: [], builtins: new Set() });
    const item = (n) => plan.items.find((i) => String(i.name || '').includes(n));
    assert.deepEqual(item('New member').target.draft.actions.map((s) => s.type), ['chat.send']);
    assert.ok(item('New member').why.some((w) => /YouTube viewers cannot be given points/.test(w)));
    assert.deepEqual(item('New follower').target.draft.actions.map((s) => s.type), ['points.add'], 'a Twitch follow automation keeps its points step');
});

// ── scopes ──────────────────────────────────────────────────────────────────────────────────

test('scopes: only youtube.force-ssl and youtube.readonly can be asked for, by any flow', () => {
    assert.deepEqual([...ALLOWED_GOOGLE_SCOPES].sort(), [YT_SCOPE.forceSsl, YT_SCOPE.readonly].sort());
    assert.deepEqual(BOT_SCOPES, [YT_SCOPE.forceSsl]);
    assert.deepEqual(VIEWER_SCOPES, [YT_SCOPE.readonly]);
    assert.equal(VIEWER_PROVIDERS.youtube.scope, YT_SCOPE.readonly);
    assert.match(fs.readFileSync(path.join(ROOT, 'core/stream-bot/viewer-signin.js'), 'utf8'), /provider === 'youtube' \? assertAllowedScopes\(p\.scope\)/, 'the viewer sign-in checks its Google scope too');
    assert.deepEqual(assertAllowedScopes(`${YT_SCOPE.forceSsl}`), [YT_SCOPE.forceSsl]);
    for (const bad of [LEGACY_FULL_SCOPE, 'openid', 'email profile', `${YT_SCOPE.forceSsl} https://www.googleapis.com/auth/drive`, '']) assert.throws(() => assertAllowedScopes(bad), undefined, bad);
    const url = new URL(getAuthUrl('s'));
    assert.equal(url.searchParams.get('scope'), YT_SCOPE.forceSsl, 'the multicast connect asks for force-ssl, not the broad youtube scope');
    assert.throws(() => getAuthUrl('s', { scope: LEGACY_FULL_SCOPE }));
    assert.ok(canWrite([LEGACY_FULL_SCOPE]), 'an old grant holding the broad scope is still recognised');
});

test('scopes: no source file names a Google scope outside the two (the broad one only as the legacy constant)', () => {
    const allowed = new Set([...ALLOWED_GOOGLE_SCOPES]);
    const hits = [];
    const googleAuth = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
            const rel = path.join(dir, e.name);
            if (e.isDirectory()) { if (!['node_modules', 'backups', 'tests', 'test'].includes(e.name)) walk(rel); continue; }
            if (!/\.(m?js|ejs)$/.test(e.name)) continue;
            const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
            for (const m of src.matchAll(/https:\/\/www\.googleapis\.com\/auth\/[A-Za-z0-9._-]+/g)) hits.push({ file: rel.replace(/\\/g, '/'), scope: m[0] });
            if (src.includes('accounts.google.com/o/oauth2')) googleAuth.push(rel.split(path.sep).join('/'));
        }
    };
    for (const d of ['core', 'dashboard', 'services', 'utils', 'commands', 'events', 'jobs'].filter((d) => fs.existsSync(path.join(ROOT, d)))) walk(d);
    const bad = hits.filter((h) => !allowed.has(h.scope) && !(h.scope === LEGACY_FULL_SCOPE && h.file === 'core/stream-bot/youtube/config.js'));
    assert.deepEqual(bad, []);
    assert.ok(hits.length >= 3, 'the scan found the real scope strings');
    // The only places that send anyone to Google's sign-in: the stream bot / multicast connect and the viewer page.
    assert.deepEqual(googleAuth.sort(), ['core/stream-bot/viewer-signin.js', 'dashboard/services/platforms/youtube.js']);
});

// ── the gate ────────────────────────────────────────────────────────────────────────────────

function fakeGateDb() {
    let row = null;
    return {
        fail: false,
        async query(sql, params = []) {
            if (this.fail) throw Object.assign(new Error('no table'), { code: 'ER_NO_SUCH_TABLE' });
            if (/^SELECT/.test(sql.trim())) return [row ? [row] : []];
            row = { is_open: params[0], reviewers: params[1], updated_by: params[2], updated_at: new Date('2026-11-21T10:00:00Z') };
            return [{ affectedRows: 1 }];
        },
    };
}

test('gate: owner and listed reviewers only, closed by default and on errors; one switch opens it', async () => {
    const db = fakeGateDb();
    const g = createYouTubeGate({ db, cacheMs: 0, ownerIds: [OWNER_DISCORD_ID] });
    assert.equal(OWNER_DISCORD_ID, '365905620060340224');
    assert.equal(await g.allows(OWNER_DISCORD_ID), true, 'the owner');
    assert.equal(await g.allows('111111111111111111'), false, 'nobody else while nothing is saved');
    assert.equal(await g.allows(''), false);
    assert.deepEqual(await g.addReviewer('nope', '', OWNER_DISCORD_ID), { ok: false, error: 'bad_id' });
    assert.equal((await g.addReviewer('222222222222222222', 'Google reviewer <b>', OWNER_DISCORD_ID)).ok, true);
    assert.deepEqual(await g.addReviewer('222222222222222222', '', OWNER_DISCORD_ID), { ok: false, error: 'exists' });
    assert.equal(await g.allows('222222222222222222'), true, 'a listed reviewer');
    assert.equal(await g.allows('111111111111111111'), false);
    await g.setOpen(true, OWNER_DISCORD_ID);
    assert.equal(await g.allows('111111111111111111'), true, 'open to everyone after approval');
    await g.setOpen(false, OWNER_DISCORD_ID);
    assert.equal(await g.allows('111111111111111111'), false);
    assert.equal((await g.removeReviewer('222222222222222222', OWNER_DISCORD_ID)).ok, true);
    assert.equal(await g.allows('222222222222222222'), false);
    assert.deepEqual(await g.removeReviewer('222222222222222222', OWNER_DISCORD_ID), { ok: false, error: 'not_listed' });
    for (let i = 0; i < MAX_REVIEWERS; i++) await g.addReviewer(String(300000000000000000n + BigInt(i)), '', OWNER_DISCORD_ID);
    assert.deepEqual(await g.addReviewer('999999999999999999', '', OWNER_DISCORD_ID), { ok: false, error: 'full' });
    db.fail = true;
    g._clearCache();
    assert.equal(await g.allows('300000000000000000'), false, 'a database error closes it to everyone but the owner');
    assert.equal(await g.allows(OWNER_DISCORD_ID), true);
    assert.equal(IN_REVIEW_TEXT, 'YouTube linking is in review with Google, back soon.');
});

test('gate: the connect routes check it for every YouTube link, before and after Google', () => {
    const src = read('dashboard/routes/stream-connect.js');
    assert.match(src, /if \(meta\.platform === 'youtube' && !\(await youtubeAllowed\(req\.user\.id\)\)\) return res\.redirect\(back \+ '\?error=youtube_in_review'\);/);
    assert.match(src, /if \(platform === 'youtube' && !\(await youtubeAllowed\(req\.user\.id\)\)\) return res\.redirect\(back \+ '\?error=youtube_in_review'\);/);
    assert.match(src, /catch \{ return false; \}/, 'fails closed');
    assert.deepEqual(connectionNotice({ error: 'youtube_in_review' }), { tone: 'error', text: IN_REVIEW_TEXT });
    assert.match(read('dashboard/server.js'), /import\('\.\/routes\/youtube-review\.js'\)/, 'the owner page is mounted');
    assert.match(read('dashboard/views/partials/site/_owner-nav.ejs'), /\/super-admin\/youtube-review/);
    const page = read('dashboard/routes/youtube-review.js');
    for (const p of ["router.get(PAGE, checkAuth, checkSuperAdmin", "router.post(`${PAGE}/open`, checkAuth, checkSuperAdmin", "router.post(`${PAGE}/reviewers`, checkAuth, checkSuperAdmin", "router.post(`${PAGE}/reviewers/:id/remove`, checkAuth, checkSuperAdmin"]) assert.ok(page.includes(p), p);
    assert.equal(reviewNotice({ error: 'constructor' }).text, 'That did not save. Try again in a minute.', 'unknown codes never echo');
    assert.equal(reviewNotice({ error: '<script>' }).text, 'That did not save. Try again in a minute.');
    assert.equal(reviewNotice({ ok: 'opened' }).tone, 'ok');
});

// ── retention ───────────────────────────────────────────────────────────────────────────────

test('retention: YouTube policy rows resolve to fixed conditions; unknown scoped rows are skipped; all 30 days', () => {
    assert.deepEqual(resolvePolicy('stream_bot_events'), { table: 'stream_bot_events', guard: null, scoped: null });
    assert.deepEqual(resolvePolicy('stream_bot_events__youtube'), { table: 'stream_bot_events', guard: "`platform` = 'youtube'", scoped: 'youtube' });
    assert.equal(resolvePolicy('stream_bot_events__kick'), null);
    assert.equal(resolvePolicy('stream_bot_devices__youtube'), null, 'only listed tables');
    assert.equal(resolvePolicy('modmail_threads').guard, sweepGuard('modmail_threads'));
    assert.match(resolvePolicy('stream_bot_viewer_history__youtube').guard, /`viewer_id` IN \(SELECT `id` FROM `stream_bot_viewers` WHERE `platform` = 'youtube'\)/);
    assert.match(resolvePolicy('stream_bot_quotes__youtube').guard, /`added_by_platform` = 'youtube'/);
    for (const [name, column, days] of RETENTION_ROWS) {
        assert.equal(days, 30, name);
        assert.ok(resolvePolicy(name), `${name} resolves`);
        assert.ok(/^[a-z_]+$/.test(column), column);
    }
    const scoped = RETENTION_ROWS.filter(([n]) => n.endsWith('__youtube')).map(([n]) => n.replace(/__youtube$/, '')).sort();
    assert.deepEqual(scoped, Object.keys(SCOPED_GUARDS.youtube).sort(), 'every YouTube guard has a policy row');
    const mig = read('migrations/480_youtube_google_verification.js');
    assert.match(mig, /ON DUPLICATE KEY UPDATE/);
    assert.match(mig, /CREATE TABLE IF NOT EXISTS/);
});

// ── pages ───────────────────────────────────────────────────────────────────────────────────

test('Connections: in review shows the message and no YouTube sign-in button; allowed shows the button', async () => {
    const view = path.join(ROOT, 'dashboard/views/stream-bot/connections.ejs');
    const base = {
        user: { id: '1', username: 'maple' }, active: 'connections', pageTitle: 'Connections', profile: { id: 7, displayName: 'Maple' }, notice: null, linkable: [], grant: null, reapprove: [],
        scopes: [], tipSources: [], tipOptions: { kofi: [], fourthwall: [], throne: null, bmac: false }, botSettings: { storeChat: false, webhookAllowHosts: [] }, csrfToken: 't', channels: [],
    };
    const yt = { config: { enabled: true }, service: { status: () => ({ channels: [], quota: null }) } };
    const opts = { async: false, views: [path.join(ROOT, 'dashboard/views')] };
    const closed = await ejs.renderFile(view, { ...base, youtube: youtubePanel(yt, 7, { canLink: false }) }, opts);
    assert.ok(!closed.includes('href="/stream/connect/youtube?for=bot"'), 'no sign-in link while in review');
    assert.ok(closed.includes(IN_REVIEW_TEXT));
    assert.match(closed, /In review with Google/);
    assert.match(closed, /YouTube viewers do not earn or spend points/);
    const open = await ejs.renderFile(view, { ...base, youtube: youtubePanel(yt, 7, { canLink: true }) }, opts);
    assert.match(open, /href="\/stream\/connect\/youtube\?for=bot">Link YouTube</);
    assert.ok(!open.includes(IN_REVIEW_TEXT));
});

test('viewer page: a YouTube viewer has no points form; the settings, store, games and media pages say why', () => {
    const settings = withDefaults({});
    const person = (platform) => ({ primary: { id: 5, platform, name: 'MapleFan88' }, rows: [{ id: 5, platform, name: 'MapleFan88', platformUserId: FAN, watchMinutes: 30, messages: 4 }], points: 0,
        totals: { watchMinutes: 30, messages: 4, follows: 1, subs: 1, subMonths: 0, gifts: 0, giftedSubs: 0, bits: 0, cheers: 0, raids: 0, raidViewers: 0, tips: 0, tipAmounts: {} } });
    const v = personView(person('youtube'), settings, []);
    assert.equal(v.pointsAllowed, false);
    assert.equal(v.youtube, true);
    assert.equal(personView(person('twitch'), settings, []).pointsAllowed, true);
    const page = read('dashboard/views/stream-bot/viewer.ejs');
    assert.match(page, /<% if \(!viewer\.pointsAllowed\) \{ %>[\s\S]*YouTube viewers do not earn or spend[\s\S]*<% \} else \{ %>[\s\S]*id="sbv-points-form"[\s\S]*<% \} %>/);
    assert.match(read('dashboard/views/stream-bot/viewers-settings.ejs'), /YouTube viewers do not earn or spend points/);
    assert.match(read('dashboard/views/stream-bot/community-store.ejs'), /The store is for Twitch and Kick/);
    assert.match(read('dashboard/views/stream-bot/community-games.ejs'), /Points games and raffles are for Twitch and Kick/);
    assert.match(read('dashboard/views/stream-bot/community-media.ejs'), /works in Twitch and Kick chat/);
    assert.match(read('dashboard/views/stream-bot/viewers.ejs'), /or 30 days on YouTube/);
});

test('/privacy: the Google user data section, Limited Use, no AI, 30 days, tokens under Data Security, YouTube on Your viewer data', () => {
    const p = read('dashboard/views/privacy-tailwind.ejs');
    assert.match(p, /<a href="#google-user-data">Google user data \(YouTube\)<\/a>/);
    assert.match(p, /<h3 id="google-user-data">Google user data \(YouTube\)<\/h3>/);
    for (const h of ['What we access.', 'How we use it.', 'Who we share it with.', 'How we protect it.', 'How long we keep it, and how to delete it.', 'Limited Use.']) assert.ok(p.includes(`<strong>${h}</strong>`), h);
    assert.ok(p.includes('CertiFried&rsquo;s use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy" rel="noopener">Google API Services User Data Policy</a>, including the Limited Use requirements.'));
    assert.match(p, /We do not send Google user data to any AI or machine-learning service/);
    assert.match(p, /never used to train or improve AI or machine-learning models/);
    assert.match(p, /YouTube viewers do not earn points, rewards, raffle entries or store items/);
    assert.match(p, /Twitch grant tokens, Google \(YouTube\) OAuth tokens and tip-service tokens are encrypted with AES-256-GCM/);
    assert.match(p, /<code>youtube\.force-ssl<\/code>/);
    assert.match(p, /<code>youtube\.readonly<\/code>/);
    assert.match(p, /found through the Twitch, Kick and YouTube accounts you linked/);
    assert.match(p, /November 21, 2026 \(Google user data\)/);
    assert.match(read('dashboard/views/privacy-viewer.ejs'), /linked to your Twitch, Kick or YouTube account/);
});
