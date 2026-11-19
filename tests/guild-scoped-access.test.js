import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Collection, SlashCommandBuilder } from 'discord.js';

/*
 * H-711: a per-server (guildScoped) command runs from chat only where it is registered: a server with an
 * enabled guild_scoped_commands row (limited to its command_names list) on the main bot, or a server a
 * custom bot serves. Anywhere else the chat bridge treats it as an unknown command.
 * H-712: the Moderation page shows Ban requests only where /ban is available.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const access = await import('../core/guild-scoped-access.js');
const { runUniversalCommand } = await import('../core/universal-commands.js');

// guild_scoped_commands as the deploy script reads it; G-ALL opted in to everything, G-KK to three commands.
const ROWS = {
    'G-ALL': { enabled: 1, command_names: null },
    'G-KK': { enabled: 1, command_names: JSON.stringify(['ban', 'modreason', 'weekly-recap']) },
    'G-OFF': { enabled: 0, command_names: null },
};
const MAPPED = new Set(['G-CUSTOM']);
const fakeDb = {
    queries: 0,
    async execute(sql, params) {
        this.queries++;
        if (/FROM guild_scoped_commands/.test(sql)) return [ROWS[params[0]] ? [ROWS[params[0]]] : []];
        if (/FROM guild_bot_mapping/.test(sql)) return [MAPPED.has(params[0]) ? [{ 1: 1 }] : []];
        throw new Error(`unexpected query ${sql}`);
    },
};
access._setDb(fakeDb);

test('namesFromRow reads a row the way scripts/deploy-guild-scoped-commands.js does', () => {
    assert.equal(access.namesFromRow(null), null);
    assert.equal(access.namesFromRow({ enabled: 0, command_names: null }), null);
    assert.equal(access.namesFromRow({ enabled: 1, command_names: null }), 'all');
    assert.equal(access.namesFromRow({ enabled: 1, command_names: 'not json' }), 'all');
    assert.deepEqual([...access.namesFromRow({ enabled: 1, command_names: '["ban","modreason"]' })], ['ban', 'modreason']);
});

test('main bot: only opted-in servers, and only the listed commands', async () => {
    const main = { isDefaultBot: true };
    assert.equal(await access.isScopedCommandAvailable(main, 'G-ALL', 'puff'), true);
    assert.equal(await access.isScopedCommandAvailable(main, 'G-KK', 'ban'), true);
    assert.equal(await access.isScopedCommandAvailable(main, 'G-KK', 'cannabis'), false);
    assert.equal(await access.isScopedCommandAvailable(main, 'G-OFF', 'ban'), false);
    assert.equal(await access.isScopedCommandAvailable(main, 'G-NONE', 'weekly-recap'), false);
    assert.equal(await access.isScopedCommandAvailable(main, null, 'ban'), false);
});

test('custom bot: every server it serves, nothing else', async () => {
    const custom = { isDefaultBot: false, assignedGuilds: ['G-CUSTOM', 'G-2'] };
    assert.equal(await access.isScopedCommandAvailable(custom, 'G-CUSTOM', 'cannabis'), true);
    assert.equal(await access.isScopedCommandAvailable(custom, 'G-2', 'ban'), true);
    assert.equal(await access.isScopedCommandAvailable(custom, 'G-NONE', 'ban'), false);
});

test('the dashboard check: a custom bot serving the server, or the main bot opt-in', async () => {
    assert.equal(await access.isCommandAvailableInGuild('G-CUSTOM', 'ban'), true);
    assert.equal(await access.isCommandAvailableInGuild('G-KK', 'ban'), true);
    assert.equal(await access.isCommandAvailableInGuild('G-NONE', 'ban'), false);
    assert.equal(await access.isCommandAvailableInGuild('G-OFF', 'ban'), false);
});

test('a database error fails closed', async () => {
    access._setDb({ execute: async () => { throw new Error('down'); } });
    try {
        assert.equal(await access.isScopedCommandAvailable({ isDefaultBot: true }, 'G-ALL', 'ban'), false);
    } finally {
        access._setDb(fakeDb);
    }
});

test('legacy cannabis prefix commands map to the guildScoped command they run', async () => {
    const { getCommand } = await import('../core/prefix-command-registry.js');
    assert.equal(access.legacyScopedCommand(getCommand('toke')), 'cannabis');
    assert.equal(access.legacyScopedCommand(getCommand('strain')), 'grow');
    assert.equal(access.legacyScopedCommand(getCommand('startgrow')), 'grow');
    assert.equal(access.legacyScopedCommand(getCommand('ban')), null);   // the /admin mod ban shortcut, not /ban
    assert.equal(access.legacyScopedCommand(null), null);
    const pcm = read('core/prefix-command-manager.js');
    assert.match(pcm, /legacyScopedCommand\(commandDef\)/);
    assert.match(pcm, /isScopedCommandAvailable\(message\.client, message\.guildId, scopedAs\)/);
});

// ── The chat bridge ──────────────────────────────────────────────────────────

function scopedModule() {
    const ran = [];
    const data = new SlashCommandBuilder().setName('fascoped').setDescription('test')
        .addStringOption(o => o.setName('what').setDescription('w').setRequired(true));
    return { ran, command: { category: 'community', guildScoped: true, data, execute: async () => { ran.push(1); } } };
}

function fakeMessage(client, guildId) {
    const replies = [];
    return {
        replies,
        client, guildId, guild: null, member: null, channelId: 'C1', id: 'M1',
        author: { id: 'U-test', bot: false },
        content: '!fascoped',
        mentions: { users: new Map() },
        reply: async (m) => { replies.push(typeof m === 'string' ? m : m.content); return { delete: async () => {} }; },
    };
}

function fakeClient(command, extra = {}) {
    const commands = new Collection();
    commands.set(command.data.name, command);
    return { commands, managersReady: true, user: { id: 'BOT' }, ...extra };
}

test('chat: a guildScoped command is unknown where it is not registered', async () => {
    const { command, ran } = scopedModule();
    const client = fakeClient(command, { isDefaultBot: true });
    const msg = fakeMessage(client, 'G-NONE');
    assert.equal(await runUniversalCommand(msg, ['fascoped'], '!'), false);
    assert.deepEqual(msg.replies, []);
    assert.equal(ran.length, 0);
    // "/" text form, as typed in a server with prefix commands off: still nothing.
    const slashMsg = fakeMessage(client, 'G-NONE');
    assert.equal(await runUniversalCommand(slashMsg, ['fascoped', 'x'], '/', { textOnly: true }), false);
    assert.deepEqual(slashMsg.replies, []);
});

test('chat: the same command runs in an opted-in server and on a custom bot that serves the server', async () => {
    const { command } = scopedModule();
    const main = fakeClient(command, { isDefaultBot: true });
    const opted = fakeMessage(main, 'G-ALL');
    assert.equal(await runUniversalCommand(opted, ['fascoped'], '!'), true);
    assert.match(opted.replies[0] || '', /Missing \*\*what\*\*/);   // reached the command's own argument check

    const custom = fakeClient(command, { isDefaultBot: false, assignedGuilds: ['G-CUSTOM'] });
    const served = fakeMessage(custom, 'G-CUSTOM');
    assert.equal(await runUniversalCommand(served, ['fascoped'], '!'), true);
    assert.match(served.replies[0] || '', /Missing \*\*what\*\*/);
});

test('chat: a server with a command list gets only the listed commands', async () => {
    const { command } = scopedModule();
    const client = fakeClient(command, { isDefaultBot: true });
    const msg = fakeMessage(client, 'G-KK');   // fascoped is not on G-KK's list
    assert.equal(await runUniversalCommand(msg, ['fascoped'], '!'), false);
    assert.deepEqual(msg.replies, []);
});

test('the real guildScoped commands are the ones the bridge now checks', async () => {
    for (const f of ['commands/admin/ban.js', 'commands/admin/modreason.js', 'commands/admin/weekly-recap.js',
        'commands/community/cannabis.js', 'commands/community/cannafriend-puff.js', 'commands/community/grow.js']) {
        const mod = (await import(path.join(root, f))).default;
        assert.equal(mod.guildScoped, true, f);
    }
    assert.match(read('core/universal-commands.js'), /scopedCommandOf\(hit\)/);
});

// ── H-712: Ban requests on the Moderation page ───────────────────────────────

async function renderModeration(extra) {
    const { createViewEngine } = await import('../dashboard/services/view-engine.js');
    const views = path.join(root, 'dashboard/views');
    const engine = createViewEngine({ viewsDir: views, cache: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fina-mod-'));
    try {
        const file = path.join(dir, 'p.ejs');
        fs.writeFileSync(file, `<%- include(${JSON.stringify(path.join(views, 'partials/manage/moderation'))}) %>`);
        const guild = { id: '111111111111111111', name: 'Test', members: { me: null } };
        return engine.renderFile(file, { guild, settings: {}, infractions: [], escalationRules: [], channels: [], roles: [], ...extra });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('Moderation page: Ban requests only where /ban is available', async () => {
    const on = await renderModeration({ banAvailable: true });
    assert.match(on, /id="cfk-mod-banreq"/);
    assert.doesNotMatch(on, /id="cfk-mod-banreq-unavailable"/);
    const off = await renderModeration({ banAvailable: false });
    assert.doesNotMatch(off, /id="cfk-mod-banreq"[ >]/);
    assert.doesNotMatch(off, /moderation\/ban-requests/);
    assert.match(off, /id="cfk-mod-banreq-unavailable"/);
    // Not passed (an older caller): the section shows, as before.
    assert.match(await renderModeration({}), /id="cfk-mod-banreq"/);
});

test('the manage page passes the same rule to the partial', () => {
    const server = read('dashboard/server.js');
    assert.match(server, /banCommandAvailable: await \(async \(\) => \{[\s\S]{0,400}isCommandAvailableInGuild\(guildId, 'ban'\)/);
    for (const f of ['dashboard/views/manage-tailwind.ejs', 'dashboard/views/manage-classic.ejs']) {
        assert.match(read(f), /'moderation': \{ partial: 'moderation', data: \{[^}]*banAvailable: locals\.banCommandAvailable !== false/, f);
    }
});
