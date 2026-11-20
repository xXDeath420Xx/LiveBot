/*
 * Pure weapon rules: generation (crates and forging), display helpers, shard values.
 */
import {
    RANKS, WEAR, WEAPON_TYPES, PERKS, TRACKER_CHANCE, rankById, rankByKey, wearById, weaponTypeById, perkById,
} from '../data/weapons.js';
import { weightedPick, pickOne, randInt } from './rng.js';

/**
 * Make a weapon. A uniform type, a weighted rank (or the given rankId when forging), a weighted wear grade, a
 * uniform quality in the type's range, perkSlots distinct perks each with a quality in the perk's range, and a
 * small chance of a takedown tracker.
 */
export function generateWeapon(rng, { rankId = null, typeId = null } = {}) {
    const type = (typeId && weaponTypeById(typeId)) || pickOne(rng, WEAPON_TYPES);
    const rank = (rankId && rankById(rankId)) || weightedPick(rng, RANKS);
    const wear = weightedPick(rng, WEAR);
    const quality = randInt(rng, type.quality[0], type.quality[1]);
    const pool = [...PERKS];
    const perks = [];
    for (let slot = 0; slot < type.perkSlots && pool.length > 0; slot++) {
        const i = Math.floor(rng() * pool.length);
        const perk = pool.splice(i, 1)[0];
        perks.push({ slot, perkId: perk.id, quality: randInt(rng, perk.quality[0], perk.quality[1]) });
    }
    const tracked = rng() < TRACKER_CHANCE;
    return { typeId: type.id, rankId: rank.id, wear: wear.id, quality, perks, tracked };
}

/** Clamp a quality into a type's range (used when migrating and when an admin edits). */
export function clampQuality(typeId, quality) {
    const type = weaponTypeById(typeId);
    const q = Math.round(Number(quality) || 0);
    if (!type) return Math.max(0, Math.min(100, q));
    return Math.max(type.quality[0], Math.min(type.quality[1], q));
}

/** "🔨 Epic Boulder Maul" */
export function weaponLabel(w) {
    const type = weaponTypeById(w.typeId);
    const rank = rankById(w.rankId);
    return `${type?.emoji || ''} ${rank?.name || '?'} ${type?.name || 'Unknown gear'}`.trim();
}

/** A display-ready description of a stored or generated weapon. */
export function describeWeapon(w) {
    const type = weaponTypeById(w.typeId);
    const rank = rankById(w.rankId);
    const wear = wearById(w.wear);
    return {
        uwid: w.uwid ?? 0,
        label: weaponLabel(w),
        type: type ? { id: type.id, key: type.key, name: type.name, emoji: type.emoji, magic: type.magic, effect: type.effect, description: type.description, quality: type.quality } : null,
        rank: rank ? { id: rank.id, key: rank.key, name: rank.name } : null,
        wear: { id: wear.id, key: wear.key, name: wear.name },
        quality: Number(w.quality) || 0,
        perks: (w.perks || []).map(p => {
            const perk = perkById(p.perkId);
            return { slot: p.slot, id: p.perkId, key: perk?.key, name: perk?.name || 'Unknown perk', description: perk?.description || '', quality: Number(p.quality) || 0, range: perk?.quality || null };
        }),
        tracked: w.kills != null || !!w.tracked,
        kills: w.kills == null ? null : Number(w.kills),
        favorite: !!w.favorite,
        petPid: w.petPid ?? null,
    };
}

export function dismantleShards(rankId) {
    return rankById(rankId)?.shards || 0;
}

export function forgeCost(rankKey) {
    const r = rankByKey(rankKey);
    return r ? r.forge : null;
}

/** Forge price table for display. */
export const FORGE_PRICES = Object.freeze(RANKS.map(r => Object.freeze({ rankId: r.id, key: r.key, name: r.name, cost: r.forge, dismantle: r.shards })));
