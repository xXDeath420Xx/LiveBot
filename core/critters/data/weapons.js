/*
 * Critters gear (original data, 2026-11-19): 18 weapon types, 10 perks, a 7-step rank ladder and 4 wear grades.
 *
 * Ranks: Common..Fabled. `bonus` is the CertiFried live battle rank bonus; weight is the crate roll weight out
 * of 1000; shards = shards from dismantling; forge = shards to forge a weapon of that rank.
 * Wear: id 4 (best) .. 1. `mult` is the CertiFried live wear multiplier; weight out of 100.
 * Weapon types: quality is rolled uniformly in [min, max]; perkSlots perks are rolled (distinct); magic types
 * add the holder's willpower to defence. `effect` names an on-attack effect run by rules/battle-engine.js.
 * Perks add floor(quality / 2) attack (the live rule); each has its own quality range.
 */

export const RANKS = Object.freeze([
    { id: 1, key: 'common', name: 'Common', bonus: 2, weight: 400, shards: 3, forge: 12 },
    { id: 2, key: 'uncommon', name: 'Uncommon', bonus: 5, weight: 270, shards: 8, forge: 30 },
    { id: 3, key: 'rare', name: 'Rare', bonus: 10, weight: 170, shards: 20, forge: 80 },
    { id: 4, key: 'epic', name: 'Epic', bonus: 20, weight: 90, shards: 50, forge: 200 },
    { id: 5, key: 'mythical', name: 'Mythical', bonus: 40, weight: 45, shards: 130, forge: 520 },
    { id: 6, key: 'legendary', name: 'Legendary', bonus: 80, weight: 18, shards: 350, forge: 1400 },
    { id: 7, key: 'fabled', name: 'Fabled', bonus: 160, weight: 7, shards: 1000, forge: 4000 },
]);

export const WEAR = Object.freeze([
    { id: 4, key: 'gleaming', name: 'Gleaming', mult: 1.25, weight: 3 },
    { id: 3, key: 'sturdy', name: 'Sturdy', mult: 1.15, weight: 9 },
    { id: 2, key: 'scuffed', name: 'Scuffed', mult: 1.05, weight: 18 },
    { id: 1, key: 'battered', name: 'Battered', mult: 1.0, weight: 70 },
]);

/** Chance a freshly made weapon carries a takedown tracker. */
export const TRACKER_CHANCE = 0.06;

const W = (id, key, name, emoji, opts) => Object.freeze({
    id, key, name, emoji,
    magic: !!opts.magic,
    effect: opts.effect || 'none',
    quality: Object.freeze(opts.quality || [10, 100]),
    perkSlots: opts.perkSlots ?? 1,
    statBoost: opts.statBoost || 0,
    description: opts.description,
});

export const WEAPON_TYPES = Object.freeze([
    W(1, 'thornflail', 'Thornflail', '\u{1F335}', { effect: 'splash', description: 'A spiked vine on a stick. Every swing nicks a second enemy.' }),
    W(2, 'dewdrop_wand', 'Dewdrop Wand', '\u{1FA84}', { magic: true, effect: 'mend', description: 'Each strike sends a few drops of healing to the most hurt teammate.' }),
    W(3, 'boulder_maul', 'Boulder Maul', '\u{1F528}', { quality: [20, 100], effect: 'crit', description: 'Slow and heavy. Now and then it lands a crushing blow.' }),
    W(4, 'acorn_charm', 'Acorn Charm', '\u{1F330}', { quality: [30, 100], perkSlots: 0, statBoost: 0.15, description: 'No tricks, no perks: the holder is simply a little stronger and tougher.' }),
    W(5, 'bark_shield', 'Bark Shield', '\u{1F6E1}\u{FE0F}', { effect: 'taunt', description: 'Draws enemy attention and softens the blows that land.' }),
    W(6, 'twin_feathers', 'Twin Feathers', '\u{1FAB6}', { perkSlots: 2, description: 'No special move, but room for two perks.' }),
    W(7, 'moss_siphon', 'Moss Siphon', '\u{1F9EA}', { magic: true, effect: 'drain', description: 'Draws life out of enemies and shares it with the whole team.' }),
    W(8, 'nettle_spear', 'Nettle Spear', '\u{1F531}', { effect: 'bleed', description: 'Leaves a sting that keeps hurting for a couple of rounds.' }),
    W(9, 'ember_staff', 'Ember Staff', '\u{1F525}', { magic: true, effect: 'burn', description: 'Sets embers that pile up the longer the fight goes on.' }),
    W(10, 'storm_bell', 'Storm Bell', '\u{1F514}', { magic: true, effect: 'chime', description: 'Its ring rattles every enemy a little.' }),
    W(11, 'blossom_totem', 'Blossom Totem', '\u{1F338}', { magic: true, effect: 'bloom', description: 'Petals mend the whole team after each strike.' }),
    W(12, 'moonwell_flask', 'Moonwell Flask', '\u{1F3FA}', { magic: true, effect: 'focus', description: 'A sip of moonwater sharpens a teammate\'s next strike.' }),
    W(13, 'second_wind_horn', 'Second Wind Horn', '\u{1F4EF}', { effect: 'revive', description: 'Once per battle, calls a fallen teammate back to its feet.' }),
    W(14, 'frost_fang', 'Frost Fang', '\u{2744}\u{FE0F}', { effect: 'stun', description: 'A cold bite that can freeze an enemy in place for a turn.' }),
    W(15, 'pack_banner', 'Pack Banner', '\u{1F6A9}', { effect: 'rally', description: 'Every swing rallies the team to hit a little harder.' }),
    W(16, 'leech_lance', 'Leech Lance', '\u{1F5E1}\u{FE0F}', { effect: 'leech', description: 'Heals its holder for part of the damage it deals.' }),
    W(17, 'sapping_vine', 'Sapping Vine', '\u{1F33F}', { magic: true, effect: 'weaken', description: 'Wraps an enemy and saps the strength from its attacks.' }),
    W(18, 'dice_sling', 'Dice Sling', '\u{1F3B2}', { quality: [5, 100], effect: 'flurry', description: 'Throws one to three dice. Nobody knows how many until they land.' }),
]);

const P = (id, key, name, quality, description) => Object.freeze({ id, key, name, quality: Object.freeze(quality), description });

export const PERKS = Object.freeze([
    P(1, 'keen_edge', 'Keen Edge', [4, 24], 'A finely kept edge.'),
    P(2, 'heavy_grip', 'Heavy Grip', [6, 22], 'Wrapped handle, solid swing.'),
    P(3, 'bright_spark', 'Bright Spark', [2, 26], 'Crackles when it connects.'),
    P(4, 'steady_paws', 'Steady Paws', [6, 20], 'Never fumbles, never rushes.'),
    P(5, 'thick_hide', 'Thick Hide', [4, 22], 'Tough enough to swing without fear.'),
    P(6, 'quick_step', 'Quick Step', [4, 24], 'Gets the first hit in.'),
    P(7, 'hunters_mark', 'Hunter\'s Mark', [8, 20], 'Marks a target and keeps after it.'),
    P(8, 'lucky_knot', 'Lucky Knot', [0, 30], 'Sometimes great, sometimes not.'),
    P(9, 'old_scars', 'Old Scars', [6, 22], 'Has seen worse and won.'),
    P(10, 'wild_heart', 'Wild Heart', [4, 26], 'Fights with everything it has.'),
]);

const RANK_BY_ID = new Map(RANKS.map(r => [r.id, r]));
const RANK_BY_KEY = new Map(RANKS.map(r => [r.key, r]));
const WEAR_BY_ID = new Map(WEAR.map(w => [w.id, w]));
const TYPE_BY_ID = new Map(WEAPON_TYPES.map(t => [t.id, t]));
const PERK_BY_ID = new Map(PERKS.map(p => [p.id, p]));

export const rankById = (id) => RANK_BY_ID.get(Number(id)) || null;
export const rankByKey = (key) => RANK_BY_KEY.get(String(key || '').toLowerCase()) || null;
export const wearById = (id) => WEAR_BY_ID.get(Number(id)) || WEAR_BY_ID.get(1);
export const weaponTypeById = (id) => TYPE_BY_ID.get(Number(id)) || null;
export const perkById = (id) => PERK_BY_ID.get(Number(id)) || null;

/** Weapon crates: chance a battle drops one (the first battle after local midnight always does), and the cap. */
export const CRATE_DROP = Object.freeze({ chance: 0.05, maxPerDay: 3 });
