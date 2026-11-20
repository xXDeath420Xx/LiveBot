/*
 * Critters economy curves (original data, 2026-11-19, except where marked CertiFried house rule).
 * Pure functions only: safe to import in tests.
 */

/** Daily claim: base + step per extra streak day, step capped at maxSteps days. */
export const DAILY = Object.freeze({ base: 500, step: 75, maxSteps: 30 });

export function dailyPayout(streak) {
    const s = Math.max(1, Math.floor(Number(streak) || 1));
    const bonus = Math.min(s - 1, DAILY.maxSteps) * DAILY.step;
    return { base: DAILY.base, bonus, total: DAILY.base + bonus };
}

/** Daily give caps from the member's server level. Level 0 still allows modest gifts. */
export const GIVE_CAPS = Object.freeze({ sendBase: 5000, sendPerLevel: 1500, sendPerTenLevels: 25000, receiveBase: 1.5, receivePerTenLevels: 0.5 });

export function sendCap(level) {
    const l = Math.max(0, Math.floor(Number(level) || 0));
    return GIVE_CAPS.sendBase + GIVE_CAPS.sendPerLevel * l + GIVE_CAPS.sendPerTenLevels * Math.floor(l / 10);
}

export function receiveCap(level) {
    const l = Math.max(0, Math.floor(Number(level) || 0));
    return Math.floor(sendCap(l) * (GIVE_CAPS.receiveBase + GIVE_CAPS.receivePerTenLevels * Math.floor(l / 10)));
}

/** Nightly lottery: per-member cap per round, the house top-up added to the pot, and the minimum entrants. */
export const LOTTERY = Object.freeze({ capPerRound: 250000, houseTopUp: 5000, minEntrants: 2 });

/** CertiFried house rule: the daily luck roll prize table (weights out of 100). */
export const LUCK_PRIZES = Object.freeze([
    { key: 'acorns_100', kind: 'currency', amount: 100, weight: 40 },
    { key: 'acorns_500', kind: 'currency', amount: 500, weight: 25 },
    { key: 'acorns_1000', kind: 'currency', amount: 1000, weight: 15 },
    { key: 'acorns_5000', kind: 'currency', amount: 5000, weight: 8 },
    { key: 'acorns_25000', kind: 'currency', amount: 25000, weight: 3 },
    { key: 'crate_1', kind: 'crate', amount: 1, weight: 6 },
    { key: 'crate_3', kind: 'crate', amount: 3, weight: 2 },
    { key: 'jackpot', kind: 'currency', amount: 100000, weight: 1 },
]);

/** Rings: all functionally the same; price is the only difference. Sold back at RING_SELL_FRACTION. */
export const RINGS = Object.freeze([
    { id: 1, key: 'twine', name: 'Twine Loop', emoji: '\u{1FAA2}', price: 1500 },
    { id: 2, key: 'copper', name: 'Copper Band', emoji: '\u{1F7E4}', price: 5000 },
    { id: 3, key: 'silver', name: 'Silver Band', emoji: '\u{26AA}', price: 15000 },
    { id: 4, key: 'pearl', name: 'Pearl Ring', emoji: '\u{1F90D}', price: 40000 },
    { id: 5, key: 'opal', name: 'Opal Ring', emoji: '\u{1F308}', price: 100000 },
    { id: 6, key: 'sapphire', name: 'Sapphire Ring', emoji: '\u{1F499}', price: 250000 },
    { id: 7, key: 'starlight', name: 'Starlight Ring', emoji: '\u{1F31F}', price: 750000 },
]);
export const RING_SELL_FRACTION = 0.6;
export const ringById = (id) => RINGS.find(r => r.id === Number(id)) || null;
export const ringSellPrice = (ring) => Math.floor(ring.price * RING_SELL_FRACTION);

/** Daily couple bonus: random base in [min, max] plus perStreakDay x combined daily streaks, capped. */
export const COUPLE_BONUS = Object.freeze({ min: 300, max: 700, perStreakDay: 25, streakBonusCap: 1500 });

export function coupleBonusAmount(streakA, streakB, rng = Math.random) {
    const base = COUPLE_BONUS.min + Math.floor(rng() * (COUPLE_BONUS.max - COUPLE_BONUS.min + 1));
    const streak = Math.max(0, Number(streakA) || 0) + Math.max(0, Number(streakB) || 0);
    return base + Math.min(COUPLE_BONUS.streakBonusCap, streak * COUPLE_BONUS.perStreakDay);
}

/** Cooldowns (ms). */
export const PRAY_COOLDOWN_MS = 5 * 60 * 1000;
export const FLOOR_COOLDOWN_MS = 10 * 1000;
export const POINTS_COOLDOWN_MS = 8 * 1000;

/** Winner's battle reward, uniform in [min, max]. */
export const BATTLE_REWARD = Object.freeze({ min: 40, max: 120 });

/** Pet levels: level = 1 + floor(sqrt(xp / 60)), capped at 100. */
export const PET_LEVEL = Object.freeze({ divisor: 60, max: 100 });

export function petLevel(xp) {
    const x = Math.max(0, Number(xp) || 0);
    return Math.min(PET_LEVEL.max, 1 + Math.floor(Math.sqrt(x / PET_LEVEL.divisor)));
}

/** Total XP needed to reach a level. */
export function xpForLevel(level) {
    const l = Math.max(1, Math.min(PET_LEVEL.max, Math.floor(Number(level) || 1)));
    return PET_LEVEL.divisor * (l - 1) * (l - 1);
}

/** Essence: sacrificing duplicates pays essence; feeding essence to a critter gives it pet XP. */
export const ESSENCE_FEED_XP = 2;

/** CertiFried house rule: ranch pays per hour per team critter by tier (see data/tiers.js `ranch`). */

/** CertiFried house rules for the guild boss. */
export const BOSS = Object.freeze({
    spawnChance: 0.015,
    tierSkipChance: 0.55,
    maxLevel: 100,
    hpPerLevel: 1500,
    hpBase: 4000,
    atkPerLevel: 18,
    atkBase: 40,
    lifetimeMs: 60 * 60 * 1000,
    rounds: 4,
    hitCooldownMs: 45 * 1000,
    poolPerLevel: 500,
    poolBase: 2000,
    topBonus: 0.15,
    minPayout: 50,
    hpBarCells: 16,
});
