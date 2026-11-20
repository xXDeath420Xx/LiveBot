/*
 * Critters species roster (original data, 2026-11-19). 40 species over 7 tiers:
 * common 8, uncommon 8, rare 7, epic 6, mythical 5, legendary 4, fabled 2.
 *
 * stats: [hp, atk, pr, wp, mag, mr] = hit points, attack, physical resistance, willpower, magic attack,
 * magic resistance. The live battle maths (rules/battle-engine.js) uses hp, atk, pr, mr, and wp when the
 * critter holds a magic weapon.
 *
 * key is the stable id stored in the database. Members can type the key, `:key:`, the display name, or an
 * alias (spaces and dashes count as underscores).
 */

const S = (key, emoji, name, tier, stats, description, aliases = []) => Object.freeze({
    key, emoji, name, tier,
    stats: Object.freeze({ hp: stats[0], atk: stats[1], pr: stats[2], wp: stats[3], mag: stats[4], mr: stats[5] }),
    description, aliases: Object.freeze(aliases),
});

export const SPECIES = Object.freeze([
    // common
    S('worm', '\u{1FAB1}', 'Garden Worm', 'common', [2, 1, 1, 1, 1, 1], 'Turns the soil over and never complains about the weather.', ['earthworm']),
    S('ant', '\u{1F41C}', 'Ant', 'common', [1, 2, 1, 1, 1, 1], 'Carries crumbs bigger than its own ambitions.'),
    S('snail', '\u{1F40C}', 'Snail', 'common', [3, 1, 2, 1, 1, 1], 'Arrives late to every fight, but always arrives.'),
    S('ladybug', '\u{1F41E}', 'Ladybug', 'common', [1, 1, 2, 1, 2, 1], 'Seven spots, each one a tiny promise of good luck.', ['ladybird']),
    S('cricket', '\u{1F997}', 'Cricket', 'common', [1, 2, 1, 2, 1, 1], 'Sings all night and naps through the day.'),
    S('chick', '\u{1F424}', 'Chick', 'common', [2, 2, 1, 1, 1, 1], 'Small, loud, and convinced it is a hawk.'),
    S('hamster', '\u{1F439}', 'Hamster', 'common', [2, 1, 1, 1, 1, 2], 'Cheeks packed for a winter that never comes.'),
    S('frog', '\u{1F438}', 'Pond Frog', 'common', [2, 1, 1, 1, 2, 1], 'Croaks the same joke at every sunset.', ['toad']),
    // uncommon
    S('hedgehog', '\u{1F994}', 'Hedgehog', 'uncommon', [3, 2, 4, 1, 1, 2], 'A pincushion with opinions.'),
    S('duck', '\u{1F986}', 'Mallard', 'uncommon', [3, 3, 2, 2, 1, 2], 'Calm on the surface, paddling furiously below.', ['mallard']),
    S('rabbit', '\u{1F407}', 'Meadow Rabbit', 'uncommon', [3, 3, 1, 2, 2, 2], 'Already gone before you finish saying "look".', ['bunny', 'hare']),
    S('squirrel', '\u{1F43F}\u{FE0F}', 'Red Squirrel', 'uncommon', [2, 3, 2, 2, 2, 2], 'Hides acorns, forgets acorns, plants forests.'),
    S('bat', '\u{1F987}', 'Fruit Bat', 'uncommon', [2, 3, 1, 3, 3, 1], 'Hangs around upside down and sees things differently.'),
    S('crab', '\u{1F980}', 'Shore Crab', 'uncommon', [3, 3, 4, 1, 1, 1], 'Walks sideways out of every argument.'),
    S('turtle', '\u{1F422}', 'Box Turtle', 'uncommon', [4, 2, 4, 1, 1, 3], 'Carries its house and never pays rent.', ['tortoise']),
    S('raccoon', '\u{1F99D}', 'Raccoon', 'uncommon', [3, 4, 2, 2, 2, 1], 'A masked bandit with excellent table manners.'),
    // rare
    S('fox', '\u{1F98A}', 'Ember Fox', 'rare', [4, 5, 2, 3, 3, 2], 'Its tail leaves a warm glow in the snow.'),
    S('owl', '\u{1F989}', 'Barn Owl', 'rare', [3, 3, 2, 5, 5, 3], 'Asks one question and waits all night for the answer.'),
    S('beaver', '\u{1F9AB}', 'Beaver', 'rare', [5, 4, 4, 2, 1, 2], 'Builds a dam out of spite and a little bit of joy.'),
    S('otter', '\u{1F9A6}', 'River Otter', 'rare', [4, 4, 3, 3, 3, 3], 'Holds hands while sleeping so nobody drifts off.'),
    S('badger', '\u{1F9A1}', 'Honey Badger', 'rare', [5, 5, 4, 2, 1, 2], 'Does not care, never has, never will.'),
    S('flamingo', '\u{1F9A9}', 'Flamingo', 'rare', [4, 3, 2, 4, 4, 3], 'Balances on one leg and one very strong opinion.'),
    S('seal', '\u{1F9AD}', 'Harbour Seal', 'rare', [5, 3, 3, 3, 3, 4], 'Claps for you even when you do nothing at all.'),
    // epic
    S('wolf', '\u{1F43A}', 'Timber Wolf', 'epic', [6, 7, 4, 3, 2, 3], 'Howls at the moon and the moon, honestly, howls back.'),
    S('deer', '\u{1F98C}', 'Silver Stag', 'epic', [6, 5, 4, 4, 4, 4], 'Its antlers catch the first light of every morning.', ['stag']),
    S('peacock', '\u{1F99A}', 'Peacock', 'epic', [5, 4, 3, 6, 6, 5], 'A hundred eyes on its tail, all of them judging.'),
    S('kangaroo', '\u{1F998}', 'Boxing Kangaroo', 'epic', [6, 7, 4, 3, 2, 3], 'Gloves on, pocket full of snacks.'),
    S('octopus', '\u{1F419}', 'Reef Octopus', 'epic', [5, 5, 3, 6, 6, 5], 'Eight arms, three hearts, zero patience for crabs.'),
    S('sloth', '\u{1F9A5}', 'Sloth', 'epic', [8, 4, 6, 3, 3, 5], 'Wins every staring contest by falling asleep.'),
    // mythical
    S('bison', '\u{1F9AC}', 'Thunder Bison', 'mythical', [9, 8, 7, 3, 2, 5], 'The ground hums for a mile when it runs.'),
    S('gorilla', '\u{1F98D}', 'Silverback', 'mythical', [8, 9, 6, 4, 3, 4], 'Gentle, wise, and a very firm hugger.', ['silverback']),
    S('shark', '\u{1F988}', 'Tide Shark', 'mythical', [7, 9, 5, 4, 4, 4], 'Never stops swimming, never stops grinning.'),
    S('eagle', '\u{1F985}', 'Storm Eagle', 'mythical', [6, 8, 4, 6, 6, 6], 'Rides the leading edge of every thunderhead.'),
    S('mammoth', '\u{1F9A3}', 'Woolly Mammoth', 'mythical', [10, 7, 8, 3, 2, 6], 'Remembers the ice age and still finds it a bit chilly.'),
    // legendary
    S('lion', '\u{1F981}', 'Sunmane Lion', 'legendary', [9, 10, 7, 6, 5, 6], 'Its roar is how the savanna knows it is noon.'),
    S('dragon', '\u{1F409}', 'Jade Dragon', 'legendary', [9, 8, 7, 9, 10, 8], 'Sleeps on a hoard of very old, very polished acorns.'),
    S('unicorn', '\u{1F984}', 'Moonlit Unicorn', 'legendary', [8, 6, 6, 10, 10, 9], 'Only seen by those who stopped looking.'),
    S('trex', '\u{1F996}', 'Tyrant Lizard', 'legendary', [10, 10, 8, 4, 3, 6], 'Tiny arms, enormous presence.', ['t_rex', 'tyrannosaurus']),
    // fabled
    S('kraken', '\u{1F991}', 'Deepwater Kraken', 'fabled', [12, 11, 9, 10, 10, 9], 'Sailors swear the sea gets quieter when it listens.'),
    S('sauropod', '\u{1F995}', 'Elder Sauropod', 'fabled', [14, 9, 11, 8, 8, 10], 'Its footsteps are the slow heartbeat of the old world.', ['brachiosaurus']),
]);

const BY_KEY = new Map(SPECIES.map(s => [s.key, s]));
const BY_TIER = new Map();
for (const s of SPECIES) {
    if (!BY_TIER.has(s.tier)) BY_TIER.set(s.tier, []);
    BY_TIER.get(s.tier).push(s);
}

export function speciesByKey(key) {
    return BY_KEY.get(String(key || '').toLowerCase()) || null;
}

export function speciesInTier(tierKey) {
    return BY_TIER.get(String(tierKey || '').toLowerCase()) || [];
}

const norm = (v) => String(v || '').trim().toLowerCase().replace(/^:+|:+$/g, '').replace(/[\s-]+/g, '_');
const LOOKUP = new Map();
for (const s of SPECIES) {
    for (const k of [s.key, s.name, ...s.aliases]) LOOKUP.set(norm(k), s);
}

/** Resolve what a member typed (`:fox:`, `fox`, `Ember Fox`, an alias) to a species, or null. */
export function resolveSpecies(query) {
    const q = norm(query);
    if (!q) return null;
    return LOOKUP.get(q) || null;
}

export const CATALOG_SIZE = SPECIES.length;
