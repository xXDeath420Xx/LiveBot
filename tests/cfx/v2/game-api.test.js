// Greenhouse Tycoon (cfx v2), phase 2: the gameplay API over real HTTP (127.0.0.1:<random port>) on
// throwaway tables (prefix ghtest_<random>_, dropped in after()).
//   - contract: every route refuses bad input with the one error shape and never a 500
//   - authorisation: account A cannot touch account B's plots, orders or crosses
//   - the full core loop on a fake clock: plant, wait, water, harvest, sell, buy seeds, an upgrade and a
//     plot, hire staff, claim offline progress (12 h cap), daily, an order, boosts, breeding
//   - GET /state?v= gives 304 when unchanged; CORS exact origins; helmet; rate limits; latency
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setupTestDb, closePool, startApp, errorShape } from './_helpers.js';
import { createAuth } from '../../../services/cfx/http/auth.js';
import { createGame } from '../../../services/cfx/store/game.js';
import { STARTER_KIT, HOUR_MS, MINUTE_MS, DAY_MS, OFFLINE_CAP_MS, TUNING } from '../../../services/cfx/config/game.js';
import { baseVariety, staffType, upgradeNode } from '../../../services/cfx/config/catalog.js';
import { sellPrice, xpForLevel, upgradeCost } from '../../../services/cfx/domain/economy.js';
import { demandPct, dayIndex } from '../../../services/cfx/domain/market.js';
import * as R from '../../../services/cfx/domain/rules.js';

let ctx, auth, srv, clock;
const secret = crypto.randomBytes(32).toString('hex');
const hints = [];

before(async () => {
    clock = Date.UTC(2027, 2, 1, 9, 0, 0);
    ctx = await setupTestDb({ now: () => clock });
    auth = createAuth({ secret, store: ctx.store });
    const game = createGame({ store: ctx.store, onChange: (accountId, v) => hints.push({ accountId, v }) });
    srv = await startApp({
        store: ctx.store, auth, game, rateLimits: false,
        config: {
            publicUrl: 'https://certifriedmultitool.com', publicOrigin: 'https://certifriedmultitool.com', publicPrefix: '/gh-api',
            gamePath: '/game', allowDevPlatform: true, twitchExt: { clientId: '7k7fn5nym3jx13sdl4d56yxlu0cytp', secret: null },
            twitchOAuth: {}, kickOAuth: {}, dashboardSecret: ''
        }
    });
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

const uid = () => `p2-${crypto.randomBytes(5).toString('hex')}`;

async function devPlayer(name = 'Grower') {
    const r = await srv.call('POST', '/auth/dev', { body: { userId: uid(), name }, key: false });
    assert.equal(r.status, 200, r.text);
    return r.json;
}

async function grant(accountId, { cash = 0, items = [] }) {
    await ctx.store.ledger.apply({ accountId, key: `grant-${crypto.randomBytes(6).toString('hex')}`, reason: 'admin_adjust', cash, items });
}

async function setLevel(accountId, level) {
    await ctx.pool.query(`UPDATE ${ctx.t.accounts} SET xp = ?, level = ? WHERE id = ?`, [xpForLevel(level), level, accountId]);
}

const BAD_SLOT = [0, 25, -1, 1.5, '1', null, true, [], {}];
const BAD_ID = [0, -5, 2.5, '1', null, true, {}, [], 2 ** 53];
const BAD_SEQ = [-1, 1.5, '2', {}, 2 ** 31];

const POSTS = [
    { path: '/plots/plant', good: { slot: 1, varietyId: 1 }, fields: { slot: BAD_SLOT, varietyId: [...BAD_ID, 2 ** 31] } },
    { path: '/plots/water', good: { slot: 1 }, fields: { slot: BAD_SLOT, plantSeq: BAD_SEQ }, optional: ['plantSeq'] },
    { path: '/plots/harvest', good: { slot: 1 }, fields: { slot: BAD_SLOT, plantSeq: BAD_SEQ }, optional: ['plantSeq'] },
    { path: '/plots/harvest-all', good: {} },
    { path: '/plots/remove', good: { slot: 1 }, fields: { slot: BAD_SLOT, plantSeq: BAD_SEQ }, optional: ['plantSeq'] },
    { path: '/plots/boost', good: { slot: 1, boostId: 1 }, fields: { slot: BAD_SLOT, boostId: [0, 3, '1', 1.5, null, []], plantSeq: BAD_SEQ }, optional: ['plantSeq'] },
    {
        path: '/sell', good: { lines: [{ varietyId: 1, quality: 0, quantity: 1 }] },
        fields: {
            lines: [[], 'x', {}, null, [{}], [{ varietyId: 1, quality: 4, quantity: 1 }], [{ varietyId: 1, quality: 0, quantity: 0 }],
                [{ varietyId: 1, quality: 0, quantity: -3 }], [{ varietyId: 1, quality: 0, quantity: 1.5 }], [{ varietyId: 1, quality: 0, quantity: '5' }],
                [{ varietyId: 1, quality: 0, quantity: 1e7 }], [{ varietyId: 1, quality: 0, quantity: 1, extra: 1 }], [{ varietyId: 0, quality: 0, quantity: 1 }],
                Array.from({ length: 21 }, (_, i) => ({ varietyId: i + 1, quality: 0, quantity: 1 }))]
        }
    },
    { path: '/shop/buy', good: { kind: 'seed', itemId: 1, quantity: 1 }, fields: { kind: ['produce', 'cash', '', 1, null], itemId: BAD_ID, quantity: [0, -1, 1001, 1.5, '1', null] } },
    { path: '/shop/plot', good: {}, fields: { level: [0, -1, 1.5, '1', 1001, null] }, optional: ['level'] },
    { path: '/upgrades/buy', good: { code: 'grow_lights' }, fields: { code: ['nope', '', 1, null, ['grow_lights']], level: [0, 1.5, '2', -1] }, optional: ['level'] },
    { path: '/staff/hire', good: { code: 'gardener' }, fields: { code: ['boss', '', 5, null], count: [0, -1, 1.5, '1'] }, optional: ['count'] },
    { path: '/staff/fire', good: { code: 'gardener' }, fields: { code: ['boss', '', 5, null], count: [-1, 1.5, '1'] }, optional: ['count'] },
    { path: '/staff/claim', good: {} },
    { path: '/breeding/start', good: { parentA: 1, parentB: 2 }, fields: { parentA: BAD_ID, parentB: BAD_ID } },
    { path: '/breeding/claim', good: { breedingId: 1 }, fields: { breedingId: BAD_ID } },
    { path: '/orders/fill', good: { orderId: 1 }, fields: { orderId: BAD_ID } },
    { path: '/orders/decline', good: { orderId: 1 }, fields: { orderId: BAD_ID } },
    { path: '/daily', good: {} }
];
const GETS = ['/state', '/shop', '/varieties', '/stats', '/market'];

describe('contract: every route refuses bad input without a 500', () => {
    test('no session: every game route is 401 with the error shape', async () => {
        for (const path of GETS) errorShape(assert, await srv.call('GET', path), 'UNAUTHORIZED', path);
        for (const { path, good } of POSTS) errorShape(assert, await srv.call('POST', path, { body: good }), 'UNAUTHORIZED', path);
    });

    test('missing Idempotency-Key, malformed JSON, non-objects, unknown fields, __proto__, oversized bodies', async () => {
        const p = await devPlayer();
        for (const { path, good } of POSTS) {
            errorShape(assert, await srv.call('POST', path, { token: p.token, body: good, key: false }), 'IDEMPOTENCY_KEY_REQUIRED', path);
            errorShape(assert, await srv.call('POST', path, { token: p.token, body: good, headers: { 'idempotency-key': 'no spaces allowed' }, key: false }), 'IDEMPOTENCY_KEY_REQUIRED', path);
            errorShape(assert, await srv.call('POST', path, { token: p.token, raw: '{"slot": ' }), 'BAD_JSON', `${path} truncated`);
            for (const raw of ['[]', '"text"', '42', 'null']) {
                const r = await srv.call('POST', path, { token: p.token, raw });
                errorShape(assert, r, null, `${path} ${raw}`);
                assert.ok(['VALIDATION', 'BAD_JSON'].includes(r.json.error.code), `${path} ${raw} -> ${r.json.error.code}`);
            }
            errorShape(assert, await srv.call('POST', path, { token: p.token, body: { ...good, extra: 1 } }), 'VALIDATION', `${path} unknown field`);
            errorShape(assert, await srv.call('POST', path, { token: p.token, raw: '{"__proto__":{"admin":true}}' }), 'VALIDATION', `${path} __proto__`);
            const big = await srv.call('POST', path, { token: p.token, body: { pad: 'x'.repeat(9 * 1024) } });
            errorShape(assert, big, 'PAYLOAD_TOO_LARGE', `${path} 9 KB`);
            assert.equal(big.status, 413);
        }
    });

    test('wrong types and out-of-range values for every field, and every required field missing', async () => {
        const p = await devPlayer();
        for (const { path, good, fields = {}, optional = [] } of POSTS) {
            for (const [field, values] of Object.entries(fields)) {
                for (const value of values) {
                    const r = await srv.call('POST', path, { token: p.token, body: { ...good, [field]: value } });
                    errorShape(assert, r, 'VALIDATION', `${path} ${field}=${JSON.stringify(value)}`);
                    assert.equal(r.status, 400);
                }
                if (!optional.includes(field)) {
                    const missing = { ...good };
                    delete missing[field];
                    errorShape(assert, await srv.call('POST', path, { token: p.token, body: missing }), 'VALIDATION', `${path} without ${field}`);
                }
            }
        }
    });

    test('bad query strings on GET routes', async () => {
        const p = await devPlayer();
        for (const q of ['?v=abc', '?v=1', '?v=1.2.3.4', '?v=1.2.', '?v=1&v=2', '?v[a]=1', `?v=${'9'.repeat(30)}.1`]) {
            errorShape(assert, await srv.call('GET', `/state${q}`, { token: p.token }), 'VALIDATION', `/state${q}`);
        }
        for (const q of ['?days=0', '?days=31', '?days=x', '?days=1e2', '?days=-1', '?days=1.5', '?days=1&days=2']) {
            errorShape(assert, await srv.call('GET', `/market${q}`, { token: p.token }), 'VALIDATION', `/market${q}`);
        }
    });

    test('business refusals are 4xx with the error shape (a fresh account)', async () => {
        const p = await devPlayer();
        const cases = [
            ['/plots/plant', { slot: 3, varietyId: 1 }, 'PLOT_LOCKED'],
            ['/plots/plant', { slot: 1, varietyId: 999 }, 'UNKNOWN_VARIETY'],
            ['/plots/plant', { slot: 1, varietyId: 4 }, 'INSUFFICIENT_ITEMS'],
            ['/plots/water', { slot: 1 }, 'PLOT_EMPTY'],
            ['/plots/harvest', { slot: 2 }, 'PLOT_EMPTY'],
            ['/plots/harvest-all', {}, 'NOTHING_READY'],
            ['/plots/remove', { slot: 1 }, 'PLOT_EMPTY'],
            ['/plots/boost', { slot: 1, boostId: 1 }, 'LEVEL_TOO_LOW'],
            ['/sell', { lines: [{ varietyId: 1, quality: 0, quantity: 1 }] }, 'INSUFFICIENT_ITEMS'],
            ['/sell', { lines: [{ varietyId: 1, quality: 0, quantity: 1 }, { varietyId: 1, quality: 0, quantity: 2 }] }, 'VALIDATION'],
            ['/shop/buy', { kind: 'seed', itemId: 12, quantity: 1 }, 'VARIETY_LOCKED'],
            ['/shop/buy', { kind: 'seed', itemId: 1500, quantity: 1 }, 'UNKNOWN_VARIETY'],
            ['/shop/buy', { kind: 'seed', itemId: 1, quantity: 1000 }, 'INSUFFICIENT_FUNDS'],
            ['/shop/buy', { kind: 'boost', itemId: 9, quantity: 1 }, 'NOT_FOUND'],
            ['/shop/plot', { level: 5 }, 'LEVEL_MISMATCH'],
            ['/upgrades/buy', { code: 'irrigation' }, 'REQUIREMENT_MISSING'],
            ['/upgrades/buy', { code: 'grow_lights' }, 'INSUFFICIENT_FUNDS'],
            ['/staff/hire', { code: 'gardener' }, 'LEVEL_TOO_LOW'],
            ['/staff/fire', { code: 'gardener' }, 'STAFF_NONE'],
            ['/breeding/start', { parentA: 1, parentB: 2 }, 'LEVEL_TOO_LOW'],
            ['/breeding/start', { parentA: 2, parentB: 2 }, 'BREEDING_PARENTS'],
            ['/breeding/start', { parentA: 1, parentB: 1000 }, 'BREEDING_PARENTS'],
            ['/breeding/claim', { breedingId: 999999 }, 'NOT_FOUND'],
            ['/orders/fill', { orderId: 999999 }, 'NOT_FOUND'],
            ['/orders/decline', { orderId: 999999 }, 'NOT_FOUND']
        ];
        for (const [path, body, code] of cases) errorShape(assert, await srv.call('POST', path, { token: p.token, body }), code, `${path} ${JSON.stringify(body)}`);
        const s = (await srv.call('GET', '/state', { token: p.token })).json.state;
        assert.equal(s.account.cash, STARTER_KIT.cash, 'nothing above changed the account');
    });

    test('no request so far produced a 500 or an unhandled error', () => {
        assert.deepEqual(srv.errorsLogged, []);
    });
});

describe('authorisation: one account cannot touch another', () => {
    test("B cannot fill, decline or claim A's orders and crosses, and its plots are its own", async () => {
        const a = await devPlayer('A');
        const b = await devPlayer('B');
        await setLevel(a.accountId, 5);
        const sa = (await srv.call('GET', '/state', { token: a.token })).json.state;
        const orderId = sa.orders[0].id;
        const cross = await srv.call('POST', '/breeding/start', { token: a.token, body: { parentA: 1, parentB: 2 } });
        assert.equal(cross.status, 200, cross.text);
        const breedingId = cross.json.result.breedingId;
        const planted = await srv.call('POST', '/plots/plant', { token: a.token, body: { slot: 2, varietyId: 3 } });
        assert.equal(planted.status, 200, planted.text);

        errorShape(assert, await srv.call('POST', '/orders/fill', { token: b.token, body: { orderId } }), 'NOT_FOUND', 'fill');
        errorShape(assert, await srv.call('POST', '/orders/decline', { token: b.token, body: { orderId } }), 'NOT_FOUND', 'decline');
        clock += 2 * HOUR_MS;
        errorShape(assert, await srv.call('POST', '/breeding/claim', { token: b.token, body: { breedingId } }), 'NOT_FOUND', 'cross');
        // B's slot 2 is B's own (empty) plot; A's plant there is untouched.
        errorShape(assert, await srv.call('POST', '/plots/harvest', { token: b.token, body: { slot: 2 } }), 'PLOT_EMPTY', 'harvest');
        errorShape(assert, await srv.call('POST', '/plots/remove', { token: b.token, body: { slot: 2 } }), 'PLOT_EMPTY', 'remove');

        const after = (await srv.call('GET', '/state', { token: a.token })).json.state;
        assert.ok(after.orders.some(o => o.id === orderId), "A's order is still open");
        assert.equal(after.breeding.length, 1, "A's cross is still waiting");
        assert.equal(after.plots[1].status, 'ready', "A's plant is still there");
        const sb = (await srv.call('GET', '/state', { token: b.token })).json.state;
        assert.equal(sb.account.id, b.accountId);
        assert.ok(sb.orders.every(o => o.id !== orderId));
        // A token for A naming B's account is stale, never B's data.
        errorShape(assert, await srv.call('GET', '/state', { token: auth.sign({ accountId: b.accountId, identityId: a.identityId }) }), 'SESSION_STALE');
    });
});

describe('the core loop on a fake clock', () => {
    test('plant, wait, water, harvest, sell, buy seeds, an upgrade and a plot, hire staff, claim offline progress', async () => {
        const p = await devPlayer('Loop');
        const token = p.token;
        const get = async () => (await srv.call('GET', '/state', { token })).json.state;
        const post = async (path, body) => {
            const r = await srv.call('POST', path, { token, body });
            assert.equal(r.status, 200, `${path} ${r.text}`);
            assert.ok(r.json.state && r.json.result, `${path} answers { result, state }`);
            return r.json;
        };

        let s = await get();
        assert.equal(s.account.cash, STARTER_KIT.cash);
        assert.equal(s.plots.length, STARTER_KIT.plots);
        assert.deepEqual(s.inventory.seeds.map(x => [x.varietyId, x.quantity]), STARTER_KIT.seeds.map(x => [x.varietyId, x.quantity]));
        assert.equal(s.orders.length, TUNING.ORDERS.PER_DAY, "today's NPC orders");
        assert.equal(s.market.length, 3, 'level 1 sees the three starter varieties at market');

        // Plant Sunmoss (2 minutes) and wait.
        const sunmoss = baseVariety(1);
        const t0 = clock;
        let r = await post('/plots/plant', { slot: 1, varietyId: 1 });
        assert.equal(r.result.readyAtMs, t0 + sunmoss.growMs);
        assert.equal(r.state.plots[0].status, 'growing');
        assert.equal(r.state.plots[0].waterableAtMs, t0 + sunmoss.growMs / 2);
        errorShape(assert, await srv.call('POST', '/plots/harvest', { token, body: { slot: 1 } }), 'NOT_READY');
        errorShape(assert, await srv.call('POST', '/plots/water', { token, body: { slot: 1 } }), 'WATER_TOO_EARLY', 'before half-grown');

        // Half-grown: water once (cuts half the time still to go); a second watering is refused.
        clock = t0 + 61_000;
        r = await post('/plots/water', { slot: 1, plantSeq: 1 });
        assert.equal(r.result.readyAtMs, t0 + sunmoss.growMs - Math.floor((sunmoss.growMs - 61_000) / 2));
        assert.equal(r.state.plots[0].watered, true);
        errorShape(assert, await srv.call('POST', '/plots/water', { token, body: { slot: 1 } }), 'ALREADY_WATERED');

        clock = r.result.readyAtMs;
        r = await post('/plots/harvest', { slot: 1, plantSeq: 1 });
        const h = r.result.harvested[0];
        assert.equal(h.units, sunmoss.baseYield);
        assert.equal(h.xp, R.harvestXp(sunmoss));
        assert.equal(r.state.plots[0].status, 'empty');
        assert.equal(r.state.account.xp, R.harvestXp(sunmoss));
        // The same harvest again (a retry with the planting number) replays, paying nothing more.
        r = await post('/plots/harvest', { slot: 1, plantSeq: 1 });
        assert.equal(r.result.replayed, true);
        assert.deepEqual(r.state.inventory.produce, [{ varietyId: 1, quality: h.quality, quantity: h.units }]);

        // Sell at today's NPC price.
        const day = dayIndex(clock);
        const unit = sellPrice({ basePrice: sunmoss.basePrice, quality: h.quality, demandPct: demandPct(1, day) });
        const cashBefore = r.state.account.cash;
        r = await post('/sell', { lines: [{ varietyId: 1, quality: h.quality, quantity: h.units }] });
        assert.equal(r.result.cash, unit * h.units);
        assert.equal(r.state.account.cash, cashBefore + unit * h.units);
        assert.deepEqual(r.state.inventory.produce, []);

        // Buy seeds, then grow to level 2 (gardeners) with both plots.
        r = await post('/shop/buy', { kind: 'seed', itemId: 1, quantity: 30 });
        assert.equal(r.result.cost, 30 * sunmoss.seedPrice);
        for (let round = 0; round < 13; round++) {
            await post('/plots/plant', { slot: 1, varietyId: 1 });
            await post('/plots/plant', { slot: 2, varietyId: 1 });
            clock += sunmoss.growMs;
            r = await post('/plots/harvest-all', {});
            assert.equal(r.result.harvested.length, 2);
        }
        assert.ok(r.state.account.level >= 2, `level ${r.state.account.level}`);
        const lines = r.state.inventory.produce.map(x => ({ varietyId: x.varietyId, quality: x.quality, quantity: x.quantity }));
        r = await post('/sell', { lines });
        assert.deepEqual(r.state.inventory.produce, []);

        // A few days of play, granted at once: an upgrade, a plot and a gardener.
        await grant(p.accountId, { cash: 5000 });
        const lights = upgradeNode('grow_lights');
        r = await post('/upgrades/buy', { code: 'grow_lights', level: 1 });
        assert.equal(r.result.cost, upgradeCost({ ...lights, level: 0 }));
        assert.equal(r.state.effects.speed_pct, lights.effect.perLevel);
        r = await post('/shop/plot', { level: 1 });
        assert.equal(r.state.plots.length, STARTER_KIT.plots + 1);
        const gardener = staffType('gardener');
        r = await post('/staff/hire', { code: 'gardener', count: 1 });
        assert.equal(r.result.cost, gardener.hireCost);
        const g = r.state.staff.find(x => x.code === 'gardener');
        assert.equal(g.count, 1);
        assert.equal(g.nextHireCost, R.staffHireCost(gardener, 1));

        // Away 20 hours: the gardener is paid for 12 (the cap), the other 8 are forfeited.
        clock += 20 * HOUR_MS;
        s = await get();
        const pending = s.staff.find(x => x.code === 'gardener').pending;
        assert.equal(pending.units, gardener.perHour * 12);
        assert.equal(pending.creditedMs, OFFLINE_CAP_MS);
        assert.equal(pending.forfeitedMs, 8 * HOUR_MS);
        r = await post('/staff/claim', {});
        assert.deepEqual(r.result.items, [{ kind: 'produce', itemId: gardener.itemId, quality: 0, delta: gardener.perHour * 12 }]);
        assert.equal(r.result.forfeitedMs, 8 * HOUR_MS);
        assert.ok(r.state.inventory.produce.some(x => x.varietyId === gardener.itemId && x.quantity === gardener.perHour * 12));
        r = await post('/staff/claim', {});
        assert.equal(r.result.paid, false, 'claiming again straight away pays nothing');

        // The daily reward, once.
        r = await post('/daily', {});
        assert.equal(r.result.streak, 1);
        assert.equal(r.result.cash, R.dailyReward({ streak: 1, level: r.state.account.level }).cash);
        assert.equal(r.state.daily.claimedToday, true);
        errorShape(assert, await srv.call('POST', '/daily', { token, body: {} }), 'DAILY_ALREADY_CLAIMED');
        clock += DAY_MS;
        r = await post('/daily', {});
        assert.equal(r.result.streak, 2, 'the next day continues the streak');

        // An NPC order: deliver, get paid once.
        s = await get();
        const order = s.orders[0];
        await grant(p.accountId, { items: [{ kind: 'produce', itemId: order.varietyId, quality: order.minQuality, delta: order.quantity }] });
        const before = (await get()).account.cash;
        r = await post('/orders/fill', { orderId: order.id });
        assert.equal(r.result.cash, order.rewardCash);
        assert.equal(r.state.account.cash, before + order.rewardCash);
        assert.ok(r.state.orders.every(o => o.id !== order.id));
        r = await post('/orders/fill', { orderId: order.id });
        assert.equal(r.result.replayed, true, 'filling again replays, paying nothing');
        assert.equal(r.state.account.cash, before + order.rewardCash);
        const other = r.state.orders[0];
        r = await post('/orders/decline', { orderId: other.id });
        assert.ok(r.state.orders.every(o => o.id !== other.id));
        errorShape(assert, await srv.call('POST', '/orders/fill', { token, body: { orderId: other.id } }), 'ORDER_NOT_OPEN');

        // Boosts (level 5): growth tonic halves the time still to go, once per planting.
        await setLevel(p.accountId, 5);
        r = await post('/shop/buy', { kind: 'boost', itemId: 2, quantity: 2 });
        r = await post('/plots/plant', { slot: 3, varietyId: 2 });
        const ready = r.result.readyAtMs;
        r = await post('/plots/boost', { slot: 3, boostId: 2 });
        assert.equal(r.result.readyAtMs, ready - Math.floor((ready - clock) / 2));
        assert.deepEqual(r.state.plots[2].boostsUsed, [2]);
        errorShape(assert, await srv.call('POST', '/plots/boost', { token, body: { slot: 3, boostId: 2 } }), 'BOOST_ALREADY_USED');
        r = await post('/plots/remove', { slot: 3 });
        assert.equal(r.state.plots[2].status, 'empty');

        // Breeding: timers are enforced by the server; a pair makes the same hybrid for everyone.
        r = await post('/breeding/start', { parentA: 2, parentB: 1 });
        const plan = R.breedingPlan(baseVariety(1), baseVariety(2));
        assert.equal(r.result.readyAtMs, clock + plan.durationMs);
        errorShape(assert, await srv.call('POST', '/breeding/start', { token, body: { parentA: 1, parentB: 3 } }), 'BREEDING_BUSY');
        errorShape(assert, await srv.call('POST', '/breeding/claim', { token, body: { breedingId: r.result.breedingId } }), 'BREEDING_NOT_READY');
        clock += plan.durationMs;
        r = await post('/breeding/claim', { breedingId: r.result.breedingId });
        const hybridId = r.result.varietyId;
        assert.ok(hybridId >= 1000);
        assert.equal(r.result.newDiscovery, true);
        assert.equal(r.result.variety.name, 'Sunmoss × Velvet Fern');
        assert.ok(r.state.inventory.seeds.some(x => x.varietyId === hybridId && x.quantity === TUNING.BREEDING.SEEDS_OUT));
        assert.ok(r.state.hybrids.some(x => x.id === hybridId));
        const q = await devPlayer('Second breeder');
        await setLevel(q.accountId, 5);
        const c2 = await srv.call('POST', '/breeding/start', { token: q.token, body: { parentA: 1, parentB: 2 } });
        clock += plan.durationMs;
        const c2done = await srv.call('POST', '/breeding/claim', { token: q.token, body: { breedingId: c2.json.result.breedingId } });
        assert.equal(c2done.json.result.varietyId, hybridId, 'stored once per pair of parents');
        const [[{ n }]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${ctx.t.varieties} WHERE parent_a = 1 AND parent_b = 2`);
        assert.equal(Number(n), 1);
        // Hybrid seeds can be bought once discovered, and planted.
        r = await post('/shop/buy', { kind: 'seed', itemId: hybridId, quantity: 1 });
        r = await post('/plots/plant', { slot: 1, varietyId: hybridId });
        errorShape(assert, await srv.call('POST', '/shop/buy', { token: (await devPlayer()).token, body: { kind: 'seed', itemId: hybridId, quantity: 1 } }), 'NOT_DISCOVERED');

        // Reads.
        const st = (await srv.call('GET', '/stats', { token })).json.stats;
        assert.ok(st.harvests >= 27 && st.ordersFilled === 1 && st.hybridsBred === 1 && st.staffClaims === 1, JSON.stringify(st));
        const shop = (await srv.call('GET', '/shop', { token })).json.shop;
        assert.ok(shop.seeds.some(x => x.varietyId === hybridId));
        assert.equal(shop.plotExpansion.level, 2);
        const vars = (await srv.call('GET', '/varieties', { token })).json;
        assert.equal(vars.possibleHybrids, 66);
        const market = (await srv.call('GET', '/market?days=14', { token })).json.market;
        assert.ok(market.varieties.every(x => x.series.length === 14));
        assert.deepEqual(srv.errorsLogged, []);
    });

    test('a plot can never be stuck: watering belongs to the planting, the next planting can be watered again', async () => {
        const p = await devPlayer();
        const t0 = clock;
        await srv.call('POST', '/plots/plant', { token: p.token, body: { slot: 1, varietyId: 3 } });
        clock = t0 + baseVariety(3).growMs / 2;
        assert.equal((await srv.call('POST', '/plots/water', { token: p.token, body: { slot: 1 } })).status, 200);
        clock += baseVariety(3).growMs;
        assert.equal((await srv.call('POST', '/plots/harvest', { token: p.token, body: { slot: 1 } })).status, 200);
        const t1 = clock;
        await srv.call('POST', '/plots/plant', { token: p.token, body: { slot: 1, varietyId: 3 } });
        const s = (await srv.call('GET', '/state', { token: p.token })).json.state;
        assert.equal(s.plots[0].watered, false);
        assert.equal(s.plots[0].waterableAtMs, t1 + baseVariety(3).growMs / 2);
        clock = t1 + baseVariety(3).growMs / 2;
        assert.equal((await srv.call('POST', '/plots/water', { token: p.token, body: { slot: 1 } })).status, 200, 'watering works again');
    });
});

describe('state polling, real-time hints and HTTP hardening', () => {
    test('GET /state?v= is 304 when nothing changed, 200 after a change or a new day', async () => {
        const p = await devPlayer();
        const first = await srv.call('GET', '/state', { token: p.token });
        assert.equal(first.status, 200);
        const etag = first.json.state.etag;
        assert.equal(first.headers.get('etag'), `"${etag}"`);
        const same = await srv.call('GET', `/state?v=${etag}`, { token: p.token });
        assert.equal(same.status, 304);
        assert.equal(same.text, '');
        assert.equal((await srv.call('GET', '/state', { token: p.token, headers: { 'if-none-match': `"${etag}"` } })).status, 304);
        hints.length = 0;
        await srv.call('POST', '/plots/plant', { token: p.token, body: { slot: 1, varietyId: 1 } });
        assert.ok(hints.some(h => h.accountId === p.accountId), 'a hint was published for the account');
        const changed = await srv.call('GET', `/state?v=${etag}`, { token: p.token });
        assert.equal(changed.status, 200);
        assert.notEqual(changed.json.state.etag, etag);
        const etag2 = changed.json.state.etag;
        clock += DAY_MS;
        const nextDay = await srv.call('GET', `/state?v=${etag2}`, { token: p.token });
        assert.equal(nextDay.status, 200, 'a new market day is a new state');
        assert.equal(nextDay.json.state.orders.length >= TUNING.ORDERS.PER_DAY, true);
    });

    test('latency: 304 polls and full states (p95 reported)', async () => {
        const p = await devPlayer();
        const etag = (await srv.call('GET', '/state', { token: p.token })).json.state.etag;
        const time = async (fn, n) => {
            const out = [];
            for (let i = 0; i < n; i++) {
                const s = process.hrtime.bigint();
                await fn();
                out.push(Number(process.hrtime.bigint() - s) / 1e6);
            }
            out.sort((a, b) => a - b);
            return { p50: out[Math.floor(n * 0.5)], p95: out[Math.floor(n * 0.95)] };
        };
        const poll = await time(() => srv.call('GET', `/state?v=${etag}`, { token: p.token }), 100);
        const full = await time(() => srv.call('GET', '/state', { token: p.token }), 100);
        const write = await time(() => srv.call('POST', '/shop/buy', { token: p.token, body: { kind: 'seed', itemId: 1, quantity: 1 } }), 30);
        console.log(`# latency ms: 304 poll p50 ${poll.p50.toFixed(1)} p95 ${poll.p95.toFixed(1)}; full state p50 ${full.p50.toFixed(1)} p95 ${full.p95.toFixed(1)}; buy+state p50 ${write.p50.toFixed(1)} p95 ${write.p95.toFixed(1)}`);
        assert.ok(poll.p95 < 50, `304 p95 ${poll.p95}`);
        assert.ok(full.p95 < 150, `full state p95 ${full.p95}`);
    });

    test('CORS: exact origins only', async () => {
        const allowed = ['https://certifriedmultitool.com', 'https://www.certifriedmultitool.com', 'https://7k7fn5nym3jx13sdl4d56yxlu0cytp.ext-twitch.tv',
            'https://supervisor.ext-twitch.tv', 'https://extension-files.twitch.tv', 'https://www.twitch.tv', 'https://dashboard.twitch.tv'];
        for (const origin of allowed) {
            const r = await srv.call('OPTIONS', '/state', { headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
            assert.equal(r.status, 204, origin);
            assert.equal(r.headers.get('access-control-allow-origin'), origin);
            assert.equal(r.headers.get('access-control-allow-credentials'), null, 'no cookies');
        }
        const refused = ['https://evil.example', 'https://abc.ext-twitch.tv', 'https://www.twitch.tv.evil.com', 'http://certifriedmultitool.com',
            'https://certifriedmultitool.com.evil.com', 'https://twitch.tv', 'null', 'https://xn--twitch-.tv'];
        for (const origin of refused) {
            const r = await srv.call('GET', '/health', { headers: { origin } });
            errorShape(assert, r, 'CORS_ORIGIN', origin);
            assert.equal(r.status, 403);
            assert.equal(r.headers.get('access-control-allow-origin'), null);
        }
        assert.equal((await srv.call('GET', '/health')).status, 200, 'no Origin header: not a CORS request');
    });

    test('helmet headers, the public prefix, no x-powered-by, catalogue', async () => {
        const r = await srv.call('GET', '/health', { prefix: '/gh-api/api/v2' });
        assert.equal(r.status, 200);
        assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
        assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
        assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
        assert.equal(r.headers.get('x-powered-by'), null);
        assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
        assert.match(r.headers.get('strict-transport-security'), /max-age=/);
        const cat = await srv.call('GET', '/catalog', { prefix: '/gh-api/api/v2' });
        assert.equal(cat.json.catalog.varieties.length, 12);
        assert.equal(cat.json.catalog.rules.offlineCapMs, 12 * HOUR_MS);
        errorShape(assert, await srv.call('GET', '/nope', { prefix: '/gh-api' }), 'NOT_FOUND');
    });

    test('rate limits: per account for writes, per address for everything, with Retry-After', async () => {
        const limited = await startApp({ store: ctx.store, auth, rateLimits: { write: { burst: 3, perSec: 0.01 }, ip: { burst: 40, perSec: 0.01 }, auth: { burst: 2, perSec: 0.01 } } });
        try {
            const p = await ctx.store.accounts.signIn({ platform: 'dev', platformUserId: uid() });
            const token = auth.sign({ accountId: p.accountId, identityId: p.identityId });
            const codes = [];
            for (let i = 0; i < 5; i++) codes.push((await limited.call('POST', '/shop/buy', { token, body: { kind: 'seed', itemId: 1, quantity: 1 } })).status);
            assert.deepEqual(codes, [200, 200, 200, 429, 429]);
            const r = await limited.call('POST', '/shop/buy', { token, body: { kind: 'seed', itemId: 1, quantity: 1 } });
            errorShape(assert, r, 'RATE_LIMITED');
            assert.ok(Number(r.headers.get('retry-after')) >= 1);
            // Another account is not affected by the first one's write limit.
            const q = await ctx.store.accounts.signIn({ platform: 'dev', platformUserId: uid() });
            assert.equal((await limited.call('POST', '/shop/buy', { token: auth.sign({ accountId: q.accountId, identityId: q.identityId }), body: { kind: 'seed', itemId: 1, quantity: 1 } })).status, 200);
            // Sign-in routes have the stricter per-address bucket.
            const a1 = await limited.call('POST', '/auth/refresh', { body: { refreshToken: 'x' }, key: false });
            const a2 = await limited.call('POST', '/auth/refresh', { body: { refreshToken: 'x' }, key: false });
            const a3 = await limited.call('POST', '/auth/refresh', { body: { refreshToken: 'x' }, key: false });
            assert.deepEqual([a1.status, a2.status, a3.status], [401, 401, 429]);
            // Then the per-address bucket runs out for every route.
            let last;
            for (let i = 0; i < 40; i++) last = await limited.call('GET', '/health');
            errorShape(assert, last, 'RATE_LIMITED', 'per address');
            assert.deepEqual(limited.errorsLogged, []);
        } finally {
            await limited.close();
        }
    });

    test('no request in this file produced a 500 or an unhandled error', () => {
        assert.deepEqual(srv.errorsLogged, []);
    });
});
