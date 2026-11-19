/*
 * /arcade greenhouse status | daily | link (commands/games/arcade-greenhouse-handler.js) against an isolated
 * Greenhouse Tycoon schema (ghtest_<6 hex>_ tables, dropped at the end), through the real arcade command
 * module with stubbed interactions, plus the text path that sends link codes by DM.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Collection } from 'discord.js';
import pool from '../utils/db.js';
import { createSchema, dropSchema, existingTables } from '../services/cfx/store/schema.js';
import { createGreenhouseBridge } from '../services/cfx/integrations/bot.js';
import { setBridgeForTests, ERROR_TEXT } from '../commands/games/arcade-greenhouse-handler.js';
import arcade from '../commands/games/arcade.js';
import { PRIVATE_TEXT_PATHS } from '../core/command-registration.js';
import { MessageContextAdapter } from '../core/message-context-adapter.js';
import { buildIndex, resolve } from '../core/universal-commands.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const prefix = `ghtest_${crypto.randomBytes(3).toString('hex')}_`;
let bridge;

const ID_A = '900000000000000001';
const ID_B = '900000000000000002';
const ID_C = '900000000000000003';

function stub({ userId, sub, code = null, message = null }) {
    const replies = [];
    return {
        user: { id: userId, username: 'tester', globalName: 'Tester' },
        guild: null,
        deferred: false,
        replied: false,
        message,
        options: {
            getSubcommandGroup: () => 'greenhouse',
            getSubcommand: () => sub,
            getString: (n) => (n === 'code' ? code : null)
        },
        async reply(p) { this.replied = true; replies.push(p); },
        async editReply(p) { replies.push(p); },
        replies
    };
}

const embedOf = (p) => p.embeds[0].toJSON();
const textOf = (p) => { const e = embedOf(p); return [e.title, e.description, ...(e.fields || []).map(f => `${f.name}: ${f.value}`)].filter(Boolean).join('\n'); };
const ephemeral = (p) => (Number(p.flags) & 64) === 64;

async function run(opts) {
    const i = stub(opts);
    await arcade.execute(i);
    assert.equal(i.replies.length, 1, 'one reply');
    return i.replies[0];
}

before(async () => {
    await createSchema(pool, prefix);
    bridge = createGreenhouseBridge({ db: pool, prefix, logger: quiet, publicUrl: 'https://example.test' });
    setBridgeForTests(bridge);
});

after(async () => {
    setBridgeForTests(null);
    await dropSchema(pool, prefix);
    assert.deepEqual(await existingTables(pool, prefix), []);
    await pool.end();
});

test('not set up: every subcommand says so when the tables do not exist', async () => {
    setBridgeForTests(createGreenhouseBridge({ db: pool, prefix: 'ghtest_000000_', logger: quiet }));
    try {
        for (const sub of ['status', 'daily', 'link']) {
            const r = await run({ userId: ID_A, sub });
            assert.match(textOf(r), /not open yet/);
        }
    } finally {
        setBridgeForTests(bridge);
    }
});

test('status without a save explains how to start', async () => {
    const r = await run({ userId: ID_A, sub: 'status' });
    assert.match(embedOf(r).title, /No greenhouse yet/);
    assert.equal(r.components[0].toJSON().components[0].url, 'https://example.test/greenhouse');
});

test('daily: the first one makes the save and pays; the second the same day is refused', async () => {
    const first = await run({ userId: ID_A, sub: 'daily' });
    assert.match(textOf(first), /greenhouse is ready/);
    assert.match(textOf(first), /collected\. Streak: day 1/);
    const second = await run({ userId: ID_A, sub: 'daily' });
    assert.match(embedOf(second).title, /Already collected today/);
    const status = await run({ userId: ID_A, sub: 'status' });
    assert.match(embedOf(status).title, /Tester's greenhouse/);
    assert.match(textOf(status), /Collected \(streak 1\)/);
    // One daily ledger entry for the account.
    const s = await bridge._parts().store;
    const who = await s.accounts.findIdentity('discord', ID_A);
    const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM ${prefix}ledger WHERE account_id = ? AND reason = 'daily'`, [who.accountId]);
    assert.equal(Number(rows[0].n), 1);
});

test('daily is shared with the website: a claim there blocks the bot the same day (after linking)', async () => {
    const { store, game } = bridge._parts();
    const web = await store.accounts.signIn({ platform: 'twitch', platformUserId: '4242424242', displayName: 'Web Grower' });
    await game.claimDaily(web.accountId, { identityId: web.identityId });
    const { code } = await store.accounts.createLinkCode({ accountId: web.accountId, identityId: web.identityId });
    const linked = await run({ userId: ID_B, sub: 'link', code });
    assert.ok(ephemeral(linked), 'link replies are private');
    assert.match(textOf(linked), /now plays that greenhouse/);
    const who = await store.accounts.findIdentity('discord', ID_B);
    assert.equal(who.accountId, web.accountId);
    const again = await run({ userId: ID_B, sub: 'daily' });
    assert.match(embedOf(again).title, /Already collected today/);
    const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM ${prefix}daily_claims WHERE account_id = ?`, [web.accountId]);
    assert.equal(Number(rows[0].n), 1);
});

test('link: makes a private code; bad codes and a second Discord sign-in on one save get clear answers', async () => {
    const made = await run({ userId: ID_A, sub: 'link' });
    assert.ok(ephemeral(made));
    const code = textOf(made).match(/\*\*([A-Z0-9]{8})\*\*/)[1];
    const bad = await run({ userId: ID_C, sub: 'link', code: 'ZZZZZZZZ' });
    assert.equal(embedOf(bad).description, ERROR_TEXT.LINK_CODE_INVALID);
    // A's save already has a Discord sign-in (A), so C cannot join it: one sign-in per platform.
    const clash = await run({ userId: ID_C, sub: 'link', code: code.toLowerCase() });
    assert.equal(embedOf(clash).description, ERROR_TEXT.PLATFORM_ALREADY_LINKED);
    const { store } = bridge._parts();
    assert.equal((await store.accounts.findIdentity('discord', ID_C)).accountId, null, 'C stays without a save');
    // Redeeming the code on the save it came from is harmless.
    const same = await run({ userId: ID_A, sub: 'link', code });
    assert.match(textOf(same), /already on that greenhouse/);
    const used = await run({ userId: ID_A, sub: 'link', code });
    assert.equal(embedOf(used).description, ERROR_TEXT.LINK_CODE_INVALID, 'a code works once');
});

test('link without a save tells the member how to join one', async () => {
    const r = await run({ userId: '900000000000000009', sub: 'link' });
    assert.match(textOf(r), /no greenhouse yet/);
});

test('text path: the link code goes by DM, the channel only gets a note, and the typed code is deleted', async () => {
    assert.ok(PRIVATE_TEXT_PATHS.has('arcade greenhouse link'));
    const dms = [];
    const channelReplies = [];
    let deleted = false;
    const message = {
        id: '1', author: { id: ID_A, username: 'tester', globalName: 'Tester', send: async (p) => { dms.push(p); return { id: 'dm' }; } },
        member: null, guild: null, guildId: '000000000000000003', channelId: '2', client: {}, createdTimestamp: Date.now(),
        channel: { sendTyping: async () => {}, send: async (p) => { channelReplies.push(p); return { id: 'c', edit: async () => {}, delete: async () => {} }; } },
        reply: async (p) => { channelReplies.push(p); return { id: 'r', edit: async () => {}, delete: async () => {} }; },
        delete: async () => { deleted = true; }
    };
    const ctx = new MessageContextAdapter(message, 'arcade', {}, { subcommand: 'link', subcommandGroup: 'greenhouse', privateDm: true });
    await arcade.execute(ctx);
    assert.equal(dms.length, 1, 'code sent by DM');
    assert.match(textOf(dms[0]), /\*\*[A-Z0-9]{8}\*\*/);
    assert.equal(channelReplies.length, 1);
    assert.equal(channelReplies[0].content, 'Sent you the result by DM.');
    const ctx2 = new MessageContextAdapter(message, 'arcade', { code: 'ZZZZZZZZ' }, { subcommand: 'link', subcommandGroup: 'greenhouse', privateDm: true });
    await arcade.execute(ctx2);
    await new Promise(r => setImmediate(r));
    assert.ok(deleted, 'the message that carried a code was deleted');
});

test('the chat bridge finds /arcade greenhouse ... and the bare /greenhouse ... form', async () => {
    const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const commands = new Collection();
    for (const folder of fs.readdirSync(path.join(ROOT, 'commands'))) {
        const dir = path.join(ROOT, 'commands', folder);
        if (!fs.statSync(dir).isDirectory()) continue;
        for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
            const c = (await import(`file://${path.join(dir, f)}`)).default;
            if (c?.data && c.execute) commands.set(c.data.name, c);
        }
    }
    buildIndex({ commands });
    for (const sub of ['status', 'daily', 'link']) {
        assert.equal(resolve(['arcade', 'greenhouse', sub])?.path, `arcade greenhouse ${sub}`);
        assert.equal(resolve(['greenhouse', sub])?.path, `arcade greenhouse ${sub}`);
    }
});
