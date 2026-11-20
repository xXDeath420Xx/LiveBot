/*
 * Random helpers. Every rule takes an `rng` (a function returning [0, 1)) so tests can seed it.
 */

/** Small fast seeded generator (mulberry32). */
export function seededRng(seed = 1) {
    let a = (Number(seed) >>> 0) || 1;
    return function rng() {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Integer in [min, max], both ends included. */
export function randInt(rng, min, max) {
    const lo = Math.ceil(Math.min(min, max));
    const hi = Math.floor(Math.max(min, max));
    return lo + Math.floor(rng() * (hi - lo + 1));
}

/** Pick an item by `weight` (or weightOf(item)). Returns null for an empty or all-zero list. */
export function weightedPick(rng, items, weightOf = (x) => x.weight) {
    let total = 0;
    for (const it of items) total += Math.max(0, Number(weightOf(it)) || 0);
    if (total <= 0) return null;
    let r = rng() * total;
    for (const it of items) {
        const w = Math.max(0, Number(weightOf(it)) || 0);
        if (r < w) return it;
        r -= w;
    }
    // Floating point leftovers: return the last item with weight.
    for (let i = items.length - 1; i >= 0; i--) if ((Number(weightOf(items[i])) || 0) > 0) return items[i];
    return null;
}

export function pickOne(rng, list) {
    if (!list || list.length === 0) return null;
    return list[Math.floor(rng() * list.length)];
}
