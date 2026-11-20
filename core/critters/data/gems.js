/*
 * Critters gems (original data, 2026-11-19). Three types x seven tiers = 21 gems, all of which can come out
 * of a lootbox.
 *
 *   trail  (hunting)    each hunt catches `amount` extra critters.
 *   echo   (empowering) doubles the number of critters a hunt catches.
 *   clover (lucky)      tilts the tier roll toward rarer tiers; `amount` is the luck tier (1..7).
 *
 * Gem id = type.id * 10 + tier (tier 1..7), so trail 11..17, echo 21..27, clover 31..37. Members type these
 * ids with `use`. length = uses once activated. weight = roll weight inside its type when a lootbox opens.
 */

export const GEM_TYPES = Object.freeze([
    { id: 1, key: 'trail', name: 'Trail Gem', effect: 'hunting', icon: '\u{1F7E2}', description: 'Each hunt brings back extra critters.' },
    { id: 2, key: 'echo', name: 'Echo Gem', effect: 'empowering', icon: '\u{1F7E3}', description: 'Doubles how many critters a hunt brings back.' },
    { id: 3, key: 'clover', name: 'Clover Gem', effect: 'lucky', icon: '\u{1F7E1}', description: 'Makes rarer critters more likely to turn up.' },
]);

export const GEM_TIER_NAMES = Object.freeze(['Rough', 'Cut', 'Polished', 'Bright', 'Radiant', 'Royal', 'Starborn']);

const WEIGHTS = [500, 260, 140, 60, 28, 10, 2];
const LENGTHS = {
    trail: [25, 40, 60, 90, 130, 200, 300],
    echo: [15, 25, 40, 60, 90, 140, 220],
    clover: [30, 50, 80, 120, 180, 260, 400],
};
const AMOUNTS = {
    trail: [1, 1, 2, 2, 3, 4, 5],
    echo: [2, 2, 2, 2, 2, 2, 2],
    clover: [1, 2, 3, 4, 5, 6, 7],
};

export const GEMS = Object.freeze(GEM_TYPES.flatMap(type => GEM_TIER_NAMES.map((tierName, i) => Object.freeze({
    id: type.id * 10 + (i + 1),
    type: type.key,
    effect: type.effect,
    tier: i + 1,
    tierName,
    name: `${tierName} ${type.name}`,
    icon: type.icon,
    amount: AMOUNTS[type.key][i],
    length: LENGTHS[type.key][i],
    weight: WEIGHTS[i],
}))));

const BY_ID = new Map(GEMS.map(g => [g.id, g]));
export function gemById(id) {
    return BY_ID.get(Number(id)) || null;
}

export function gemsOfType(typeKey) {
    return GEMS.filter(g => g.type === typeKey);
}

export function gemTypeByKey(key) {
    return GEM_TYPES.find(t => t.key === key) || null;
}

/** Map a (type key, tier 1..7) to the gem. */
export function gemFor(typeKey, tier) {
    const t = gemTypeByKey(typeKey);
    if (!t || tier < 1 || tier > 7) return null;
    return BY_ID.get(t.id * 10 + tier) || null;
}

/** Lootboxes: chance a hunt drops one (the first hunt after local midnight always does), and the daily cap. */
export const LOOTBOX_DROP = Object.freeze({ chance: 0.04, maxPerDay: 3 });
