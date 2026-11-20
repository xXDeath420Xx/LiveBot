import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyTable, redactRow, DELETE_PLAN, ANONYMISE_PLAN, SAFETY_TABLES, SECRET_TABLES, plannedTables,
    fitExportToBudget, USER_ID_COLUMNS, PAIR_ID_COLUMNS, EXPORT_EXTRA,
} from '../core/privacy-tables.js';
import { PER_USER_COLUMNS } from '../core/critters/privacy.js';

/*
 * /privacy delete must never remove moderation records, and /privacy export must never hand
 * out credentials or name the staff who acted. These tests pin the lists to those rules.
 */

test('nothing the delete or anonymise plan touches is a safety or secret table', () => {
    for (const table of plannedTables()) {
        assert.equal(classifyTable(table), 'export', `${table} must not be a safety/secret table`);
    }
});

test('safety and secret tables are classified as such, including by name shape', () => {
    for (const t of ['infractions', 'audit_logs', 'global_ban_entries', 'quarantined_users', 'invite_tracker_logs']) {
        assert.equal(classifyTable(t), 'safety', t);
    }
    for (const t of ['some_new_ban_list', 'spam_reports_v2', 'raid_events']) {
        assert.equal(classifyTable(t), 'safety', t);
    }
    assert.equal(classifyTable('rumble_stream_keys'), 'secret');
    assert.equal(classifyTable('user_levels'), 'export');
    assert.equal(classifyTable('banner_settings'), 'export'); // "banner" is not "ban"
});

test('plans use only member-id columns and fixed conditions', () => {
    for (const p of DELETE_PLAN) {
        // Two-party critters rows (duels, marriages, proposals, prayers) name a member in user1/user2/sender/receiver.
        assert.ok(USER_ID_COLUMNS.includes(p.column) || (p.table.startsWith('critter_') && PAIR_ID_COLUMNS.includes(p.column)), `${p.table}.${p.column}`);
        assert.match(p.table, /^[a-z0-9_]+$/);
        if (p.where) assert.equal(p.where, 'event_type IS NULL');
    }
    for (const p of ANONYMISE_PLAN) {
        assert.ok(p.set.includes(p.column), `${p.table} must null the id column it matches on`);
    }
    assert.equal(new Set(DELETE_PLAN.map(p => `${p.table}.${p.column}`)).size, DELETE_PLAN.length, 'no duplicates');
    assert.equal(SAFETY_TABLES.has('message_logs'), false);
    assert.equal(SECRET_TABLES.has('message_logs'), false);
});

test('redactRow hides secrets and staff identities, keeps the member\'s own data', () => {
    const row = redactRow({
        user_id: '1', reason: 'spam', moderator_id: '2', access_token: 'abc', refresh_token: null,
        ip_address: '1.2.3.4', content: 'hello', blob: Buffer.from('xyz'), big: 10n,
    });
    assert.equal(row.user_id, '1');
    assert.equal(row.content, 'hello');
    assert.equal(row.moderator_id, '[staff member]');
    assert.equal(row.access_token, '[redacted]');
    assert.equal(row.refresh_token, null);
    assert.equal(row.ip_address, '[redacted]');
    assert.equal(row.blob, '[binary, 3 bytes]');
    assert.equal(row.big, '10');
});

test('fitExportToBudget trims the largest sections until the export fits', () => {
    const sections = {
        big: { rows: Array.from({ length: 2000 }, (_, i) => ({ i, text: 'x'.repeat(50) })), total: 2000 },
        small: { rows: [{ a: 1 }], total: 1 },
    };
    const { truncated } = fitExportToBudget(sections, 20_000);
    assert.deepEqual(truncated, ['big']);
    assert.ok(Buffer.byteLength(JSON.stringify(sections)) <= 20_000);
    assert.equal(sections.small.rows.length, 1);
    assert.equal(sections.big.truncated, true);
});

test('every critters per-member column is deleted or anonymised, and pair tables are listed for export', () => {
    const planned = new Set([...DELETE_PLAN, ...ANONYMISE_PLAN].map(p => `${p.table}.${p.column}`));
    for (const c of PER_USER_COLUMNS) assert.ok(planned.has(`${c.table}.${c.column}`), `${c.table}.${c.column}`);
    for (const e of EXPORT_EXTRA) {
        for (const c of e.columns) assert.ok(PAIR_ID_COLUMNS.includes(c) || c === 'last_winner', `${e.table}.${c}`);
    }
});
