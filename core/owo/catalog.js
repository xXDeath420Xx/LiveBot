/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 *
 * DB-backed animal catalog loader. Sources the 20 seeded animals from
 * `owo_animals` and the 14 rank types from `owo_animals_rank`, merging with
 * the rank metadata (rarity %, prices, XP) from upstream's animal.json.
 *
 * Caches in-process with a configurable TTL so commands don't hammer the DB.
 * Call invalidateCatalog() after admin edits to the owo_animals table.
 */

import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { resolveEmoji } from './shortcode-emoji.js';

// Rank metadata is static — lives in upstream's animal.json but is small
// enough to bake in here. Rarity/price/points/essence/xp come directly from
// that file. `conditional` ranks (patreon, cpatreon, hidden, gem, bot,
// distorted, special, fabled) only appear with specific hunt conditions.
export const RANK_META = {
    patreon:   { rarity: 0.5,    order: 5,  price: 1000,  points: 500,   essence: 500,   xp: 400,  conditional: true },
    cpatreon:  { rarity: 0.01,   order: 12, price: 50000, points: 25000, essence: 25000, xp: 2000, conditional: true },
    common:    { rarity: 58.8489, order: 1, price: 1,     points: 1,     essence: 1,     xp: 1,
                 placeholder: [':bee:', ':bug:', ':snail:', ':beetle:', ':butterfly:'] },
    uncommon:  { rarity: 30,     order: 2,  price: 3,     points: 5,     essence: 5,     xp: 10,
                 placeholder: [':baby_chick:', ':mouse2:', ':rooster:', ':rabbit2:', ':chipmunk:'] },
    rare:      { rarity: 10,     order: 3,  price: 10,    points: 20,    essence: 20,    xp: 20,
                 placeholder: [':sheep:', ':pig2:', ':cow2:', ':dog2:', ':cat2:'] },
    epic:      { rarity: 1,      order: 4,  price: 250,   points: 250,   essence: 250,   xp: 400,
                 placeholder: [':crocodile:', ':tiger2:', ':penguin:', ':elephant:', ':whale:'] },
    mythical:  { rarity: 0.1,    order: 7,  price: 5000,  points: 3000,  essence: 3000,  xp: 1000,
                 placeholder: [':dragon:', ':unicorn:', ':snowman2:', ':ghost:', ':dove:'] },
    legendary: { rarity: 0.05,   order: 6,  price: 15000, points: 10000, essence: 10000, xp: 2000 },
    fabled:    { rarity: 0.01,   order: 8,  price: 100000, points: 100000, essence: 100000, xp: 5000, conditional: true },
    hidden:    { rarity: 0.005,  order: 9,  price: 500000, points: 500000, essence: 500000, xp: 10000, conditional: true },
    special:   { rarity: 0,      order: 10, price: 5000,   points: 500,   essence: 500,   xp: 1000, conditional: true },
    gem:       { rarity: 0.001,  order: 11, price: 20000,  points: 20000, essence: 20000, xp: 3000, conditional: true },
    bot:       { rarity: 0.001,  order: 13, price: 30000,  points: 30000, essence: 30000, xp: 4000, conditional: true },
    distorted: { rarity: 0.005,  order: 14, price: 200000, points: 200000, essence: 200000, xp: 8000, conditional: true },
};

// Rank display colors (embed tint) — our own choice.
export const RANK_COLORS = {
    common: 0x9E9E9E,
    uncommon: 0x4CAF50,
    rare: 0x2196F3,
    epic: 0x9C27B0,
    mythical: 0xFF9800,
    legendary: 0xF44336,
    fabled: 0xE91E63,
    hidden: 0x673AB7,
    special: 0x00BCD4,
    gem: 0x3F51B5,
    bot: 0x607D8B,
    distorted: 0x000000,
    patreon: 0xFFC107,
    cpatreon: 0xFF6F00,
};

const CACHE_TTL_MS = 60 * 1000;
let cache = null;
let cacheExpiresAt = 0;

async function loadFromDb() {
    const [animals] = await pool.execute('SELECT * FROM owo_animals');
    const [ranks] = await pool.execute('SELECT rank FROM owo_animals_rank');

    const byName = {};
    const byRank = {};
    for (const a of animals) {
        const entry = {
            name: a.name,
            emoji: resolveEmoji(a.name),
            rank: a.rank,
            // Battle stats — upstream's 6-stat system
            hp: Number(a.hp) || 0,
            att: Number(a.att) || 0,
            pr: Number(a.pr) || 0,    // physical resistance
            wp: Number(a.wp) || 0,    // willpower (magic)
            mag: Number(a.mag) || 0,  // magic attack
            mr: Number(a.mr) || 0,    // magic resistance
            description: a.description || '',
            aliases: (a.alt || '').split(',').map(s => s.trim()).filter(Boolean),
        };
        byName[a.name] = entry;
        if (!byRank[a.rank]) byRank[a.rank] = [];
        byRank[a.rank].push(entry);
    }

    const rankList = ranks.map(r => r.rank);
    return { byName, byRank, rankList, animals };
}

export async function getCatalog() {
    if (cache && cacheExpiresAt > Date.now()) return cache;
    try {
        cache = await loadFromDb();
        cacheExpiresAt = Date.now() + CACHE_TTL_MS;
        return cache;
    } catch (e) {
        logger.error('[OwO catalog] load failed', { err: e.message });
        if (cache) return cache; // serve stale if DB hiccup
        return { byName: {}, byRank: {}, rankList: [], animals: [] };
    }
}

export function invalidateCatalog() {
    cache = null;
    cacheExpiresAt = 0;
}

export async function getAnimal(name) {
    const cat = await getCatalog();
    return cat.byName[name] || null;
}

export async function getAnimalsByRank(rank) {
    const cat = await getCatalog();
    return cat.byRank[rank] || [];
}

export async function getAllRanks() {
    const cat = await getCatalog();
    return cat.rankList;
}

/**
 * Roll a random rank weighted by RANK_META.rarity. Conditional ranks are
 * excluded unless explicitly enabled via `opts` (e.g. { special: true }).
 */
export function rollRank(opts = {}) {
    const weights = {};
    for (const [rank, meta] of Object.entries(RANK_META)) {
        if (meta.conditional && !opts[rank]) continue;
        weights[rank] = meta.rarity;
    }

    // A Lucky gem (tier 1-7) tilts the roll toward the rare end: every rank above `common` gets
    // its weight scaled up, and `common` is squeezed by the same factor. Rank ORDER is preserved,
    // so a Fabled hunt is still vanishingly unlikely — it just stops being all bees.
    const lucky = Number(opts.lucky) || 0;
    if (lucky > 0) {
        const boost = 1 + lucky * 0.5;
        for (const rank of Object.keys(weights)) {
            if (rank === 'common') weights[rank] /= boost;
            else weights[rank] *= boost;
        }
    }

    const total = Object.values(weights).reduce((s, v) => s + v, 0);
    let roll = Math.random() * total;
    for (const [rank, w] of Object.entries(weights)) {
        roll -= w;
        if (roll <= 0) return rank;
    }
    return 'common';
}

/**
 * Pick a random animal from a rank. Falls back to rank placeholder list if
 * that rank has no seeded animals yet (e.g. legendary, mythical before the
 * catalog is filled out).
 */
export async function pickAnimalByRank(rank) {
    const list = await getAnimalsByRank(rank);
    if (list.length > 0) return list[Math.floor(Math.random() * list.length)];

    // Fall back to rank placeholder (upstream pattern). Synthesize a minimal
    // entry so hunt still succeeds even on ranks without seeded animals.
    const placeholders = RANK_META[rank]?.placeholder || [];
    if (placeholders.length > 0) {
        const name = placeholders[Math.floor(Math.random() * placeholders.length)];
        return {
            name,
            emoji: resolveEmoji(name),
            rank,
            hp: 0, att: 0, pr: 0, wp: 0, mag: 0, mr: 0,
            description: '',
            aliases: [],
            placeholder: true,
        };
    }
    return null;
}

/**
 * Single call: roll rank, pick animal, return full hunt result.
 */
export async function rollHunt(opts = {}) {
    const rank = rollRank(opts);
    const animal = await pickAnimalByRank(rank);
    const meta = RANK_META[rank];
    return {
        rank,
        animal,
        points: meta.points,
        xp: meta.xp,
        price: meta.price,
        essence: meta.essence,
        color: RANK_COLORS[rank] || 0x9E9E9E,
    };
}

export function listAllRanks() {
    return Object.keys(RANK_META).sort((a, b) => RANK_META[a].order - RANK_META[b].order);
}
