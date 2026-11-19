// Greenhouse Tycoon (cfx v2), phase 5: migration 438 (drop the old game's tables), prepared and NOT run.
// Every refusal is checked on throwaway ghtest_<hex>_ tables with a throwaway archive, then one real drop of those
// throwaway tables. The production archive is only read (gzip check and table list), never changed, and the
// production cfx_ tables are only counted.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import pool from '../../../utils/db.js';
import { closePool } from './_helpers.js';
import { checkPreconditions, dropOldGame, archivedObjects, ARCHIVE, PREFIX, down } from '../../../migrations/438_drop_cfx_v1_tables.js';

const prefix = `ghtest_${crypto.randomBytes(3).toString('hex')}_`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh438-'));
const LIVE = { GREENHOUSE_LIVE: '1' };
const tables = ['players', 'grow_slots', 'notes'].map(n => `${prefix}${n}`);
const view = `${prefix}slots_view`;
const policyRow = `${prefix}notes`;

function dump(names) {
    const text = names.map(n => `DROP TABLE IF EXISTS \`${n}\`;\nCREATE TABLE \`${n}\` (\n  \`id\` int\n);\n`).join('\n')
        + `/*!50001 CREATE VIEW \`${view}\` AS SELECT 1 */;\n`;
    return zlib.gzipSync(Buffer.from(`-- test dump\n${text}`));
}

function file(name, content) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
}

async function count() {
    const [[r]] = await pool.query(
        'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE ?', [`${prefix.replace(/_/g, '\\_')}%`]);
    return Number(r.n);
}

const refused = (re) => (err) => err.code === 'DROP_REFUSED' && re.test(err.message);

before(async () => {
    await pool.query(`CREATE TABLE ${tables[0]} (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE ${tables[1]} (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, player_id INT UNSIGNED NOT NULL,
        CONSTRAINT ${prefix}fk_gs FOREIGN KEY (player_id) REFERENCES ${tables[0]} (id)) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE ${tables[2]} (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, created_at DATETIME NULL) ENGINE=InnoDB`);
    await pool.query(`CREATE VIEW ${view} AS SELECT id, player_id FROM ${tables[1]}`);
    await pool.query(`INSERT INTO ${tables[0]} () VALUES ()`);
    await pool.query(`INSERT INTO ${tables[1]} (player_id) VALUES (1)`);
    await pool.query(
        `INSERT INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes) VALUES (?, 'created_at', 30, 0, 'test row (tests/cfx/v2/drop-migration.test.js)')`,
        [policyRow]);
});

after(async () => {
    await pool.query(`DROP VIEW IF EXISTS ${view}`);
    const conn = await pool.getConnection();
    try {
        await conn.query('SET FOREIGN_KEY_CHECKS = 0');
        for (const t of tables) await conn.query(`DROP TABLE IF EXISTS ${t}`);
    } finally {
        await conn.query('SET FOREIGN_KEY_CHECKS = 1');
        conn.release();
    }
    await pool.query('DELETE FROM data_retention_policy WHERE table_name = ?', [policyRow]);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(await count(), 0);
    await closePool();
});

describe('438 refuses', () => {
    const good = () => file('good.sql.gz', dump([...tables, view]));

    test('without GREENHOUSE_LIVE=1', async () => {
        const archive = good();
        for (const env of [{}, { GREENHOUSE_LIVE: '0' }, { GREENHOUSE_LIVE: 'true' }, { GREENHOUSE_LIVE: '' }]) {
            await assert.rejects(checkPreconditions(pool, { prefix, archive, env }), refused(/GREENHOUSE_LIVE=1 is not set/));
        }
        assert.equal(await count(), 4);
    });

    test('when the archive is missing, empty, a folder, not gzip, or cut short', async () => {
        await assert.rejects(checkPreconditions(pool, { prefix, archive: path.join(dir, 'nope.sql.gz'), env: LIVE }), refused(/does not exist/));
        await assert.rejects(checkPreconditions(pool, { prefix, archive: file('empty.sql.gz', ''), env: LIVE }), refused(/is empty/));
        await assert.rejects(checkPreconditions(pool, { prefix, archive: dir, env: LIVE }), refused(/is not a file/));
        await assert.rejects(checkPreconditions(pool, { prefix, archive: file('plain.sql.gz', 'CREATE TABLE `x` (id int);'), env: LIVE }), refused(/not a valid gzip/));
        const whole = dump([...tables, view]);
        await assert.rejects(checkPreconditions(pool, { prefix, archive: file('cut.sql.gz', whole.subarray(0, whole.length - 12)), env: LIVE }), refused(/not a valid gzip/));
        const bad = Buffer.from(whole);
        bad[bad.length - 6] ^= 0xff; // checksum
        await assert.rejects(checkPreconditions(pool, { prefix, archive: file('crc.sql.gz', bad), env: LIVE }), refused(/not a valid gzip/));
        assert.equal(await count(), 4);
    });

    test('when a table to drop is not in the archive', async () => {
        const archive = file('partial.sql.gz', dump([tables[0], tables[1]]));
        await assert.rejects(checkPreconditions(pool, { prefix, archive, env: LIVE }), refused(new RegExp(`not in the archive: ${tables[2]}`)));
        assert.equal(await count(), 4);
    });

    test('for any prefix but the old game\'s (or a test prefix)', async () => {
        for (const p of ['gh_', 'ghtest_x_', '', 'cfx', 'cfx_players', 'users_']) {
            await assert.rejects(checkPreconditions(pool, { prefix: p, archive: good(), env: LIVE }), refused(/is not the old game's/), p);
        }
    });

    test('down() never restores by itself', async () => {
        await assert.rejects(down(), /cannot be undone automatically/);
    });
});

describe('438 drops when every check passes', () => {
    test('views, then tables (foreign keys between them do not matter), then their retention rows', async () => {
        const archive = file('good2.sql.gz', dump([...tables, view]));
        const found = await checkPreconditions(pool, { prefix, archive, env: LIVE });
        assert.deepEqual(found.tables.sort(), [...tables].sort());
        assert.deepEqual(found.views, [view]);
        const r = await dropOldGame(pool, { prefix, archive, env: LIVE });
        assert.equal(r.tables.length, 3);
        assert.equal(r.views.length, 1);
        assert.equal(r.policies, 1);
        assert.equal(await count(), 0);
        const [[p]] = await pool.query('SELECT COUNT(*) AS n FROM data_retention_policy WHERE table_name = ?', [policyRow]);
        assert.equal(Number(p.n), 0);
        const [[fk]] = await pool.query('SELECT @@FOREIGN_KEY_CHECKS AS v');
        assert.equal(Number(fk.v), 1, 'foreign key checks are back on for the pool');
    });
});

describe('the real archive (read only)', () => {
    test('is a valid gzip mysqldump holding every cfx_ table and view that exists now', async () => {
        assert.equal(PREFIX, 'cfx_');
        assert.ok(fs.statSync(ARCHIVE).size > 0);
        const archived = await archivedObjects(ARCHIVE);
        const [rows] = await pool.query(
            'SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE ?', ['cfx\\_%']);
        const missing = rows.map(r => r.n).filter(n => !archived.has(n));
        assert.deepEqual(missing, []);
        assert.ok(rows.length === 0 || rows.length === 103, `${rows.length} old objects`);
        // and the production run would still be refused today: the flag is not set in this test process
        await assert.rejects(checkPreconditions(pool, { env: {} }), refused(/GREENHOUSE_LIVE=1/));
    });
});
