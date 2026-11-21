import './fixtures/test-log-dir.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import feedsRouter from '../dashboard/routes/api/features/feeds.js';

/*
 * The Feeds page's Post-to picker (GET /api/guilds/:guildId/feeds/targets) and "Create a thread for this feed"
 * (POST .../feeds/threads), against a mocked guild served by the guild's own bot (global.botManager).
 */

const G = '100000000000000301';
const TEXT = '100000000000000302';
const VOICE = '100000000000000303';
const THREAD = '100000000000000304';
const ROLE = '100000000000000305';

const perms = (...flags) => ({ has: (f) => flags.includes(f) });
let created = [];

function makeGuild() {
    const me = { permissions: perms(PermissionFlagsBits.MentionEveryone) };
    const text = {
        id: TEXT, name: 'ace-feeds', type: 0, guildId: G, rawPosition: 1,
        permissionsFor: () => perms(PermissionFlagsBits.ViewChannel, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.MentionEveryone),
        threads: {
            fetchActive: async () => ({ threads: new Map([[THREAD, thread]]) }),
            fetchArchived: async () => ({ threads: new Map() }),
            create: async (opts) => { const t = { id: '100000000000000399', name: opts.name, type: 11, parentId: TEXT, parent: text, opts }; created.push(t); return t; },
        },
    };
    const thread = { id: THREAD, name: 'YouTube', type: 11, guildId: G, parentId: TEXT, parent: text };
    const voice = { id: VOICE, name: 'Lounge', type: 2, guildId: G };
    const cache = new Map([[TEXT, text], [VOICE, voice]]);
    return {
        id: G,
        members: { me },
        roles: { cache: new Map([[ROLE, { id: ROLE, name: 'X Notifications', mentionable: true }]]) },
        channels: {
            cache,
            fetch: async (id) => cache.get(id) || null,
            fetchActiveThreads: async () => ({ threads: new Map([[THREAD, thread]]) }),
        },
    };
}

let server, base;
before(async () => {
    const guild = makeGuild();
    global.botManager = { getClientForGuild: (id) => (id === G ? { guilds: { cache: new Map([[G, guild]]) } } : null) };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: '1', username: 'tester' }; next(); });
    app.use('/api/guilds/:guildId/feeds', feedsRouter);
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}/api/guilds`;
});
after(async () => {
    delete global.botManager;
    await new Promise((r) => server.close(r));
    await pool.end().catch(() => {});
});

test('GET /targets lists text channels and their active threads, not voice channels', async () => {
    const res = await fetch(`${base}/${G}/feeds/targets`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.targets.map((t) => [t.id, t.label, t.thread]), [
        [TEXT, '#ace-feeds', false],
        [THREAD, '#ace-feeds › YouTube', true],
    ]);
    assert.equal(body.canMentionAll, true);
});

test('GET /targets without a connected bot says so', async () => {
    const res = await fetch(`${base}/100000000000000999/feeds/targets`);
    assert.equal(res.status, 503);
});

test('POST /threads reuses a thread with the same name', async () => {
    created = [];
    const res = await fetch(`${base}/${G}/feeds/threads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel_id: TEXT, name: 'youtube' }) });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.reused, true);
    assert.equal(body.thread.id, THREAD);
    assert.equal(created.length, 0);
});

test('POST /threads creates a public thread with a one-week auto-archive', async () => {
    created = [];
    const res = await fetch(`${base}/${G}/feeds/threads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel_id: TEXT, name: 'Bluesky' }) });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.reused, false);
    assert.equal(body.thread.label, '#ace-feeds › Bluesky');
    assert.equal(created[0].opts.autoArchiveDuration, 10080);
});

test('POST /threads refuses a voice channel and an empty name', async () => {
    const voice = await fetch(`${base}/${G}/feeds/threads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel_id: VOICE, name: 'X' }) });
    assert.equal(voice.status, 400);
    const empty = await fetch(`${base}/${G}/feeds/threads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel_id: TEXT, name: '  ' }) });
    assert.equal(empty.status, 400);
    assert.match((await empty.json()).error, /name/);
});
