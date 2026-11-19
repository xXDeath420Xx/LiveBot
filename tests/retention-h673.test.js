import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * H-673: infractions, tickets, ticket_transcripts and raid_lockdowns have data_retention_policy rows
 * (migration 449), the HTML transcript files follow the tickets row (jobs/retention-sweeper.js
 * pruneTranscriptFiles), and the privacy policy states the same periods.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h673-'));
process.env.LOG_DIR = tmp;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pool = (await import('../utils/db.js')).default;
const { pruneTranscriptFiles } = await import('../jobs/retention-sweeper.js');

const EXPECTED = {
    infractions: ['created_at', 730],
    tickets: ['closed_at', 365],
    ticket_transcripts: ['created_at', 365],
    raid_lockdowns: ['ended_at', 180],
};

test('each table has an enabled policy row on a real column, with an index the sweep can use', async () => {
    const [rows] = await pool.query(
        'SELECT table_name, timestamp_column, retain_days, enabled FROM data_retention_policy WHERE table_name IN (?)', [Object.keys(EXPECTED)]);
    assert.equal(rows.length, 4);
    for (const r of rows) {
        assert.deepEqual([r.timestamp_column, r.retain_days, Number(r.enabled)], [...EXPECTED[r.table_name], 1], r.table_name);
        const [col] = await pool.query(
            'SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
            [r.table_name, r.timestamp_column]);
        assert.equal(col.length, 1, `${r.table_name}.${r.timestamp_column} exists`);
    }
    // Open tickets and active lockdowns have no closing time, so `< cutoff` never matches them.
    for (const [t, c] of [['tickets', 'closed_at'], ['raid_lockdowns', 'ended_at'], ['infractions', 'created_at']]) {
        const [idx] = await pool.query(
            'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? AND SEQ_IN_INDEX = 1', [t, c]);
        assert.ok(idx.length > 0, `${t}.${c} indexed`);
    }
});

test('pruneTranscriptFiles removes only transcript files older than the window', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'tr-'));
    const old = Date.now() / 1000 - 400 * 86400;
    const files = {
        'transcript-1-111111111111111111.html': old,
        'transcript-2-111111111111111111.html': Date.now() / 1000 - 10 * 86400,
        'notes.html': old,
    };
    for (const [name, t] of Object.entries(files)) { fs.writeFileSync(path.join(dir, name), 'x'); fs.utimesSync(path.join(dir, name), t, t); }
    const out = await pruneTranscriptFiles({ dir, retainDays: 365 });
    assert.equal(out.deleted, 1);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['notes.html', 'transcript-2-111111111111111111.html']);
    assert.deepEqual(await pruneTranscriptFiles({ dir, retainDays: 0 }), { deleted: 0, days: null });
    // With no override it reads the tickets row.
    assert.equal((await pruneTranscriptFiles({ dir })).days, 365);
});

test('the privacy policy states the same periods', () => {
    const html = fs.readFileSync(path.join(root, 'dashboard/views/privacy-tailwind.ejs'), 'utf8');
    assert.doesNotMatch(html, /Other records are kept until that server's staff remove them/);
    assert.match(html, /deleted after two years/);
    assert.match(html, /Support tickets[^<]*<\/td><td>365 days after the ticket is closed/);
    assert.match(html, /Raid lockdown records[^<]*<\/td><td>180 days after the lockdown ends/);
});
