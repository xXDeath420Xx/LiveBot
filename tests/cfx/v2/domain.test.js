// Greenhouse Tycoon (cfx v2), audit B3 test 1: domain unit tests. Pure functions only, no database.
// Covers growth, the economy primitives (one sell formula, XP curve, upgrade costs), staff offline yield
// with the 12-hour cap, breeding, season score caps, the shared validator and the theme rule.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRng, hashSeed } from '../../../services/cfx/domain/rng.js';
import { readyAt, plotState, harvestYield, qualityBand } from '../../../services/cfx/domain/growth.js';
import { sellPrice, saleTotal, xpToNext, xpForLevel, levelForXp, upgradeCost, upgradeEffects, QUALITY_PRICE_PCT } from '../../../services/cfx/domain/economy.js';
import { offlineClaim } from '../../../services/cfx/domain/staff.js';
import { crossVarieties, parentPair } from '../../../services/cfx/domain/breeding.js';
import { addPoints, rankStandings, dayKey, pointsFor, challengeShouldRun } from '../../../services/cfx/domain/season-score.js';
import { int, intFromString, quantity, schema, v, idempotencyKey, displayName } from '../../../services/cfx/lib/validate.js';
import { GameError } from '../../../services/cfx/lib/errors.js';
import { BASE_VARIETIES, STAFF_TYPES, UPGRADE_NODES, baseVariety } from '../../../services/cfx/config/catalog.js';
import { OFFLINE_CAP_MS, HOUR_MS, MINUTE_MS, LIMITS, STARTER_KIT, GROWTH, SEASON_SCORE } from '../../../services/cfx/config/game.js';
import { GAME_TITLE, BRAND, VARIETY_NAMES, STAFF_NAMES, UPGRADE_NAMES } from '../../../services/cfx/config/copy.js';
import { THEME_WORDS } from '../../../services/cfx/lib/name-filter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);

const BAD_NUMBERS = [NaN, Infinity, -Infinity, 1.5, -0.25, '5', '1e3', null, undefined, true, [], {}, 2 ** 53, -(2 ** 53)];

describe('rng', () => {
    test('same seed, same sequence; different seed, different sequence', () => {
        const a = createRng('seed-1'), b = createRng('seed-1'), c = createRng('seed-2');
        const sa = Array.from({ length: 20 }, () => a.next());
        assert.deepEqual(sa, Array.from({ length: 20 }, () => b.next()));
        assert.notDeepEqual(sa, Array.from({ length: 20 }, () => c.next()));
        assert.ok(sa.every(x => x >= 0 && x < 1));
        assert.equal(hashSeed('a', 1), hashSeed('a', 1));
    });
    test('int() stays inside [min, max] and hits both ends', () => {
        const r = createRng(42);
        const seen = new Set();
        for (let i = 0; i < 2000; i++) {
            const x = r.int(3, 7);
            assert.ok(Number.isInteger(x) && x >= 3 && x <= 7);
            seen.add(x);
        }
        assert.deepEqual([...seen].sort(), [3, 4, 5, 6, 7]);
        assert.throws(() => r.int(5, 1), RangeError);
        assert.throws(() => r.int(0.5, 2), RangeError);
    });
});

describe('growth: state from timestamps', () => {
    const sunmoss = baseVariety(1);
    const planted = T0;
    const ready = readyAt({ plantedAtMs: planted, growMs: sunmoss.growMs });

    test('readyAt: grow time, speed bonus, speed cap and minimum grow time', () => {
        assert.equal(ready - planted, sunmoss.growMs);
        assert.equal(readyAt({ plantedAtMs: planted, growMs: 600_000, speedPct: 20 }) - planted, 480_000);
        assert.equal(readyAt({ plantedAtMs: planted, growMs: 600_000, speedPct: 500 }) - planted, 600_000 * (100 - GROWTH.MAX_SPEED_PCT) / 100);
        assert.equal(readyAt({ plantedAtMs: planted, growMs: 1000 }) - planted, GROWTH.MIN_GROW_MS);
    });
    test('plotState at any moment: empty, growing (progress rises), ready from readyAt on', () => {
        assert.deepEqual(plotState(null, T0), { status: 'empty' });
        assert.deepEqual(plotState({ varietyId: null }, T0), { status: 'empty' });
        const plot = { varietyId: 1, plantedAtMs: planted, readyAtMs: ready };
        let last = -1;
        for (let t = planted - 5000; t < ready; t += 7919) {
            const s = plotState(plot, t);
            assert.equal(s.status, 'growing');
            assert.ok(s.progress >= last && s.progress < 1);
            assert.equal(s.remainingMs, ready - t);
            last = s.progress;
        }
        assert.equal(plotState(plot, planted - 5000).progress, 0, 'a clock behind planting shows 0 %, not negative');
        assert.deepEqual(plotState(plot, ready), { status: 'ready', progress: 1, remainingMs: 0, readyAtMs: ready });
        assert.equal(plotState(plot, ready + 10 * 86_400_000).status, 'ready');
    });
    test('bad timestamps are refused', () => {
        for (const bad of [NaN, -1, 1.5, '1000', null]) {
            assert.throws(() => plotState({ varietyId: 1, plantedAtMs: bad, readyAtMs: ready }, T0), RangeError);
            assert.throws(() => plotState({ varietyId: 1, plantedAtMs: planted, readyAtMs: ready }, bad), RangeError);
        }
        assert.throws(() => plotState({ varietyId: 1, plantedAtMs: ready, readyAtMs: planted }, T0), RangeError);
        assert.throws(() => readyAt({ plantedAtMs: T0, growMs: 0 }), RangeError);
    });
    test('harvestYield: deterministic, at least the base, average follows the bonus', () => {
        assert.equal(harvestYield({ baseYield: 4, rng: createRng(1) }), 4);
        let total = 0;
        const rng = createRng('yield');
        for (let i = 0; i < 4000; i++) {
            const y = harvestYield({ baseYield: 4, yieldPct: 10, rng });
            assert.ok(y === 4 || y === 5);
            total += y;
        }
        const avg = total / 4000;
        assert.ok(Math.abs(avg - 4.4) < 0.05, `average ${avg} should be close to 4.4`);
        assert.equal(harvestYield({ baseYield: 4, yieldPct: 25, rng }), 5);
        assert.throws(() => harvestYield({ baseYield: 0, rng }), RangeError);
    });
    test('qualityBand: thresholds and upgrade bonus, never above band 3', () => {
        assert.equal(qualityBand({ roll: 0 }), 0);
        assert.equal(qualityBand({ roll: 549 }), 0);
        assert.equal(qualityBand({ roll: 550 }), 1);
        assert.equal(qualityBand({ roll: 850 }), 2);
        assert.equal(qualityBand({ roll: 970 }), 3);
        assert.equal(qualityBand({ roll: 500, qualityPct: 20 }), 1);
        assert.equal(qualityBand({ roll: 999, qualityPct: 999 }), 3);
        assert.throws(() => qualityBand({ roll: 1000 }), RangeError);
        for (let roll = 0; roll < 1000; roll += 37) {
            assert.ok(qualityBand({ roll, qualityPct: 10 }) >= qualityBand({ roll }));
        }
    });
});

describe('economy primitives', () => {
    test('one sell formula: integer, >= 1, rises with quality, demand clamped to 60-140 %', () => {
        assert.equal(sellPrice({ basePrice: 10, quality: 0 }), 10);
        assert.equal(sellPrice({ basePrice: 10, quality: 3 }), 22);
        assert.equal(sellPrice({ basePrice: 10, quality: 0, demandPct: 0 }), 6);
        assert.equal(sellPrice({ basePrice: 10, quality: 0, demandPct: 999 }), 14);
        assert.equal(sellPrice({ basePrice: 10, quality: 0, pricePct: 30 }), 13);
        assert.equal(sellPrice({ basePrice: 1, quality: 0, demandPct: 60 }), 1);
        for (const variety of BASE_VARIETIES) {
            let prev = 0;
            for (let q = 0; q < QUALITY_PRICE_PCT.length; q++) {
                const p = sellPrice({ basePrice: variety.basePrice, quality: q });
                assert.ok(Number.isSafeInteger(p) && p >= 1 && p >= prev);
                prev = p;
            }
        }
    });
    test('sell formula refuses bad input', () => {
        for (const bad of BAD_NUMBERS) {
            assert.throws(() => sellPrice({ basePrice: bad, quality: 0 }), RangeError, String(bad));
            assert.throws(() => sellPrice({ basePrice: 10, quality: bad }), RangeError, String(bad));
        }
        assert.throws(() => sellPrice({ basePrice: 0, quality: 0 }), RangeError);
        assert.throws(() => sellPrice({ basePrice: 10, quality: 4 }), RangeError);
        assert.throws(() => sellPrice({ basePrice: 10, quality: 0, pricePct: -5 }), RangeError);
    });
    test('saleTotal: exact product, refuses zero, negative and overflow', () => {
        assert.equal(saleTotal({ unitPrice: 13, quantity: 7 }), 91);
        assert.throws(() => saleTotal({ unitPrice: 13, quantity: 0 }), RangeError);
        assert.throws(() => saleTotal({ unitPrice: 13, quantity: -3 }), RangeError);
        assert.throws(() => saleTotal({ unitPrice: 2 ** 40, quantity: LIMITS.MAX_ITEM_DELTA }), RangeError);
    });
    test('XP curve: strictly increasing, and levelForXp inverts xpForLevel', () => {
        let prev = 0;
        for (let l = 1; l < LIMITS.MAX_LEVEL; l++) {
            const need = xpToNext(l);
            assert.ok(need > prev, `xpToNext(${l})`);
            prev = need;
            assert.equal(xpForLevel(l + 1), xpForLevel(l) + need);
        }
        for (let l = 1; l <= LIMITS.MAX_LEVEL; l++) {
            assert.equal(levelForXp(xpForLevel(l)), l);
            if (l > 1) assert.equal(levelForXp(xpForLevel(l) - 1), l - 1);
        }
        assert.equal(levelForXp(0), 1);
        assert.equal(levelForXp(Number.MAX_SAFE_INTEGER), LIMITS.MAX_LEVEL);
        assert.throws(() => levelForXp(-1), RangeError);
        assert.throws(() => levelForXp(1.5), RangeError);
    });
    test('upgrade costs: exact integer steps, rising, refused past max level', () => {
        assert.equal(upgradeCost({ costBase: 300, costGrowthPct: 160, level: 0, maxLevel: 10 }), 300);
        assert.equal(upgradeCost({ costBase: 300, costGrowthPct: 160, level: 1, maxLevel: 10 }), 480);
        assert.equal(upgradeCost({ costBase: 300, costGrowthPct: 160, level: 2, maxLevel: 10 }), 768);
        for (const node of UPGRADE_NODES) {
            let prev = 0;
            for (let level = 0; level < node.maxLevel; level++) {
                const c = upgradeCost({ ...node, level });
                assert.ok(Number.isSafeInteger(c) && c > prev, `${node.code} level ${level}`);
                prev = c;
            }
            assert.throws(() => upgradeCost({ ...node, level: node.maxLevel }), RangeError);
        }
        assert.deepEqual(upgradeEffects(UPGRADE_NODES, { grow_lights: 3, extra_bench: 2 }), { speed_pct: 15, plots: 2 });
        assert.throws(() => upgradeEffects(UPGRADE_NODES, { grow_lights: 99 }), RangeError);
    });
});

describe('staff: offline yield with the 12-hour cap', () => {
    const gardener = { code: 'gardener', output: 'produce', perHour: 6, count: 1 };

    test('the cap is 12 hours (owner decision)', () => {
        assert.equal(OFFLINE_CAP_MS, 12 * HOUR_MS);
    });
    test('away 30 minutes: 3 units, clock moves exactly 30 minutes', () => {
        const out = offlineClaim({ staff: [{ ...gardener, lastClaimAtMs: T0 }], nowMs: T0 + 30 * MINUTE_MS });
        assert.equal(out.rows[0].units, 3);
        assert.equal(out.rows[0].newLastClaimAtMs, T0 + 30 * MINUTE_MS);
        assert.deepEqual(out.totals, { produce: 3 });
    });
    test('away 20 hours: paid for 12, the other 8 are forfeited, clock jumps to now', () => {
        const now = T0 + 20 * HOUR_MS;
        const out = offlineClaim({ staff: [{ ...gardener, count: 3, lastClaimAtMs: T0 }], nowMs: now });
        const row = out.rows[0];
        assert.equal(row.units, 3 * 6 * 12);
        assert.equal(row.creditedMs, OFFLINE_CAP_MS);
        assert.equal(row.forfeitedMs, 8 * HOUR_MS);
        assert.equal(row.newLastClaimAtMs, now);
    });
    test('away a week pays the same as away 12 hours', () => {
        const a = offlineClaim({ staff: [{ ...gardener, lastClaimAtMs: T0 }], nowMs: T0 + 12 * HOUR_MS });
        const b = offlineClaim({ staff: [{ ...gardener, lastClaimAtMs: T0 }], nowMs: T0 + 7 * 24 * HOUR_MS });
        assert.equal(a.rows[0].units, b.rows[0].units);
    });
    test('a larger capMs cannot raise the cap; a smaller one lowers it', () => {
        const big = offlineClaim({ staff: [{ ...gardener, lastClaimAtMs: T0 }], nowMs: T0 + 48 * HOUR_MS, capMs: 48 * HOUR_MS });
        assert.equal(big.rows[0].units, 6 * 12);
        const small = offlineClaim({ staff: [{ ...gardener, lastClaimAtMs: T0 }], nowMs: T0 + 48 * HOUR_MS, capMs: 2 * HOUR_MS });
        assert.equal(small.rows[0].units, 6 * 2);
    });
    test('claiming every 7 minutes for 12 hours never pays more than one claim, and loses at most one unit in progress', () => {
        const single = offlineClaim({ staff: [{ ...gardener, lastClaimAtMs: T0 }], nowMs: T0 + 12 * HOUR_MS }).rows[0].units;
        let clock = T0;
        let total = 0;
        for (let now = T0 + 7 * MINUTE_MS; now <= T0 + 12 * HOUR_MS; now += 7 * MINUTE_MS) {
            const row = offlineClaim({ staff: [{ ...gardener, lastClaimAtMs: clock }], nowMs: now }).rows[0];
            assert.ok(row.newLastClaimAtMs <= now && row.newLastClaimAtMs >= clock);
            total += row.units;
            clock = row.newLastClaimAtMs;
        }
        total += offlineClaim({ staff: [{ ...gardener, lastClaimAtMs: clock }], nowMs: T0 + 12 * HOUR_MS }).rows[0].units;
        assert.ok(total <= single && total >= single - 1, `frequent ${total} vs single ${single}`);
    });
    test('upgrade bonus, several staff types and outputs', () => {
        const out = offlineClaim({
            staff: [
                { ...gardener, count: 2, lastClaimAtMs: T0 },
                { code: 'shop_assistant', output: 'cash', perHour: 40, count: 1, lastClaimAtMs: T0 }
            ],
            nowMs: T0 + 2 * HOUR_MS,
            ratePct: 50
        });
        assert.deepEqual(out.totals, { produce: 2 * 6 * 2 * 1.5, cash: 40 * 2 * 1.5 });
    });
    test('a clock in the future pays nothing and stays put; zero staff pay nothing', () => {
        const ahead = offlineClaim({ staff: [{ ...gardener, lastClaimAtMs: T0 + HOUR_MS }], nowMs: T0 });
        assert.equal(ahead.rows[0].units, 0);
        assert.equal(ahead.rows[0].newLastClaimAtMs, T0 + HOUR_MS);
        const none = offlineClaim({ staff: [{ ...gardener, count: 0, lastClaimAtMs: T0 }], nowMs: T0 + HOUR_MS });
        assert.equal(none.rows[0].units, 0);
        assert.equal(none.rows[0].newLastClaimAtMs, T0 + HOUR_MS);
    });
    test('bad staff input is refused', () => {
        for (const bad of [NaN, -1, 1.5, '3', null]) {
            assert.throws(() => offlineClaim({ staff: [{ ...gardener, count: bad, lastClaimAtMs: T0 }], nowMs: T0 + HOUR_MS }), RangeError);
            assert.throws(() => offlineClaim({ staff: [{ ...gardener, lastClaimAtMs: bad }], nowMs: T0 + HOUR_MS }), RangeError);
            assert.throws(() => offlineClaim({ staff: [{ ...gardener, lastClaimAtMs: T0 }], nowMs: bad }), RangeError);
        }
    });
});

describe('breeding', () => {
    const a = baseVariety(1), b = baseVariety(7);
    test('deterministic and symmetric: the same pair always makes the same hybrid', () => {
        assert.deepEqual(crossVarieties(a, b), crossVarieties(a, b));
        assert.deepEqual(crossVarieties(a, b), crossVarieties(b, a));
        const h = crossVarieties(a, b);
        assert.equal(h.parentA, 1);
        assert.equal(h.parentB, 7);
        assert.equal(h.name, `${a.name} × ${b.name}`);
    });
    test('inherited numbers stay in their bands', () => {
        for (const x of BASE_VARIETIES) {
            for (const y of BASE_VARIETIES) {
                if (x.id >= y.id) continue;
                const h = crossVarieties(x, y);
                const avgGrow = (x.growMs + y.growMs) / 2;
                assert.ok(h.growMs >= Math.max(GROWTH.MIN_GROW_MS, avgGrow * 0.89) && h.growMs <= Math.max(GROWTH.MIN_GROW_MS, avgGrow * 1.11));
                assert.ok(h.baseYield >= Math.max(x.baseYield, y.baseYield) && h.baseYield <= Math.max(x.baseYield, y.baseYield) + 1);
                const avgPrice = Math.round((x.basePrice + y.basePrice) / 2);
                assert.ok(h.basePrice >= Math.round(avgPrice * 1.05) && h.basePrice <= Math.round(avgPrice * 1.2));
                assert.ok(h.rarity >= Math.max(x.rarity, y.rarity) && h.rarity <= 3);
            }
        }
    });
    test('a variety cannot be crossed with itself; ids must be positive integers', () => {
        assert.throws(() => crossVarieties(a, a), RangeError);
        assert.throws(() => parentPair(0, 2), RangeError);
        assert.throws(() => parentPair(1.5, 2), RangeError);
        assert.deepEqual(parentPair(9, 4), [4, 9]);
    });
});

describe('season score', () => {
    test('daily cap: points past the cap do not count; a new day starts at 0', () => {
        let s = addPoints(null, 600, '2026-11-18');
        assert.deepEqual(s, { score: 600, scoreDay: '2026-11-18', scoreToday: 600, added: 600 });
        s = addPoints(s, 600, '2026-11-18');
        assert.equal(s.added, SEASON_SCORE.DAILY_CAP - 600);
        assert.equal(s.score, SEASON_SCORE.DAILY_CAP);
        s = addPoints(s, 50, '2026-11-18');
        assert.equal(s.added, 0);
        s = addPoints(s, 50, '2026-11-19');
        assert.deepEqual(s, { score: SEASON_SCORE.DAILY_CAP + 50, scoreDay: '2026-11-19', scoreToday: 50, added: 50 });
        assert.throws(() => addPoints(s, -5, '2026-11-19'), RangeError);
        assert.throws(() => addPoints(s, 1.5, '2026-11-19'), RangeError);
        assert.throws(() => addPoints(s, 5, '19/11/2026'), RangeError);
    });
    test('30 days of round-the-clock staff cannot beat 30 days at the cap', () => {
        let s = null;
        for (let d = 0; d < 30; d++) s = addPoints(s, 1_000_000, dayKey(T0 + d * 86_400_000));
        assert.equal(s.score, 30 * SEASON_SCORE.DAILY_CAP);
    });
    test('ranking: score descending, ties share a rank, zero scores left out', () => {
        const ranked = rankStandings([
            { account_id: 5, score: 100 }, { account_id: 2, score: 300 }, { account_id: 9, score: 0 },
            { account_id: 3, score: 100 }, { account_id: 7, score: '50' }
        ]);
        assert.deepEqual(ranked.map(r => [r.final_rank, r.account_id]), [[1, 2], [2, 3], [2, 5], [4, 7]]);
    });
    test('points table and the weekly challenge minimum-players rule', () => {
        assert.equal(pointsFor('harvest', 3), 3 * SEASON_SCORE.POINTS.harvest);
        assert.throws(() => pointsFor('nonsense'), RangeError);
        assert.equal(challengeShouldRun({ activePlayers: 2, minActivePlayers: 3 }), false);
        assert.equal(challengeShouldRun({ activePlayers: 3, minActivePlayers: 3 }), true);
        assert.equal(challengeShouldRun({ activePlayers: 9, minActivePlayers: 0 }), false);
    });
});

describe('shared validator', () => {
    const isValidation = (err) => err instanceof GameError && err.code === 'VALIDATION' && err.status === 400;

    test('int / quantity refuse NaN, Infinity, fractions, strings, booleans, null and out-of-range', () => {
        for (const bad of BAD_NUMBERS) {
            assert.throws(() => int(bad), isValidation, String(bad));
            assert.throws(() => quantity(bad), isValidation, String(bad));
        }
        for (const bad of [0, -1, -5000, LIMITS.MAX_ITEM_DELTA + 1]) assert.throws(() => quantity(bad), isValidation, String(bad));
        assert.equal(quantity(1), 1);
        assert.equal(int(-0), 0);
        assert.ok(Object.is(int(-0), 0));
    });
    test('intFromString accepts plain digits only', () => {
        assert.equal(intFromString('42', { min: 1 }), 42);
        for (const bad of ['1e3', '0x10', ' 5', '5 ', '+5', '1.0', '', 'NaN', 'Infinity', '99999999999999999']) {
            assert.throws(() => intFromString(bad), isValidation, bad);
        }
    });
    test('schemas: unknown keys, __proto__ and constructor refused; missing required refused; defaults filled', () => {
        const check = schema({ qty: v.quantity(), note: v.optional(v.str({ max: 10 }), 'none') });
        assert.deepEqual(check({ qty: 3 }), { qty: 3, note: 'none' });
        assert.throws(() => check({}), isValidation);
        assert.throws(() => check({ qty: 3, extra: 1 }), isValidation);
        assert.throws(() => check(JSON.parse('{"qty":3,"__proto__":{"admin":true}}')), isValidation);
        assert.throws(() => check({ qty: 3, constructor: 'x' }), isValidation);
        for (const bad of [null, [], 'x', 5, true]) assert.throws(() => check(bad), isValidation);
        for (const bad of BAD_NUMBERS.filter(x => x !== undefined)) assert.throws(() => check({ qty: bad }), isValidation, String(bad));
        assert.equal({}.admin, undefined, 'no prototype pollution');
    });
    test('idempotency keys and display names', () => {
        assert.equal(idempotencyKey('buy:seed:0001'), 'buy:seed:0001');
        for (const bad of ['short', 'has space here', 'x'.repeat(65), 'emoji\u{1F331}key', 12345678, null]) {
            assert.throws(() => idempotencyKey(bad), isValidation, String(bad));
        }
        assert.equal(displayName('  Fern\u0000Lover​  '), 'FernLover');
        assert.equal(displayName('a'.repeat(50)).length, 32);
        assert.equal(displayName('\u0007', { fallback: 'Grower' }), 'Grower');
    });
});

describe('catalogue and copy', () => {
    test('ids and codes are unique, every code has a display name, starter seeds exist', () => {
        assert.equal(new Set(BASE_VARIETIES.map(x => x.id)).size, BASE_VARIETIES.length);
        assert.equal(new Set(BASE_VARIETIES.map(x => x.code)).size, BASE_VARIETIES.length);
        assert.ok(BASE_VARIETIES.every(x => x.id >= 1 && x.id < 1000 && typeof x.name === 'string' && x.name));
        assert.deepEqual(Object.keys(VARIETY_NAMES).sort(), BASE_VARIETIES.map(x => x.code).sort());
        assert.ok(STAFF_TYPES.every(s => STAFF_NAMES[s.code] === s.name));
        assert.ok(UPGRADE_NODES.every(n => UPGRADE_NAMES[n.code] === n.name));
        for (const node of UPGRADE_NODES) for (const req of node.requires) assert.ok(UPGRADE_NODES.some(n => n.code === req.code));
        for (const seed of STARTER_KIT.seeds) assert.ok(baseVariety(seed.varietyId));
        assert.equal(GAME_TITLE, 'Greenhouse Tycoon');
        assert.equal(BRAND, 'CertiFried');
    });

    // Owner rule 2026-11-18: neutral botany everywhere. Nothing in the v2 service may name drugs, crime or
    // smoking. Scans every .js file of the service (phase 2: integrations, sim, store/game.js ...), its
    // README, the v2 migration, the other v2 test files and (phase 3) the frontend in frontend/greenhouse/
    // (source, HTML, CSS, build script), and (phase 4) the new Discord and dashboard files. The word list is
    // lib/name-filter.js THEME_WORDS (it also filters
    // player names), the one file that has to spell the words out, so it is the one file not scanned.
    test('theme rule: no drug, crime or smoking words anywhere in the v2 service or the v2 frontend', () => {
        const banned = THEME_WORDS;
        const files = [];
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(full); }
                else if (/\.(js|mjs|css|html)$/.test(entry.name) && full !== path.join(repo, 'services/cfx/lib/name-filter.js')) files.push(full);
            }
        };
        walk(path.join(repo, 'services/cfx'));
        walk(path.join(repo, 'frontend/greenhouse'));
        files.push(path.join(repo, 'migrations/437_greenhouse_v2_schema.js'));
        files.push(path.join(repo, 'services/cfx/README.md'));
        // Phase 4: the Discord commands, the dashboard pages and their tests (new files outside the two folders).
        const PHASE4_FILES = [
            'commands/games/arcade-greenhouse-handler.js', 'dashboard/routes/api/features/greenhouse.js',
            'dashboard/routes/greenhouse-admin.js', 'dashboard/routes/greenhouse.js', 'dashboard/views/partials/manage/greenhouse.ejs',
            'tests/greenhouse-discord.test.js', 'tests/greenhouse-dashboard.test.js'
        ];
        for (const f of PHASE4_FILES) {
            assert.ok(fs.existsSync(path.join(repo, f)), `${f} exists`);
            files.push(path.join(repo, f));
        }
        // Phase 5: the drop migration, the privacy script for Twitch and Kick requests and the cutover runbook. (The
        // privacy, retention, cutover and drop tests are in this folder and scanned below.)
        const PHASE5_FILES = ['migrations/438_drop_cfx_v1_tables.js', 'scripts/greenhouse-privacy.mjs', 'docs/greenhouse-cutover.md'];
        for (const f of PHASE5_FILES) {
            assert.ok(fs.existsSync(path.join(repo, f)), `${f} exists`);
            files.push(path.join(repo, f));
        }
        for (const entry of fs.readdirSync(here)) {
            if (entry.endsWith('.js') && entry !== path.basename(fileURLToPath(import.meta.url))) files.push(path.join(here, entry));
        }
        assert.ok(files.length >= 40, `scanned ${files.length} files`);
        for (const f of ['store/game.js', 'integrations/twitch-ext.js', 'integrations/oauth.js', 'sim/economy.js', 'domain/market.js']) {
            assert.ok(files.includes(path.join(repo, 'services/cfx', f)), `${f} is scanned`);
        }
        for (const f of ['src/main.js', 'src/art/plant.js', 'src/copy.js', 'src/styles/app.css', 'src/panel.html', 'build.mjs']) {
            assert.ok(files.includes(path.join(repo, 'frontend/greenhouse', f)), `frontend ${f} is scanned`);
        }
        const hits = [];
        for (const file of files) {
            fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
                const m = line.match(banned);
                if (m) hits.push(`${path.relative(repo, file)}:${i + 1}: ${m[0]}`);
            });
        }
        assert.deepEqual(hits, []);
    });
});
