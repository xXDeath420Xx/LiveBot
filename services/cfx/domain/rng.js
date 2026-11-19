// Greenhouse Tycoon (cfx v2): seeded random numbers. Pure; the same seed always gives the same sequence,
// so a harvest or a hybrid can be recomputed and tested exactly.

/** 32-bit FNV-1a style string hash (xmur3 finaliser) -> unsigned 32-bit seed. */
export function hashSeed(...parts) {
    const s = parts.map(p => String(p)).join('|');
    let h = 1779033703 ^ s.length;
    for (let i = 0; i < s.length; i++) {
        h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
}

/** mulberry32 generator. */
export function createRng(seed) {
    let a = (typeof seed === 'number' ? seed : hashSeed(seed)) >>> 0;
    const next = () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
        next,
        /** Integer in [min, max], inclusive. */
        int(min, max) {
            if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) throw new RangeError('rng.int needs integers min <= max');
            return min + Math.floor(next() * (max - min + 1));
        },
        chance(probability) {
            return next() < probability;
        }
    };
}
