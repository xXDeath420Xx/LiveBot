// Greenhouse Tycoon (cfx v2), phase 2: races. Many identical or competing requests at once over real HTTP;
// each must pay exactly once, and cash and items must equal the ledger afterwards. Throwaway tables
// (ghtest_<random>_), dropped in after(). Rate limits are off in this app (they would hide the races).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setupTestDb, closePool, startApp } from './_helpers.js';
import { createAuth } from '../../../services/cfx/http/auth.js';
import { createGame } from '../../../services/cfx/store/game.js';
import { HOUR_MS, DAY_MS } from '../../../services/cfx/config/game.js';
import { baseVariety, staffType } from '../../../services/cfx/config/catalog.js';
import { xpForLevel } from '../../../services/cfx/domain/economy.js';
import * as R from '../../../services/cfx/domain/rules.js';

let ctx, auth, srv, game, clock;
const N = 12;

before(async () => {
    clock = Date.UTC(2027, 4, 10, 12, 0, 0);
    ctx = await setupTestDb({ now: () => clock });
    auth = createAuth({ secret: crypto.randomBytes(32).toString('hex'), store: ctx.store });
    game = createGame({ store: ctx.store });
    srv = await startApp({ store: ctx.store, auth, game, rateLimits: false });
});

after(async () => {
    try {
        await srv?.close();
        const left = await ctx?.cleanup();
        assert.deepEqual(left, [], 'every ghtest table was dropped');
    } finally {
        await closePool();
    }
});

async function player({ cash = 0, items = [], level = 1 } = {}) {
    const s = await ctx.store.accounts.signIn({ platform: 'dev', platformUserId: `race-${crypto.randomBytes(5).toString('hex')}` });
    if (cash || items.length) await ctx.store.ledger.apply({ accountId: s.accountId, key: `fund-${crypto.randomBytes(6).toString('hex')}`, reason: 'admin_adjust', cash, items });
    if (level > 1) await ctx.pool.query(`UPDATE ${ctx.t.accounts} SET xp = ?, level = ? WHERE id = ?`, [xpForLevel(level), level, s.accountId]);
    return { ...s, token: auth.sign({ accountId: s.accountId, identityId: s.identityId }) };
}

const all = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
const statuses = (rs) => rs.map(r => r.status).sort((a, b) => a - b);

async function ledgerCount(accountId, where, params = []) {
    const [[{ n }]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${ctx.t.ledger} WHERE account_id = ? AND ${where}`, [accountId, ...params]);
    return Number(n);
}

/** Cash and every inventory row equal the sums of the ledger: nothing created or lost. */
async function assertBooksBalance(accountId) {
    const [[acc]] = await ctx.pool.query(`SELECT cash FROM ${ctx.t.accounts} WHERE id = ?`, [accountId]);
    const [[sum]] = await ctx.pool.query(`SELECT COALESCE(SUM(cash_delta), 0) AS s FROM ${ctx.t.ledger} WHERE account_id = ?`, [accountId]);
    assert.equal(Number(acc.cash), Number(sum.s), 'cash equals the ledger');
    const [rows] = await ctx.pool.query(`SELECT item_lines FROM ${ctx.t.ledger} WHERE account_id = ? AND item_lines IS NOT NULL`, [accountId]);
    const want = new Map();
    for (const r of rows) {
        for (const l of (typeof r.item_lines === 'string' ? JSON.parse(r.item_lines) : r.item_lines)) {
            const k = `${l.kind}:${l.itemId}:${l.quality}`;
            want.set(k, (want.get(k) || 0) + l.delta);
        }
    }
    const inv = await ctx.store.ledger.inventory(accountId);
    const have = new Map(inv.map(i => [`${i.kind}:${i.itemId}:${i.quality}`, i.quantity]));
    for (const [k, n] of want) assert.equal(have.get(k) || 0, n, `inventory ${k}`);
    for (const [k, n] of have) assert.equal(want.get(k) || 0, n, `inventory ${k}`);
}

describe('each of these pays exactly once', () => {
    test(`double harvest: ${N} parallel harvests of one ready plot`, async () => {
        const p = await player();
        await srv.call('POST', '/plots/plant', { token: p.token, body: { slot: 1, varietyId: 1 } });
        clock += baseVariety(1).growMs;
        // Without the planting number: one 200, the rest PLOT_EMPTY.
        const rs = await all(N, () => srv.call('POST', '/plots/harvest', { token: p.token, body: { slot: 1 } }));
        assert.equal(rs.filter(r => r.status === 200).length, 1, JSON.stringify(statuses(rs)));
        assert.ok(rs.filter(r => r.status !== 200).every(r => r.json.error.code === 'PLOT_EMPTY'));
        assert.equal(await ledgerCount(p.accountId, "reason = 'harvest'"), 1);
        // With the planting number (a client retrying): one pays, the rest replay that harvest.
        await srv.call('POST', '/plots/plant', { token: p.token, body: { slot: 1, varietyId: 1 } });
        clock += baseVariety(1).growMs;
        const rs2 = await all(N, () => srv.call('POST', '/plots/harvest', { token: p.token, body: { slot: 1, plantSeq: 2 } }));
        assert.ok(rs2.every(r => r.status === 200), JSON.stringify(statuses(rs2)));
        assert.equal(rs2.filter(r => r.json.result.replayed === false).length, 1);
        assert.equal(await ledgerCount(p.accountId, "reason = 'harvest'"), 2);
        // harvest-all racing single harvests.
        await srv.call('POST', '/plots/plant', { token: p.token, body: { slot: 1, varietyId: 1 } });
        await srv.call('POST', '/plots/plant', { token: p.token, body: { slot: 2, varietyId: 1 } });
        clock += baseVariety(1).growMs;
        await all(N, (i) => (i % 2 ? srv.call('POST', '/plots/harvest-all', { token: p.token, body: {} }) : srv.call('POST', '/plots/harvest', { token: p.token, body: { slot: 1 + (i % 4 === 0 ? 0 : 1) } })));
        assert.equal(await ledgerCount(p.accountId, "reason = 'harvest'"), 4);
        await assertBooksBalance(p.accountId);
    });

    test(`double sell: ${N} parallel sells with one Idempotency-Key, and ${N} with different keys`, async () => {
        const p = await player({ items: [{ kind: 'produce', itemId: 2, quality: 1, delta: 10 }] });
        const before = (await ctx.store.ledger.balance(p.accountId)).cash;
        const rs = await all(N, () => srv.call('POST', '/sell', { token: p.token, key: 'same-sell-key-0001', body: { lines: [{ varietyId: 2, quality: 1, quantity: 4 }] } }));
        assert.ok(rs.every(r => r.status === 200), JSON.stringify(statuses(rs)));
        assert.equal(rs.filter(r => r.json.result.replayed === false).length, 1);
        const paid = rs.find(r => r.json.result.replayed === false).json.result.cash;
        assert.ok(rs.every(r => r.json.result.cash === paid), 'every replay reports the same sale');
        assert.equal((await ctx.store.ledger.balance(p.accountId)).cash, before + paid);
        // The same key for a different sale is refused.
        const mismatch = await srv.call('POST', '/sell', { token: p.token, key: 'same-sell-key-0001', body: { lines: [{ varietyId: 2, quality: 1, quantity: 1 }] } });
        assert.equal(mismatch.json.error.code, 'IDEMPOTENCY_MISMATCH');
        // Different keys, each selling all 6 that are left: exactly one succeeds.
        const rs2 = await all(N, () => srv.call('POST', '/sell', { token: p.token, body: { lines: [{ varietyId: 2, quality: 1, quantity: 6 }] } }));
        assert.equal(rs2.filter(r => r.status === 200).length, 1, JSON.stringify(statuses(rs2)));
        assert.ok(rs2.filter(r => r.status !== 200).every(r => r.json.error.code === 'INSUFFICIENT_ITEMS'));
        assert.equal(await ledgerCount(p.accountId, "reason = 'sell'"), 2);
        await assertBooksBalance(p.accountId);
    });

    test(`double daily: ${N} parallel claims, and one sign-in cannot claim on two accounts the same day`, async () => {
        const p = await player();
        const rs = await all(N, () => srv.call('POST', '/daily', { token: p.token, body: {} }));
        assert.equal(rs.filter(r => r.status === 200).length, 1, JSON.stringify(statuses(rs)));
        assert.ok(rs.filter(r => r.status !== 200).every(r => r.json.error.code === 'DAILY_ALREADY_CLAIMED'));
        assert.equal(await ledgerCount(p.accountId, "reason = 'daily'"), 1);
        // The same sign-in on a second account (as after an unlink) gets nothing more today.
        const q = await player();
        await assert.rejects(game.claimDaily(q.accountId, { identityId: p.identityId }), e => e.code === 'DAILY_ALREADY_CLAIMED' && e.details.by === 'sign-in');
        assert.equal(await ledgerCount(q.accountId, "reason = 'daily'"), 0);
        // Tomorrow it works again, for each account once.
        clock += DAY_MS;
        const rs2 = await all(N, () => srv.call('POST', '/daily', { token: p.token, body: {} }));
        assert.equal(rs2.filter(r => r.status === 200).length, 1);
        assert.equal(rs2.find(r => r.status === 200).json.result.streak, 2);
        await assertBooksBalance(p.accountId);
    });

    test(`parallel order completion: one order ${N} times, and two orders competing for the same produce`, async () => {
        const p = await player();
        const s = await game.state(p.accountId);
        const [o1, o2] = s.orders;
        await ctx.store.ledger.apply({ accountId: p.accountId, key: `fund-o1-${p.accountId}`, reason: 'admin_adjust', items: [{ kind: 'produce', itemId: o1.varietyId, quality: 3, delta: o1.quantity }] });
        const rs = await all(N, () => srv.call('POST', '/orders/fill', { token: p.token, body: { orderId: o1.id } }));
        assert.ok(rs.every(r => r.status === 200), JSON.stringify(statuses(rs)));
        assert.equal(rs.filter(r => r.json.result.replayed === false).length, 1);
        assert.equal(await ledgerCount(p.accountId, "reason = 'order'"), 1);
        // Two orders, produce for only one of them (make them want the same thing).
        await ctx.pool.query(`UPDATE ${ctx.t.orders} SET variety_id = ?, min_quality = 0, quantity = 5 WHERE id = ?`, [o1.varietyId, o2.id]);
        const o3 = s.orders[2];
        await ctx.pool.query(`UPDATE ${ctx.t.orders} SET variety_id = ?, min_quality = 0, quantity = 5 WHERE id = ?`, [o1.varietyId, o3.id]);
        await ctx.store.ledger.apply({ accountId: p.accountId, key: `fund-o2-${p.accountId}`, reason: 'admin_adjust', items: [{ kind: 'produce', itemId: o1.varietyId, quality: 0, delta: 5 }] });
        const rs2 = await all(N, (i) => srv.call('POST', '/orders/fill', { token: p.token, body: { orderId: i % 2 ? o2.id : o3.id } }));
        const won = rs2.filter(r => r.status === 200 && r.json.result.replayed === false);
        assert.equal(won.length, 1, JSON.stringify(rs2.map(r => r.json?.error?.code || r.json?.result?.replayed)));
        assert.equal(await ledgerCount(p.accountId, "reason = 'order'"), 2);
        await assertBooksBalance(p.accountId);
    });

    test(`double upgrade, double plot, double cross claim, double staff claim: ${N} each`, async () => {
        const p = await player({ cash: 100_000, level: 10 });
        const rs = await all(N, () => srv.call('POST', '/upgrades/buy', { token: p.token, body: { code: 'market_stall', level: 1 } }));
        assert.ok(rs.every(r => r.status === 200), JSON.stringify(statuses(rs)));
        assert.equal(await ledgerCount(p.accountId, "reason = 'upgrade' AND ref = 'market_stall'"), 1);
        const plots = await all(N, () => srv.call('POST', '/shop/plot', { token: p.token, body: { level: 1 } }));
        assert.ok(plots.every(r => r.status === 200));
        const [[{ n }]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${ctx.t.plots} WHERE account_id = ?`, [p.accountId]);
        assert.equal(Number(n), 3, 'one plot bought');

        const cross = await srv.call('POST', '/breeding/start', { token: p.token, body: { parentA: 1, parentB: 3 } });
        clock += R.breedingPlan(baseVariety(1), baseVariety(3)).durationMs;
        const claims = await all(N, () => srv.call('POST', '/breeding/claim', { token: p.token, body: { breedingId: cross.json.result.breedingId } }));
        assert.ok(claims.every(r => r.status === 200), JSON.stringify(statuses(claims)));
        assert.equal(claims.filter(r => r.json.result.replayed === false).length, 1);
        assert.equal(await ledgerCount(p.accountId, 'idempotency_key LIKE ?', ['breedclaim:%']), 1);

        await srv.call('POST', '/staff/hire', { token: p.token, body: { code: 'shop_assistant' } });
        clock += 5 * HOUR_MS;
        const before = (await ctx.store.ledger.balance(p.accountId)).cash;
        await all(N, () => srv.call('POST', '/staff/claim', { token: p.token, body: {} }));
        const after = (await ctx.store.ledger.balance(p.accountId)).cash;
        assert.equal(after - before, staffType('shop_assistant').perHour * 5, 'five hours paid once');
        assert.equal(await ledgerCount(p.accountId, "reason = 'staff_claim'"), 1);
        await assertBooksBalance(p.accountId);
    });

    test(`${N} parallel hires with different keys never pass the staff limit; plant races fill a plot once`, async () => {
        const p = await player({ cash: 10_000_000, level: 10 });
        const type = staffType('gardener');
        const rs = await all(N, () => srv.call('POST', '/staff/hire', { token: p.token, body: { code: 'gardener' } }));
        assert.equal(rs.filter(r => r.status === 200).length, type.maxCount);
        assert.ok(rs.filter(r => r.status !== 200).every(r => r.json.error.code === 'STAFF_FULL'));
        const plant = await all(N, () => srv.call('POST', '/plots/plant', { token: p.token, body: { slot: 1, varietyId: 1 } }));
        assert.equal(plant.filter(r => r.status === 200).length, 1);
        assert.ok(plant.filter(r => r.status !== 200).every(r => r.json.error.code === 'PLOT_OCCUPIED'));
        await assertBooksBalance(p.accountId);
        assert.deepEqual(srv.errorsLogged, []);
    });
});

describe('no 500s', () => {
    test('no request in this file produced a 500 or an unhandled error', () => {
        assert.deepEqual(srv.errorsLogged, []);
    });
});

