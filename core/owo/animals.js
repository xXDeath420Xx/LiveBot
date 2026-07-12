/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 *
 * Rarity framework adapted from OwO Bot's public animal.json rank metadata:
 *   https://github.com/ChristopherBThai/Discord-OwO-Bot/blob/master/src/data/animal.json
 *
 * Animal roster is entirely original to CertiFried — Unicode emoji only so
 * no custom-emoji dependencies and no risk of breaking when the bot isn't in
 * the emoji host guild.
 */

export const RANKS = {
    common:    { rarity: 58.85,  points: 1,     xp: 1,    emoji: '🥉', color: 0x9E9E9E },
    uncommon:  { rarity: 30.00,  points: 5,     xp: 10,   emoji: '🥈', color: 0x4CAF50 },
    rare:      { rarity: 10.00,  points: 20,    xp: 20,   emoji: '🥇', color: 0x2196F3 },
    epic:      { rarity: 1.00,   points: 250,   xp: 400,  emoji: '💎', color: 0x9C27B0 },
    mythical:  { rarity: 0.10,   points: 3000,  xp: 1000, emoji: '🌟', color: 0xFF9800 },
    legendary: { rarity: 0.05,   points: 10000, xp: 2000, emoji: '👑', color: 0xF44336 },
};

// Rarity percentages above sum to exactly 100.00 — keeps the roll math simple.

export const ANIMALS = {
    common: [
        { key: 'bug',        emoji: '🐛',  name: 'Bug' },
        { key: 'ladybug',    emoji: '🐞',  name: 'Ladybug' },
        { key: 'ant',        emoji: '🐜',  name: 'Ant' },
        { key: 'fly',        emoji: '🪰',  name: 'Fly' },
        { key: 'snail',      emoji: '🐌',  name: 'Snail' },
        { key: 'shell',      emoji: '🐚',  name: 'Shell' },
        { key: 'worm',       emoji: '🪱',  name: 'Worm' },
        { key: 'mosquito',   emoji: '🦟',  name: 'Mosquito' },
        { key: 'cricket',    emoji: '🦗',  name: 'Cricket' },
        { key: 'beetle',     emoji: '🪲',  name: 'Beetle' },
        { key: 'spider',     emoji: '🕷️',  name: 'Spider' },
        { key: 'cockroach',  emoji: '🪳',  name: 'Cockroach' },
    ],
    uncommon: [
        { key: 'mouse',      emoji: '🐭',  name: 'Mouse' },
        { key: 'rabbit',     emoji: '🐰',  name: 'Rabbit' },
        { key: 'chick',      emoji: '🐥',  name: 'Chick' },
        { key: 'frog',       emoji: '🐸',  name: 'Frog' },
        { key: 'turtle',     emoji: '🐢',  name: 'Turtle' },
        { key: 'lizard',     emoji: '🦎',  name: 'Lizard' },
        { key: 'snake',      emoji: '🐍',  name: 'Snake' },
        { key: 'squirrel',   emoji: '🐿️',  name: 'Squirrel' },
        { key: 'hedgehog',   emoji: '🦔',  name: 'Hedgehog' },
        { key: 'rat',        emoji: '🐀',  name: 'Rat' },
        { key: 'hamster',    emoji: '🐹',  name: 'Hamster' },
        { key: 'duck',       emoji: '🦆',  name: 'Duck' },
    ],
    rare: [
        { key: 'cat',        emoji: '🐱',  name: 'Cat' },
        { key: 'dog',        emoji: '🐶',  name: 'Dog' },
        { key: 'fox',        emoji: '🦊',  name: 'Fox' },
        { key: 'wolf',       emoji: '🐺',  name: 'Wolf' },
        { key: 'raccoon',    emoji: '🦝',  name: 'Raccoon' },
        { key: 'bear',       emoji: '🐻',  name: 'Bear' },
        { key: 'panda',      emoji: '🐼',  name: 'Panda' },
        { key: 'badger',     emoji: '🦡',  name: 'Badger' },
        { key: 'kangaroo',   emoji: '🦘',  name: 'Kangaroo' },
        { key: 'llama',      emoji: '🦙',  name: 'Llama' },
        { key: 'otter',      emoji: '🦦',  name: 'Otter' },
        { key: 'beaver',     emoji: '🦫',  name: 'Beaver' },
    ],
    epic: [
        { key: 'lion',       emoji: '🦁',  name: 'Lion' },
        { key: 'tiger',      emoji: '🐯',  name: 'Tiger' },
        { key: 'horse',      emoji: '🐴',  name: 'Horse' },
        { key: 'deer',       emoji: '🦌',  name: 'Deer' },
        { key: 'elephant',   emoji: '🐘',  name: 'Elephant' },
        { key: 'rhino',      emoji: '🦏',  name: 'Rhino' },
        { key: 'hippo',      emoji: '🦛',  name: 'Hippo' },
        { key: 'bison',      emoji: '🦬',  name: 'Bison' },
        { key: 'buffalo',    emoji: '🐃',  name: 'Water Buffalo' },
        { key: 'camel',      emoji: '🐫',  name: 'Camel' },
        { key: 'zebra',      emoji: '🦓',  name: 'Zebra' },
        { key: 'giraffe',    emoji: '🦒',  name: 'Giraffe' },
    ],
    mythical: [
        { key: 'eagle',      emoji: '🦅',  name: 'Eagle' },
        { key: 'owl',        emoji: '🦉',  name: 'Owl' },
        { key: 'peacock',    emoji: '🦚',  name: 'Peacock' },
        { key: 'swan',       emoji: '🦢',  name: 'Swan' },
        { key: 'flamingo',   emoji: '🦩',  name: 'Flamingo' },
        { key: 'octopus',    emoji: '🐙',  name: 'Octopus' },
        { key: 'whale',      emoji: '🐋',  name: 'Whale' },
        { key: 'shark',      emoji: '🦈',  name: 'Shark' },
        { key: 'crocodile',  emoji: '🐊',  name: 'Crocodile' },
        { key: 'seal',       emoji: '🦭',  name: 'Seal' },
    ],
    legendary: [
        { key: 'dragon',     emoji: '🐉',  name: 'Dragon' },
        { key: 't-rex',      emoji: '🦖',  name: 'T-Rex' },
        { key: 'sauropod',   emoji: '🦕',  name: 'Sauropod' },
        { key: 'unicorn',    emoji: '🦄',  name: 'Unicorn' },
        { key: 'mammoth',    emoji: '🦣',  name: 'Mammoth' },
        { key: 'phoenix',    emoji: '🔥',  name: 'Phoenix' },
    ],
};

/**
 * Roll a random rank weighted by rarity percentages.
 * @returns {string} One of the RANKS keys.
 */
export function rollRank() {
    const total = Object.values(RANKS).reduce((s, r) => s + r.rarity, 0);
    const roll = Math.random() * total;
    let cum = 0;
    for (const [rank, meta] of Object.entries(RANKS)) {
        cum += meta.rarity;
        if (roll < cum) return rank;
    }
    return 'common';
}

/**
 * Pick a random animal from the given rank.
 */
export function pickAnimal(rank) {
    const pool = ANIMALS[rank] || ANIMALS.common;
    return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Roll a complete hunt result: rank + animal + reward.
 */
export function hunt() {
    const rank = rollRank();
    const animal = pickAnimal(rank);
    const meta = RANKS[rank];
    return {
        rank,
        animal,       // { key, emoji, name }
        points: meta.points,
        xp: meta.xp,
        emoji: meta.emoji,
        color: meta.color,
    };
}

export function getAnimalByKey(key) {
    for (const [rank, pool] of Object.entries(ANIMALS)) {
        const match = pool.find(a => a.key === key);
        if (match) return { ...match, rank };
    }
    return null;
}
