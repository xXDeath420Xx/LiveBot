import './fixtures/test-log-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import activitiesRouter from '../dashboard/routes/activities/index.js';
import { signSession } from '../core/activities/discord-auth.js';
import { takeIntent, _resetIntentsForTests } from '../core/activities/intents.js';
import { guildClientFor, servedByCustomBot, watchAvailability, customBotWatchNotice, USER_INSTALL_URL } from '../core/activities/watch/guild-config.js';
import { fromOtherApp, openItYourself, handleActivityOpen, launchWatchFromPicker, handleMovieActivity } from '../handlers/activities/launch.js';

/*
 * Watch Together in a server run by a custom-branded bot (fix wave 6, 2026-11-20). The Activity belongs to the main
 * application; members open it through their own install (User Install). Mocked servers: "main bot absent, custom bot
 * present" and "no CertiFried bot at all, nothing set up". Sign-in, availability, the host and control rights read
 * through the custom bot (never failing open), Greenhouse, the custom bot's /movie answers and the Cinema page note.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_APP = '1409904443125665875';
const CUSTOM_APP = '100000000000000777';
const G = '100000000000000101', C = '100000000000000102'; // custom-bot server
const G0 = '100000000000000201', C0 = '100000000000000202'; // no CertiFried bot, nothing set up
const MOD = { id: '100000000000000111', name: 'Mod', avatar: null };
const ROLE = { id: '100000000000000112', name: 'Roley', avatar: null };
const NOBODY = { id: '100000000000000113', name: 'Gone', avatar: null };

const savedEnv = { ...process.env };
Object.assign(process.env, { ACTIVITIES_ENABLED: '1', ACTIVITY_APP_ID: MAIN_APP, ACTIVITY_CLIENT_SECRET: 'cs-test', ACTIVITY_SESSION_SECRET: 's'.repeat(43), CFX2_DASHBOARD_SECRET: 'g'.repeat(40) });
after(async () => {
    for (const k of ['ACTIVITIES_ENABLED', 'ACTIVITY_APP_ID', 'ACTIVITY_CLIENT_SECRET', 'ACTIVITY_SESSION_SECRET', 'CFX2_DASHBOARD_SECRET']) {
        if (k in savedEnv) process.env[k] = savedEnv[k]; else delete process.env[k];
    }
    delete global.botManager;
    await pool.end().catch(() => {});
});

const cfg = {
    enabled: true, appId: MAIN_APP, clientSecret: 'cs', botToken: 'bt', publicKey: '', sessionSecret: 's'.repeat(43), siteUrl: 'https://example.invalid', sessionTtlSec: 3600,
    watch: { maxSessions: 2, maxViewers: 10, maxBitrateKbps: 6000, cacheMb: 8, idleEndSec: 120, hostHandoverSec: 60 },
    jellyfin: { base: 'https://jf.invalid', apiKey: 'k'.repeat(32), userId: '' },
};

// The main bot is in neither server; the custom bot is in G and can read its members.
const mainClient = { guilds: { cache: { has: () => false, get: () => undefined } } };
const member = (perms, roles) => ({ permissions: { has: (p) => perms.includes(p) }, roles: { cache: { has: (r) => roles.includes(r) } } });
const customGuild = { members: { fetch: async (id) => {
    if (id === MOD.id) return member([PermissionFlagsBits.ManageGuild], []);
    if (id === ROLE.id) return member([], ['ctl']);
    throw new Error('Unknown Member');
} } };
const customClient = { guilds: { cache: { has: (g) => g === G, get: (g) => (g === G ? customGuild : undefined) } } };
const botManager = { getClientForGuild: (g) => (g === G ? customClient : null) };

test('the server\'s bot: the main one when it is there, else its custom bot, else none', () => {
    const main = { guilds: { cache: { has: (g) => g === G } } };
    assert.equal(guildClientFor(main, G, botManager), main);
    assert.equal(guildClientFor(mainClient, G, botManager), customClient);
    assert.equal(guildClientFor(mainClient, G0, botManager), null);
    assert.equal(guildClientFor(mainClient, G, { getClientForGuild: () => ({ guilds: { cache: { has: () => false } } }) }), null, 'a bot that cannot see the server does not count');
    assert.equal(servedByCustomBot(mainClient, G, botManager), true);
    assert.equal(servedByCustomBot(main, G, botManager), false);
    assert.equal(watchAvailability({ activityEnabled: true, guildId: G0, botInGuild: false, config: null }).reason, 'This server hasn\'t set up Watch Together.');
    assert.match(watchAvailability({ activityEnabled: true, guildId: G0, botInGuild: false, config: { enabled: true, mode: 'activity' } }).reason, /not in this server/);
});

async function start() {
    global.botManager = botManager;
    const db = { execute: async (sql, params) => (sql.includes('cinema_config') && params?.[0] === G ? [[{ guild_id: G, enabled: 1, watch_mode: 'activity', jellyfin_library_id: null, control_role_id: 'ctl' }]] : [[]]) };
    const discord = async (url, init) => {
        const u = String(url);
        const json = (status, body) => ({ status, json: async () => body });
        if (u.endsWith('/oauth2/token')) return json(200, { access_token: 'at-mod', scope: 'identify' });
        if (u.endsWith('/users/@me')) return json(200, { id: MOD.id, username: 'mod' });
        // The instance belongs to the application, not to a server the bot is in
        if (u.includes(`/applications/${MAIN_APP}/activity-instances/`)) {
            const gid = u.includes(`-gc-${G0}-`) ? G0 : G;
            return json(200, { users: [MOD.id], location: { kind: 'gc', guild_id: gid, channel_id: gid === G ? C : C0 } });
        }
        return json(404, {});
    };
    const app = express();
    app.locals.client = mainClient;
    app.use('/activity', activitiesRouter({ getCfg: () => cfg, db, fetchImpl: discord, media: { getItem: async () => { throw new Error('unused'); } }, store: null, startTicker: false }));
    const srv = app.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const base = `http://127.0.0.1:${srv.address().port}/activity`;
    const tok = (u, g = G, c = C) => signSession({ user: u, instance: { instanceId: `i-100000000000000009-gc-${g}-${c}`, guildId: g, channelId: c }, cfg });
    const get = (u, p, g, c) => fetch(`${base}/${p}`, { headers: { Authorization: `Bearer ${tok(u, g, c)}` } });
    return { srv, base, get };
}

test('main bot absent, custom bot present: sign-in, Cinema settings and rights through the custom bot', async () => {
    const { srv, base, get } = await start();
    try {
        const r = await fetch(`${base}/api/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'modcode12345', instanceId: `i-100000000000000009-gc-${G}-${C}` }) });
        const j = await r.json();
        assert.equal(r.status, 200, 'the instance check works for a server the main bot is not in');
        assert.deepEqual(j.where, { guildId: G, channelId: C });
        const me = await (await get(MOD, 'api/me')).json();
        assert.equal(me.watch.available, true, 'the custom bot counts as CertiFried being in the server');
        let s = await (await get(MOD, 'api/watch/state')).json();
        assert.deepEqual([s.you.canStart, s.you.canControl], [true, true], 'Manage Server, read through the custom bot');
        s = await (await get(ROLE, 'api/watch/state')).json();
        assert.equal(s.you.canControl, true, 'the Cinema control role, read through the custom bot');
        s = await (await get(NOBODY, 'api/watch/state')).json();
        assert.deepEqual([s.you.canStart, s.you.canControl], [false, false], 'a member the bot cannot read gets nothing (never fails open)');
    } finally { srv.close(); delete global.botManager; }
});

test('no CertiFried bot and nothing set up: a plain message, not an error; Greenhouse still opens', async () => {
    const { srv, base, get } = await start();
    try {
        const r = await fetch(`${base}/api/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'modcode12345', instanceId: `i-100000000000000009-gc-${G0}-${C0}` }) });
        assert.equal(r.status, 200);
        const me = await (await get(MOD, 'api/me', G0, C0)).json();
        assert.equal(me.watch.available, false);
        assert.equal(me.watch.reason, 'This server hasn\'t set up Watch Together.');
        assert.equal(me.greenhouse.available, true);
        const st = await get(MOD, 'api/watch/state', G0, C0);
        assert.equal(st.status, 403);
        assert.equal((await st.json()).error.message, 'This server hasn\'t set up Watch Together.');
        const gh = await get(MOD, 'greenhouse/session/discord', G0, C0);
        assert.equal(gh.status, 200, 'Greenhouse needs nothing from the server');
        assert.ok((await gh.json()).assertion);
    } finally { srv.close(); delete global.botManager; }
});

test('the custom bot cannot open the Activity: it gives the steps and the link, and keeps the pick', async () => {
    _resetIntentsForTests();
    const replies = [];
    let launched = 0;
    const ix = (appId, extra = {}) => ({
        applicationId: appId, guildId: G, user: { id: ROLE.id }, member: { voice: { channel: { isVoiceBased: () => true } } },
        reply: async (p) => { replies.push(p); }, launchActivity: async () => { launched++; }, ...extra,
    });
    assert.equal(fromOtherApp({ applicationId: CUSTOM_APP }, MAIN_APP), true);
    assert.equal(fromOtherApp({ applicationId: MAIN_APP }, MAIN_APP), false);
    assert.ok(openItYourself('watch').includes(USER_INSTALL_URL));

    await launchWatchFromPicker(ix(CUSTOM_APP), { itemId: 'a'.repeat(32), audioIndex: 1, queue: null, libraryId: null });
    assert.equal(launched, 0);
    assert.match(replies.at(-1).content, /Your pick is saved for 10 minutes/);
    assert.ok(replies.at(-1).content.includes(USER_INSTALL_URL));
    assert.equal(replies.at(-1).ephemeral, true);
    assert.equal(takeIntent(G, ROLE.id)?.itemId, 'a'.repeat(32), 'the pick waits for the Activity');

    await handleActivityOpen(ix(CUSTOM_APP, { customId: 'activity_open:greenhouse' }));
    assert.match(replies.at(-1).content, /can't open Greenhouse Tycoon itself/);
    await handleMovieActivity(ix(CUSTOM_APP), 'open', {});
    assert.ok(!replies.at(-1).components, 'no button the custom bot could not honour');
    assert.match(replies.at(-1).content, /Activities button/);
    await handleActivityOpen(ix(MAIN_APP, { customId: 'activity_open:watch' }));
    assert.equal(launched, 1, 'the main bot still launches it');
});

test('the Cinema page and the guide explain it in a custom-bot server', () => {
    assert.equal(customBotWatchNotice(mainClient, G0, botManager), null);
    const n = customBotWatchNotice(mainClient, G, botManager);
    assert.equal(n.link.href, USER_INSTALL_URL);
    assert.match(n.text, /Use Activities/);
    assert.match(n.text, /Use External Apps/);
    assert.equal(USER_INSTALL_URL, 'https://discord.com/oauth2/authorize?client_id=1409904443125665875&integration_type=1&scope=applications.commands');
    const api = fs.readFileSync(path.join(root, 'dashboard/routes/api/features/feature-config.js'), 'utf8');
    assert.ok(/feature === 'cinema'[\s\S]{0,200}customBotWatchNotice\(req\.app\?\.locals\?\.client, guildId\)/.test(api));
    const page = fs.readFileSync(path.join(root, 'dashboard/views/partials/manage/feature-config.ejs'), 'utf8');
    assert.ok(page.includes('spec.notices') && page.includes("/^https:\\/\\/discord\\.com\\//"), 'the page renders the note, and only a discord.com link');
    const guide = fs.readFileSync(path.join(root, 'dashboard/content/guides/watch-together.js'), 'utf8');
    assert.ok(guide.includes('[Add CertiFried to your account](/invite?account=1)'), 'the site link (/invite?account=1 redirects to the user-install URL)');
    const server = fs.readFileSync(path.join(root, 'dashboard/server.js'), 'utf8');
    assert.ok(server.includes("if (req.query.account === '1') return res.redirect(`https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(id)}&integration_type=1&scope=applications.commands`);"), '/invite?account=1 sends members to the user-install link');
    assert.ok(/Use External Apps/.test(guide) && /Use Activities/.test(guide));
});
