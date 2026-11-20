import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeGuild } from './fixtures/fake-discord-guild.js';
import {
    normalizeSnapshot, detectFormat, readGuildState, planRestore, summarizePlan, startRestore, runStatus,
    setRunDir, saveRun, restoreConfigTable, withRetry, desiredOverwrites,
} from '../core/backup-restore.js';

/*
 * H-801: /admin backup restore deleted every channel and role, then rebuilt nothing from weekly or
 * dashboard backups. The rebuilt restore previews, never deletes unless asked, deletes last, reads every
 * backup kind, retries rate limits and can resume. All of it runs here against an in-memory guild.
 */

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-restore-'));
setRunDir(runDir);
process.on('exit', () => { try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* best effort */ } });

const G = '100000000000000001';
const R = { admin: '200000000000000001', mod: '200000000000000002', member: '200000000000000003', muted: '200000000000000004' };
const C = { info: '300000000000000001', staff: '300000000000000002' };
const CH = { rules: '400000000000000001', ann: '400000000000000002', modchat: '400000000000000003', vc: '400000000000000004', lobby: '400000000000000005' };
const U1 = '500000000000000001'; const U2 = '500000000000000002';
const VIEW = '1024'; const SEND = '2048';

function v5Snapshot() {
    return {
        version: 5,
        discord: {
            roles: [
                { id: R.admin, name: 'Admin', color: '#ff0000', position: 5, permissions: '8', hoist: true, mentionable: false },
                { id: R.mod, name: 'Mod', color: '#00ff00', position: 4, permissions: '8192', hoist: true, mentionable: true },
                { id: R.member, name: 'Member', color: '#000000', position: 3, permissions: '0', hoist: false, mentionable: false },
                { id: R.muted, name: 'Muted', color: '#808080', position: 2, permissions: '0', hoist: false, mentionable: false },
            ],
            everyonePermissions: '3072',
            members: [
                { id: U1, username: 'one', roles: [R.mod, R.member] },
                { id: U2, username: 'two', roles: [R.member] },
            ],
            categories: [
                { id: C.info, name: 'Info', position: 0, permissionOverwrites: [{ id: G, type: 0, allow: '0', deny: SEND }] },
                { id: C.staff, name: 'Staff', position: 1, permissionOverwrites: [{ id: G, type: 0, allow: '0', deny: VIEW }, { id: R.mod, type: 0, allow: VIEW, deny: '0' }] },
            ],
            channels: [
                { id: CH.rules, name: 'rules', type: 0, parentId: C.info, position: 0, topic: 'Read me', permissionOverwrites: [{ id: G, type: 0, allow: '0', deny: SEND }] },
                { id: CH.ann, name: 'announcements', type: 5, parentId: C.info, position: 1, permissionOverwrites: [] },
                { id: CH.modchat, name: 'mod-chat', type: 0, parentId: C.staff, position: 0, permissionOverwrites: [
                    { id: G, type: 0, allow: '0', deny: VIEW }, { id: R.mod, type: 0, allow: VIEW, deny: '0' }, { id: U1, type: 1, allow: VIEW, deny: '0' }] },
                { id: CH.vc, name: 'General VC', type: 2, parentId: null, position: 0, bitrate: 64000, userLimit: 10, permissionOverwrites: [] },
                { id: CH.lobby, name: 'lobby', type: 0, parentId: null, position: 1, permissionOverwrites: [] },
            ],
            settings: { verificationLevel: 1, systemChannelId: CH.lobby },
            emojis: [{ name: 'wave', url: 'https://cdn.example/wave.png' }],
            stickers: [],
        },
        webhooks: [{ name: 'Hook', channelId: CH.lobby }],
        bans: [{ userId: '600000000000000001', username: 'spammer', reason: 'spam' }],
    };
}
const row = (snapshot, id = 1, name = 'Auto Weekly 2026-11-15') => ({ id, snapshot_name: name, snapshot_json: JSON.stringify(snapshot) });
const deps = () => ({ pool: null, allowedTables: new Set(), pace: 0, sleep: async () => {} });
const nuked = () => fakeGuild({ id: G, members: [{ id: U1 }, { id: U2 }] });

async function restore(guild, snapshot, options = {}, extra = {}) {
    const r = await startRestore({ guild, backupRow: row(snapshot), options, by: { id: '1', username: 'admin' }, source: 'test', deps: { ...deps(), ...extra } });
    assert.equal(r.ok, true, r.error);
    return r.done;
}

test('every backup kind is read: v5 (weekly/dashboard), flat, and the old /admin backup create format', () => {
    assert.equal(detectFormat(v5Snapshot()), 'v5');
    assert.equal(detectFormat({ roles: [{ id: '1', name: 'a' }], channels: [] }), 'flat');
    assert.equal(detectFormat({ version: '2.0', roles: [{ name: 'a' }], categories: [], channels: [] }), 'v2');
    assert.equal(detectFormat({ botConfig: {} }), 'unknown');
    const n = normalizeSnapshot(v5Snapshot(), { guildId: G });
    assert.equal(n.roles.length, 4);
    assert.equal(n.categories.length, 2);
    assert.equal(n.channels.length, 5);
    const modchat = n.channels.find(c => c.name === 'mod-chat');
    assert.deepEqual(modchat.overwrites.map(o => o.target.kind), ['everyone', 'role', 'member']);
    assert.equal(modchat.parentKey, `cat:${C.staff}`);
    assert.equal(n.roles[0].color, 0xff0000);
    assert.equal(n.members.find(m => m.id === U1).roles.length, 2);
});

test('preview of a wiped server: creates everything, deletes nothing, and changes nothing on the server', async () => {
    const g = nuked();
    const norm = normalizeSnapshot(v5Snapshot(), { guildId: G });
    const plan = planRestore(norm, await readGuildState(g));
    const s = summarizePlan(plan);
    assert.equal(s.counts.createRoles, 4);
    assert.equal(s.counts.createCategories, 2);
    assert.equal(s.counts.createChannels, 5);
    assert.equal(s.counts.deletes, 0);
    assert.ok(s.create.includes('Create category "Staff"'));
    assert.ok(s.notes.some(n => n.includes('webhook')));
    assert.equal(g.calls.length, 0, 'a preview makes no Discord calls');
});

test('restoring a wiped server rebuilds roles, categories, channels, overwrites, order and member roles', async () => {
    const g = nuked();
    const run = await restore(g, v5Snapshot());
    assert.equal(run.status, 'done', JSON.stringify(run.failed));
    assert.deepEqual(g.orderedRoleNames(), ['Admin', 'Mod', 'Member', 'Muted']);
    assert.equal(g.roleByName('Mod').permissions.bitfield, 8192n);
    assert.equal(g.roleByName('Admin').color, 0xff0000);
    assert.equal(g.roles.everyone.permissions.bitfield, 3072n);
    assert.deepEqual(g.categoryNames(), ['Info', 'Staff']);
    const info = g.channelByName('Info', 4); const staff = g.channelByName('Staff', 4);
    assert.deepEqual(g.childrenOf(info.id), ['rules', 'announcements']);
    assert.deepEqual(g.childrenOf(staff.id), ['mod-chat']);
    assert.deepEqual(g.childrenOf(null).sort(), ['General VC', 'lobby']);
    assert.equal(g.channelByName('rules').topic, 'Read me');
    assert.equal(g.channelByName('General VC').userLimit, 10);
    // overwrites point at the NEW role ids, @everyone at the guild id, members kept
    const ow = g.channelByName('mod-chat').permissionOverwrites.cache;
    assert.equal(ow.get(G).deny.bitfield, 1024n);
    assert.equal(ow.get(g.roleByName('Mod').id).allow.bitfield, 1024n);
    assert.equal(ow.get(U1).allow.bitfield, 1024n);
    assert.equal(ow.has(R.mod), false, 'the old role id is not used');
    assert.equal(staff.permissionOverwrites.cache.get(g.roleByName('Mod').id).allow.bitfield, 1024n);
    // members and settings
    assert.ok(g.members.cache.get(U1).roles.cache.has(g.roleByName('Mod').id));
    assert.ok(g.members.cache.get(U2).roles.cache.has(g.roleByName('Member').id));
    assert.equal(g.systemChannelId, g.channelByName('lobby').id);
    assert.equal(g.verificationLevel, 1);
    assert.ok(g.calls.some(c => c[0] === 'createEmoji'));
    assert.ok(!g.calls.some(c => c[0].startsWith('delete')), 'nothing deleted');
    assert.ok(!g.calls.some(c => c[0] === 'ban'), 'bans are only re-applied when asked');
    // a second restore finds nothing to do
    const again = planRestore(normalizeSnapshot(v5Snapshot(), { guildId: G }), await readGuildState(g));
    assert.deepEqual(again.steps.map(s => s.id), []);
});

function damagedGuild() {
    return fakeGuild({
        id: G, botTop: 50, members: [{ id: U1 }],
        roles: [
            { id: R.admin, name: 'Admin', color: 0xff0000, position: 6, permissions: 8, hoist: true },
            { id: R.member, name: 'Member', position: 5, permissions: 2048 },
            { id: '200000000000000077', name: 'Temp', position: 4 },
            { id: '200000000000000088', name: 'Owner', position: 60 },
            { id: '200000000000000099', name: 'Some Bot', position: 3, managed: true },
        ],
        channels: [
            { id: C.info, name: 'Info', type: 4, position: 0 },
            { id: CH.rules, name: 'rules', type: 0, parentId: C.info, position: 0, topic: 'Read me',
                overwrites: [{ id: G, type: 0, allow: '0', deny: SEND }, { id: '200000000000000077', type: 0, allow: VIEW, deny: '0' }] },
            { id: '400000000000000099', name: 'spam', type: 0, parentId: null, position: 0 },
            { id: '300000000000000099', name: 'Old Stuff', type: 4, position: 1 },
        ],
    });
}

test('default restore is non-destructive: extra roles, channels and overwrites stay; preview lists them', async () => {
    const g = damagedGuild();
    const norm = normalizeSnapshot(v5Snapshot(), { guildId: G });
    const s = summarizePlan(planRestore(norm, await readGuildState(g)));
    assert.equal(s.counts.deletes, 0);
    assert.deepEqual(s.keptNotInBackup.channels, ['spam']);
    assert.deepEqual(s.keptNotInBackup.categories, ['Old Stuff']);
    assert.deepEqual(s.keptNotInBackup.roles.sort(), ['Owner', 'Temp']);
    assert.ok(s.update.some(u => u.startsWith('Update role "Member"')));
    const run = await restore(g, v5Snapshot());
    assert.equal(run.status, 'done', JSON.stringify(run.failed));
    assert.ok(g.channelByName('spam') && g.channelByName('Old Stuff', 4) && g.roleByName('Temp'));
    assert.equal(g.roleByName('Member').permissions.bitfield, 0n);
    assert.equal(g.roleByName('Admin').id, R.admin, 'matched by id, not re-created');
    assert.equal(g.channelByName('rules').id, CH.rules);
    // the Temp overwrite on #rules is kept next to the backup's
    assert.ok(g.channelByName('rules').permissionOverwrites.cache.has('200000000000000077'));
    assert.ok(!g.calls.some(c => c[0].startsWith('delete')));
});

test('"also remove" deletes extras only after every create, and never the bot\'s or higher roles', async () => {
    const g = damagedGuild();
    const run = await restore(g, v5Snapshot(), { removeExtras: true });
    assert.equal(run.status, 'done', JSON.stringify(run.failed));
    assert.equal(g.channelByName('spam'), undefined);
    assert.equal(g.channelByName('Old Stuff', 4), undefined);
    assert.equal(g.roleByName('Temp'), undefined);
    assert.ok(g.roleByName('Owner'), 'a role above the bot is never deleted');
    assert.ok(g.roleByName('Some Bot'), 'managed roles are never deleted');
    assert.ok(g.roleByName('CertiFried'));
    const firstDelete = g.calls.findIndex(c => c[0].startsWith('delete'));
    const lastCreate = g.calls.map(c => c[0]).lastIndexOf('createChannel');
    assert.ok(firstDelete > lastCreate, 'deletes come after the last create');
    // exact overwrites now: Temp's overwrite on #rules is gone (the role too)
    assert.ok(!g.channelByName('rules').permissionOverwrites.cache.has('200000000000000077'));
});

test('if any create or update fails, nothing is deleted', async () => {
    const g = damagedGuild();
    g.failAlways('createChannel', { status: 403, code: 50013, message: 'Missing Permissions' }, (o) => o.name === 'mod-chat');
    const run = await restore(g, v5Snapshot(), { removeExtras: true });
    assert.equal(run.status, 'done_with_errors');
    assert.ok(run.failed.some(f => f.label.includes('mod-chat')));
    assert.ok(run.failed.some(f => f.error.startsWith('Skipped: an earlier step failed')));
    assert.ok(g.channelByName('spam'), 'extras survive a failed run');
    assert.ok(!g.calls.some(c => c[0].startsWith('delete')));
});

test('a backup without channels never removes channels, even with "also remove"', async () => {
    const g = damagedGuild();
    const snap = v5Snapshot(); snap.discord.channels = []; snap.discord.categories = [];
    const plan = planRestore(normalizeSnapshot(snap, { guildId: G }), await readGuildState(g), { removeExtras: true });
    assert.ok(!plan.steps.some(s => s.kind === 'deleteChannel' || s.kind === 'deleteCategory'));
    assert.ok(plan.notes.some(n => n.includes('no channels')));
});

test('rate limits are waited out and retried', async () => {
    const g = nuked();
    g.failNext('createRole', { status: 429, retryAfter: 0.001, message: 'You are being rate limited.' });
    g.failNext('setOverwrites', { status: 502, message: 'Bad Gateway' });
    const run = await restore(g, v5Snapshot());
    assert.equal(run.status, 'done', JSON.stringify(run.failed));
    assert.deepEqual(g.orderedRoleNames(), ['Admin', 'Mod', 'Member', 'Muted']);
    assert.ok(run.log.some(l => l.includes('slow down')));
    let n = 0;
    await assert.rejects(withRetry(async () => { n++; throw Object.assign(new Error('nope'), { status: 403 }); }, { sleep: async () => {} }));
    assert.equal(n, 1, 'a permission error is not retried');
});

test('an interrupted restore resumes without duplicating anything', async () => {
    const g = nuked();
    let seen = 0;
    const first = await restore(g, v5Snapshot(), {}, { onProgress: () => { if (++seen === 5) throw new Error('process restarted'); } });
    assert.equal(first.status, 'failed');
    assert.ok(first.completed.length === 5);
    assert.equal(runStatus(G).status, 'failed');
    const r = await startRestore({ guild: g, backupRow: row(v5Snapshot()), resume: true, source: 'test', deps: deps() });
    assert.equal(r.ok, true, r.error);
    const run = await r.done;
    assert.equal(run.status, 'done', JSON.stringify(run.failed));
    const names = [...g.roles.cache.values()].map(x => x.name);
    assert.equal(names.length, new Set(names).size, 'no duplicate roles');
    const chans = [...g.channels.cache.values()].map(x => `${x.type}:${x.name}`);
    assert.equal(chans.length, new Set(chans).size, 'no duplicate channels');
    assert.equal(chans.length, 7);
    assert.deepEqual(g.orderedRoleNames(), ['Admin', 'Mod', 'Member', 'Muted']);
    // a "running" run left by a restart shows as interrupted
    saveRun({ ...run, status: 'running' });
    assert.equal(runStatus(G).status, 'interrupted');
});

test('the old /admin backup create format restores (nested channels, roles by name)', async () => {
    const g = fakeGuild({ id: G, members: [{ id: U1 }] });
    const v2 = {
        version: '2.0', guildName: 'x', roles: [{ name: 'Mod', color: 255, position: 3, permissions: '8192', hoist: true, mentionable: false }, { name: 'Fan', color: 0, position: 2, permissions: '0' }],
        categories: [{ name: 'Talk', position: 0, channels: [{ name: 'chat', type: 0, position: 0, parentName: 'Talk' }, { name: 'voice', type: 2, position: 1, bitrate: 64000, parentName: 'Talk' }] }],
        channels: [{ name: 'welcome', type: 0, position: 0, parentName: null }],
        emoji: [], stickers: [], webhooks: [], memberRoles: [{ userId: U1, username: 'one', roles: ['Mod', 'Some Bot Role'] }],
    };
    const r = await startRestore({ guild: g, backupRow: row(v2, 2, 'Current_Backup'), source: 'test', deps: deps() });
    assert.ok(r.summary.notes.some(n => n.includes('old /admin backup create')));
    const run = await r.done;
    assert.equal(run.status, 'done', JSON.stringify(run.failed));
    const talk = g.channelByName('Talk', 4);
    assert.deepEqual(g.childrenOf(talk.id).sort(), ['chat', 'voice']);
    assert.deepEqual(g.childrenOf(null), ['welcome']);
    assert.deepEqual(g.orderedRoleNames(), ['Mod', 'Fan']);
    assert.ok(g.members.cache.get(U1).roles.cache.has(g.roleByName('Mod').id));
});

test('a changed server between preview and confirm needs a new preview', async () => {
    const g = nuked();
    const r = await startRestore({ guild: g, backupRow: row(v5Snapshot()), expectedHash: 'stale', source: 'test', deps: deps() });
    assert.equal(r.ok, false);
    assert.match(r.error, /changed since the preview/);
    assert.equal(g.calls.length, 0);
});

test('overwrite merge keeps others by default and is exact with "also remove"', () => {
    const state = { guildId: G, roles: [], members: new Map() };
    const backup = [{ target: { kind: 'everyone' }, type: 0, allow: '0', deny: VIEW }];
    const live = [{ id: G, type: 0, allow: '0', deny: '0' }, { id: '7', type: 1, allow: VIEW, deny: '0' }];
    assert.deepEqual(desiredOverwrites(backup, live, {}, state).map(o => o.id).sort(), ['100000000000000001', '7'].sort());
    assert.deepEqual(desiredOverwrites(backup, live, {}, state, { exact: true }).map(o => o.id), [G]);
    assert.equal(desiredOverwrites(null, live, {}, state), null, 'a backup without overwrites leaves them alone');
    assert.equal(desiredOverwrites(backup, [{ id: G, type: 0, allow: '0', deny: VIEW }], {}, state), null, 'no change, no call');
});

test('bot settings: upsert by default, replace with "also remove", old ids remapped, other servers untouched', async () => {
    const sql = [];
    const conn = {
        async beginTransaction() { sql.push('BEGIN'); }, async commit() { sql.push('COMMIT'); }, async rollback() { sql.push('ROLLBACK'); }, release() {},
        async execute(q, v) { sql.push([q, v]); return [{}]; },
    };
    const pool = {
        async execute() { return [[{ COLUMN_NAME: 'guild_id' }, { COLUMN_NAME: 'channel_id' }, { COLUMN_NAME: 'settings' }, { COLUMN_NAME: 'updated_at' }]]; },
        async getConnection() { return conn; },
    };
    const remap = new Map([[CH.lobby, '499999999999999999']]);
    const rows = [{ guild_id: 'other', channel_id: CH.lobby, settings: { roles: [R.mod] }, updated_at: '2026-11-01T10:00:00.000Z', dropped_col: 1 }];
    const r = await restoreConfigTable(pool, G, 'welcome_settings', rows, { remap, allowedTables: new Set(['welcome_settings']) });
    assert.deepEqual(r.ignored, ['dropped_col']);
    const [q, v] = sql[1];
    assert.match(q, /ON DUPLICATE KEY UPDATE/);
    assert.match(q, /IF\(guild_id = VALUES\(guild_id\)/);
    assert.ok(!sql.some(s => Array.isArray(s) && /^DELETE/.test(s[0])), 'upsert never deletes');
    assert.equal(v[0], G, 'rows are pinned to this server');
    assert.equal(v[1], '499999999999999999', 'old channel id remapped');
    assert.equal(v[2], JSON.stringify({ roles: [R.mod] }));
    assert.equal(v[3], '2026-11-01 10:00:00');
    sql.length = 0;
    await restoreConfigTable(pool, G, 'welcome_settings', rows, { replace: true, allowedTables: new Set(['welcome_settings']) });
    assert.match(sql[1][0], /^DELETE FROM `welcome_settings` WHERE guild_id = \?/);
    assert.deepEqual(await restoreConfigTable(pool, G, 'users', rows, { allowedTables: new Set(['welcome_settings']) }), { skipped: 'unknown table users' });
});
