// Greenhouse Tycoon (cfx v2): the game rules built on the phase 1 primitives. Pure, integer-only, no I/O.
// The HTTP layer (store/game.js) and the economy simulator (sim/economy.js) both call these, so the
// simulated economy is the real one.
import { STARTER_KIT, TUNING, MINUTE_MS, DAY_MS, LIMITS, GROWTH } from '../config/game.js';
import { UPGRADE_NODES, STAFF_TYPES, BASE_VARIETIES, staffType, baseVariety } from '../config/catalog.js';
import { upgradeEffects, upgradeCost, sellPrice, QUALITY_PRICE_PCT } from './economy.js';
import { createRng, hashSeed } from './rng.js';

function assertInt(name, value, min = 0, max = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer in [${min}, ${max}]`);
}

/** Effects of owned upgrade levels, every stat present (0 when not owned). */
export function effectsFor(levels = {}) {
    const raw = upgradeEffects(UPGRADE_NODES, levels);
    const out = {};
    for (const node of UPGRADE_NODES) out[node.effect.stat] = raw[node.effect.stat] || 0;
    return out;
}

/** Plots an account owns: the starter plots plus one per Extra bench level. */
export function plotsOwned(levels = {}) {
    return Math.min(LIMITS.MAX_PLOTS, STARTER_KIT.plots + (levels.extra_bench || 0));
}

/**
 * Level from which a hybrid's seeds are sold: the higher of its parents' unlock levels. Before phase 4 a
 * player could only have bred it at that level anyway; after a Replant (level back to 1) the collection is
 * kept, and this stops the shop from selling late hybrids to a level-1 greenhouse.
 */
export function hybridUnlockLevel(variety) {
    const a = baseVariety(variety.parentA);
    const b = baseVariety(variety.parentB);
    return Math.max(a ? a.unlockLevel : 1, b ? b.unlockLevel : 1);
}

/** Can the account buy seeds of this variety? Base varieties by level; hybrids once discovered (and see above). */
export function seedUnlocked(variety, level, discovered) {
    if (variety.hybrid) return !!discovered && hybridUnlockLevel(variety) <= level;
    return variety.unlockLevel <= level;
}

/** Shop price of one seed. Hybrids: base price x yield x HYBRID_SEED_PRICE_PCT. */
export function seedPrice(variety) {
    if (!variety.hybrid) return variety.seedPrice;
    return Math.max(1, Math.ceil((variety.basePrice * variety.baseYield * TUNING.HYBRID_SEED_PRICE_PCT) / 100));
}

/** XP for harvesting one plant of a variety. */
export function harvestXp(variety) {
    return Math.max(1, Math.round((variety.growMs / MINUTE_MS) * TUNING.XP_PER_GROW_MINUTE));
}

/** XP for a sale of `cash`. */
export function sellXp(cash) {
    assertInt('cash', cash);
    return Math.floor(cash / TUNING.SELL_CASH_PER_XP);
}

/** New ready time after cutting `pct` % of the time still to go (never before now + 1 s, never later than before). */
export function cutRemaining({ nowMs, readyAtMs, pct }) {
    assertInt('nowMs', nowMs);
    assertInt('readyAtMs', readyAtMs);
    assertInt('pct', pct, 0, 100);
    const remaining = readyAtMs - nowMs;
    if (remaining <= 0) return readyAtMs;
    return Math.min(readyAtMs, Math.max(nowMs + 1000, readyAtMs - Math.floor((remaining * pct) / 100)));
}

/**
 * Can this planting be watered now? Once per planting (wateredAtMs null), from WATER_MIN_PROGRESS_PCT of
 * its growth until it is ready. Everything comes from the planting's own timestamps: no cooldown exists.
 */
export function canWater({ plantedAtMs, readyAtMs, wateredAtMs, nowMs }) {
    if (plantedAtMs == null || readyAtMs == null || wateredAtMs != null) return false;
    if (nowMs >= readyAtMs) return false;
    return (nowMs - plantedAtMs) * 100 >= (readyAtMs - plantedAtMs) * TUNING.WATER_MIN_PROGRESS_PCT;
}

/** When a planting becomes waterable (ms), for the client's countdown. */
export function waterableAt({ plantedAtMs, readyAtMs }) {
    return plantedAtMs + Math.ceil(((readyAtMs - plantedAtMs) * TUNING.WATER_MIN_PROGRESS_PCT) / 100);
}

/** Quality roll after a boost (0..999). */
export function boostedRoll(roll, amount) {
    assertInt('roll', roll, 0, 999);
    return Math.min(999, roll + amount);
}

/** Cost to hire one more of a staff type when `count` are already employed. */
export function staffHireCost(type, count) {
    assertInt('count', count, 0, 1000);
    let cost = type.hireCost;
    for (let i = 0; i < count; i++) cost = Math.floor((cost * TUNING.STAFF.HIRE_GROWTH_PCT) / 100);
    return cost;
}

/** How many of a staff type an account may employ (Staff room adds one slot per level to each type). */
export function staffMax(type, effects) {
    return type.maxCount + (effects.staff_slots || 0);
}

/** Next level and cost of an upgrade node, or null at max level. */
export function nextUpgrade(node, level) {
    if (level >= node.maxLevel) return null;
    return { level: level + 1, cost: upgradeCost({ ...node, level }) };
}

/** Are the node's requirements met by these levels? */
export function requirementsMet(node, levels) {
    return node.requires.every(r => (levels[r.code] || 0) >= r.level);
}

/** Unit price to NPC buyers today. */
export function unitPrice({ variety, quality, demand, effects }) {
    return sellPrice({ basePrice: variety.basePrice, quality, demandPct: demand, pricePct: effects.price_pct || 0 });
}

/** The daily reward for a streak (1..) at a level. Day STREAK_MAX of a streak also gives seeds. */
export function dailyReward({ streak, level }) {
    assertInt('streak', streak, 1);
    assertInt('level', level, 1, LIMITS.MAX_LEVEL);
    const d = TUNING.DAILY;
    const step = Math.min(streak, d.STREAK_MAX) - 1;
    const cash = d.BASE_CASH + d.PER_LEVEL_CASH * level + d.STREAK_STEP_CASH * step;
    const items = streak % d.STREAK_MAX === 0 ? [{ kind: 'seed', itemId: 2, delta: d.STREAK_SEEDS }] : [];
    return { cash, items };
}

/** Streak for a claim today, given yesterday's streak (null if no claim yesterday). */
export function nextStreak(yesterdayStreak) {
    return yesterdayStreak ? yesterdayStreak + 1 : 1;
}

/**
 * Today's NPC orders for an account (deterministic per account and day). Varieties come from the base
 * varieties the account's level has unlocked. Rewards pay a premium over today's market so orders are
 * worth planning for.
 *   accountId, day (index), level, nowMs (the moment they are created)
 * Returns [{ varietyId, minQuality, quantity, rewardCash, rewardXp, expiresAtMs }].
 */
export function orderOffers({ accountId, day, level }) {
    assertInt('accountId', accountId, 1);
    assertInt('day', day, 0);
    assertInt('level', level, 1, LIMITS.MAX_LEVEL);
    const o = TUNING.ORDERS;
    const rng = createRng(hashSeed('orders', accountId, day));
    const pool = BASE_VARIETIES.filter(v => v.unlockLevel <= level);
    const out = [];
    for (let i = 0; i < o.PER_DAY; i++) {
        const variety = pool[rng.int(0, pool.length - 1)];
        const qRoll = rng.int(0, 99);
        const minQuality = qRoll < 60 ? 0 : qRoll < 90 ? 1 : 2;
        const quantity = variety.baseYield * rng.int(2, 5);
        const premium = rng.int(o.PREMIUM_MIN_PCT, o.PREMIUM_MAX_PCT);
        const unit = sellPrice({ basePrice: variety.basePrice, quality: minQuality, demandPct: 100 });
        const rewardCash = Math.ceil((unit * quantity * premium) / 100);
        const plantings = Math.ceil(quantity / variety.baseYield);
        const rewardXp = Math.ceil((harvestXp(variety) * plantings * o.XP_BONUS_PCT) / 100);
        const days = rng.int(o.MIN_DAYS, o.MAX_DAYS);
        out.push({ varietyId: variety.id, minQuality, quantity, rewardCash, rewardXp, expiresAtMs: (day + 1 + days) * DAY_MS - 1 });
    }
    return out;
}

/** Breeding a pair: how long it takes and what it costs (parents are variety objects). */
export function breedingPlan(a, b) {
    const t = TUNING.BREEDING;
    const avg = Math.round((a.growMs + b.growMs) / 2);
    const durationMs = Math.min(t.MAX_MS, Math.max(t.MIN_MS, Math.round((avg * t.TIME_FACTOR_PCT) / 100)));
    const feeCash = Math.ceil(((seedPrice(a) + seedPrice(b)) * t.FEE_PCT) / 100);
    return { durationMs, feeCash, seedsOut: t.SEEDS_OUT };
}

/** The item a staff type produces: { kind, itemId } or { kind: 'cash' }. */
export function staffOutput(code) {
    const type = staffType(code);
    if (!type) throw new RangeError(`unknown staff type ${code}`);
    if (type.output === 'cash') return { kind: 'cash', itemId: null };
    return { kind: type.output, itemId: type.itemId };
}

/** Average price multiplier of a fresh harvest with no quality bonus (for display and the simulator). */
export function expectedQualityPct(qualityPct = 0) {
    // Bands on a 0..999 roll raised by qualityPct * 3: >= 970, >= 850, >= 550 (domain/growth.js).
    const boost = Math.min(300, qualityPct * 3);
    const share = (lo, hi) => Math.max(0, Math.min(1000, hi) - Math.max(0, lo)) / 1000;
    const t3 = share(970 - boost, 1000 + 1000);
    const t2 = share(850 - boost, 970 - boost);
    const t1 = share(550 - boost, 850 - boost);
    const t0 = Math.max(0, 1 - t1 - t2 - t3);
    return t0 * QUALITY_PRICE_PCT[0] + t1 * QUALITY_PRICE_PCT[1] + t2 * QUALITY_PRICE_PCT[2] + t3 * QUALITY_PRICE_PCT[3];
}

export const ALL_STAFF_CODES = Object.freeze(STAFF_TYPES.map(s => s.code));
export { GROWTH };
