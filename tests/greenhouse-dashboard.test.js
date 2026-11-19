/*
 * Greenhouse Tycoon dashboard routes in a temporary express app against an isolated ghtest_ schema:
 *   /api/guilds/:guildId/greenhouse      (routes/api/features/greenhouse.js, the ?page=greenhouse server page)
 *   /api/super-admin/greenhouse[...]     (routes/greenhouse-admin.js: job kill switch, Twitch review save)
 * plus the nav alias (?page=cfx -> greenhouse). Throwaway guild 000000000000000003; tables dropped at the end.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import pool from '../utils/db.js';
import { createSchema, dropSchema, existingTables } from '../services/cfx/store/schema.js';
import { createGreenhouseBridge } from '../services/cfx/integrations/bot.js';
import { createGreenhouseRouter } from '../dashboard/routes/api/features/greenhouse.js';
import { registerGreenhouseAdmin, GAME_JOBS } from '../dashboard/routes/greenhouse-admin.js';
import { requireSuperAdmin } from '../utils/auth-middleware.js';
import { PAGES, PAGE_ALIASES } from '../core/manage-nav.js';
import { pageHelp } from '../core/page-help.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const prefix = `ghtest_${crypto.randomBytes(3).toString('hex')}_`;
const GUILD = '000000000000000003';
const MEMBER_1 = '910000000000000001';
const MEMBER_2 = '910000000000000002';
const STRANGER = '910000000000000099';
let bridge;
let server;
let base;
let fetchCalls = 0;

function fakeGuild() {
    const cache = new Map([[MEMBER_1, { displayName: 'Member One' }]]);
    return {
        id: GUILD,
        members: {
            cache,
            fetch: async ({ user }) => {
                fetchCalls++;
                // like discord.js: fetched members land in the cache too
                const got = new Map(user.filter(id => id === MEMBER_2).map(id => [id, { displayName: 'Member Two' }]));
                for (const [id, m] of got) cache.set(id, m);
                return got;
            }
        }
    };
}

async function call(method, url, body) {
    const res = await fetch(base + url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
}

before(async () => {
    await createSchema(pool, prefix);
    bridge = createGreenhouseBridge({ db: pool, prefix, logger: quiet, publicUrl: 'https://example.test' });
    const guild = fakeGuild();
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { id: '111111111111111111' }; req.botClient = { guilds: { cache: new Map([[GUILD, guild]]) } }; next(); });
    app.use('/api/guilds/:guildId/greenhouse', createGreenhouseRouter({ getBridge: async () => bridge, db: pool, prefix }));
    app.use('/api/guilds/:guildId/greenhouse-down', createGreenhouseRouter({ getBridge: async () => null, db: pool, prefix }));
    app.use('/api/guilds/:guildId/greenhouse-empty', createGreenhouseRouter({ getBridge: async () => createGreenhouseBridge({ db: pool, prefix: 'ghtest_000000_', logger: quiet }), db: pool, prefix }));
    const admin = express.Router();
    registerGreenhouseAdmin(admin, { getBridge: async () => bridge, guard: (req, res, next) => next() });
    app.use('/open', admin);
    const guarded = express.Router();
    registerGreenhouseAdmin(guarded, { getBridge: async () => bridge, guard: requireSuperAdmin });
    app.use('/guarded', guarded);
    server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise(r => server.close(r));
    await dropSchema(pool, prefix);
    assert.deepEqual(await existingTables(pool, prefix), []);
    await pool.end();
});

test('nav: ?page=cfx is an alias of the Greenhouse Tycoon page, which has one entry and help', () => {
    assert.equal(PAGE_ALIASES.cfx, 'greenhouse');
    assert.equal(PAGES.filter(p => p.page === 'greenhouse').length, 1);
    assert.equal(PAGES.filter(p => p.page === 'cfx').length, 0);
    assert.equal(pageHelp('cfx').page, 'greenhouse');
    assert.match(pageHelp('greenhouse').help, /Greenhouse Tycoon/);
});

test('server page: not set up yet, both when the bridge cannot load and when the tables do not exist', async () => {
    assert.deepEqual((await call('GET', `/api/guilds/${GUILD}/greenhouse-down`)).json, { ready: false });
    assert.deepEqual((await call('GET', `/api/guilds/${GUILD}/greenhouse-empty`)).json, { ready: false });
});

test('server page: members who play (cache and batched fetch), the season and the game link', async () => {
    const { store, game } = bridge._parts();
    for (const [id, name] of [[MEMBER_1, 'One'], [MEMBER_2, 'Two'], [STRANGER, 'Stranger']]) {
        const s = await store.accounts.signIn({ platform: 'discord', platformUserId: id, displayName: name });
        await game.claimDaily(s.accountId, { identityId: s.identityId });
    }
    await store.meta.rollover();
    const r = await call('GET', `/api/guilds/${GUILD}/greenhouse`);
    assert.equal(r.status, 200);
    const d = r.json;
    assert.equal(d.ready, true);
    assert.equal(d.gameUrl, 'https://example.test/greenhouse');
    assert.equal(d.botInServer, true);
    assert.equal(d.playersTotal, 2, 'only members of this server');
    assert.deepEqual(d.players.map(p => p.displayName).sort(), ['Member One', 'Member Two']);
    assert.equal(d.partial, false);
    assert.equal(d.season.number, 1);
    assert.ok(fetchCalls >= 1, 'uncached candidates were fetched in a batch');
    const before = fetchCalls;
    await call('GET', `/api/guilds/${GUILD}/greenhouse`);
    assert.equal(fetchCalls, before, 'member resolution is cached');
    const other = await call('GET', '/api/guilds/000000000000000004/greenhouse');
    assert.equal(other.json.botInServer, false);
    assert.equal(other.json.playersTotal, 0);
});

test('super-admin: only super-admins reach the game controls', async () => {
    for (const [m, u] of [['GET', '/guarded/api/super-admin/greenhouse'], ['POST', '/guarded/api/super-admin/greenhouse/jobs'], ['POST', '/guarded/api/super-admin/greenhouse/review'], ['POST', '/guarded/api/super-admin/greenhouse/review/reset']]) {
        const r = await call(m, u, m === 'POST' ? { disabled: true, enabled: true } : undefined);
        assert.equal(r.status, 403, `${m} ${u}`);
    }
});

test('super-admin: job kill switch (all, none, per job) with the updater recorded', async () => {
    let r = await call('GET', '/open/api/super-admin/greenhouse');
    assert.equal(r.json.ready, true);
    assert.equal(r.json.disabled, false);
    assert.deepEqual(r.json.jobs, GAME_JOBS);
    r = await call('POST', '/open/api/super-admin/greenhouse/jobs', { disabled: ['season-rollover', 'review-reset'] });
    assert.deepEqual(r.json.disabled, ['season-rollover', 'review-reset']);
    const { store } = bridge._parts();
    store.flags.clearCache();
    assert.equal(await store.flags.jobDisabled('season-rollover'), true);
    assert.equal(await store.flags.jobDisabled('market-day'), false);
    const [rows] = await pool.query(`SELECT updated_by FROM ${prefix}config WHERE name = 'jobs.disabled'`);
    assert.equal(rows[0].updated_by, '111111111111111111');
    r = await call('POST', '/open/api/super-admin/greenhouse/jobs', { disabled: true });
    assert.equal(r.json.disabled, true);
    r = await call('POST', '/open/api/super-admin/greenhouse/jobs', { disabled: false });
    assert.equal(r.json.disabled, false);
    r = await call('POST', '/open/api/super-admin/greenhouse/jobs', { disabled: ['not-a-job'] });
    assert.equal(r.status, 400);
    r = await call('POST', '/open/api/super-admin/greenhouse/jobs', { disabled: 'yes' });
    assert.equal(r.status, 400);
});

test('super-admin: review save switch, channel list and reset', async () => {
    let r = await call('POST', '/open/api/super-admin/greenhouse/review/reset');
    assert.equal(r.json.reset, false, 'nothing to reset before it exists');
    r = await call('POST', '/open/api/super-admin/greenhouse/review', { enabled: true, channelIds: '123456, 789' });
    assert.equal(r.json.enabled, true);
    r = await call('GET', '/open/api/super-admin/greenhouse');
    assert.equal(r.json.review.enabled, true);
    assert.deepEqual(r.json.review.channelIds, ['123456', '789']);
    const [acc] = await pool.query(`SELECT id, level, review FROM ${prefix}accounts WHERE review = 1`);
    assert.equal(acc.length, 1, 'the review save exists once it is opened');
    await pool.query(`UPDATE ${prefix}accounts SET level = 2 WHERE id = ?`, [acc[0].id]);
    r = await call('POST', '/open/api/super-admin/greenhouse/review/reset');
    assert.equal(r.json.reset, true);
    const [again] = await pool.query(`SELECT level FROM ${prefix}accounts WHERE id = ?`, [acc[0].id]);
    assert.equal(Number(again[0].level), 12, 'reset put the mid-game save back');
    r = await call('POST', '/open/api/super-admin/greenhouse/review', { enabled: false });
    assert.equal(r.json.enabled, false);
    r = await call('POST', '/open/api/super-admin/greenhouse/review', { enabled: 'yes' });
    assert.equal(r.status, 400);
    r = await call('POST', '/open/api/super-admin/greenhouse/review', { enabled: true, channelIds: 'abc' });
    assert.equal(r.status, 400);
});
