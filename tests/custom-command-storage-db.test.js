import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../utils/db.js';
import { createSqlStore } from '../core/custom-command-store.js';
import { renderCustomResponse } from '../core/custom-command-handler.js';
import { buildExport, deleteUserData } from '../core/privacy-manager.js';
import { sweepTable } from '../jobs/retention-sweeper.js';
import { DB_SERVER_USER, DB_USER_KEYS, DB_SERVER_KEYS, DB_FULL_TEXT, DB_TOO_LONG_TEXT } from '../core/custom-command-vars.js';

/*
 * Custom-command storage against the live custom_commands_kv table (register H-648), through the real
 * handler path (renderCustomResponse → SQL store). Throwaway ids that cannot be Discord snowflakes;
 * every row they create (storage rows and the privacy_actions_log rows /privacy writes) is deleted
 * before and after.
 */

const G = 'cctest648-guild';
const G2 = 'cctest648-guild2';
const U1 = 'cctest648-u1';
const U2 = 'cctest648-u2';
const store = createSqlStore(pool);

async function cleanup() {
    await pool.query('DELETE FROM custom_commands_kv WHERE guild_id IN (?, ?)', [G, G2]);
    await pool.query('DELETE FROM privacy_actions_log WHERE user_id IN (?, ?)', [U1, U2]);
}

const say = (response, { userId = U1, guildId = G, args = [], preview = false } = {}) => {
    const sender = { id: userId, username: `tester-${userId.slice(-2)}`, tag: 'tester' };
    return renderCustomResponse(response, {
        guild: { id: guildId, name: 'Test server' }, channel: { id: '1', name: 'general' },
        sender, senderName: 'Tester', target: sender, mentionedName: null, args, commandName: 'cctest', log: false, preview,
    });
};
const value = async (owner, key, guildId = G) => {
    const [rows] = await pool.query('SELECT value_text FROM custom_commands_kv WHERE guild_id = ? AND user_id = ? AND key_name = ?', [guildId, owner, key]);
    return rows.length ? rows[0].value_text : undefined;
};

test.before(cleanup);
test.after(async () => {
    await cleanup();
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM custom_commands_kv WHERE guild_id IN (?, ?)', [G, G2]);
    assert.equal(Number(n), 0, 'no test rows left');
    await pool.end().catch(() => {});
});

test('the table is the one migration 352 made, plus the retention index', async () => {
    const [cols] = await pool.query(
        `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'custom_commands_kv' ORDER BY ORDINAL_POSITION`);
    assert.deepEqual(cols.map(r => r.c), ['guild_id', 'user_id', 'key_name', 'value_text', 'updated_at']);
    const [idx] = await pool.query(
        `SELECT COLUMN_NAME AS c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'custom_commands_kv' AND INDEX_NAME = 'idx_updated'`);
    assert.deepEqual(idx.map(r => r.c), ['updated_at'], 'migration 439 index for the retention sweep');
});

test('!cookie through the handler: per member, per server, in the database', async () => {
    const tpl = '{sender} has {db:incr:cookies} cookies';
    assert.equal((await say(tpl)).content, 'Tester has 1 cookies');
    assert.equal((await say(tpl)).content, 'Tester has 2 cookies');
    assert.equal((await say('{{db:incr:cookies:5}}')).content, '7', 'doubled braces and an amount');
    assert.equal((await say(tpl, { userId: U2 })).content, 'Tester has 1 cookies');
    assert.equal((await say(tpl, { guildId: G2 })).content, 'Tester has 1 cookies', 'another server is separate');
    assert.equal(await value(U1, 'cookies'), '7');

    assert.equal((await say('{db:set:Quote:{args}}ok', { args: ['hello', 'there'] })).content, 'ok');
    assert.equal((await say('[{db:get:quote}] [{db:get:nothing}]')).content, '[hello there] []');
    assert.equal((await say('{db:del:quote}[{db:get:quote}]')).content, '[]');
    assert.equal(await value(U1, 'quote'), undefined);

    assert.equal((await say('{sdb:incr:deaths}')).content, '1');
    assert.equal((await say('{sdb:incr:deaths}', { userId: U2 })).content, '2');
    assert.equal(await value(DB_SERVER_USER, 'deaths'), '2');
});

test('incr is atomic: 20 concurrent runs add exactly 20, each seeing its own total', async () => {
    const runs = await Promise.all(Array.from({ length: 20 }, () => say('{db:incr:race}')));
    assert.deepEqual(runs.map(r => Number(r.content)).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.equal(await value(U1, 'race'), '20');

    await say('{sdb:set:race:100}');
    const more = await Promise.all(Array.from({ length: 20 }, (_, i) => say('{sdb:incr:race}', { userId: i % 2 ? U1 : U2 })));
    assert.equal(new Set(more.map(r => r.content)).size, 20);
    assert.equal(await value(DB_SERVER_USER, 'race'), '120');
});

test('incr on stored text that is not a whole number counts it as 0', async () => {
    await say('{db:set:n:abc}');
    assert.equal((await say('{db:incr:n}')).content, '1');
    await pool.query("UPDATE custom_commands_kv SET value_text = '2.5' WHERE guild_id = ? AND user_id = ? AND key_name = 'n'", [G, U1]);
    assert.equal((await say('{db:incr:n:3}')).content, '3');
    await pool.query('UPDATE custom_commands_kv SET value_text = NULL WHERE guild_id = ? AND user_id = ? AND key_name = ?', [G, U1, 'n']);
    assert.equal((await say('{db:incr:n:-4}')).content, '-4');
    await pool.query("UPDATE custom_commands_kv SET value_text = ' 41 ' WHERE guild_id = ? AND user_id = ? AND key_name = 'n'", [G, U1]);
    assert.equal((await say('{db:incr:n}')).content, '42');
    await pool.query("UPDATE custom_commands_kv SET value_text = '999999999999999' WHERE guild_id = ? AND user_id = ? AND key_name = 'n'", [G, U1]);
    assert.equal((await say('{db:incr:n:1000}')).content, '999999999999999', 'clamped');
    assert.equal((await say('{db:get:n}')).content, '999999999999999');
});

test('limits: value length, 100 keys per member, 1,000 server keys', async () => {
    assert.equal((await say('{db:set:long:{args}}', { args: ['x'.repeat(1001)] })).content, DB_TOO_LONG_TEXT);
    assert.equal(await value(U1, 'long'), undefined);

    const userRows = Array.from({ length: DB_USER_KEYS }, (_, i) => [G, U2, `k${i}`, 'v']);
    await pool.query('INSERT INTO custom_commands_kv (guild_id, user_id, key_name, value_text) VALUES ?', [userRows]);
    assert.equal((await say('{db:set:extra:v}', { userId: U2 })).content, DB_FULL_TEXT);
    assert.equal((await say('{db:incr:extra2}', { userId: U2 })).content, DB_FULL_TEXT);
    assert.equal(await value(U2, 'extra'), undefined);
    assert.equal((await say('{db:set:k3:changed}{db:get:k3}', { userId: U2 })).content, 'changed', 'existing keys still update');

    const serverRows = Array.from({ length: DB_SERVER_KEYS }, (_, i) => [G2, DB_SERVER_USER, `s${i}`, '1']);
    await pool.query('INSERT INTO custom_commands_kv (guild_id, user_id, key_name, value_text) VALUES ?', [serverRows]);
    assert.equal((await say('{sdb:set:one-more:v}', { guildId: G2 })).content, DB_FULL_TEXT);
    assert.equal((await say('{sdb:incr:s9}', { guildId: G2 })).content, '2');
    assert.equal((await say('{db:set:mine:v}{db:get:mine}', { guildId: G2 })).content, 'v', 'member keys have their own limit');
});

test('stored text cannot ping: output defused and allowedMentions empty', async () => {
    await say('{db:set:evil:{args}}', { args: ['@everyone', '@here', '<@&555555555555555555>', '<@666666666666666666>'] });
    const out = await say('{db:get:evil}');
    assert.doesNotMatch(out.content, /@everyone|@here/);
    assert.deepEqual(out.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
});

test('dashboard Test reads real values and saves nothing', async () => {
    await say('{db:set:pv:10}');
    const out = await say('{db:incr:pv} {db:set:pv2:x}{db:get:pv2}', { preview: true });
    assert.equal(out.content, '11 x');
    assert.equal(await value(U1, 'pv'), '10');
    assert.equal(await value(U1, 'pv2'), undefined);
});

test('a read refreshes a stale updated_at (retention counts reads as use)', async () => {
    await say('{db:set:old:1}');
    await pool.query("UPDATE custom_commands_kv SET updated_at = NOW() - INTERVAL 3 DAY WHERE guild_id = ? AND user_id = ? AND key_name = 'old'", [G, U1]);
    await store.get(G, U1, 'old');
    let age = null;
    for (let i = 0; i < 20; i++) {
        const [[row]] = await pool.query("SELECT TIMESTAMPDIFF(SECOND, updated_at, NOW()) AS age FROM custom_commands_kv WHERE guild_id = ? AND user_id = ? AND key_name = 'old'", [G, U1]);
        age = Number(row.age);
        if (age < 60) break;
        await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(age < 60, `updated_at refreshed (age ${age}s)`);
});

test('retention: the policy row exists and the sweep deletes rows untouched for 400 days', async () => {
    const [[policy]] = await pool.query("SELECT table_name, timestamp_column, retain_days, enabled, last_swept_at, last_deleted FROM data_retention_policy WHERE table_name = 'custom_commands_kv'");
    assert.ok(policy, 'data_retention_policy has a custom_commands_kv row (migration 439)');
    assert.equal(policy.timestamp_column, 'updated_at');
    assert.equal(Number(policy.retain_days), 400);
    assert.equal(Number(policy.enabled), 1);
    await say('{db:set:ancient:1}{db:set:fresh:1}');
    await pool.query("UPDATE custom_commands_kv SET updated_at = NOW() - INTERVAL 401 DAY WHERE guild_id = ? AND user_id = ? AND key_name = 'ancient'", [G, U1]);
    const [[{ schema }]] = await pool.query('SELECT DATABASE() AS `schema`');
    try {
        const r = await sweepTable(schema, policy);
        assert.ok(r.deleted >= 1);
        assert.equal(await value(U1, 'ancient'), undefined);
        assert.equal(await value(U1, 'fresh'), '1');
    } finally {
        // Leave the policy's bookkeeping as the nightly sweep last wrote it.
        await pool.query('UPDATE data_retention_policy SET last_swept_at = ?, last_deleted = ? WHERE table_name = ?',
            [policy.last_swept_at, policy.last_deleted, 'custom_commands_kv']);
    }
});

test('departed-guild purge finds the table by its guild_id column', async () => {
    const [rows] = await pool.query(
        `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'custom_commands_kv' AND COLUMN_NAME = 'guild_id' AND DATA_TYPE = 'varchar'`);
    assert.equal(rows.length, 1);
});

test('/privacy export lists the member\'s rows and delete removes them, server rows stay', { timeout: 300_000 }, async () => {
    await say('{db:set:priv1:a}{db:set:priv2:b}');
    await say('{db:set:priv3:c}', { guildId: G2 });
    await say('{sdb:set:shared:s}');
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM custom_commands_kv WHERE user_id = ?', [U1]);
    assert.ok(Number(n) >= 3);

    const { buffer } = await buildExport(U1);
    const exported = JSON.parse(buffer.toString('utf8'));
    const section = exported.tables.custom_commands_kv;
    assert.ok(section, 'export has a custom_commands_kv section');
    assert.equal(section.total, Number(n));
    assert.ok(section.rows.every(r => r.user_id === U1), 'only the member\'s rows, never server rows');
    assert.deepEqual(section.rows.filter(r => r.key_name.startsWith('priv')).map(r => `${r.guild_id}:${r.key_name}=${r.value_text}`).sort(),
        [`${G2}:priv3=c`, `${G}:priv1=a`, `${G}:priv2=b`].sort());

    const result = await deleteUserData(U1);
    assert.equal(result.deleted.custom_commands_kv, Number(n));
    assert.ok(!result.failed.includes('custom_commands_kv'));
    const [[{ left }]] = await pool.query('SELECT COUNT(*) AS `left` FROM custom_commands_kv WHERE user_id = ?', [U1]);
    assert.equal(Number(left), 0);
    assert.equal(await value(DB_SERVER_USER, 'shared'), 's', 'server-wide values are not the member\'s');
    assert.equal(await value(U2, 'cookies'), '1', 'other members keep theirs');
});
