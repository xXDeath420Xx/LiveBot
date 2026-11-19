import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * H-718: typed self-care commands (/habit, /tasks, /challenges, /wellness) posted their "private" replies in the
 * channel, because a chat message cannot answer ephemerally and the text bridge dropped the flag. Every selfcare
 * text path now sends private replies by DM (core/command-registration.js isPrivateTextPath) with a short note in
 * the channel; with DMs closed, only a short note is posted and the private content is not.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h718-'));
process.env.LOG_DIR = tmp;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pool = (await import('../utils/db.js')).default;
const { isPrivateTextPath } = await import('../core/command-registration.js');
const { MessageContextAdapter } = await import('../core/message-context-adapter.js');
const selfcare = (await import('../commands/tools/selfcare.js')).default;

test.after(async () => { await pool.end().catch(() => {}); fs.rmSync(tmp, { recursive: true, force: true }); });

const GUILD = '900000000000000718';   // no self-care settings saved: replies are private by default
const USER = '900000000000000719';
const textOf = (p) => (typeof p === 'string' ? p : [p.content, ...(p.embeds || []).map((e) => JSON.stringify(e.toJSON ? e.toJSON() : e))].join(' '));

function chatMessage({ dmOpen }) {
    const dms = [];
    const channel = [];
    const sent = { id: 'r', edit: async (p) => { channel.push(p); return sent; }, delete: async () => {} };
    const message = {
        id: '1', guildId: GUILD, channelId: '2', guild: { id: GUILD, name: 'Test server' }, member: null, client: {}, createdTimestamp: Date.now(),
        author: { id: USER, username: 'tester', globalName: 'Tester', send: async (p) => { if (!dmOpen) throw new Error('Cannot send messages to this user'); dms.push(p); return { id: 'dm' }; } },
        channel: { sendTyping: async () => {}, send: async (p) => { channel.push(p); return sent; } },
        reply: async (p) => { channel.push(p); return sent; },
    };
    return { message, dms, channel };
}

test('every selfcare text path is private; other commands are not', () => {
    for (const p of ['selfcare habit list', 'selfcare habit add', 'selfcare tasks tasks', 'selfcare challenges view', 'selfcare wellness affirmation']) {
        assert.equal(isPrivateTextPath(p), true, p);
    }
    for (const p of ['tools generate password', 'arcade greenhouse link']) assert.equal(isPrivateTextPath(p), true, p);
    for (const p of ['fun joke', 'selfcareless x', '', null]) assert.equal(isPrivateTextPath(p), false, String(p));
    const bridge = fs.readFileSync(path.join(root, 'core/universal-commands.js'), 'utf8');
    assert.match(bridge, /privateDm: isPrivateTextPath\(path\)/);
});

test('typed /habit list replies by DM and says so in the channel', async () => {
    const { message, dms, channel } = chatMessage({ dmOpen: true });
    const ctx = new MessageContextAdapter(message, 'selfcare', {}, { subcommand: 'list', subcommandGroup: 'habit', privateDm: isPrivateTextPath('selfcare habit list') });
    await selfcare.execute(ctx);
    assert.equal(dms.length, 1, 'the reply went by DM');
    assert.doesNotMatch(textOf(dms[0]), /Error:/, 'the command ran, not its error path');
    assert.equal(channel.length, 1, 'one note in the channel');
    assert.equal(channel[0].content, 'Sent you the result by DM.');
});

test('with DMs closed, the channel gets a short note and not the private reply', async () => {
    const { message, dms, channel } = chatMessage({ dmOpen: false });
    const ctx = new MessageContextAdapter(message, 'selfcare', {}, { subcommand: 'list', subcommandGroup: 'habit', privateDm: true });
    await selfcare.execute(ctx);
    assert.equal(dms.length, 0);
    assert.equal(channel.length, 1);
    assert.equal(channel[0].content, 'That reply is private, but your DMs are closed. Allow DMs from server members and try again.');
    assert.doesNotMatch(textOf(channel[0]), /habit/i);
});

test('the Self-Care page no longer says typed commands answer in the channel', async () => {
    const { FEATURE_SPECS } = await import('../core/feature-config-spec.js');
    const hint = FEATURE_SPECS.selfcare.fields.find((f) => f.key === 'private_by_default').hint;
    assert.doesNotMatch(hint, /cannot reply privately/);
    assert.match(hint, /by DM/);
});
