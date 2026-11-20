/*
 * Pure game rules: hunting, gems, lootboxes, daily drops, daily streaks, autohunt, ranch, luck roll.
 * No DB, no Discord: the services in core/critters/*.js call these inside their transactions.
 */
import { TIERS, tierByKey, tierIndex } from '../data/tiers.js';
import { speciesInTier } from '../data/species.js';
import { GEM_TYPES, gemById, gemsOfType } from '../data/gems.js';
import { LUCK_PRIZES } from '../data/economy.js';
import {
    DAILY_COOLDOWN_MS, DAILY_STREAK_GRACE_MS, AUTOHUNT_INTERVAL_MS, AUTOHUNT_MAX_QUEUED, RANCH_TICK_MS, RANCH_MAX_HOURS,
    GEM_USE_MAX_IDS,
} from '../constants.js';
import { weightedPick, pickOne } from './rng.js';
import { isBeforeToday } from './time.js';

/* ----------------------------------------------------------------------------------------------- hunting */

/** activeGems: [{ gemId, usesLeft }] with usesLeft > 0. Returns the gem objects by effect. */
export function activeByEffect(activeGems) {
    const out = {};
    for (const a of activeGems || []) {
        const gem = gemById(a.gemId);
        if (gem && a.usesLeft > 0) out[gem.effect] = { gem, usesLeft: a.usesLeft };
    }
    return out;
}

/** Critters per hunt: 1, plus a hunting gem's amount, then doubled by an empowering gem. */
export function huntCount(activeGems) {
    const g = activeByEffect(activeGems);
    let n = 1;
    if (g.hunting) n += g.hunting.gem.amount;
    if (g.empowering) n *= 2;
    return n;
}

export function luckTierOf(activeGems) {
    const g = activeByEffect(activeGems);
    return g.lucky ? g.lucky.gem.amount : 0;
}

/**
 * Tier weights after luck. A lucky gem of tier t multiplies every non-lowest tier's weight by (1 + 0.5t) and
 * divides the lowest tier's weight by the same factor (CertiFried rule).
 */
export function tierWeights(luckTier = 0) {
    const factor = 1 + 0.5 * Math.max(0, Number(luckTier) || 0);
    return TIERS.map((t, i) => ({ tier: t, weight: i === 0 ? t.weight / factor : t.weight * factor }));
}

export function rollTier(rng, luckTier = 0) {
    return weightedPick(rng, tierWeights(luckTier)).tier;
}

/** Roll n catches. Every tier has species, so there is no placeholder fallback. */
export function rollCatches(n, luckTier, rng) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const tier = rollTier(rng, luckTier);
        out.push(pickOne(rng, speciesInTier(tier.key)));
    }
    return out;
}

/** Acorns for a hunt: sum over catches of max(1, floor(points x multiplier)). */
export function huntCurrency(catches, multiplier = 1) {
    let sum = 0;
    for (const s of catches) sum += Math.max(1, Math.floor(tierByKey(s.tier).points * multiplier));
    return sum;
}

/** Pet XP each team critter gets from a hunt: floor(sum of tier xp x reward_xp_multiplier). */
export function huntXp(catches, xpMultiplier = 1) {
    let sum = 0;
    for (const s of catches) sum += tierByKey(s.tier).xp;
    return Math.max(0, Math.floor(sum * xpMultiplier));
}

/** Group catches: [{ species, count }] sorted common first, rarest last. */
export function groupCatches(catches) {
    const map = new Map();
    for (const s of catches) {
        const e = map.get(s.key) || { species: s, count: 0 };
        e.count += 1;
        map.set(s.key, e);
    }
    return [...map.values()].sort((a, b) => tierIndex(a.species.tier) - tierIndex(b.species.tier) || a.species.key.localeCompare(b.species.key));
}

/**
 * Gem uses burned by a hunt that caught n critters: hunting 1; empowering floor(n/2); lucky n, or floor(n/2)
 * when hunting and empowering are both active. Never below 0.
 * @returns [{ gemId, before, after }]
 */
export function burnGems(activeGems, n) {
    const g = activeByEffect(activeGems);
    const out = [];
    const both = !!(g.hunting && g.empowering);
    const burn = (entry, amount) => {
        if (!entry) return;
        out.push({ gemId: entry.gem.id, before: entry.usesLeft, after: Math.max(0, entry.usesLeft - Math.max(0, amount)) });
    };
    burn(g.hunting, 1);
    burn(g.empowering, Math.floor(n / 2));
    burn(g.lucky, both ? Math.floor(n / 2) : n);
    return out;
}

export class GemInputError extends Error {
    constructor(code, message, data = {}) { super(message); this.code = code; this.data = data; }
}

/** Parse "11 21, 31" (or an array) into distinct valid gem ids, at most 4, at most one per type. */
export function parseGemIds(input) {
    const tokens = Array.isArray(input) ? input.map(String) : String(input || '').split(/[\s,]+/);
    const ids = [];
    for (const t of tokens) {
        const s = t.trim();
        if (!s) continue;
        if (!/^\d+$/.test(s)) throw new GemInputError('UNKNOWN_GEM', `"${s}" is not a gem id.`, { id: s });
        const n = Number(s);
        if (!ids.includes(n)) ids.push(n);
    }
    if (ids.length === 0) throw new GemInputError('NO_IDS', 'Give at least one gem id.');
    if (ids.length > GEM_USE_MAX_IDS) throw new GemInputError('TOO_MANY', `You can switch on at most ${GEM_USE_MAX_IDS} gems at once.`);
    const types = new Set();
    for (const id of ids) {
        const gem = gemById(id);
        if (!gem) throw new GemInputError('UNKNOWN_GEM', `There is no gem with id ${id}.`, { id });
        if (types.has(gem.type)) throw new GemInputError('DUPLICATE_TYPE', 'Only one gem of each kind can be switched on at a time.', { type: gem.type });
        types.add(gem.type);
    }
    return ids;
}

/** One lootbox: a uniform gem type, then a tier by weight. */
export function rollLootboxGem(rng) {
    const type = pickOne(rng, GEM_TYPES);
    return weightedPick(rng, gemsOfType(type.key));
}

/* ----------------------------------------------------------------------------------------------- daily drops */

/**
 * Daily drop decision (lootboxes from hunts, crates from battles). The window resets at local midnight; the first
 * eligible action after the reset always drops; later ones drop at `chance`, up to `max` a day.
 */
export function decideDailyDrop({ claims, windowAt, now = new Date(), chance, max, rng }) {
    const stale = isBeforeToday(windowAt, now);
    const used = stale ? 0 : Math.max(0, Number(claims) || 0);
    if (used >= max) return { drop: false, claimsAfter: used, windowAfter: stale ? now : windowAt, stale, max };
    const drop = used === 0 ? true : rng() < chance;
    return { drop, claimsAfter: drop ? used + 1 : used, windowAfter: stale ? now : windowAt, stale, max };
}

/* ----------------------------------------------------------------------------------------------- daily claim */

/**
 * Daily claim timing. 24 h rolling cooldown; the streak continues when the last claim was 48 h ago or less.
 * @returns {{ onCooldown: true, msLeft, readyAt } | { onCooldown: false, streak }}
 */
export function dailyState(lastAt, prevStreak, now = new Date()) {
    const last = lastAt ? new Date(lastAt).getTime() : null;
    if (last && now.getTime() - last < DAILY_COOLDOWN_MS) {
        const readyAt = new Date(last + DAILY_COOLDOWN_MS);
        return { onCooldown: true, msLeft: readyAt.getTime() - now.getTime(), readyAt };
    }
    const keep = last && now.getTime() - last <= DAILY_STREAK_GRACE_MS;
    return { onCooldown: false, streak: keep ? Math.max(0, Number(prevStreak) || 0) + 1 : 1 };
}

/* ----------------------------------------------------------------------------------------------- autohunt */

/** Queued autohunts since anchor: one per 30 min, at most 24. The new anchor carries the remainder. */
export function autohuntQueue(anchorAt, now = new Date()) {
    const anchor = new Date(anchorAt).getTime();
    const elapsed = Math.max(0, now.getTime() - anchor);
    const ticks = Math.floor(elapsed / AUTOHUNT_INTERVAL_MS);
    const queued = Math.min(AUTOHUNT_MAX_QUEUED, ticks);
    const nextInMs = queued >= AUTOHUNT_MAX_QUEUED ? 0 : AUTOHUNT_INTERVAL_MS - (elapsed % AUTOHUNT_INTERVAL_MS);
    // The anchor moves by exactly queued intervals, so any remainder (including time past the cap) carries over.
    const newAnchor = new Date(anchor + queued * AUTOHUNT_INTERVAL_MS);
    return { queued, nextInMs, newAnchor, capped: ticks >= AUTOHUNT_MAX_QUEUED };
}

/* ----------------------------------------------------------------------------------------------- ranch */

export function ranchRate(tierKeys) {
    let sum = 0;
    for (const k of tierKeys || []) sum += tierByKey(k)?.ranch || 0;
    return sum;
}

/** Whole hours accrued since lastAt, capped at 24. */
export function ranchHours(lastAt, now = new Date()) {
    const elapsed = Math.max(0, now.getTime() - new Date(lastAt).getTime());
    return { hours: Math.min(RANCH_MAX_HOURS, Math.floor(elapsed / RANCH_TICK_MS)), nextInMs: RANCH_TICK_MS - (elapsed % RANCH_TICK_MS) };
}

/* ----------------------------------------------------------------------------------------------- luck roll */

export function rollLuckPrize(rng) {
    return weightedPick(rng, LUCK_PRIZES);
}
