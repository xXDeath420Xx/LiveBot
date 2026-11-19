// Greenhouse Tycoon (cfx v2), phase 5: retention.
//   - every v2 table is either swept (config/retention.js RETENTION) or small by design (BOUNDED);
//   - each swept column exists and is indexed;
//   - the bot's nightly sweeper (jobs/retention-sweeper.js) deletes the old rows of each and keeps the rest, and
//     does not skip gh_ rows while the old game is frozen;
//   - migration 437 inserts the policy rows;
//   - a save older than the ledger window is never "fresh" when its sign-in is linked elsewhere.
// Throwaway ghtest_<hex>_ tables, dropped at the end.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setupTestDb, closePool } from './_helpers.js';
import { TABLES } from '../../../services/cfx/store/schema.js';
import { RETENTION, BOUNDED, LEDGER_RETENTION_DAYS, retentionPolicyRows } from '../../../services/cfx/config/retention.js';
import { sweepTable, sweepable } from '../../../jobs/retention-sweeper.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let ctx;
let schemaName;

before(async () => {
    ctx = await setupTestDb();
    const [[row]] = await ctx.pool.query('SELECT DATABASE() AS db');
    schemaName = row.db;
});

after(async () => {
    const left = await ctx.cleanup();
    assert.deepEqual(left, []);
    await closePool();
});

describe('the policy', () => {
    test('every v2 table is swept or listed as small by design, never both', () => {
        const swept = new Set(RETENTION.map(r => r.table));
        for (const name of TABLES) {
            assert.ok(swept.has(name) !== Object.hasOwn(BOUNDED, name), `${name}: in exactly one of RETENTION and BOUNDED`);
        }
        assert.equal(swept.size, RETENTION.length, 'no table twice');
        for (const name of [...swept, ...Object.keys(BOUNDED)]) assert.ok(TABLES.includes(name), `${name} is a v2 table`);
    });

    test('windows: ledger 180 days, notifications 30, everything else long enough for the rules that read it', () => {
        const days = Object.fromEntries(RETENTION.map(r => [r.table, r.days]));
        assert.equal(LEDGER_RETENTION_DAYS, 180);
        assert.equal(days.ledger, LEDGER_RETENTION_DAYS);
        assert.equal(days.notifications, 30);
        assert.ok(days.identity_events >= 8, 'the relink rule reads 7 days');
        assert.ok(days.daily_claims >= 2, 'the daily rule reads today and yesterday');
        assert.ok(days.account_quests >= 14, 'last week\'s quests can still be collected');
        assert.ok(days.market_days >= 31, 'the market shows 30 days');
        for (const r of RETENTION) assert.ok(Number.isInteger(r.days) && r.days >= 1 && r.notes.length <= 255, r.table);
    });

    test('each swept column exists and leads an index (the nightly delete is a range scan, not a full scan)', async () => {
        for (const r of RETENTION) {
            const table = ctx.t[r.table];
            const [cols] = await ctx.pool.query(
                'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, r.column]);
            assert.equal(cols.length, 1, `${r.table}.${r.column} exists`);
            const [idx] = await ctx.pool.query(
                'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? AND SEQ_IN_INDEX = 1', [table, r.column]);
            assert.ok(idx.length >= 1, `${r.table}.${r.column} leads an index`);
        }
    });

    test('migration 437 inserts these rows into data_retention_policy (and down() removes them)', () => {
        const rows = retentionPolicyRows('gh_');
        assert.equal(rows.length, RETENTION.length);
        assert.deepEqual(rows[0], ['gh_ledger', 'created_at', 180, 1, RETENTION[0].notes]);
        const src = fs.readFileSync(path.join(repo, 'migrations/437_greenhouse_v2_schema.js'), 'utf8');
        assert.match(src, /INSERT IGNORE INTO data_retention_policy \(table_name, timestamp_column, retain_days, enabled, notes\) VALUES \?/);
        assert.match(src, /retentionPolicyRows\(PREFIX\)/);
        assert.match(src, /DELETE FROM data_retention_policy WHERE table_name IN \(\?\)/);
    });

    test('the sweeper keeps gh_ rows while the old game is frozen (it only holds back cfx_)', () => {
        const rows = [{ table_name: 'gh_ledger' }, { table_name: 'gh_notifications' }, { table_name: 'cfx_worker_logs' }, { table_name: 'message_logs' }];
        const kept = sweepable(rows).map(r => r.table_name);
        assert.ok(kept.includes('gh_ledger') && kept.includes('gh_notifications') && kept.includes('message_logs'));
    });
});

describe('the nightly sweep enforces it', () => {
    test('old rows go, recent rows and open crosses stay, for every swept table', async () => {
        const t = ctx.t;
        const [acc] = await ctx.pool.query(`INSERT INTO ${t.accounts} (display_name) VALUES ('Sweep')`);
        const a = Number(acc.insertId);
        const [idn] = await ctx.pool.query(`INSERT INTO ${t.identities} (account_id, platform, platform_user_id) VALUES (?, 'dev', 'sweep-1')`, [a]);
        const i = Number(idn.insertId);
        const ago = (days) => `NOW(3) - INTERVAL ${Number(days)} DAY`;
        let n = 0;
        const insert = {
            ledger: (d) => ctx.pool.query(`INSERT INTO ${t.ledger} (account_id, idempotency_key, reason, cash_after, request_hash, created_at) VALUES (?, ?, 'test', 0, ?, ${ago(d)})`,
                [a, `k${++n}`, 'x'.repeat(64)]),
            notifications: (d) => ctx.pool.query(`INSERT INTO ${t.notifications} (account_id, kind, created_at) VALUES (?, 'quest', ${ago(d)})`, [a]),
            identity_events: (d) => ctx.pool.query(`INSERT INTO ${t.identity_events} (identity_id, account_id, event, created_at) VALUES (?, ?, 'linked', ${ago(d)})`, [i, a]),
            daily_claims: (d) => ctx.pool.query(`INSERT INTO ${t.daily_claims} (account_id, day, identity_id, created_at) VALUES (?, DATE(${ago(d)}), ?, ${ago(d)})`, [a, i]),
            account_quests: (d) => ctx.pool.query(`INSERT INTO ${t.account_quests} (account_id, quest_code, period_key, target, created_at) VALUES (?, 'd_plant', ?, 3, ${ago(d)})`, [a, `d${++n}`]),
            breeding: (d) => ctx.pool.query(`INSERT INTO ${t.breeding} (account_id, parent_a, parent_b, started_at_ms, ready_at_ms, status, claimed_at, created_at) VALUES (?, 1, 2, 1, 2, 'claimed', ${ago(d)}, ${ago(d)})`, [a]),
            market_days: (d) => ctx.pool.query(`INSERT INTO ${t.market_days} (variety_id, day) VALUES (?, DATE(${ago(d)}))`, [++n]),
            orders: (d) => ctx.pool.query(`INSERT INTO ${t.orders} (account_id, variety_id, quantity, reward_cash, expires_at_ms, status, offered_at) VALUES (?, 1, 1, 10, 1, 'expired', ${ago(d)})`, [a]),
            sessions: (d) => ctx.pool.query(`INSERT INTO ${t.sessions} (account_id, identity_id, family, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ${ago(d + 30)}, ${ago(d)})`,
                [a, i, crypto.randomBytes(16).toString('hex'), crypto.randomBytes(32).toString('hex')]),
            link_codes: (d) => ctx.pool.query(`INSERT INTO ${t.link_codes} (account_id, code_hash, created_by_identity, created_at, expires_at) VALUES (?, ?, ?, ${ago(d)}, ${ago(d)})`,
                [a, crypto.randomBytes(32).toString('hex'), i])
        };
        assert.deepEqual(Object.keys(insert).sort(), RETENTION.map(r => r.table).sort(), 'a case for every swept table');
        // an open cross started long ago is never swept (claimed_at is NULL)
        await ctx.pool.query(`INSERT INTO ${t.breeding} (account_id, parent_a, parent_b, started_at_ms, ready_at_ms, created_at) VALUES (?, 3, 4, 1, 2, ${ago(999)})`, [a]);

        for (const r of RETENTION) {
            await insert[r.table](r.days + 2);
            await insert[r.table](Math.max(0, r.days - 1));
            const table = t[r.table];
            const [[before]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${table}`);
            const result = await sweepTable(schemaName, { table_name: table, timestamp_column: r.column, retain_days: r.days });
            assert.equal(result.deleted, 1, `${r.table}: one old row removed`);
            const [[afterRows]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${table}`);
            assert.equal(Number(afterRows.n), Number(before.n) - 1, `${r.table}: the recent row stays`);
        }
        const [[open]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${t.breeding} WHERE claimed_at IS NULL`);
        assert.equal(Number(open.n), 1);
    });
});

describe('the ledger window and linking', () => {
    test('a save older than the ledger window is never absorbed as "fresh" when its sign-in is linked elsewhere', async () => {
        const accounts = ctx.store.accounts;
        const target = await accounts.signIn({ platform: 'discord', platformUserId: '000000000000000541', displayName: 'Target' });
        const source = await accounts.signIn({ platform: 'twitch', platformUserId: '541541', displayName: 'Source' });
        await ctx.pool.query(`UPDATE ${ctx.t.accounts} SET created_at = NOW(3) - INTERVAL ? DAY WHERE id = ?`, [LEDGER_RETENTION_DAYS + 1, source.accountId]);
        const { code } = await accounts.createLinkCode({ accountId: target.accountId, identityId: target.identityId });
        await assert.rejects(accounts.redeemLinkCode({ identityId: source.identityId, code }), (e) => e.code === 'SOURCE_HAS_PROGRESS');

        // the same save, young: it has only the starter kit, so it is absorbed as before
        await ctx.pool.query(`UPDATE ${ctx.t.accounts} SET created_at = NOW(3) WHERE id = ?`, [source.accountId]);
        const r = await accounts.redeemLinkCode({ identityId: source.identityId, code });
        assert.equal(r.accountId, target.accountId);
        assert.equal(r.removedAccountId, source.accountId);
    });
});
