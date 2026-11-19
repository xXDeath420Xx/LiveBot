// Greenhouse Tycoon (cfx v2): economy simulator (audit B3 test 4). Pure: it drives the same domain functions
// the server uses (growth, sell formula, upgrade costs, staff claims with the 12 h cap, breeding, market
// demand, orders, daily reward) for one simulated player, minute by minute while they play and in one jump
// while they are away.
//
//   simulate({ profile: 'casual', strategy: 'balanced', days: 30, seed: 1 }) -> { days: [...], summary }
//
// Phase 4 options (all off by default, so the phase 2 curves are unchanged):
//   meta: true          daily and weekly quest rewards (QUESTS; casual players finish 2 of 3 dailies a day and
//                       1 weekly, regular 3 and 2, heavy 3 and 3, idle none)
//   replant: { atLevel, whenTreeDone } Replant when the level reaches atLevel (and, with whenTreeDone, only once
//                       the upgrade tree is complete); REPLANT gives a bonus to prices and XP
//   decorate: true      once the upgrade tree is complete, spend spare cash on decorations (cheapest first)
//
// Profiles say when the player is online; strategies say what they spend on. Every decision is a simple
// greedy rule a real player could follow, so the curves show what the numbers give, not a perfect bot.
import { BASE_VARIETIES, STAFF_TYPES, UPGRADE_NODES, BOOSTS, baseVariety, staffType, upgradeNode } from '../config/catalog.js';
import { OFFLINE_CAP_MS, MINUTE_MS, HOUR_MS, DAY_MS, STARTER_KIT, TUNING, QUALITY_BANDS } from '../config/game.js';
import { readyAt, harvestYield, qualityBand } from '../domain/growth.js';
import { sellPrice, levelForXp, xpForLevel } from '../domain/economy.js';
import { offlineClaim } from '../domain/staff.js';
import { crossVarieties } from '../domain/breeding.js';
import { demandPct } from '../domain/market.js';
import * as R from '../domain/rules.js';
import { createRng, hashSeed } from '../domain/rng.js';
import { withPrestige, boostedXp, replantBonus, questReward, SOLD_DECORATIONS } from '../domain/meta.js';
import { REPLANT, QUESTS } from '../config/game.js';

// Quests a player of each profile finishes: [daily per day, weekly per week].
export const QUEST_HABITS = Object.freeze({ casual: [2, 1], regular: [3, 2], heavy: [3, 3], idle: [0, 0] });

// [start minute of the day, length in minutes]
export const PROFILES = Object.freeze({
    casual: Object.freeze({ label: 'Casual, 10 min a day', sessions: [[8 * 60, 5], [19 * 60, 5]] }),
    regular: Object.freeze({ label: 'Regular, 1 h a day', sessions: [[7 * 60 + 30, 10], [12 * 60 + 30, 10], [18 * 60, 30], [22 * 60, 10]] }),
    heavy: Object.freeze({ label: 'Heavy, 4 h a day', sessions: [[9 * 60, 60], [13 * 60, 60], [18 * 60, 120]] }),
    idle: Object.freeze({ label: 'Idle, one 2-minute visit a day', sessions: [[20 * 60, 2]] })
});

export const STRATEGIES = Object.freeze({
    balanced: Object.freeze({ label: 'Balanced', staff: true, upgrades: true, orders: true, breeding: true, staffWeight: 1 }),
    grower: Object.freeze({ label: 'Grower (no staff)', staff: false, upgrades: true, orders: true, breeding: true, staffWeight: 1 }),
    staff: Object.freeze({ label: 'Staff first', staff: true, upgrades: true, orders: false, breeding: false, staffWeight: 0.4 })
});

const xpForLevelSafe = (level) => xpForLevel(Math.max(1, Math.min(100, level)));

export const UPGRADE_TIERS = Object.freeze([5, 10, 20, 30, 40, 50]);

// The simulation starts at midnight UTC on 2027-01-04 (any day works; this fixes the market pattern).
export const SIM_START_MS = Date.UTC(2027, 0, 4);

/**
 * initial (optional) starts from an established save instead of the starter kit:
 *   { level, cash, levels: { node: level }, staff: { code: count } }   e.g. a fully staffed player going idle
 */
export function simulate({ profile = 'regular', strategy = 'balanced', days = 30, seed = 1, initial = null, meta = false, replant = null, decorate = false } = {}) {
    const prof = PROFILES[profile];
    const strat = STRATEGIES[strategy];
    if (!prof || !strat) throw new RangeError('unknown profile or strategy');
    const rng = createRng(hashSeed('sim', profile, strategy, seed));
    const accountId = 1 + (hashSeed('sim-account', seed) % 1_000_000);

    const s = {
        cash: STARTER_KIT.cash,
        xp: 0,
        level: 1,
        seeds: new Map(STARTER_KIT.seeds.map(x => [x.varietyId, x.quantity])),
        staffSeeds: new Map(), // seeds made by staff and not planted yet (counted as staff income when planted)
        produce: new Map(), // `${variety}:${quality}` -> units
        plots: [],
        levels: {},
        staff: new Map(), // code -> { count, clock }
        discovered: new Set(STARTER_KIT.seeds.map(x => x.varietyId)),
        hybrids: new Map(),
        crossed: new Set(),
        breeding: null,
        orders: [],
        ordersDay: -1,
        dailyDay: -1,
        streak: 0,
        income: { sell: 0, orders: 0, daily: 0, staffCash: 0, staffProduce: 0, staffSeeds: 0 },
        spend: { seeds: 0, upgrades: 0, staff: 0, breeding: 0 },
        forfeitedMs: 0,
        maxClaimCreditMs: 0,
        tierDay: {},
        nextHybridId: 1000,
        // phase 4
        prestige: 0,
        xpEarned: 0,
        replants: [],
        decorations: new Set(),
        decorSpend: 0,
        questIncome: 0,
        allDecorDay: null,
        treeDoneDay: null
    };
    if (initial) {
        if (initial.level) { s.level = initial.level; s.xp = xpForLevelSafe(initial.level); }
        if (initial.cash != null) s.cash = initial.cash;
        if (initial.levels) s.levels = { ...initial.levels };
        for (const [code, count] of Object.entries(initial.staff || {})) s.staff.set(code, { count, clock: SIM_START_MS });
    }
    for (let i = 0; i < R.plotsOwned(s.levels); i++) s.plots.push(null);
    let staffDayStart = 0;
    const staffPerDay = [];

    const variety = (id) => baseVariety(id) || s.hybrids.get(id);
    const effects = () => withPrestige(R.effectsFor(s.levels), s.prestige);
    const day = (t) => Math.floor(t / DAY_MS);
    const addXp = (n) => { const g = boostedXp(n, replantBonus(s.prestige).xpPct); s.xp += g; s.xpEarned += g; s.level = levelForXp(s.xp); };
    const treeDone = () => UPGRADE_NODES.every(n => (s.levels[n.code] || 0) >= n.maxLevel || (!strat.staff && n.branch === 'staff') || (!strat.orders && n.code === 'packaging'));
    const totalLevels = () => Object.values(s.levels).reduce((a, b) => a + b, 0);

    function noteTiers(t) {
        const total = totalLevels();
        for (const tier of UPGRADE_TIERS) if (total >= tier && s.tierDay[tier] == null) s.tierDay[tier] = (t - SIM_START_MS) / DAY_MS;
    }

    function claimStaff(t) {
        const rows = [...s.staff.entries()].map(([code, r]) => ({ code, output: staffType(code).output, perHour: staffType(code).perHour, count: r.count, lastClaimAtMs: r.clock }));
        if (!rows.length) return;
        const out = offlineClaim({ staff: rows, nowMs: t, ratePct: effects().staff_rate_pct });
        for (const row of out.rows) {
            const r = s.staff.get(row.code);
            r.clock = row.newLastClaimAtMs;
            s.forfeitedMs += row.forfeitedMs * (r.count ? 1 : 0);
            if (r.count) s.maxClaimCreditMs = Math.max(s.maxClaimCreditMs, row.creditedMs);
            if (!row.units) continue;
            const type = staffType(row.code);
            if (type.output === 'cash') {
                s.cash += row.units;
                s.income.staffCash += row.units;
            } else if (type.output === 'produce') {
                const v = variety(type.itemId);
                const value = sellPrice({ basePrice: v.basePrice, quality: 0, demandPct: demandPct(v.id, day(t)), pricePct: effects().price_pct }) * row.units;
                s.cash += value;
                s.income.staffProduce += value;
            } else {
                s.seeds.set(type.itemId, (s.seeds.get(type.itemId) || 0) + row.units);
                s.staffSeeds.set(type.itemId, (s.staffSeeds.get(type.itemId) || 0) + row.units);
            }
        }
    }

    function refreshOrders(t) {
        const d = day(t);
        if (s.ordersDay === d) return;
        s.ordersDay = d;
        s.orders = s.orders.filter(o => o.open && o.expiresAtMs > t);
        if (strat.orders) for (const o of R.orderOffers({ accountId, day: d, level: s.level })) s.orders.push({ ...o, open: true });
    }

    function claimDaily(t) {
        const d = day(t);
        if (s.dailyDay === d) return;
        s.streak = s.dailyDay === d - 1 ? s.streak + 1 : 1;
        s.dailyDay = d;
        const r = R.dailyReward({ streak: s.streak, level: s.level });
        s.cash += r.cash;
        s.income.daily += r.cash;
        for (const it of r.items) s.seeds.set(it.itemId, (s.seeds.get(it.itemId) || 0) + it.delta);
    }

    function harvest(t) {
        const e = effects();
        s.plots.forEach((p, i) => {
            if (!p || p.ready > t) return;
            const v = variety(p.v);
            const units = harvestYield({ baseYield: v.baseYield, yieldPct: e.yield_pct, rng });
            const q = qualityBand({ roll: p.roll, qualityPct: e.quality_pct });
            const k = `${v.id}:${q}`;
            s.produce.set(k, (s.produce.get(k) || 0) + units);
            addXp(R.harvestXp(v));
            s.plots[i] = null;
        });
    }

    function water(t) {
        for (const p of s.plots) {
            if (p && R.canWater({ plantedAtMs: p.planted, readyAtMs: p.ready, wateredAtMs: p.watered, nowMs: t })) {
                p.ready = R.cutRemaining({ nowMs: t, readyAtMs: p.ready, pct: TUNING.WATER_CUT_PCT });
                p.watered = t;
            }
        }
    }

    function fillOrders(t) {
        if (!strat.orders) return;
        const e = effects();
        for (const o of s.orders) {
            if (!o.open || o.expiresAtMs <= t) continue;
            let have = 0;
            for (let q = o.minQuality; q < QUALITY_BANDS; q++) have += s.produce.get(`${o.varietyId}:${q}`) || 0;
            if (have < o.quantity) continue;
            let need = o.quantity;
            for (let q = o.minQuality; q < QUALITY_BANDS && need; q++) {
                const k = `${o.varietyId}:${q}`;
                const take = Math.min(need, s.produce.get(k) || 0);
                s.produce.set(k, (s.produce.get(k) || 0) - take);
                need -= take;
            }
            const cash = Math.floor((o.rewardCash * (100 + (e.order_reward_pct || 0))) / 100);
            s.cash += cash;
            s.income.orders += cash;
            addXp(o.rewardXp);
            o.open = false;
        }
    }

    function reservedFor(varietyId, q) {
        // Keep produce an open order could use.
        let keep = 0;
        for (const o of s.orders) if (o.open && o.varietyId === varietyId && q >= o.minQuality) keep += o.quantity;
        return keep;
    }

    function sell(t) {
        const e = effects();
        for (const [k, units] of s.produce) {
            if (!units) continue;
            const [vid, q] = k.split(':').map(Number);
            const sellable = units - Math.min(units, reservedFor(vid, q));
            if (sellable <= 0) continue;
            const v = variety(vid);
            const cash = sellPrice({ basePrice: v.basePrice, quality: q, demandPct: demandPct(vid, day(t)), pricePct: e.price_pct }) * sellable;
            s.cash += cash;
            s.income.sell += cash;
            addXp(R.sellXp(cash));
            s.produce.set(k, units - sellable);
        }
    }

    function plantable() {
        const list = BASE_VARIETIES.filter(v => v.unlockLevel <= s.level);
        for (const h of s.hybrids.values()) if (R.hybridUnlockLevel(h) <= s.level || (s.seeds.get(h.id) || 0) > 0) list.push(h);
        return list;
    }

    function choosePlant(t, sessionEnd, nextSessionStart) {
        const e = effects();
        const qPct = R.expectedQualityPct(e.quality_pct) / 100;
        let best = null;
        for (const v of plantable()) {
            const own = s.seeds.get(v.id) || 0;
            const cost = own > 0 ? 0 : R.seedPrice(v);
            if (cost > s.cash) continue;
            const grow = readyAt({ plantedAtMs: 0, growMs: v.growMs, speedPct: e.speed_pct });
            const units = (v.baseYield * (100 + e.yield_pct)) / 100;
            let value = units * v.basePrice * qPct * (demandPct(v.id, day(t)) / 100) * ((100 + e.price_pct) / 100);
            for (const o of s.orders) if (o.open && o.varietyId === v.id) value += Math.min(units, o.quantity) * (o.rewardCash / o.quantity) * 0.5;
            const profit = value - R.seedPrice(v);
            const cycle = t + grow <= sessionEnd ? grow : Math.max(grow, nextSessionStart - t);
            const score = profit / cycle;
            if (!best || score > best.score) best = { v, score, cost };
        }
        return best;
    }

    function plant(t, sessionEnd, nextSessionStart) {
        s.plots.forEach((p, i) => {
            if (p) return;
            const pick = choosePlant(t, sessionEnd, nextSessionStart);
            if (!pick) return;
            const v = pick.v;
            if ((s.seeds.get(v.id) || 0) > 0) {
                s.seeds.set(v.id, s.seeds.get(v.id) - 1);
                if ((s.staffSeeds.get(v.id) || 0) > 0) {
                    s.staffSeeds.set(v.id, s.staffSeeds.get(v.id) - 1);
                    s.income.staffSeeds += R.seedPrice(v);
                }
            }
            else { s.cash -= pick.cost; s.spend.seeds += pick.cost; }
            const ready = readyAt({ plantedAtMs: t, growMs: v.growMs, speedPct: effects().speed_pct });
            s.plots[i] = { v: v.id, planted: t, ready, roll: rng.int(0, 999), watered: null };
        });
    }

    function reserve() {
        const prices = plantable().map(v => R.seedPrice(v));
        return Math.max(...prices) * s.plots.length;
    }

    function invest(t) {
        for (let guard = 0; guard < 50; guard++) {
            const options = [];
            if (strat.upgrades) {
                for (const node of UPGRADE_NODES) {
                    if (!strat.staff && node.branch === 'staff') continue;
                    if (!strat.orders && node.code === 'packaging') continue;
                    if (!R.requirementsMet(node, s.levels)) continue;
                    const next = R.nextUpgrade(node, s.levels[node.code] || 0);
                    if (next) options.push({ kind: 'upgrade', code: node.code, cost: next.cost, weight: next.cost });
                }
            }
            if (strat.staff) {
                for (const type of STAFF_TYPES) {
                    if (type.unlockLevel > s.level) continue;
                    const r = s.staff.get(type.code);
                    const count = r ? r.count : 0;
                    if (count >= R.staffMax(type, effects())) continue;
                    const cost = R.staffHireCost(type, count);
                    options.push({ kind: 'staff', code: type.code, cost, weight: cost * strat.staffWeight });
                }
            }
            const budget = s.cash - reserve();
            const affordable = options.filter(o => o.cost <= budget).sort((a, b) => a.weight - b.weight);
            if (!affordable.length) return;
            const o = affordable[0];
            s.cash -= o.cost;
            if (o.kind === 'upgrade') {
                if (upgradeNode(o.code).branch === 'staff') claimStaff(t);
                s.levels[o.code] = (s.levels[o.code] || 0) + 1;
                s.spend.upgrades += o.cost;
                while (s.plots.length < R.plotsOwned(s.levels)) s.plots.push(null);
                noteTiers(t);
            } else {
                claimStaff(t);
                const r = s.staff.get(o.code) || { count: 0, clock: t };
                r.count += 1;
                s.staff.set(o.code, r);
                s.spend.staff += o.cost;
            }
        }
    }

    function breed(t) {
        if (!strat.breeding) return;
        if (s.breeding && s.breeding.ready <= t) {
            const { a, b } = s.breeding;
            const key = `${a.id}x${b.id}`;
            let h = [...s.hybrids.values()].find(x => x.key === key);
            if (!h) {
                const made = crossVarieties(a, b);
                h = { ...made, id: s.nextHybridId++, key, hybrid: true, parentA: a.id, parentB: b.id };
                s.hybrids.set(h.id, h);
                addXp(TUNING.BREEDING.XP_NEW);
            } else addXp(TUNING.BREEDING.XP_REPEAT);
            s.discovered.add(h.id);
            s.seeds.set(h.id, (s.seeds.get(h.id) || 0) + TUNING.BREEDING.SEEDS_OUT);
            s.breeding = null;
        }
        if (s.breeding || s.level < TUNING.BREEDING.MIN_LEVEL) return;
        const parents = BASE_VARIETIES.filter(v => v.unlockLevel <= s.level).sort((x, y) => y.basePrice - x.basePrice);
        for (let i = 0; i < parents.length; i++) {
            for (let j = i + 1; j < parents.length; j++) {
                const [a, b] = parents[i].id < parents[j].id ? [parents[i], parents[j]] : [parents[j], parents[i]];
                const key = `${a.id}x${b.id}`;
                if (s.crossed.has(key)) continue;
                const plan = R.breedingPlan(a, b);
                const seedCost = (s.seeds.get(a.id) ? 0 : R.seedPrice(a)) + (s.seeds.get(b.id) ? 0 : R.seedPrice(b));
                if (plan.feeCash + seedCost > s.cash - reserve()) return;
                for (const p of [a, b]) {
                    if (s.seeds.get(p.id)) s.seeds.set(p.id, s.seeds.get(p.id) - 1);
                }
                s.cash -= plan.feeCash + seedCost;
                s.spend.breeding += plan.feeCash + seedCost;
                s.crossed.add(key);
                s.breeding = { a, b, ready: t + plan.durationMs };
                return;
            }
        }
    }


    // ------------------------------------------------------------------ phase 4
    function quests(t, dayNumber) {
        if (!meta) return;
        const [daily, weekly] = QUEST_HABITS[profile] || [0, 0];
        const r = questReward('daily', s.level);
        for (let i = 0; i < Math.min(daily, QUESTS.DAILY_COUNT); i++) { s.cash += r.cash; s.questIncome += r.cash; addXp(r.xp); }
        if (dayNumber % 7 === 6) {
            const w = questReward('weekly', s.level);
            for (let i = 0; i < Math.min(weekly, QUESTS.WEEKLY_COUNT); i++) { s.cash += w.cash; s.questIncome += w.cash; addXp(w.xp); }
        }
    }

    function maybeReplant(t) {
        if (!replant || s.level < Math.max(REPLANT.MIN_LEVEL, replant.atLevel || REPLANT.MIN_LEVEL)) return;
        if (replant.whenTreeDone && !treeDone()) return;
        s.replants.push({ day: (t - SIM_START_MS) / DAY_MS, level: s.level, cash: s.cash, upgradeLevels: totalLevels() });
        s.prestige += 1;
        s.cash = STARTER_KIT.cash;
        s.xp = 0;
        s.level = 1;
        s.seeds = new Map(STARTER_KIT.seeds.map(x => [x.varietyId, x.quantity]));
        s.staffSeeds = new Map();
        s.produce = new Map();
        s.levels = {};
        s.staff = new Map();
        s.plots = [];
        for (let i = 0; i < R.plotsOwned(s.levels); i++) s.plots.push(null);
        s.breeding = null;
        s.orders = [];
        s.ordersDay = -1;
    }

    function buyDecorations(t) {
        if (!decorate || !treeDone()) return;
        if (s.treeDoneDay == null) s.treeDoneDay = (t - SIM_START_MS) / DAY_MS;
        for (const d of SOLD_DECORATIONS) {
            if (s.decorations.has(d.code) || d.unlockLevel > s.level) continue;
            if (s.cash - reserve() < d.price) return;
            s.cash -= d.price;
            s.decorSpend += d.price;
            s.decorations.add(d.code);
            if (s.decorations.size === SOLD_DECORATIONS.length && s.allDecorDay == null) s.allDecorDay = (t - SIM_START_MS) / DAY_MS;
        }
    }

    const series = [];
    const sessions = prof.sessions;
    for (let d = 0; d < days; d++) {
        const dayStart = SIM_START_MS + d * DAY_MS;
        sessions.forEach(([startMin, length], idx) => {
            const start = dayStart + startMin * MINUTE_MS;
            const end = start + length * MINUTE_MS;
            const nextStart = idx + 1 < sessions.length ? dayStart + sessions[idx + 1][0] * MINUTE_MS : dayStart + DAY_MS + sessions[0][0] * MINUTE_MS;
            claimDaily(start);
            if (idx === sessions.length - 1) quests(start, d);
            refreshOrders(start);
            claimStaff(start);
            for (let t = start; t < end; t += MINUTE_MS) {
                harvest(t);
                water(t);
                breed(t);
                fillOrders(t);
                sell(t);
                invest(t);
                buyDecorations(t);
                plant(t, end, nextStart);
                maybeReplant(t);
            }
        });
        const income = { ...s.income };
        const staffIncome = income.staffCash + income.staffProduce + income.staffSeeds;
        staffPerDay.push(staffIncome - staffDayStart);
        staffDayStart = staffIncome;
        const activeIncome = income.sell + income.orders;
        series.push({
            day: d + 1,
            cash: s.cash,
            level: s.level,
            xp: s.xp,
            plots: s.plots.length,
            upgradeLevels: totalLevels(),
            staff: [...s.staff.values()].reduce((a, r) => a + r.count, 0),
            hybrids: s.hybrids.size,
            income,
            staffShare: staffIncome + activeIncome > 0 ? staffIncome / (staffIncome + activeIncome + income.daily) : 0,
            totalIncome: staffIncome + activeIncome + income.daily + s.questIncome,
            prestige: s.prestige,
            decorations: s.decorations.size
        });
    }
    const last = series[series.length - 1];
    return {
        profile, strategy, days, seed,
        series,
        summary: {
            cash: last.cash,
            level: last.level,
            totalIncome: last.totalIncome,
            spentOnUpgrades: s.spend.upgrades,
            spentOnStaff: s.spend.staff,
            upgradeLevels: last.upgradeLevels,
            staff: last.staff,
            plots: last.plots,
            hybrids: last.hybrids,
            staffShare: last.staffShare,
            tierDay: { ...s.tierDay },
            forfeitedHours: s.forfeitedMs / HOUR_MS,
            maxClaimCreditHours: s.maxClaimCreditMs / HOUR_MS,
            staffPerDay,
            offlineCapHours: OFFLINE_CAP_MS / HOUR_MS,
            boostsModelled: BOOSTS.length ? 'not used by the simulated players' : 'none',
            // phase 4
            questIncome: s.questIncome,
            xpEarned: s.xpEarned,
            prestige: s.prestige,
            replants: s.replants,
            decorations: s.decorations.size,
            decorSpend: s.decorSpend,
            treeDoneDay: s.treeDoneDay,
            allDecorDay: s.allDecorDay
        }
    };
}

/** Net worth used to compare strategies: cash plus what was invested (upgrades and staff keep paying). */
export function netWorth(result) {
    const sm = result.summary;
    return sm.cash + sm.spentOnUpgrades + sm.spentOnStaff;
}
