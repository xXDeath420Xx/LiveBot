// Greenhouse Tycoon (cfx v2): static catalogue. Codes and numbers only; names come from copy.js.
//
// Static definitions live in code, not in tables, so nothing is seeded or re-applied at boot (the old
// game re-ran a data script on every start). Only player state and player-bred hybrids are stored.
// Base variety ids are fixed forever (1..999) because inventory, plots and discoveries reference them.
import { VARIETY_NAMES, STAFF_NAMES, UPGRADE_NAMES, BOOST_NAMES } from './copy.js';
import { FIRST_HYBRID_ID, MINUTE_MS } from './game.js';

const v = (id, code, rarity, growMinutes, baseYield, basePrice, seedPrice, unlockLevel) => Object.freeze({
    id, code, name: VARIETY_NAMES[code], rarity, growMs: growMinutes * MINUTE_MS, baseYield, basePrice,
    seedPrice, unlockLevel, hybrid: false
});

// rarity: 0 common, 1 uncommon, 2 rare, 3 very rare
export const BASE_VARIETIES = Object.freeze([
    v(1, 'sunmoss', 0, 2, 3, 6, 10, 1),
    v(2, 'velvet_fern', 0, 4, 3, 9, 15, 1),
    v(3, 'ember_coleus', 0, 6, 4, 10, 20, 1),
    v(4, 'frostbell', 1, 10, 4, 16, 35, 3),
    v(5, 'copper_calathea', 1, 15, 4, 22, 50, 5),
    v(6, 'moonpetal', 1, 20, 5, 25, 65, 7),
    v(7, 'glasswing_orchid', 2, 30, 4, 45, 110, 10),
    v(8, 'tiger_begonia', 2, 30, 5, 38, 100, 12),
    v(9, 'starlace_fern', 2, 40, 5, 48, 140, 15),
    v(10, 'ruby_peperomia', 2, 45, 6, 44, 150, 18),
    v(11, 'cloudleaf_ivy', 3, 60, 6, 70, 260, 22),
    v(12, 'aurora_bromeliad', 3, 60, 5, 90, 300, 25)
]);

const BY_ID = new Map(BASE_VARIETIES.map(x => [x.id, x]));
const BY_CODE = new Map(BASE_VARIETIES.map(x => [x.code, x]));

export function baseVariety(id) {
    return BY_ID.get(id) || null;
}
export function baseVarietyByCode(code) {
    return BY_CODE.get(code) || null;
}
export function isHybridId(id) {
    return Number.isSafeInteger(id) && id >= FIRST_HYBRID_ID;
}

// Staff earn while the player is away (domain/staff.js), capped at OFFLINE_CAP_MS.
//   output   what one staff member produces: produce, seeds or cash
//   itemId   the variety they grow or propagate (fixed, so players know what they get)
//   perHour  output per hour for one staff member before upgrades
// Hiring the n-th member of a type costs hireCost x HIRE_GROWTH_PCT^(n-1) (domain/rules.js).
export const STAFF_TYPES = Object.freeze([
    Object.freeze({ code: 'gardener', name: STAFF_NAMES.gardener, output: 'produce', itemId: 1, perHour: 3, hireCost: 500, maxCount: 5, unlockLevel: 2 }),
    Object.freeze({ code: 'propagator', name: STAFF_NAMES.propagator, output: 'seed', itemId: 3, perHour: 2, hireCost: 1200, maxCount: 3, unlockLevel: 6 }),
    Object.freeze({ code: 'shop_assistant', name: STAFF_NAMES.shop_assistant, output: 'cash', itemId: null, perHour: 20, hireCost: 2000, maxCount: 3, unlockLevel: 8 })
]);

// Consumables sold in the shop and used on one growing plant (once per type per planting).
//   quality_roll  adds to the planting's quality roll (0..999)
//   time_cut_pct  cuts the time still to go by this %
export const BOOSTS = Object.freeze([
    Object.freeze({ id: 1, code: 'plant_food', name: BOOST_NAMES.plant_food, price: 60, unlockLevel: 3, effect: Object.freeze({ kind: 'quality_roll', amount: 200 }) }),
    Object.freeze({ id: 2, code: 'growth_tonic', name: BOOST_NAMES.growth_tonic, price: 90, unlockLevel: 5, effect: Object.freeze({ kind: 'time_cut_pct', amount: 50 }) })
]);

export function boostById(id) {
    return BOOSTS.find(b => b.id === id) || null;
}

// One upgrade tree (audit B1 merged six systems into this). costGrowthPct: each level costs this % of
// the previous one. effect.perLevel is a percentage point (or a count for plots).
export const UPGRADE_NODES = Object.freeze([
    Object.freeze({ code: 'grow_lights', name: UPGRADE_NAMES.grow_lights, branch: 'growing', maxLevel: 10, costBase: 900, costGrowthPct: 175, effect: Object.freeze({ stat: 'speed_pct', perLevel: 5 }), requires: Object.freeze([]) }),
    Object.freeze({ code: 'irrigation', name: UPGRADE_NAMES.irrigation, branch: 'growing', maxLevel: 10, costBase: 1200, costGrowthPct: 175, effect: Object.freeze({ stat: 'yield_pct', perLevel: 5 }), requires: Object.freeze([{ code: 'grow_lights', level: 1 }]) }),
    Object.freeze({ code: 'soil_mix', name: UPGRADE_NAMES.soil_mix, branch: 'growing', maxLevel: 10, costBase: 1500, costGrowthPct: 180, effect: Object.freeze({ stat: 'quality_pct', perLevel: 4 }), requires: Object.freeze([{ code: 'irrigation', level: 1 }]) }),
    Object.freeze({ code: 'extra_bench', name: UPGRADE_NAMES.extra_bench, branch: 'growing', maxLevel: 10, costBase: 1500, costGrowthPct: 170, effect: Object.freeze({ stat: 'plots', perLevel: 1 }), requires: Object.freeze([]) }),
    Object.freeze({ code: 'market_stall', name: UPGRADE_NAMES.market_stall, branch: 'selling', maxLevel: 10, costBase: 1200, costGrowthPct: 175, effect: Object.freeze({ stat: 'price_pct', perLevel: 3 }), requires: Object.freeze([]) }),
    Object.freeze({ code: 'packaging', name: UPGRADE_NAMES.packaging, branch: 'selling', maxLevel: 5, costBase: 3000, costGrowthPct: 180, effect: Object.freeze({ stat: 'order_reward_pct', perLevel: 6 }), requires: Object.freeze([{ code: 'market_stall', level: 2 }]) }),
    Object.freeze({ code: 'staff_training', name: UPGRADE_NAMES.staff_training, branch: 'staff', maxLevel: 10, costBase: 2000, costGrowthPct: 175, effect: Object.freeze({ stat: 'staff_rate_pct', perLevel: 4 }), requires: Object.freeze([]) }),
    Object.freeze({ code: 'staff_quarters', name: UPGRADE_NAMES.staff_quarters, branch: 'staff', maxLevel: 3, costBase: 5000, costGrowthPct: 200, effect: Object.freeze({ stat: 'staff_slots', perLevel: 1 }), requires: Object.freeze([{ code: 'staff_training', level: 1 }]) })
]);

// ------------------------------------------------------------------ phase 4: quests, achievements, cosmetics
// Text for all of these is in copy.js (QUEST_TEXT, ACHIEVEMENT_TEXT, DECORATION_NAMES, BADGE_NAMES).

// Things a quest or challenge can count. Each gameplay action reports one or more of these
// (store/meta.js progress()).
export const QUEST_METRICS = Object.freeze([
    'harvest', 'plant', 'water', 'sell_units', 'earn_cash', 'fill_order', 'cross', 'staff_claim', 'upgrade', 'daily', 'boost'
]);

// Quest templates. Target at level L: base + floor(L * num / den), capped at max.
//   period    'daily' | 'weekly'
//   minLevel  only offered from this level (the action must be possible by then)
const q = (code, period, metric, base, [num, den], max, minLevel = 1) => Object.freeze({ code, period, metric, base, num, den, max, minLevel });
export const QUESTS_CATALOG = Object.freeze([
    q('d_harvest', 'daily', 'harvest', 4, [1, 3], 20),
    q('d_plant', 'daily', 'plant', 4, [1, 3], 20),
    q('d_water', 'daily', 'water', 2, [1, 8], 8),
    q('d_sell', 'daily', 'sell_units', 15, [4, 1], 300),
    q('d_earn', 'daily', 'earn_cash', 200, [120, 1], 15000, 2),
    q('d_order', 'daily', 'fill_order', 1, [0, 1], 1),
    q('d_staff', 'daily', 'staff_claim', 1, [0, 1], 1, 3),
    q('d_cross', 'daily', 'cross', 1, [0, 1], 1, 5),
    q('w_harvest', 'weekly', 'harvest', 30, [2, 1], 150),
    q('w_sell', 'weekly', 'sell_units', 150, [25, 1], 2500),
    q('w_earn', 'weekly', 'earn_cash', 2000, [900, 1], 120000, 2),
    q('w_order', 'weekly', 'fill_order', 5, [0, 1], 5),
    q('w_water', 'weekly', 'water', 15, [1, 2], 40),
    q('w_upgrade', 'weekly', 'upgrade', 3, [0, 1], 3, 2),
    q('w_daily', 'weekly', 'daily', 5, [0, 1], 5),
    q('w_cross', 'weekly', 'cross', 3, [0, 1], 3, 5)
]);

// Weekly challenges inside a season: one per week, the same for every player, fixed targets.
export const CHALLENGES_CATALOG = Object.freeze([
    Object.freeze({ code: 'c_harvest', metric: 'harvest', target: 40 }),
    Object.freeze({ code: 'c_plant', metric: 'plant', target: 40 }),
    Object.freeze({ code: 'c_order', metric: 'fill_order', target: 6 }),
    Object.freeze({ code: 'c_water', metric: 'water', target: 20 }),
    Object.freeze({ code: 'c_sell', metric: 'sell_units', target: 400 }),
    Object.freeze({ code: 'c_cross', metric: 'cross', target: 3 })
]);

export function questDef(code) {
    return QUESTS_CATALOG.find(x => x.code === code) || CHALLENGES_CATALOG.find(x => x.code === code) || null;
}

// Achievements: unlocked from lifetime stats (store/meta.js statsFor), claimed for a reward.
//   stat   harvests | units_sold | cash_earned | orders_filled | hybrids_bred | base_varieties | best_level |
//          staff_claims | quests_claimed | best_streak | replants | decorations | challenges_completed
//   badge  a badge code granted with the reward (copy.js BADGE_NAMES), or null
const a = (code, stat, target, cash, badge = null) => Object.freeze({ code, stat, target, cash, badge });
export const ACHIEVEMENTS = Object.freeze([
    a('first_harvest', 'harvests', 1, 100),
    a('harvests_100', 'harvests', 100, 1000),
    a('harvests_1000', 'harvests', 1000, 10000),
    a('harvests_10000', 'harvests', 10000, 50000, 'master_grower'),
    a('sold_1000', 'units_sold', 1000, 1500),
    a('sold_100000', 'units_sold', 100000, 30000),
    a('earned_100k', 'cash_earned', 100000, 2500),
    a('earned_10m', 'cash_earned', 10000000, 50000),
    a('orders_1', 'orders_filled', 1, 150),
    a('orders_50', 'orders_filled', 50, 5000),
    a('orders_500', 'orders_filled', 500, 40000, 'trusted_supplier'),
    a('hybrid_1', 'hybrids_bred', 1, 500),
    a('hybrid_10', 'hybrids_bred', 10, 10000),
    a('hybrid_all', 'hybrids_bred', 66, 100000, 'botanist'),
    a('collection_base', 'base_varieties', 12, 20000),
    a('level_10', 'best_level', 10, 2000),
    a('level_25', 'best_level', 25, 15000),
    a('level_50', 'best_level', 50, 75000, 'veteran'),
    a('staff_first', 'staff_claims', 1, 300),
    a('quests_25', 'quests_claimed', 25, 5000),
    a('quests_250', 'quests_claimed', 250, 40000),
    a('streak_7', 'best_streak', 7, 3000),
    a('challenge_1', 'challenges_completed', 1, 2000),
    a('replant_1', 'replants', 1, 10000, 'replanted'),
    a('replant_5', 'replants', 5, 50000, 'evergreen'),
    a('decor_1', 'decorations', 1, 500),
    a('decor_all', 'decorations', 11, 0, 'curator')
]);

export function achievement(code) {
    return ACHIEVEMENTS.find(x => x.code === code) || null;
}

// Decorations for the greenhouse: cosmetic only, bought once each with cash. `price: null` means it is
// not sold (season rewards). A Replant keeps them.
const d = (code, price, unlockLevel) => Object.freeze({ code, price, unlockLevel });
export const DECORATIONS = Object.freeze([
    d('potted_fern', 5000, 3),
    d('stone_path', 15000, 5),
    d('bird_bath', 40000, 8),
    d('wind_chime', 80000, 10),
    d('trellis_arch', 150000, 12),
    d('koi_pond', 300000, 15),
    d('glass_cupola', 600000, 18),
    d('sundial', 1200000, 20),
    d('fountain', 2500000, 22),
    d('orangery_wing', 5000000, 25),
    d('golden_can', 10000000, 30),
    d('laurel_arch', null, null)
]);

export function decoration(code) {
    return DECORATIONS.find(x => x.code === code) || null;
}

// Season reward tiers, best first. A standing gets the first tier it qualifies for:
//   maxRank   final rank at most this (ties share a rank)
//   topPct    final rank within this % of ranked players (rounded up)
//   minScore  any ranked player with at least this score
// Badges are per season (`s<number>_<tier>`); top tiers also get the season-only decoration.
export const SEASON_TIERS = Object.freeze([
    Object.freeze({ tier: 'champion', maxRank: 1, cash: 25000, decoration: 'laurel_arch' }),
    Object.freeze({ tier: 'podium', maxRank: 3, cash: 15000, decoration: 'laurel_arch' }),
    Object.freeze({ tier: 'top10', maxRank: 10, cash: 8000, decoration: 'laurel_arch' }),
    Object.freeze({ tier: 'top_quarter', topPct: 25, cash: 4000, decoration: null }),
    Object.freeze({ tier: 'grower', minScore: 100, cash: 1500, decoration: null })
]);

export function staffType(code) {
    return STAFF_TYPES.find(s => s.code === code) || null;
}
export function upgradeNode(code) {
    return UPGRADE_NODES.find(n => n.code === code) || null;
}
