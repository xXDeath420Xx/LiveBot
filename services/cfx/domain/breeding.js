// Greenhouse Tycoon (cfx v2): cross-breeding two varieties. Pure and deterministic: the same pair of
// parents always gives the same hybrid (seeded by the pair), so a hybrid is a fixed thing players
// discover, stored once in gh_varieties with UNIQUE (parent_a, parent_b).
import { createRng, hashSeed } from './rng.js';
import { hybridName } from '../config/copy.js';
import { GROWTH } from '../config/game.js';

export const MAX_RARITY = 3;

/** Normalised pair key: the lower id first. */
export function parentPair(idA, idB) {
    if (!Number.isSafeInteger(idA) || !Number.isSafeInteger(idB) || idA < 1 || idB < 1) throw new RangeError('parent ids must be positive integers');
    if (idA === idB) throw new RangeError('a variety cannot be crossed with itself');
    return idA < idB ? [idA, idB] : [idB, idA];
}

/**
 * The hybrid of two varieties ({id, name, rarity, growMs, baseYield, basePrice}).
 *   growMs     average of the parents, +-10 %
 *   baseYield  the better parent's, +0 or +1
 *   basePrice  average of the parents, +5..20 %
 *   rarity     the rarer parent's, +1 when both parents share a rarity (max 3)
 */
export function crossVarieties(a, b) {
    const [lowId] = parentPair(a.id, b.id);
    const [first, second] = lowId === a.id ? [a, b] : [b, a];
    const rng = createRng(hashSeed('hybrid', first.id, second.id));
    const avgGrow = Math.round((first.growMs + second.growMs) / 2);
    const growMs = Math.max(GROWTH.MIN_GROW_MS, Math.round((avgGrow * rng.int(90, 110)) / 100));
    const baseYield = Math.max(first.baseYield, second.baseYield) + rng.int(0, 1);
    const avgPrice = Math.round((first.basePrice + second.basePrice) / 2);
    const basePrice = Math.max(1, Math.round((avgPrice * rng.int(105, 120)) / 100));
    const rarity = Math.min(MAX_RARITY, Math.max(first.rarity, second.rarity) + (first.rarity === second.rarity ? 1 : 0));
    return {
        parentA: first.id,
        parentB: second.id,
        name: hybridName(first.name, second.name),
        rarity,
        growMs,
        baseYield,
        basePrice
    };
}
