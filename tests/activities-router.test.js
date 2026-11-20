import './fixtures/test-log-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import jwt from 'jsonwebtoken';
import { PermissionFlagsBits } from 'discord.js';
import activitiesRouter, { activityCsp } from '../dashboard/routes/activities/index.js';
import { signSession } from '../core/activities/discord-auth.js';
import { setIntent, _resetIntentsForTests } from '../core/activities/intents.js';
import { mediaKey, signRef } from '../core/activities/watch/media-links.js';
import { JellyfinError } from '../core/activities/watch/jellyfin-media.js';
import pool from '../utils/db.js';

// The member checks read the Watch party settings (core/feature-config.js), which opens the database pool: close it so
// the file exits on its own.
after(() => pool.end().catch(() => {}));

/*
 * The Activity's HTTP side (dashboard/routes/activities/index.js) with a fake Discord, a fake Jellyfin and an
 * invented server: the page can be framed by Discord and has its own CSP; sign-in answers with our session and the
 * /movie intent; every API call needs the session; only the host (or the control role, Manage Server) controls; the
 * video goes through signed links with no Jellyfin key, and old links die; the Greenhouse frame gets a Discord
 * assertion the game accepts. Plus the server.js mount and the docs.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const G = '100000000000000001', C = '100000000000000002';
const HOST = { id: '100000000000000011', name: 'Ash', avatar: null };
const GUEST = { id: '100000000000000012', name: 'Birch', avatar: null };
const ITEM = 'a'.repeat(32);
const GUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const API_KEY = 'k'.repeat(32);
const cfg = {
    enabled: true, appId: '100000000000000999', clientSecret: 'client-secret-zz', botToken: 'bot-token-zz', publicKey: '', sessionSecret: 's'.repeat(43), siteUrl: 'https://example.invalid', sessionTtlSec: 3600,
    watch: { maxSessions: 2, maxViewers: 10, maxBitrateKbps: 6000, cacheMb: 8, idleEndSec: 120, hostHandoverSec: 60 },
    jellyfin: { base: 'https://jf.invalid', apiKey: API_KEY, userId: '' },
};

function fakeMedia() {
    const calls = { upstream: [] };
    return {
        calls,
        getItem: async (id, lib) => {
            if (id !== ITEM) throw new JellyfinError('NOT_FOUND', 404, 'That title is not in this server\'s library.');
            return { id: ITEM, name: 'Film', type: 'Movie', year: 2020, runtimeSec: 100, mediaSourceId: ITEM, image: null, audio: [{ index: 1, label: 'English' }], subtitles: [{ index: 3, label: 'English', text: true }], lib };
        },
        browse: async () => ({ items: [{ id: ITEM, type: 'Movie', name: 'Film', year: 2020, image: 'b'.repeat(32) }], total: 1, page: 0, pages: 1 }),
        seasons: async () => [], episodes: async () => [],
        startPlayback: async () => ({ playSessionId: 'ps1', path: `/videos/${GUID}/master.m3u8?DeviceId=d`, runtimeSec: 100, remux: true }),
        stopPlayback: async () => {},
        subtitlePath: (it, i) => `/Videos/${it.id}/${it.mediaSourceId}/Subtitles/${i}/0/Stream.vtt`,
        image: async () => ({ type: 'image/jpeg', body: Buffer.from('jpeg') }),
        fetchUpstream: async (rel) => {
            calls.upstream.push(rel);
            const body = rel.includes('master.m3u8') ? `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmain.m3u8?x=1&ApiKey=${API_KEY}\n#EXT-X-IMAGE-STREAM-INF:URI="Trickplay/320/tiles.m3u8?ApiKey=${API_KEY}"\n`
                : rel.includes('main.m3u8') ? `#EXTM3U\n#EXTINF:3,\nhls1/main/0.ts?r=0&api_key=${API_KEY}\n#EXT-X-ENDLIST\n`
                    : rel.endsWith('.vtt') ? 'WEBVTT\n' : 'TSDATA';
            return new Response(body, { status: 200, headers: { 'content-type': rel.endsWith('.ts?r=0') ? 'video/mp2t' : 'text/plain' } });
        },
    };
}

async function start({ intent = null } = {}) {
    _resetIntentsForTests();
    if (intent) setIntent(G, HOST.id, intent);
    const media = fakeMedia();
    const db = { execute: async (sql) => (sql.includes('cinema_config') ? [[{ guild_id: G, enabled: 1, watch_mode: 'activity', jellyfin_library_id: 'lib1', control_role_id: 'ctl' }]] : [[]]) };
    const discord = async (url, init) => {
        const u = String(url);
        const json = (status, body) => ({ status, json: async () => body });
        if (u.endsWith('/oauth2/token')) return json(200, { access_token: `at-${new URLSearchParams(init.body).get('code')}`, scope: 'identify' });
        if (u.endsWith('/users/@me')) return json(200, init.headers.Authorization === 'Bearer at-hostcode1234' ? { id: HOST.id, username: 'ash', global_name: 'Ash' } : { id: GUEST.id, username: 'birch' });
        if (u.includes('/activity-instances/')) return json(200, { users: [HOST.id, GUEST.id], location: { kind: 'gc', guild_id: G, channel_id: C } });
        return json(404, {});
    };
    const app = express();
    app.set('views', path.join(root, 'dashboard/views'));
    app.set('view engine', 'ejs');
    const roles = { [HOST.id]: [], [GUEST.id]: [] };
    app.locals.client = { guilds: { cache: { has: (g) => g === G, get: (g) => (g === G ? { members: { fetch: async (id) => ({ permissions: { has: (p) => p === PermissionFlagsBits.ManageGuild && false }, roles: { cache: { has: (r) => (roles[id] || []).includes(r) } } }) } } : undefined) } } };
    app.use((req, res, next) => { res.set('X-Frame-Options', 'SAMEORIGIN'); next(); }); // as the site's helmet does
    app.use('/activity', activitiesRouter({ getCfg: () => cfg, db, fetchImpl: discord, media, store: null, startTicker: false }));
    const srv = app.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const base = `http://127.0.0.1:${srv.address().port}/activity`;
    const tok = (u) => signSession({ user: u, instance: { instanceId: `i-100000000000000009-gc-${G}-${C}`, guildId: G, channelId: C }, cfg });
    const call = (u, p, body) => fetch(`${base}/${p}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${tok(u)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { srv, base, media, call, roles };
}

test('the page can be framed by Discord, has its own CSP, and names no secret', async () => {
    const built = fs.existsSync(path.join(root, 'frontend/activities/dist/manifest.json'));
    const { srv, base } = await start();
    try {
        const r = await fetch(`${base}/`);
        const html = await r.text();
        assert.equal(r.headers.get('x-frame-options'), null, 'Discord must be able to frame it');
        assert.equal(r.headers.get('content-security-policy'), activityCsp());
        assert.doesNotMatch(activityCsp(), /frame-ancestors|unsafe-inline|unsafe-eval/);
        if (built) {
            assert.equal(r.status, 200);
            assert.ok(html.includes('content="100000000000000999"'), 'the application id');
            assert.ok(!html.includes(API_KEY) && !html.includes('client-secret-zz') && !html.includes('bot-token-zz'), 'no secret');
            assert.ok(!/<script>(?!\s*$)|\son[a-z]+=/i.test(html), 'no inline script or handler');
        } else {
            assert.equal(r.status, 503);
        }
    } finally { srv.close(); }
});

test('sign-in returns our session and the /movie intent; the API needs the session', async () => {
    const { srv, base } = await start({ intent: { kind: 'watch', itemId: ITEM, audioIndex: 1 } });
    try {
        let r = await fetch(`${base}/api/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'hostcode1234', instanceId: `i-100000000000000009-gc-${G}-${C}` }) });
        const j = await r.json();
        assert.equal(r.status, 200);
        assert.equal(j.user.id, HOST.id);
        assert.deepEqual(j.where, { guildId: G, channelId: C });
        assert.deepEqual(j.intent, { kind: 'watch', itemId: ITEM, audioIndex: 1 });
        assert.ok(typeof j.session === 'string' && j.session.length > 40);
        r = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${j.session}` } });
        assert.equal((await r.json()).watch.available, true);
        for (const p of ['api/me', 'api/watch/state', 'api/watch/library', 'greenhouse/session/discord']) {
            assert.equal((await fetch(`${base}/${p}`)).status, 401, `${p} without a session`);
            assert.equal((await fetch(`${base}/${p}`, { headers: { Authorization: 'Bearer nope.nope.nope-nope-nope' } })).status, 401, `${p} with a bad session`);
        }
        r = await fetch(`${base}/api/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'x', instanceId: 'bad' }) });
        assert.equal(r.status, 400);
    } finally { srv.close(); }
});

test('the host controls, a guest cannot; posters are signed', async () => {
    const { srv, base, call, roles } = await start();
    try {
        let r = await call(HOST, 'api/watch/library');
        const lib = await r.json();
        assert.match(lib.items[0].image, /^media\/img\/a{32}\/b{32}\/[A-Za-z0-9_-]{22}$/);
        assert.equal((await fetch(`${base}/${lib.items[0].image}`)).status, 200);
        assert.equal((await fetch(`${base}/media/img/${ITEM}/${'b'.repeat(32)}/${'A'.repeat(22)}`)).status, 404, 'forged poster link');
        r = await call(HOST, 'api/watch/play', { itemId: ITEM });
        assert.equal(r.status, 200);
        const st = (await r.json()).state;
        assert.equal(st.host.id, HOST.id);
        assert.equal((await call(HOST, 'api/watch/play', { itemId: 'c'.repeat(32) })).status, 404, 'not in the library');
        // the host is connected (an open event stream), so a guest cannot take over
        const ctrl = new AbortController();
        const es = await fetch(`${base}/api/watch/events`, { headers: { Authorization: `Bearer ${signSession({ user: HOST, instance: { instanceId: `i-100000000000000009-gc-${G}-${C}`, guildId: G, channelId: C }, cfg })}` }, signal: ctrl.signal });
        assert.equal(es.headers.get('content-type'), 'text/event-stream; charset=utf-8');
        const first = new TextDecoder().decode((await es.body.getReader().read()).value);
        assert.match(first, /retry: 3000/);
        assert.equal((await call(GUEST, 'api/watch/control', { action: 'pause' })).status, 403);
        assert.equal((await call(GUEST, 'api/watch/play', { itemId: ITEM })).status, 403);
        assert.equal((await call(HOST, 'api/watch/control', { action: 'pause' })).status, 200);
        assert.equal((await call(HOST, 'api/watch/control', { action: 'nope' })).status, 400);
        ctrl.abort();
    } finally { srv.close(); }
});

test('video goes through signed links with no Jellyfin key, and old links die', async () => {
    const { srv, base, call, media } = await start();
    try {
        const st = (await (await call(HOST, 'api/watch/play', { itemId: ITEM })).json()).state;
        const dir = st.media.src.replace(/index\.m3u8$/, '');
        let r = await fetch(`${base}/${st.media.src}`);
        const master = await r.text();
        assert.match(r.headers.get('content-type'), /^application\/vnd\.apple\.mpegurl/);
        assert.ok(!master.includes(API_KEY) && !master.includes('Trickplay') && !master.includes('jf.invalid'));
        const mainRef = master.split('\n').find((l) => l && !l.startsWith('#'));
        r = await fetch(`${base}/${dir}${mainRef}`);
        const main = await r.text();
        assert.ok(!main.includes(API_KEY));
        const seg = main.split('\n').find((l) => l && !l.startsWith('#'));
        r = await fetch(`${base}/${dir}${seg}`);
        assert.equal(await r.text(), 'TSDATA');
        assert.match(r.headers.get('cache-control'), /private/);
        await fetch(`${base}/${dir}${seg}`);
        assert.equal(media.calls.upstream.filter((u) => u.includes('.ts')).length, 1, 'the second viewer is served from the cache');
        assert.ok(media.calls.upstream.every((u) => !u.includes(API_KEY)), 'upstream paths carry no key either (it goes in a header)');
        const key = mediaKey(cfg.sessionSecret, st.id, 1);
        assert.equal((await fetch(`${base}/${dir}${signRef(key, '/Users')}`)).status, 404, 'a signed path that is not a video file');
        assert.equal((await fetch(`${base}/${dir}sub-3.vtt`)).status, 200);
        assert.equal((await fetch(`${base}/${dir}sub-9.vtt`)).status, 404);
        assert.equal((await call(HOST, 'api/watch/control', { action: 'stop' })).status, 200);
        assert.equal((await fetch(`${base}/${st.media.src}`)).status, 410, 'stopped: the links are gone');
        assert.equal((await fetch(`${base}/media/zzzzzzzzzzzzzzzzzzzzzzzz/1/index.m3u8`)).status, 410);
    } finally { srv.close(); }
});

test('the Greenhouse frame gets a Discord assertion the game accepts', async () => {
    const prev = process.env.CFX2_DASHBOARD_SECRET;
    process.env.CFX2_DASHBOARD_SECRET = 'd'.repeat(40);
    const { srv, call } = await start();
    try {
        const r = await call(HOST, 'greenhouse/session/discord');
        const j = await r.json();
        const { createDiscordVerifier } = await import('../services/cfx/integrations/discord.js');
        const who = createDiscordVerifier({ secret: 'd'.repeat(40) })(j.assertion);
        assert.equal(who.platformUserId, HOST.id);
        assert.equal(jwt.decode(j.assertion).iss, 'certifried-dashboard');
    } finally {
        srv.close();
        if (prev === undefined) delete process.env.CFX2_DASHBOARD_SECRET; else process.env.CFX2_DASHBOARD_SECRET = prev;
    }
});

test('mounted before the site\'s limiter and CSRF check; the docs and register cover it', () => {
    const server = fs.readFileSync(path.join(root, 'dashboard/server.js'), 'utf8');
    const mount = server.indexOf("app.use('/activity', activitiesRouter());");
    assert.ok(mount > 0, 'mounted');
    assert.ok(mount < server.indexOf('app.use(globalLimiter);') && mount < server.indexOf('app.use(csrfProtection('), 'before the per-IP limiter and CSRF');
    const doc = fs.readFileSync(path.join(root, 'docs/activities.md'), 'utf8');
    for (const s of ['URL Mappings', '/gh-api', 'ACTIVITIES_ENABLED', 'pm2 stop CertiFried-Cinema', 'Bandwidth']) assert.ok(doc.includes(s), `docs/activities.md: ${s}`);
    const reg = fs.readFileSync(path.join(root, 'docs/feature-health-register.md'), 'utf8');
    assert.ok(/Discord Activities/.test(reg), 'register rows');
});
