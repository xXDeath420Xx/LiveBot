import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

/*
 * H-715: giveaway host roles gate the Create Giveaway button panel, which only a one-server script ever posted.
 * The Giveaways page now posts that panel in any server (core/giveaway-panel.js, PUT /api/guilds/:id/giveaways/panel):
 * one per server, edited in place when posted again, moved when another channel is chosen, removed with None.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h715-'));
process.env.LOG_DIR = tmp;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const pool = (await import('../utils/db.js')).default;
const panel = await import('../core/giveaway-panel.js');
const router = (await import('../dashboard/routes/api/features/giveaways.js')).default;

const GUILD = '900000000000000715';
const BOT = '900000000000000800';
const A = '900000000000000801';
const B = '900000000000000802';
const VOICE = '900000000000000803';

function makeGuild({ canPost = true, oldPanel = false } = {}) {
    const log = { sent: [], edited: [], deleted: [] };
    const messages = new Map();
    let n = 1000;
    const message = (id, channelId, components = []) => ({
        id, channelId, author: { id: BOT }, components,
        edit: async () => { log.edited.push(id); return message(id, channelId, components); },
        delete: async () => { log.deleted.push(id); messages.delete(id); },
        pin: async () => {},
    });
    const channel = (id, type, name) => ({
        id, type, name,
        permissionsFor: () => ({ has: () => canPost }),
        send: async (payload) => { const m = message(String(++n), id, payload.components); messages.set(m.id, m); log.sent.push({ channel: id, payload }); return m; },
        messages: {
            fetch: async (arg) => {
                if (arg && typeof arg === 'object') return new Map([...messages].filter(([, m]) => m.channelId === id));
                return messages.get(String(arg)) || null;
            },
        },
    });
    const cache = new Map([[A, channel(A, 0, 'giveaways')], [B, channel(B, 5, 'events')], [VOICE, channel(VOICE, 2, 'lounge')]]);
    if (oldPanel) {
        const m = message('999', A, [{ components: [{ customId: 'giveaway_create' }] }]);
        messages.set('999', m);
    }
    return { id: GUILD, log, members: { me: { id: BOT } }, channels: { cache, fetch: async (id) => cache.get(id) || null } };
}

function memoryDb() {
    const rows = new Map();
    return {
        rows,
        async execute(sql, params) {
            if (/^\s*SELECT/i.test(sql)) return [rows.has(params[0]) ? [rows.get(params[0])] : []];
            if (/^\s*INSERT/i.test(sql)) { rows.set(params[0], { channel_id: params[1], message_id: params[2] }); return [{ affectedRows: 1 }]; }
            if (/^\s*DELETE/i.test(sql)) { rows.delete(params[0]); return [{ affectedRows: 1 }]; }
            throw new Error(sql);
        },
    };
}

test.after(async () => {
    await pool.execute('DELETE FROM giveaway_panels WHERE guild_id = ?', [GUILD]).catch(() => {});
    await pool.end().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('the panel carries the button host roles gate', () => {
    const p = panel.panelPayload(GUILD);
    assert.equal(p.components[0].components[0].custom_id, 'giveaway_create');
    assert.match(read('interactions/handlerRegistry.js'), /'giveaway_create': handleGiveawayCreateButton/);
    assert.match(read('interactions/buttons/giveaway_create.js'), /giveaway_host_roles/);
});

test('post, post again, move, remove', async () => {
    const guild = makeGuild();
    const db = memoryDb();
    const first = await panel.postGiveawayPanel({ guild, channelId: A, db });
    assert.deepEqual([first.ok, first.action, first.channelId], [true, 'posted', A]);
    assert.equal(guild.log.sent.length, 1);
    assert.equal(db.rows.get(GUILD).message_id, first.messageId);

    const again = await panel.postGiveawayPanel({ guild, channelId: A, db });
    assert.equal(again.action, 'updated');
    assert.equal(again.messageId, first.messageId);
    assert.equal(guild.log.sent.length, 1, 'no second message');

    const moved = await panel.postGiveawayPanel({ guild, channelId: B, db });
    assert.equal(moved.action, 'moved');
    assert.deepEqual(guild.log.deleted, [first.messageId]);
    assert.equal(db.rows.get(GUILD).channel_id, B);

    const gone = await panel.removeGiveawayPanel({ guild, db });
    assert.equal(gone.removed, true);
    assert.equal(db.rows.has(GUILD), false);
    assert.deepEqual(guild.log.deleted, [first.messageId, moved.messageId]);
});

test('a panel the old script posted is reused, not doubled', async () => {
    const guild = makeGuild({ oldPanel: true });
    const out = await panel.postGiveawayPanel({ guild, channelId: A, db: memoryDb() });
    assert.equal(out.messageId, '999');
    assert.deepEqual(guild.log.edited, ['999']);
    assert.equal(guild.log.sent.length, 0);
});

test('refuses a bad, non-text or unpostable channel', async () => {
    const db = memoryDb();
    assert.equal((await panel.postGiveawayPanel({ guild: makeGuild(), channelId: 'x', db })).ok, false);
    assert.match((await panel.postGiveawayPanel({ guild: makeGuild(), channelId: VOICE, db })).error, /text or announcement/);
    assert.match((await panel.postGiveawayPanel({ guild: makeGuild({ canPost: false }), channelId: A, db })).error, /cannot post in #giveaways/);
    assert.equal((await panel.postGiveawayPanel({ guild: null, channelId: A, db })).ok, false);
    assert.equal(db.rows.size, 0);
});

test('the Giveaways page API posts it in any server and the table exists', async () => {
    const guild = makeGuild();
    global.botManager = { getClientForGuild: () => ({ guilds: { cache: new Map([[GUILD, guild]]) } }) };
    const app = express();
    app.use(express.json());
    app.use('/api/guilds/:guildId/giveaways', router);
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/guilds/${GUILD}/giveaways/panel`;
    try {
        const put = await fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel_id: A }) });
        const body = await put.json();
        assert.equal(put.status, 200, JSON.stringify(body));
        assert.equal(body.message, 'Panel posted');
        const got = await (await fetch(base)).json();
        assert.equal(got.panel.channel_id, A);
        const off = await (await fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"channel_id":""}' })).json();
        assert.equal(off.message, 'Panel removed');
        assert.equal((await (await fetch(base)).json()).panel, null);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        delete global.botManager;
    }
});

test('the page has the panel channel picker and saves through the API', () => {
    const page = read('dashboard/views/partials/manage/giveaways.ejs');
    assert.match(page, /id="gw-panel-channel"/);
    assert.match(page, /giveaways\/panel`, \{\s*method: 'PUT'/);
    assert.doesNotMatch(page, /These roles apply to the Create giveaway button panel in Discord\./);
});
