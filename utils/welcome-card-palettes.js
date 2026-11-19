/*
 * Welcome card palettes.
 *
 * One list, used in two places that must never disagree: the mock-ups an owner
 * picks from, and the card the bot actually draws when someone joins. When the
 * previews live in a render script and the real colours live in the renderer,
 * they drift, and the owner is told the card doesn't look like what they chose.
 *
 * `stops` are the three gradient stops left-to-right. `eyebrow`, `ink` and `body`
 * are the three text colours. `emoji` is [large background, small background,
 * tiny accent, beside-the-name] — a null tiny means only two emoji on that card.
 */

export const PALETTES = [
    // The first eight, offered as 1-8.
    { key: 'frosted',        name: 'Frosted',         stops: ['#E3F1FF', '#F0E4FB', '#FFE2EF'], eyebrow: '#5F79A8', ink: '#2F3A5C', body: '#59689A', emoji: ['❄️', '🪷', '🐦‍🔥', '❄️'] },
    { key: 'blossom',        name: 'Blossom',         stops: ['#FFD9E8', '#F6D8F2', '#E6DCFF'], eyebrow: '#A2637F', ink: '#4A2740', body: '#7C5570', emoji: ['🪷', '❄️', null,  '🪷'] },
    { key: 'ember',          name: 'Ember',           stops: ['#FFE8DC', '#FFD3D8', '#F3D7EF'], eyebrow: '#B05A6E', ink: '#4D2333', body: '#8A5162', emoji: ['🐦‍🔥', '🪷', '❄️', '🐦‍🔥'] },
    { key: 'seafoam',        name: 'Seafoam',         stops: ['#DCF5EC', '#E2F0FB', '#F4E6FB'], eyebrow: '#3F8A7A', ink: '#1F4A44', body: '#4B7E75', emoji: ['🪷', '❄️', '🐦‍🔥', '🪷'] },
    { key: 'twilight',       name: 'Twilight',        stops: ['#2B2340', '#453059', '#6B3B5E'], eyebrow: '#D9A7E8', ink: '#FBF1F8', body: '#CDB6DE', emoji: ['❄️', '🪷', '🐦‍🔥', '🐦‍🔥'], dark: true },
    { key: 'butter',         name: 'Butter',          stops: ['#FFF3D6', '#FFE4E0', '#FBDCF0'], eyebrow: '#A87A3C', ink: '#503512', body: '#8A6636', emoji: ['🪷', '🐦‍🔥', null,  '🪷'] },
    { key: 'periwinkle',     name: 'Periwinkle',      stops: ['#E6E3FF', '#DCEAFF', '#E6F6FF'], eyebrow: '#5D5BA8', ink: '#2C2A5C', body: '#5B5991', emoji: ['❄️', '🪷', null,  '❄️'] },
    { key: 'rosewood',       name: 'Rosewood',        stops: ['#F6DFE4', '#E9D2DE', '#D9CFE8'], eyebrow: '#8E4A63', ink: '#3D1F2E', body: '#74495C', emoji: ['🐦‍🔥', '❄️', '🪷', '🐦‍🔥'] },

    // Sampled straight out of the onboarding mock-up the owner pointed at: a
    // saturated pink -> lilac -> sky run, not the pale washes above. She looked at
    // sixteen pastels and said "not those colours", which is the difference.
    { key: 'utopia',         name: 'Utopia',          stops: ['#F5A7C5', '#CFA7E2', '#9BC1EF'], eyebrow: '#6B3F7E', ink: '#331A4A', body: '#53356B', emoji: ['🪷', '❄️', '🐦‍🔥', '🪷'] },
    { key: 'utopia-soft',    name: 'Utopia Soft',     stops: ['#FBD2E2', '#E8D3F2', '#CEE1FA'], eyebrow: '#8A5C9B', ink: '#402458', body: '#6B4A82', emoji: ['🪷', '🐦‍🔥', '❄️', '🪷'] },
    { key: 'utopia-deep',    name: 'Utopia Deep',     stops: ['#EE7FAE', '#B87FD8', '#6FA8EA'], eyebrow: '#FBE9F4', ink: '#FFFFFF', body: '#F2DDF0', emoji: ['❄️', '🪷', '🐦‍🔥', '❄️'], dark: true },
    { key: 'utopia-flipped', name: 'Utopia Flipped',  stops: ['#9BC1EF', '#CFA7E2', '#F5A7C5'], eyebrow: '#3F5D8A', ink: '#1E2E52', body: '#42568A', emoji: ['❄️', '🪷', '🐦‍🔥', '❄️'] },
    { key: 'utopia-warm',    name: 'Utopia Warm',     stops: ['#F7A2BE', '#F0A6D2', '#D3ABE9'], eyebrow: '#8E3D68', ink: '#45172F', body: '#6E3553', emoji: ['🐦‍🔥', '🪷', '❄️', '🐦‍🔥'] },
    { key: 'utopia-cool',    name: 'Utopia Cool',     stops: ['#D8AEE6', '#AFBCEE', '#8FCBF2'], eyebrow: '#3B5F86', ink: '#1C3050', body: '#3F5C82', emoji: ['❄️', '🪷', '🐦‍🔥', '❄️'] },

    // Crosses and variations of frosted / blossom / ember / seafoam, offered as A-H.
    { key: 'frosted-blossom', name: 'Frosted Blossom', stops: ['#DCEFFF', '#F4DCF4', '#FFD9E8'], eyebrow: '#7A6398', ink: '#37294F', body: '#6B5A88', emoji: ['🪷', '❄️', '🐦‍🔥', '🪷'] },
    { key: 'blossom-ember',   name: 'Blossom Ember',   stops: ['#FFDCEA', '#FFD6D6', '#FFE6D4'], eyebrow: '#B8596B', ink: '#4E2129', body: '#8B5059', emoji: ['🐦‍🔥', '🪷', '❄️', '🐦‍🔥'] },
    { key: 'seafoam-frost',   name: 'Seafoam Frost',   stops: ['#DCF6EE', '#DFEEFF', '#F6E2F2'], eyebrow: '#3E8398', ink: '#183F52', body: '#4A7488', emoji: ['❄️', '🪷', '🐦‍🔥', '❄️'] },
    { key: 'ember-seafoam',   name: 'Ember Seafoam',   stops: ['#FFE4D6', '#F4ECDF', '#DCF2EC'], eyebrow: '#9A6448', ink: '#3F2A1E', body: '#7A5B45', emoji: ['🪷', '🐦‍🔥', '❄️', '🪷'] },
    { key: 'deep-frost',      name: 'Deep Frost',      stops: ['#C9E4FF', '#DDD0F5', '#FFCFE2'], eyebrow: '#4A5F94', ink: '#222C52', body: '#4E5C8C', emoji: ['❄️', '🪷', '🐦‍🔥', '❄️'] },
    { key: 'pale-blossom',    name: 'Pale Blossom',    stops: ['#FFF0F6', '#FBEEFB', '#F2F0FF'], eyebrow: '#B57FA0', ink: '#523650', body: '#87698A', emoji: ['🪷', '❄️', null,  '🪷'] },
    { key: 'ember-frost',     name: 'Ember Frost',     stops: ['#FFE2D8', '#EEDFF5', '#D8ECFF'], eyebrow: '#96607F', ink: '#3E2740', body: '#74566F', emoji: ['🐦‍🔥', '❄️', '🪷', '🐦‍🔥'] },
    { key: 'seafoam-blossom', name: 'Seafoam Blossom', stops: ['#D8F4E6', '#EBE4FA', '#FFDCEC'], eyebrow: '#4E8A76', ink: '#1F4438', body: '#4C7A69', emoji: ['🪷', '🐦‍🔥', '❄️', '🪷'] },
];

export const PALETTE_BY_KEY = new Map(PALETTES.map((p) => [p.key, p]));

export function paletteOf(key) {
    return PALETTE_BY_KEY.get(String(key || '').toLowerCase()) || PALETTES[0];
}

/**
 * Draw the next design from a shuffled bag.
 *
 * A plain random pick repeats: with eight designs, roughly one join in eight
 * looks identical to the one before it, which is exactly what the rotation was
 * asked for to avoid. A bag deals every design once before reshuffling, and the
 * reshuffle refuses to put the just-used design first, so no two consecutive
 * joins ever match and the order changes each time round.
 *
 * @param {string[]} pool       Design keys the guild has enabled.
 * @param {string[]} remaining  What's left in the current bag.
 * @param {string|null} lastKey The design the previous member got.
 * @returns {{key: string, remaining: string[]}}
 */
export function drawFromBag(pool, remaining, lastKey) {
    const valid = (pool || []).filter((k) => PALETTE_BY_KEY.has(k));
    if (!valid.length) return { key: PALETTES[0].key, remaining: [] };
    if (valid.length === 1) return { key: valid[0], remaining: [] };

    // Drop anything the owner has since removed from the pool.
    let bag = (remaining || []).filter((k) => valid.includes(k));

    if (!bag.length) {
        bag = shuffle(valid);
        // Never open a fresh bag with the design that closed the last one.
        if (bag[0] === lastKey) bag.push(bag.shift());
    }

    return { key: bag[0], remaining: bag.slice(1) };
}

function shuffle(input) {
    const a = [...input];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
