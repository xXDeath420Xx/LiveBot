// Greenhouse Tycoon (cfx v2): economy primitives. Pure, integer-only. The ONE sell formula, the XP curve
// and upgrade costs. The old game had four sell formulas; every sale path in v2 must call sellPrice().
import { LIMITS } from '../config/game.js';

function assertInt(name, value, min = 0, max = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer in [${min}, ${max}]`);
}

// Price multiplier per quality band, in percent.
export const QUALITY_PRICE_PCT = Object.freeze([100, 125, 160, 220]);

// NPC demand moves the price between 60 % and 140 % of base (domain of gh_market_days.demand_pct).
export const DEMAND_MIN_PCT = 60;
export const DEMAND_MAX_PCT = 140;

/**
 * Price of one unit sold to NPC buyers.
 *   basePrice  variety base price (integer >= 1)
 *   quality    band 0..3
 *   demandPct  today's demand for the variety (clamped to 60..140)
 *   pricePct   bonus from upgrades (>= 0)
 * Always >= 1. Integer maths: basePrice * quality% * demand% * (100 + bonus)% / 100^3, floored.
 */
export function sellPrice({ basePrice, quality, demandPct = 100, pricePct = 0 }) {
    assertInt('basePrice', basePrice, 1, 1_000_000_000);
    assertInt('quality', quality, 0, QUALITY_PRICE_PCT.length - 1);
    assertInt('demandPct', demandPct, 0, 1000);
    assertInt('pricePct', pricePct, 0, 1000);
    const demand = Math.min(DEMAND_MAX_PCT, Math.max(DEMAND_MIN_PCT, demandPct));
    const numerator = basePrice * QUALITY_PRICE_PCT[quality] * demand * (100 + pricePct);
    if (!Number.isSafeInteger(numerator)) throw new RangeError('price overflow');
    return Math.max(1, Math.floor(numerator / 1_000_000));
}

/** unitPrice * quantity, refusing anything that would leave the safe range or the ledger cap. */
export function saleTotal({ unitPrice, quantity }) {
    assertInt('unitPrice', unitPrice, 1);
    assertInt('quantity', quantity, 1, LIMITS.MAX_ITEM_DELTA);
    const total = unitPrice * quantity;
    if (!Number.isSafeInteger(total) || total > LIMITS.MAX_CASH_DELTA) throw new RangeError('sale total too large');
    return total;
}

/** XP needed to go from `level` to `level + 1`: 100 * level^1.5, rounded down. */
export function xpToNext(level) {
    assertInt('level', level, 1, LIMITS.MAX_LEVEL);
    return Math.floor(100 * Math.pow(level, 1.5));
}

// Cumulative XP at which each level starts. LEVEL_START[1] = 0.
const LEVEL_START = (() => {
    const out = [0, 0];
    for (let l = 1; l < LIMITS.MAX_LEVEL; l++) out.push(out[l] + xpToNext(l));
    return Object.freeze(out);
})();

/** Total XP at which `level` begins. */
export function xpForLevel(level) {
    assertInt('level', level, 1, LIMITS.MAX_LEVEL);
    return LEVEL_START[level];
}

/** Level reached with `xp` total XP (1..MAX_LEVEL). */
export function levelForXp(xp) {
    assertInt('xp', xp);
    let lo = 1;
    let hi = LIMITS.MAX_LEVEL;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (LEVEL_START[mid] <= xp) lo = mid; else hi = mid - 1;
    }
    return lo;
}

/**
 * Cost to raise an upgrade from `level` to `level + 1`.
 * costBase * (costGrowthPct / 100) ^ level, computed step by step with integer flooring so the result is
 * exact and identical on every machine. Throws past maxLevel.
 */
export function upgradeCost({ costBase, costGrowthPct, level, maxLevel }) {
    assertInt('costBase', costBase, 1);
    assertInt('costGrowthPct', costGrowthPct, 100, 1000);
    assertInt('maxLevel', maxLevel, 1, 1000);
    assertInt('level', level, 0, maxLevel - 1);
    let cost = costBase;
    for (let i = 0; i < level; i++) {
        cost = Math.floor((cost * costGrowthPct) / 100);
        if (cost > LIMITS.MAX_CASH_DELTA) throw new RangeError('upgrade cost too large');
    }
    return cost;
}

/** Sum the effect of owned upgrade levels per stat: { speed_pct: 15, plots: 2, ... }. */
export function upgradeEffects(nodes, levels) {
    const out = {};
    for (const node of nodes) {
        const level = levels?.[node.code] ?? 0;
        assertInt(`level of ${node.code}`, level, 0, node.maxLevel);
        if (!level) continue;
        out[node.effect.stat] = (out[node.effect.stat] || 0) + node.effect.perLevel * level;
    }
    return out;
}
