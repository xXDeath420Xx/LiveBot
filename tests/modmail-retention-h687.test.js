import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/*
 * H-687: closed modmail threads (and, by ON DELETE CASCADE, their messages) are deleted 365 days after
 * they close, like tickets (migration 451, jobs/retention-sweeper.js SWEEP_GUARDS). Open threads are
 * never swept. The privacy policy says so.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h687-'));
process.env.LOG_DIR = tmp;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pool = (await import('../utils/db.js')).default;
const { sweepTable, sweepGuard } = await import('../jobs/retention-sweeper.js');

test.after(async () => { await pool.end().catch(() => {}); fs.rmSync(tmp, { recursive: true, force: true }); });

test('modmail_threads has an enabled 365-day policy row on closed_at, and closed_at leads an index', async () => {
    const [rows] = await pool.query(
        "SELECT timestamp_column, retain_days, enabled FROM data_retention_policy WHERE table_name = 'modmail_threads'");
    assert.equal(rows.length, 1, 'policy row exists');
    assert.deepEqual([rows[0].timestamp_column, rows[0].retain_days, Number(rows[0].enabled)], ['closed_at', 365, 1]);
    const [idx] = await pool.query(
        "SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'modmail_threads' AND COLUMN_NAME = 'closed_at' AND SEQ_IN_INDEX = 1");
    assert.ok(idx.length > 0, 'modmail_threads.closed_at indexed');
    // Messages go with their thread.
    const [fk] = await pool.query(
        `SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'modmail_messages' AND REFERENCED_TABLE_NAME = 'modmail_threads'`);
    assert.equal(fk[0]?.DELETE_RULE, 'CASCADE');
});

test('the sweep only deletes closed threads older than the window, with their messages', async () => {
    assert.equal(sweepGuard('modmail_threads'), "`status` = 'closed'");
    assert.equal(sweepGuard('tickets'), null);

    const hex = crypto.randomBytes(4).toString('hex');
    const threads = `finb_mmt_${hex}`;
    const messages = `finb_mmm_${hex}`;
    const [[{ schema }]] = await pool.query('SELECT DATABASE() AS `schema`');
    await pool.query(`CREATE TABLE \`${threads}\` (id INT PRIMARY KEY, status ENUM('open','closed') DEFAULT 'open', closed_at TIMESTAMP NULL DEFAULT NULL) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE \`${messages}\` (id INT AUTO_INCREMENT PRIMARY KEY, thread_id INT NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES \`${threads}\` (id) ON DELETE CASCADE) ENGINE=InnoDB`);
    try {
        await pool.query(`INSERT INTO \`${threads}\` (id, status, closed_at) VALUES
            (1, 'closed', NOW() - INTERVAL 400 DAY),
            (2, 'closed', NOW() - INTERVAL 30 DAY),
            (3, 'open', NULL),
            (4, 'open', NOW() - INTERVAL 400 DAY)`);
        await pool.query(`INSERT INTO \`${messages}\` (thread_id) VALUES (1), (1), (2), (3), (4)`);

        const out = await sweepTable(schema, { table_name: threads, timestamp_column: 'closed_at', retain_days: 365, guard: sweepGuard('modmail_threads') });
        assert.equal(out.deleted, 1);
        const [left] = await pool.query(`SELECT id FROM \`${threads}\` ORDER BY id`);
        assert.deepEqual(left.map(r => r.id), [2, 3, 4]);
        const [msgs] = await pool.query(`SELECT thread_id FROM \`${messages}\` ORDER BY thread_id`);
        assert.deepEqual(msgs.map(r => r.thread_id), [2, 3, 4]);
    } finally {
        await pool.query(`DROP TABLE IF EXISTS \`${messages}\``);
        await pool.query(`DROP TABLE IF EXISTS \`${threads}\``);
    }
});

test('the privacy policy lists modmail with the same period', () => {
    const page = fs.readFileSync(path.join(root, 'dashboard/views/privacy-tailwind.ejs'), 'utf8');
    const row = page.split('\n').find(l => /<tr><td>[^<]*[Mm]odmail/.test(l));
    assert.ok(row, 'a retention row for modmail');
    assert.match(row, /365 days after the conversation is closed/);
    assert.match(row, /open/);
});
