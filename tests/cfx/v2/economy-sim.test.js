// Greenhouse Tycoon (cfx v2), audit B3 test 4: the economy simulation, plus the phase 2 pure rules (market
// demand, orders, daily reward, watering, staff hire costs). No database. The simulator drives the same
// domain functions as the server (services/cfx/sim/economy.js); `node services/cfx/sim/report.js` prints
// the full curves.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, netWorth, UPGRADE_TIERS } from '../../../services/cfx/sim/economy.js';
import { demandPct, demandChangePct, dayIndex, dayString, MAX_DAILY_SWING } from '../../../services/cfx/domain/market.js';
import { DEMAND_MIN_PCT, DEMAND_MAX_PCT } from '../../../services/cfx/domain/economy.js';
import * as R from '../../../services/cfx/domain/rules.js';
import { BASE_VARIETIES, STAFF_TYPES, staffType, baseVariety } from '../../../services/cfx/config/catalog.js';
import { OFFLINE_CAP_MS, HOUR_MS, DAY_MS, TUNING, LIMITS } from '../../../services/cfx/config/game.js';

const DAY0 = dayIndex(Date.UTC(2027, 0, 1));

describe('market: NPC demand moves, deterministically, within bounds', () => {
    test('same variety and day, same demand; always 60..140; day-to-day change at most 25 points', () => {
        for (const v of [...BASE_VARIETIES.map(x => x.id), 1000, 1001, 1065]) {
            let prev = demandPct(v, DAY0);
            const seen = new Set([prev]);
            for (let d = DAY0 + 1; d < DAY0 + 1000; d++) {
                const x = demandPct(v, d);
                assert.equal(x, demandPct(v, d), 'deterministic');
                assert.ok(x >= DEMAND_MIN_PCT && x <= DEMAND_MAX_PCT, `${v} day ${d}: ${x}`);
                assert.ok(Math.abs(x - prev) <= MAX_DAILY_SWING, `${v} day ${d}: ${prev} -> ${x}`);
                seen.add(x);
                prev = x;
            }
            assert.ok(seen.size >= 20, `variety ${v} uses ${seen.size} different prices: it really moves`);
        }
    });
    test('prices are not stuck: most days differ from the day before, and varieties differ from each other', () => {
        let changed = 0;
        for (let d = DAY0 + 1; d <= DAY0 + 60; d++) if (demandChangePct(1, d) !== 0) changed++;
        assert.ok(changed >= 45, `${changed} of 60 days changed`);
        const today = BASE_VARIETIES.map(v => demandPct(v.id, DAY0));
        assert.ok(new Set(today).size >= 6, 'different varieties have different demand on one day');
        assert.equal(dayString(DAY0), '2027-01-01');
    });
});

describe('rules', () => {
    test('watering: once per planting, from half-grown, cuts half the time still to go; no cooldown state', () => {
        const p = { plantedAtMs: 0, readyAtMs: 600_000, wateredAtMs: null };
        assert.equal(R.canWater({ ...p, nowMs: 299_999 }), false);
        assert.equal(R.canWater({ ...p, nowMs: 300_000 }), true);
        assert.equal(R.canWater({ ...p, nowMs: 600_000 }), false, 'ready: nothing to water');
        assert.equal(R.canWater({ ...p, wateredAtMs: 300_000, nowMs: 400_000 }), false);
        assert.equal(R.waterableAt(p), 300_000);
        assert.equal(R.cutRemaining({ nowMs: 300_000, readyAtMs: 600_000, pct: TUNING.WATER_CUT_PCT }), 450_000);
        assert.equal(R.cutRemaining({ nowMs: 598_000, readyAtMs: 600_000, pct: 90 }), 599_000, 'never earlier than a second from now');
        assert.equal(R.cutRemaining({ nowMs: 599_500, readyAtMs: 600_000, pct: 50 }), 600_000, 'never later than it was');
    });
    test('staff hire costs rise; the Staff room adds slots', () => {
        for (const type of STAFF_TYPES) {
            let prev = 0;
            for (let n = 0; n < 10; n++) {
                const c = R.staffHireCost(type, n);
                assert.ok(Number.isSafeInteger(c) && c > prev);
                prev = c;
            }
            assert.equal(R.staffMax(type, R.effectsFor({ staff_quarters: 2 })), type.maxCount + 2);
        }
    });
    test('orders: deterministic per account and day, unlocked varieties only, a premium over the market', () => {
        const a = R.orderOffers({ accountId: 7, day: DAY0, level: 5 });
        assert.deepEqual(a, R.orderOffers({ accountId: 7, day: DAY0, level: 5 }));
        assert.notDeepEqual(a, R.orderOffers({ accountId: 8, day: DAY0, level: 5 }));
        assert.equal(a.length, TUNING.ORDERS.PER_DAY);
        for (let acc = 1; acc < 200; acc++) {
            for (const o of R.orderOffers({ accountId: acc, day: DAY0 + acc, level: 3 })) {
                const v = baseVariety(o.varietyId);
                assert.ok(v.unlockLevel <= 3);
                assert.ok(o.quantity >= v.baseYield && o.quantity % v.baseYield === 0);
                assert.ok(o.rewardCash > o.quantity * v.basePrice, 'pays more than selling at 100 %');
                assert.ok(o.expiresAtMs > (DAY0 + acc + 1) * DAY_MS);
                assert.ok(o.minQuality >= 0 && o.minQuality <= 2);
            }
        }
    });
    test('daily reward grows with the streak and level; day 7 adds seeds', () => {
        const d1 = R.dailyReward({ streak: 1, level: 1 });
        const d2 = R.dailyReward({ streak: 2, level: 1 });
        assert.ok(d2.cash > d1.cash);
        assert.equal(R.dailyReward({ streak: 30, level: 1 }).cash, R.dailyReward({ streak: TUNING.DAILY.STREAK_MAX, level: 1 }).cash);
        assert.deepEqual(R.dailyReward({ streak: 7, level: 1 }).items, [{ kind: 'seed', itemId: 2, delta: TUNING.DAILY.STREAK_SEEDS }]);
        assert.ok(d1.cash >= 10 * baseVariety(1).seedPrice, 'an empty account can restart from one daily');
        assert.equal(R.nextStreak(null), 1);
        assert.equal(R.nextStreak(4), 5);
    });
    test('breeding plan and hybrid seed prices stay in range', () => {
        for (const a of BASE_VARIETIES) {
            for (const b of BASE_VARIETIES) {
                if (a.id >= b.id) continue;
                const plan = R.breedingPlan(a, b);
                assert.ok(plan.durationMs >= TUNING.BREEDING.MIN_MS && plan.durationMs <= TUNING.BREEDING.MAX_MS);
                assert.ok(plan.feeCash > 0);
            }
        }
        assert.equal(R.plotsOwned({}), 2);
        assert.equal(R.plotsOwned({ extra_bench: 10 }), 12);
        assert.ok(R.plotsOwned({ extra_bench: 10 }) <= LIMITS.MAX_PLOTS);
    });
});

// Bands agreed for phase 2 (see the README "Economy" section for the curves they come from).
const BANDS = {
    30: { casual: [6, 12], regular: [14, 24], heavy: [25, 42] },
    90: { casual: [13, 22], regular: [28, 44], heavy: [45, 70] }
};

describe('economy simulation (B3 test 4)', () => {
    const runs = {};
    const run = (profile, strategy, days, initial) => {
        const k = `${profile}/${strategy}/${days}/${initial ? 'i' : ''}`;
        runs[k] ||= simulate({ profile, strategy, days, seed: 1, initial });
        return runs[k];
    };

    test('levels after 30 and 90 days stay inside the bands for each kind of player', () => {
        for (const days of [30, 90]) {
            for (const profile of ['casual', 'regular', 'heavy']) {
                const lv = run(profile, 'balanced', days).summary.level;
                const [lo, hi] = BANDS[days][profile];
                assert.ok(lv >= lo && lv <= hi, `${profile} day ${days}: level ${lv} not in [${lo}, ${hi}]`);
            }
        }
    });

    test('progression is smooth: upgrade tiers arrive in order, without long stalls, and more play means faster', () => {
        for (const profile of ['casual', 'regular', 'heavy']) {
            const r = run(profile, 'balanced', 90);
            const days = UPGRADE_TIERS.map(t => r.summary.tierDay[t]).filter(d => d != null);
            assert.ok(days.length >= 4, `${profile} reaches at least 4 tiers in 90 days`);
            for (let i = 1; i < days.length; i++) assert.ok(days[i] >= days[i - 1]);
            for (let i = 1; i < days.length; i++) assert.ok(days[i] - days[i - 1] <= 25, `${profile}: ${days[i - 1]} -> ${days[i]} is a stall`);
            const levels = r.series.map(x => x.level);
            for (let d = 1; d < levels.length; d++) assert.ok(levels[d] >= levels[d - 1]);
        }
        const tier = (p) => run(p, 'balanced', 90).summary.tierDay[20];
        assert.ok(tier('heavy') < tier('regular') && tier('regular') < tier('casual'));
        assert.ok(run('regular', 'balanced', 30).summary.upgradeLevels < 60, 'a regular player has not finished the tree in a month');
    });

    test('staff are a supplement, not the game: share of income from staff by kind of player', () => {
        const share = (p) => run(p, 'balanced', 90).summary.staffShare;
        assert.ok(share('casual') <= 0.75, `casual ${share('casual')}`);
        assert.ok(share('regular') <= 0.4, `regular ${share('regular')}`);
        assert.ok(share('heavy') <= 0.15, `heavy ${share('heavy')}`);
        assert.ok(share('heavy') < share('regular') && share('regular') < share('casual'));
    });

    test('idle with maximal staff earns far less than a casual player (b <= k * a, k = 0.35)', () => {
        for (const days of [30, 90]) {
            const idle = run('idle', 'staff', days).summary;
            const casual = run('casual', 'balanced', days).summary;
            assert.ok(idle.totalIncome <= 0.35 * casual.totalIncome, `day ${days}: idle ${idle.totalIncome} vs casual ${casual.totalIncome}`);
            assert.ok(idle.level < casual.level / 2, 'staff earn no XP: idle players do not level');
        }
    });

    test('no single strategy dominates: specialists stay within 1.5x of the balanced player, and lose somewhere', () => {
        for (const profile of ['casual', 'regular']) {
            for (const days of [30, 90]) {
                const bal = run(profile, 'balanced', days);
                for (const strategy of ['grower', 'staff']) {
                    if (profile === 'casual' && strategy === 'grower') continue;
                    const other = run(profile, strategy, days);
                    assert.ok(netWorth(other) <= 1.5 * netWorth(bal), `${profile}/${strategy} day ${days}: ${netWorth(other)} vs ${netWorth(bal)}`);
                }
            }
        }
        // Each specialist loses to the balanced player on net worth or level for a regular player.
        const bal = run('regular', 'balanced', 90).summary;
        for (const strategy of ['grower', 'staff']) {
            const o = run('regular', strategy, 90);
            assert.ok(netWorth(o) < netWorth(run('regular', 'balanced', 90)) || o.summary.level < bal.level, strategy);
        }
    });

    test('the 12-hour offline cap holds: no claim credits more than 12 h; one visit a day earns 12 h, two earn 24 h', () => {
        for (const k of Object.keys(runs)) assert.ok(runs[k].summary.maxClaimCreditHours <= OFFLINE_CAP_MS / HOUR_MS, k);
        const maxed = { level: 30, cash: 0, levels: { staff_training: 10, staff_quarters: 3 }, staff: { gardener: 8, propagator: 6, shop_assistant: 6 } };
        const idle = run('idle', 'staff', 10, maxed).summary;
        const twice = run('casual', 'staff', 10, maxed).summary;
        assert.equal(idle.maxClaimCreditHours, 12);
        assert.ok(idle.forfeitedHours > 0, 'once a day: the hours past 12 are forfeited');
        // Upper bound for 12 h of the maximal staff: cash and produce at the best price (140 % demand).
        const rate = (code) => staffType(code).perHour * (100 + 10 * 4) / 100;
        const bound12 = 12 * (8 * rate('gardener') * baseVariety(1).basePrice * 1.4 + 6 * rate('shop_assistant') + 6 * rate('propagator') * baseVariety(3).seedPrice);
        for (const perDay of idle.staffPerDay.slice(1)) assert.ok(perDay <= bound12, `idle day ${perDay} > 12 h bound ${bound12}`);
        const avg = (xs) => xs.slice(1).reduce((a, b) => a + b, 0) / (xs.length - 1);
        assert.ok(avg(twice.staffPerDay) > 1.6 * avg(idle.staffPerDay), 'two visits a day earn about twice one visit');
        assert.ok(avg(twice.staffPerDay) <= 2 * bound12);
    });
});
