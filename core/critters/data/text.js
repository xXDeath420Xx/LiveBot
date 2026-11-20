/*
 * Critters flavour text (original wording, 2026-11-19). Surfaces pick lines with pick(list, rng).
 */

export const pick = (list, rng = Math.random) => list[Math.floor(rng() * list.length)];

export const PRAY_SELF = Object.freeze([
    'You close your eyes and ask the forest for a little luck.',
    'You leave an acorn on a mossy stone and make a wish.',
    'A breeze rustles the leaves. That probably means yes.',
]);

export const PRAY_OTHER = Object.freeze([
    '{you} whispers a kind word for {them} to the old oak.',
    '{you} plants a wish for {them} under the full moon.',
    '{you} hands a four-leaf clover to {them}.',
]);

export const CURSE_SELF = Object.freeze([
    'You step on every crack on purpose. Bold.',
    'You open an umbrella indoors and stare at the ceiling.',
    'You whistle at a black cat. It does not whistle back.',
]);

export const CURSE_OTHER = Object.freeze([
    '{you} ties {them}\'s bootlaces together in their sleep.',
    '{you} hides a pinecone in {them}\'s pillow.',
    '{you} tells the crows where {them} keeps their snacks.',
]);

export const COMPLIMENTS = Object.freeze([
    'Still the best team on the forest floor.',
    'Two acorns, one oak tree.',
    'They share their snacks without being asked.',
    'Nobody has ever seen them argue about the last berry.',
    'They finish each other\'s hunts.',
]);

export const CPU_TEAM_NAMES = Object.freeze([
    'Hedgerow Ambush', 'Ambush at the Old Stump', 'Thicket Ambush', 'Ambush by the Creek', 'Ambush in the Bracken',
]);

export const BOT_MARRIAGE_REFUSAL = 'That is very sweet, but I am already married to my job.';
