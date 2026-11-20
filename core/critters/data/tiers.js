/*
 * Critters rarity tiers (original data, 2026-11-19).
 *
 * Seven rollable tiers. There are no conditional or special tiers: every tier can be caught and every tier
 * has species. weight is the catch chance in percent (sums to 100). points = acorns per catch, sell = base
 * sell price (times the server's sell multiplier), essence = essence per sacrificed duplicate, xp = pet XP
 * per catch, ranch = acorns per hour while the critter is on the active team (CertiFried ranch rates).
 */

export const TIERS = Object.freeze([
    { key: 'common',    name: 'Common',    order: 1, weight: 62,   points: 2,     sell: 4,      essence: 1,     xp: 4,    ranch: 1,    color: 0x8d99a6, icon: '\u{1F343}' },
    { key: 'uncommon',  name: 'Uncommon',  order: 2, weight: 25,   points: 6,     sell: 12,     essence: 3,     xp: 10,   ranch: 3,    color: 0x4caf7d, icon: '\u{1F33F}' },
    { key: 'rare',      name: 'Rare',      order: 3, weight: 9,    points: 25,    sell: 50,     essence: 12,    xp: 30,   ranch: 10,   color: 0x3d8bd9, icon: '\u{1F48E}' },
    { key: 'epic',      name: 'Epic',      order: 4, weight: 3,    points: 120,   sell: 300,    essence: 60,    xp: 100,  ranch: 40,   color: 0x9b59d0, icon: '\u{1F52E}' },
    { key: 'mythical',  name: 'Mythical',  order: 5, weight: 0.8,  points: 900,   sell: 2500,   essence: 400,   xp: 400,  ranch: 300,  color: 0xe8833a, icon: '\u{1F30B}' },
    { key: 'legendary', name: 'Legendary', order: 6, weight: 0.18, points: 6000,  sell: 15000,  essence: 2500,  xp: 1500, ranch: 1000, color: 0xf2c94c, icon: '\u{1F451}' },
    { key: 'fabled',    name: 'Fabled',    order: 7, weight: 0.02, points: 40000, sell: 100000, essence: 15000, xp: 6000, ranch: 2500, color: 0xe0457b, icon: '\u{1F320}' },
]);

export const TIER_KEYS = Object.freeze(TIERS.map(t => t.key));
const BY_KEY = new Map(TIERS.map(t => [t.key, t]));

export function tierByKey(key) {
    return BY_KEY.get(String(key || '').toLowerCase()) || null;
}

/** 0-based position on the ladder (common = 0), or -1. */
export function tierIndex(key) {
    return TIER_KEYS.indexOf(String(key || '').toLowerCase());
}

/** Tiers whose catches go to the server's audit log when announce_rare_catches is on. */
export const AUDITABLE_TIERS = Object.freeze(['epic', 'mythical', 'legendary', 'fabled']);

/** Tiers a guild boss can be drawn from (CertiFried rule: rare up to legendary). */
export const BOSS_TIERS = Object.freeze(['rare', 'epic', 'mythical', 'legendary']);

/** The tiers the sell / sacrifice commands offer. All seven are accepted by the service. */
export const SELLABLE_TIERS = TIER_KEYS;
