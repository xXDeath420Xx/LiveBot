import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pool from '../utils/db.js';
import { sweepTable, sweepGuard, followsGuard } from '../jobs/retention-sweeper.js';
import { RETENTION_ROWS } from '../migrations/462_stream_bot_device_retention.js';
import { followsExport, followsDelete, followsOf } from '../core/twitch-follows-archive.js';

/*
 * Fix wave 3 (2026-11-19), on throwaway copies of the real tables:
 *   H-765  revoked stream bot devices are swept 30 days after revoked_at (migration 462); active devices (revoked_at
 *          NULL) never; the Devices page's Remove revokes and then deletes, after a confirmation.
 *   H-762  twitch_user_follows (historical, 2026-10-28) is swept only once its broadcaster has no CertiFried Twitch
 *          connection left (SWEEP_GUARDS); /privacy export and delete find it by the broadcaster's Twitch id.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const hex = crypto.randomBytes(4).toString('hex');
const [[{ schema }]] = await pool.query('SELECT DATABASE() AS `schema`');

test.after(async () => { await pool.end().catch(() => {}); });

test('migration 462: two policy rows, re-runnable', () => {
    assert.deepEqual(RETENTION_ROWS.map(([t, c, d]) => [t, c, d]), [['stream_bot_devices', 'revoked_at', 30], ['twitch_user_follows', 'updated_at', 30]]);
    const src = read('migrations/462_stream_bot_device_retention.js');
    assert.ok(src.includes('INSERT IGNORE INTO data_retention_policy'), 'safe to run twice');
    assert.equal(sweepGuard('stream_bot_devices'), null, 'revoked_at NULL never matches the date test, so no guard is needed');
});

test('H-765: the sweep deletes devices revoked more than 30 days ago, never an active one', async () => {
    const t = `fw3_dev_${hex}`;
    await pool.query(`CREATE TABLE \`${t}\` LIKE stream_bot_devices`);
    try {
        const cols = "(profile_id, kind, name, token_hash, token_hint, capabilities, revoked_at, created_at)";
        await pool.query(`INSERT INTO \`${t}\` ${cols} VALUES
            (1, 'studio', 'Old revoked', REPEAT('a', 64), 'aaaa', '[]', NOW() - INTERVAL 31 DAY, NOW() - INTERVAL 200 DAY),
            (1, 'studio', 'Recently revoked', REPEAT('b', 64), 'bbbb', '[]', NOW() - INTERVAL 5 DAY, NOW() - INTERVAL 200 DAY),
            (1, 'dock', 'Active old', REPEAT('c', 64), 'cccc', '[]', NULL, NOW() - INTERVAL 400 DAY)`);
        const out = await sweepTable(schema, { table_name: t, timestamp_column: 'revoked_at', retain_days: 30, guard: sweepGuard('stream_bot_devices') });
        assert.equal(out.deleted, 1);
        const [left] = await pool.query(`SELECT name FROM \`${t}\` ORDER BY name`);
        assert.deepEqual(left.map((r) => r.name), ['Active old', 'Recently revoked']);
    } finally {
        await pool.query(`DROP TABLE IF EXISTS \`${t}\``);
    }
});

test('H-765: Remove on the Devices page revokes, then deletes, after a confirmation', () => {
    const route = read('dashboard/routes/stream-bot.js');
    const del = route.slice(route.indexOf("router.delete('/stream/bot/api/devices/:id'"));
    const body = del.slice(0, del.indexOf('}));'));
    assert.ok(body.indexOf('revokeDevice') > 0 && body.indexOf('revokeDevice') < body.indexOf('deleteDevice'), 'revoke before delete');
    assert.ok(body.includes('disconnectDevice'), 'and disconnected');
    const view = read('dashboard/views/stream-bot/devices.ejs');
    assert.ok(view.includes('data-delete-device="<%= d.id %>" data-name="<%= d.name %>">Remove</button>'));
    assert.ok(view.includes('deleted after 30 days'));
    const js = read('dashboard/public/js/stream-bot.js');
    assert.ok(/deviceAction\('data-delete-device', 'DELETE', '', 'Remove %s\?/.test(js), 'asks first (window.confirm in deviceAction)');
    assert.ok(js.includes('window.confirm(question.replace'), 'deviceAction confirms');
});

test('H-762: historical follows are swept only once the broadcaster has no CertiFried Twitch connection', async () => {
    const t = `fw3_fol_${hex}`;
    const [[linked]] = await pool.query('SELECT broadcaster_twitch_id AS id FROM twitch_role_sync_config LIMIT 1');
    assert.ok(linked?.id, 'needs one connected broadcaster to compare with');
    await pool.query(`CREATE TABLE \`${t}\` LIKE twitch_user_follows`);
    try {
        await pool.query(`INSERT INTO \`${t}\` (follower_id, broadcaster_id, broadcaster_login, broadcaster_name, followed_at, updated_at) VALUES
            (?, '111', 'maple_hollow', 'Maple Hollow', '2025-01-01', '2026-10-28 11:00:00'),
            ('900000000000000001', '222', 'juniper_ridge', 'Juniper Ridge', '2025-02-01', '2026-10-28 11:00:00'),
            ('900000000000000001', '333', 'cedar_lane', 'Cedar Lane', '2025-03-01', '2026-10-28 11:00:00')`, [String(linked.id)]);
        assert.ok(sweepGuard('twitch_user_follows').includes('twitch_role_sync_config'));
        const out = await sweepTable(schema, { table_name: t, timestamp_column: 'updated_at', retain_days: 1, guard: followsGuard(t) });
        assert.equal(out.deleted, 2, 'only the broadcaster with no connection left');
        const [left] = await pool.query(`SELECT follower_id FROM \`${t}\``);
        assert.deepEqual(left.map((r) => r.follower_id), [String(linked.id)]);

        // /privacy: found and removed by the broadcaster's Twitch id only.
        assert.equal((await followsExport(pool, ['nope', String(linked.id)], { table: t })).length, 1);
        assert.equal((await followsOf(pool, String(linked.id), { table: t }))[0].broadcaster_login, 'maple_hollow');
        assert.deepEqual(await followsExport(pool, [], { table: t }), []);
        assert.equal(await followsDelete(pool, ['900000000000000002'], { table: t }), 0, 'someone else: nothing');
        assert.equal(await followsDelete(pool, [String(linked.id)], { table: t }), 1);
    } finally {
        await pool.query(`DROP TABLE IF EXISTS \`${t}\``);
    }
    assert.throws(() => followsGuard('x; DROP TABLE y'), /bad table name/);
});

test('H-762: the privacy manager exports and deletes it; nothing collects it again', () => {
    const pm = read('core/privacy-manager.js');
    assert.ok(pm.includes('sections.twitch_user_follows') && pm.includes('followsDelete(pool, twitchIds)'));
    for (const f of ['core', 'dashboard/routes', 'services', 'jobs']) {
        const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(d, e.name))) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
        for (const file of walk(f)) {
            if (file === path.join('core', 'twitch-follows-archive.js')) continue;   // reads and deletes only; its header tells the history
            const src = read(file).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');   // code, not comments
            assert.ok(!/INSERT[^;]*twitch_user_follows|REPLACE[^;]*twitch_user_follows|channels\/followed/i.test(src), `${file} writes or collects follows`);
        }
    }
});
