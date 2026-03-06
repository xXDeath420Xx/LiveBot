/**
 * Random Number Generation
 * Seeded RNG and Gaussian distribution for game mechanics
 */

/**
 * Mulberry32 PRNG - fast, seedable, good distribution
 * @param {number} seed - Initial seed
 * @returns {function} RNG function returning 0-1
 */
export function createSeededRNG(seed) {
    let a = seed >>> 0;

    return function() {
        a |= 0;
        a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

/**
 * Generate Gaussian (normal) distributed random number
 * Using Box-Muller transform
 * @param {number} mean - Mean of distribution
 * @param {number} stdDev - Standard deviation
 * @param {function} rng - Random number generator (0-1)
 * @returns {number} Normally distributed random number
 */
export function gaussian(mean, stdDev, rng = Math.random) {
    let u1 = rng();
    let u2 = rng();

    // Avoid log(0)
    while (u1 === 0) u1 = rng();

    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    return z0 * stdDev + mean;
}

/**
 * Clamp a value between min and max
 * @param {number} value - Value to clamp
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number} Clamped value
 */
export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

/**
 * Generate a random integer in range [min, max] inclusive
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @param {function} rng - Random number generator
 * @returns {number} Random integer
 */
export function randomInt(min, max, rng = Math.random) {
    return Math.floor(rng() * (max - min + 1)) + min;
}

/**
 * Generate a random float in range [min, max]
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @param {function} rng - Random number generator
 * @returns {number} Random float
 */
export function randomFloat(min, max, rng = Math.random) {
    return rng() * (max - min) + min;
}

/**
 * Roll a percentage chance
 * @param {number} percent - Chance (0-100)
 * @param {function} rng - Random number generator
 * @returns {boolean} Whether the roll succeeded
 */
export function rollChance(percent, rng = Math.random) {
    return rng() * 100 < percent;
}

/**
 * Pick a random element from an array
 * @param {Array} array - Array to pick from
 * @param {function} rng - Random number generator
 * @returns {*} Random element
 */
export function pickRandom(array, rng = Math.random) {
    if (!array || array.length === 0) return null;
    return array[Math.floor(rng() * array.length)];
}

/**
 * Shuffle an array (Fisher-Yates)
 * @param {Array} array - Array to shuffle (mutates in place)
 * @param {function} rng - Random number generator
 * @returns {Array} Shuffled array
 */
export function shuffle(array, rng = Math.random) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

/**
 * Generate variance on a base value
 * @param {number} base - Base value
 * @param {number} variancePercent - Variance as decimal (0.1 = +/-10%)
 * @param {function} rng - Random number generator
 * @returns {number} Value with variance applied
 */
export function applyVariance(base, variancePercent, rng = Math.random) {
    const variance = base * variancePercent;
    return base + randomFloat(-variance, variance, rng);
}

/**
 * Weighted random selection
 * @param {Array<{item: *, weight: number}>} items - Items with weights
 * @param {function} rng - Random number generator
 * @returns {*} Selected item
 */
export function weightedRandom(items, rng = Math.random) {
    const totalWeight = items.reduce((sum, i) => sum + i.weight, 0);
    let random = rng() * totalWeight;

    for (const { item, weight } of items) {
        random -= weight;
        if (random <= 0) {
            return item;
        }
    }

    // Fallback (shouldn't happen)
    return items[items.length - 1].item;
}

export default {
    createSeededRNG,
    gaussian,
    clamp,
    randomInt,
    randomFloat,
    rollChance,
    pickRandom,
    shuffle,
    applyVariance,
    weightedRandom
};
