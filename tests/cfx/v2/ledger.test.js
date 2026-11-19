// Greenhouse Tycoon (cfx v2), audit B3 test 2: the ledger against the live database, on throwaway tables
// (prefix ghtest_<random>_, dropped in after()). Proves: bad amounts are refused and write nothing,
// a repeated idempotency key is a no-op, 50 parallel spends never overdraw, and 50 parallel mixed
// operations neither create nor lose money or items.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, makeAccount, closePool } from './_helpers.js';
import { GameError } from '../../../services/cfx/lib/errors.js';
import { LIMITS } from '../../../services/cfx/config/game.js';
import { createRng } from '../../../services/cfx/domain/rng.js';

let ctx;
before(async () => { ctx = await setupTestDb(); });
after(async () => {
    try {
        const left = await ctx?.cleanup();
        assert.deepEqual(left, [], 'every ghtest table was dropped');
    } finally {
        await closePool();
    }
});

const code = (c) => (err) => err instanceof GameError && err.code === c;

async function ledgerRows(accountId) {
    const [rows] = await ctx.pool.query(
        `SELECT id, idempotency_key, reason, cash_delta, cash_after, item_lines FROM ${ctx.t.ledger} WHERE account_id = ? ORDER BY id`, [accountId]);
    return rows.map(r => ({ ...r, cash_delta: Number(r.cash_delta), cash_after: Number(r.cash_after), item_lines: r.item_lines ? JSON.parse(r.item_lines) : [] }));
}

/** Cash and every item recomputed from the ledger rows must equal what the tables hold. */
async function assertConserved(accountId) {
    const rows = await ledgerRows(accountId);
    let running = 0;
    const items = new Map();
    for (const r of rows) {
        running += r.cash_delta;
        assert.equal(r.cash_after, running, `ledger row ${r.id}: cash_after follows the running total (writes were serialised)`);
        assert.ok(running >= 0, 'never negative at any point');
        for (const l of r.item_lines) {
            const k = `${l.kind}:${l.itemId}:${l.quality}`;
            items.set(k, (items.get(k) || 0) + l.delta);
            assert.ok(items.get(k) >= 0, `item ${k} never negative`);
        }
    }
    const { cash } = await ctx.store.ledger.balance(accountId);
    assert.equal(cash, running, 'cash equals the sum of the ledger');
    const inv = await ctx.store.ledger.inventory(accountId);
    const held = new Map(inv.map(i => [`${i.kind}:${i.itemId}:${i.quality}`, i.quantity]));
    for (const [k, q] of items) assert.equal(held.get(k) || 0, q, `inventory ${k} equals the sum of the ledger`);
    for (const [k, q] of held) assert.equal(items.get(k), q, `no inventory row ${k} without ledger lines`);
    assert.ok(inv.every(i => i.quantity > 0), 'empty stacks are deleted');
    return { cash, rows: rows.length };
}

describe('ledger: validation', () => {
    test('bad cash amounts are refused and nothing is written', async () => {
        const id = await makeAccount(ctx.store, { cash: 1000 });
        const bad = [NaN, Infinity, -Infinity, 0.5, -1.5, '5', '-100', '1e3', true, null, [], {}, 2 ** 53, LIMITS.MAX_CASH_DELTA + 1, -(LIMITS.MAX_CASH_DELTA + 1)];
        for (const cash of bad) {
            await assert.rejects(ctx.store.ledger.apply({ accountId: id, key: `bad-cash-${String(cash).slice(0, 20)}`.replace(/[^A-Za-z0-9._:-]/g, '_').padEnd(8, '_'), reason: 'test', cash }),
                code('VALIDATION'), `cash ${String(cash)}`);
        }
        await assert.rejects(ctx.store.ledger.apply({ accountId: id, key: 'zero-change', reason: 'test', cash: 0 }), code('VALIDATION'));
        await assert.rejects(ctx.store.ledger.apply({ accountId: id, key: 'nothing-at-all', reason: 'test' }), code('VALIDATION'));
        assert.equal((await ledgerRows(id)).length, 1, 'only the funding row');
        assert.equal((await ctx.store.ledger.balance(id)).cash, 1000);
    });

    test('bad item lines, keys, reasons and account ids are refused', async () => {
        const id = await makeAccount(ctx.store, { cash: 10, items: [{ kind: 'seed', itemId: 1, delta: 5 }] });
        const line = { kind: 'seed', itemId: 1, quality: 0, delta: 1 };
        const badLines = [
            { ...line, delta: 0 }, { ...line, delta: 0.5 }, { ...line, delta: -0.5 }, { ...line, delta: '3' }, { ...line, delta: NaN },
            { ...line, delta: LIMITS.MAX_ITEM_DELTA + 1 }, { ...line, delta: -(LIMITS.MAX_ITEM_DELTA + 1) },
            { ...line, kind: 'gold' }, { ...line, kind: undefined }, { ...line, itemId: 0 }, { ...line, itemId: -1 }, { ...line, itemId: 1.5 },
            { ...line, itemId: '1' }, { ...line, quality: 4 }, { ...line, quality: -1 }, null, 'seed', [line]
        ];
        for (const [i, l] of badLines.entries()) {
            await assert.rejects(ctx.store.ledger.apply({ accountId: id, key: `bad-line-${i}-xx`, reason: 'test', items: [l] }), code('VALIDATION'), JSON.stringify(l));
        }
        await assert.rejects(ctx.store.ledger.apply({ accountId: id, key: 'dup-lines-x', reason: 'test', items: [line, { ...line }] }), code('VALIDATION'));
        await assert.rejects(ctx.store.ledger.apply({ accountId: id, key: 'not-a-list', reason: 'test', items: line }), code('VALIDATION'));
        const tooMany = Array.from({ length: LIMITS.MAX_LINES_PER_OP + 1 }, (_, i) => ({ ...line, itemId: i + 1 }));
        await assert.rejects(ctx.store.ledger.apply({ accountId: id, key: 'too-many-lines', reason: 'test', items: tooMany }), code('VALIDATION'));
        for (const key of ['short', 'has space key', 'x'.repeat(65), null, 12345678]) {
            await assert.rejects(ctx.store.ledger.apply({ accountId: id, key, reason: 'test', cash: 1 }), code('VALIDATION'), String(key));
        }
        await assert.rejects(ctx.store.ledger.apply({ accountId: id, key: 'bad-reason', reason: 'gift', cash: 1 }), code('VALIDATION'));
        for (const accountId of [0, -1, 1.5, '1', null]) {
            await assert.rejects(ctx.store.ledger.apply({ accountId, key: 'bad-account', reason: 'test', cash: 1 }), code('VALIDATION'), String(accountId));
        }
        await assert.rejects(ctx.store.ledger.apply({ accountId: 999_999_999, key: 'no-such-account', reason: 'test', cash: 1 }), code('NOT_FOUND'));
        await assertConserved(id);
        assert.equal((await ledgerRows(id)).length, 1);
    });
});

describe('ledger: non-negative and atomic', () => {
    test('a debit larger than the balance is refused; balance unchanged', async () => {
        const id = await makeAccount(ctx.store, { cash: 100 });
        await assert.rejects(ctx.store.ledger.apply({ accountId: id, key: 'overdraw-1', reason: 'buy', cash: -101 }), code('INSUFFICIENT_FUNDS'));
        const ok = await ctx.store.ledger.apply({ accountId: id, key: 'exact-spend', reason: 'buy', cash: -100 });
        assert.equal(ok.cashAfter, 0);
        await assert.rejects(ctx.store.ledger.apply({ accountId: id, key: 'overdraw-2', reason: 'buy', cash: -1 }), code('INSUFFICIENT_FUNDS'));
        await assertConserved(id);
    });

    test('a multi-line change applies completely or not at all', async () => {
        const id = await makeAccount(ctx.store, { cash: 50, items: [{ kind: 'seed', itemId: 2, delta: 3 }] });
        // Sell 5 seeds for 40: only 3 held, so the cash credit must not happen either.
        await assert.rejects(ctx.store.ledger.apply({ accountId: id, key: 'sell-too-many', reason: 'sell', cash: 40, items: [{ kind: 'seed', itemId: 2, delta: -5 }] }), code('INSUFFICIENT_ITEMS'));
        // Cash is credited and the produce line written first (lines run in sorted order: produce before
        // seed), then the seed line fails: the credit and the produce must both roll back.
        await assert.rejects(ctx.store.ledger.apply({
            accountId: id, key: 'mixed-fail', reason: 'harvest', cash: 10,
            items: [{ kind: 'seed', itemId: 2, delta: -4 }, { kind: 'produce', itemId: 4, quality: 2, delta: 2 }]
        }), code('INSUFFICIENT_ITEMS'));
        await assert.rejects(ctx.store.ledger.apply({ accountId: id, key: 'cash-fail-x', reason: 'buy', cash: -60, items: [{ kind: 'produce', itemId: 4, delta: 1 }] }), code('INSUFFICIENT_FUNDS'));
        assert.equal((await ctx.store.ledger.balance(id)).cash, 50);
        assert.deepEqual(await ctx.store.ledger.inventory(id), [{ kind: 'seed', itemId: 2, quality: 0, quantity: 3 }]);
        const ok = await ctx.store.ledger.apply({ accountId: id, key: 'sell-all-3', reason: 'sell', cash: 24, items: [{ kind: 'seed', itemId: 2, delta: -3 }] });
        assert.equal(ok.cashAfter, 74);
        assert.deepEqual(await ctx.store.ledger.inventory(id), [], 'stack deleted at zero');
        await assertConserved(id);
    });

    test('balance and stack limits hold', async () => {
        const id = await makeAccount(ctx.store, { cash: 1 });
        await ctx.pool.query(`UPDATE ${ctx.t.accounts} SET cash = ? WHERE id = ?`, [LIMITS.MAX_BALANCE - 10, id]);
        await assert.rejects(ctx.store.ledger.apply({ accountId: id, key: 'over-max-bal', reason: 'test', cash: 11 }), code('BALANCE_LIMIT'));
        const ok = await ctx.store.ledger.apply({ accountId: id, key: 'to-max-bal', reason: 'test', cash: 10 });
        assert.equal(ok.cashAfter, LIMITS.MAX_BALANCE);
        await ctx.pool.query(`INSERT INTO ${ctx.t.inventory} (account_id, kind, item_id, quality, quantity) VALUES (?, 'seed', 1, 0, ?)`, [id, LIMITS.MAX_ITEM_QUANTITY - 1]);
        await assert.rejects(ctx.store.ledger.apply({ accountId: id, key: 'over-max-item', reason: 'test', items: [{ kind: 'seed', itemId: 1, delta: 2 }] }), code('ITEM_LIMIT'));
    });

    test('the database itself refuses a negative balance even without the ledger checks', async () => {
        const id = await makeAccount(ctx.store, { cash: 5 });
        await assert.rejects(ctx.pool.query(`UPDATE ${ctx.t.accounts} SET cash = cash - 10 WHERE id = ?`, [id]));
        assert.equal((await ctx.store.ledger.balance(id)).cash, 5);
    });

    test('a suspended account refuses new changes but still answers replays', async () => {
        const id = await makeAccount(ctx.store, { cash: 100 });
        const first = await ctx.store.ledger.apply({ accountId: id, key: 'before-suspend', reason: 'buy', cash: -10 });
        await ctx.pool.query(`UPDATE ${ctx.t.accounts} SET status = 'suspended' WHERE id = ?`, [id]);
        await assert.rejects(ctx.store.ledger.apply({ accountId: id, key: 'after-suspend', reason: 'buy', cash: -10 }), code('ACCOUNT_INACTIVE'));
        const replay = await ctx.store.ledger.apply({ accountId: id, key: 'before-suspend', reason: 'buy', cash: -10 });
        assert.equal(replay.replayed, true);
        assert.equal(replay.entryId, first.entryId);
    });
});

describe('ledger: idempotency', () => {
    test('a repeated key is a no-op that returns the original result', async () => {
        const id = await makeAccount(ctx.store, { cash: 500 });
        const op = { accountId: id, key: 'buy:seed:0001', reason: 'buy', cash: -30, items: [{ kind: 'seed', itemId: 3, delta: 2 }] };
        const a = await ctx.store.ledger.apply(op);
        const b = await ctx.store.ledger.apply({ ...op, items: [{ ...op.items[0] }] });
        assert.equal(a.replayed, false);
        assert.equal(b.replayed, true);
        assert.equal(b.entryId, a.entryId);
        assert.equal(b.cashAfter, 470);
        assert.equal((await ctx.store.ledger.balance(id)).cash, 470);
        await assertConserved(id);
    });

    test('the same key with a different change is refused (IDEMPOTENCY_MISMATCH)', async () => {
        const id = await makeAccount(ctx.store, { cash: 500 });
        await ctx.store.ledger.apply({ accountId: id, key: 'reuse-me-01', reason: 'buy', cash: -30 });
        await assert.rejects(ctx.store.ledger.apply({ accountId: id, key: 'reuse-me-01', reason: 'buy', cash: -31 }), code('IDEMPOTENCY_MISMATCH'));
        await assert.rejects(ctx.store.ledger.apply({ accountId: id, key: 'reuse-me-01', reason: 'sell', cash: -30 }), code('IDEMPOTENCY_MISMATCH'));
        assert.equal((await ctx.store.ledger.balance(id)).cash, 470);
    });

    test('keys are per account and case-sensitive', async () => {
        const a = await makeAccount(ctx.store, { cash: 100 });
        const b = await makeAccount(ctx.store, { cash: 100 });
        const ra = await ctx.store.ledger.apply({ accountId: a, key: 'Shared-Key-1', reason: 'buy', cash: -10 });
        const rb = await ctx.store.ledger.apply({ accountId: b, key: 'Shared-Key-1', reason: 'buy', cash: -10 });
        const rc = await ctx.store.ledger.apply({ accountId: a, key: 'shared-key-1', reason: 'buy', cash: -10 });
        assert.deepEqual([ra.replayed, rb.replayed, rc.replayed], [false, false, false]);
        assert.equal((await ctx.store.ledger.balance(a)).cash, 80);
        assert.equal((await ctx.store.ledger.balance(b)).cash, 90);
    });
});

describe('ledger: concurrency (50 parallel operations)', () => {
    test('50 parallel identical spends with one key: applied exactly once', async () => {
        const id = await makeAccount(ctx.store, { cash: 1000 });
        const op = { accountId: id, key: 'double-click-0001', reason: 'buy', cash: -100 };
        const results = await Promise.allSettled(Array.from({ length: 50 }, () => ctx.store.ledger.apply({ ...op })));
        const failed = results.filter(r => r.status === 'rejected');
        assert.deepEqual(failed.map(r => r.reason?.code), [], 'no errors, not even deadlocks');
        const values = results.map(r => r.value);
        assert.equal(values.filter(v => !v.replayed).length, 1);
        assert.equal(values.filter(v => v.replayed).length, 49);
        assert.equal(new Set(values.map(v => v.entryId)).size, 1);
        const { cash, rows } = await assertConserved(id);
        assert.equal(cash, 900);
        assert.equal(rows, 2);
    });

    test('50 parallel spends with different keys: exactly the funded ones pass', async () => {
        const id = await makeAccount(ctx.store, { cash: 1000 });
        const results = await Promise.allSettled(Array.from({ length: 50 }, (_, i) =>
            ctx.store.ledger.apply({ accountId: id, key: `spend-${String(i).padStart(4, '0')}`, reason: 'buy', cash: -100 })));
        const ok = results.filter(r => r.status === 'fulfilled');
        const refused = results.filter(r => r.status === 'rejected');
        assert.equal(ok.length, 10);
        assert.equal(refused.length, 40);
        assert.ok(refused.every(r => r.reason?.code === 'INSUFFICIENT_FUNDS'), refused.map(r => r.reason?.code).join(','));
        const { cash, rows } = await assertConserved(id);
        assert.equal(cash, 0);
        assert.equal(rows, 11);
    });

    test('50 parallel mixed operations on two accounts: no money or items created or lost', async () => {
        const accounts = [
            await makeAccount(ctx.store, { cash: 3000, items: [{ kind: 'seed', itemId: 1, delta: 40 }, { kind: 'produce', itemId: 5, quality: 1, delta: 20 }] }),
            await makeAccount(ctx.store, { cash: 300, items: [{ kind: 'seed', itemId: 1, delta: 5 }] })
        ];
        const start = new Map();
        for (const a of accounts) start.set(a, { cash: (await ctx.store.ledger.balance(a)).cash });

        const rng = createRng('mixed-50');
        const ops = [];
        for (let i = 0; i < 50; i++) {
            const accountId = accounts[rng.int(0, 1)];
            const key = `mix-${String(i).padStart(4, '0')}`;
            const kind = rng.int(0, 4);
            if (kind === 0) ops.push({ accountId, key, reason: 'buy', cash: -rng.int(10, 400), items: [{ kind: 'seed', itemId: 1, delta: rng.int(1, 5) }] });
            else if (kind === 1) ops.push({ accountId, key, reason: 'sell', cash: rng.int(5, 200), items: [{ kind: 'produce', itemId: 5, quality: 1, delta: -rng.int(1, 6) }] });
            else if (kind === 2) ops.push({ accountId, key, reason: 'plant', items: [{ kind: 'seed', itemId: 1, delta: -rng.int(1, 8) }] });
            else if (kind === 3) ops.push({ accountId, key, reason: 'harvest', items: [{ kind: 'produce', itemId: 5, quality: 1, delta: rng.int(1, 4) }, { kind: 'produce', itemId: 6, quality: 0, delta: rng.int(1, 3) }] });
            else ops.push({ accountId, key, reason: 'upgrade', cash: -rng.int(50, 900) });
        }
        // 10 more are exact repeats of earlier operations (retried requests): they must change nothing.
        for (let i = 0; i < 10; i++) ops.push({ ...ops[rng.int(0, 49)] });

        const results = await Promise.allSettled(ops.map(op => ctx.store.ledger.apply(op)));
        const unexpected = results.filter(r => r.status === 'rejected' && !['INSUFFICIENT_FUNDS', 'INSUFFICIENT_ITEMS'].includes(r.reason?.code));
        assert.deepEqual(unexpected.map(r => r.reason?.code || r.reason?.message), [], 'only business refusals, no deadlocks or 500s');

        // Client-side tally of what was applied (first application of each key only).
        const applied = new Set();
        for (const [i, r] of results.entries()) {
            if (r.status !== 'fulfilled' || r.value.replayed) continue;
            assert.ok(!applied.has(ops[i].key), 'a key is applied at most once');
            applied.add(ops[i].key);
        }
        for (const a of accounts) {
            const expectedCash = start.get(a).cash + ops
                .filter((op, i) => op.accountId === a && applied.has(op.key) && results[i].status === 'fulfilled' && !results[i].value.replayed)
                .reduce((sum, op) => sum + (op.cash || 0), 0);
            const { cash } = await assertConserved(a);
            assert.equal(cash, expectedCash, `account ${a}: cash equals start + applied deltas`);
        }
        const [[{ n }]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${ctx.t.ledger} WHERE account_id IN (?) AND idempotency_key LIKE 'mix-%'`, [accounts]);
        assert.equal(Number(n), applied.size, 'one ledger row per applied key');
    });
});
