// Greenhouse Tycoon (cfx v2): NPC buyers' demand per variety per day. Pure and deterministic: the same
// variety on the same UTC day always has the same demand, on every server and in the simulator.
//
// demand = 100 + amp * sin(2 pi * day / period + phase) + noise, where amp (10..20 points), period
// (7..13 days) and phase are fixed per variety and noise (-3..3) is fixed per variety and day. So prices
// really move (the old game's were stuck at 0 %), drift in slow waves the player can learn, and never jump:
// the largest possible day-to-day change is amp * 2 pi / period + 1 (rounding) + 6 (noise) <= 25 points,
// and the value always stays inside 60..140 (economy.js DEMAND_MIN_PCT..DEMAND_MAX_PCT).
import { createRng, hashSeed } from './rng.js';
import { DEMAND_MIN_PCT, DEMAND_MAX_PCT } from './economy.js';
import { DAY_MS } from '../config/game.js';

export const MAX_DAILY_SWING = 25;

/** Days since the epoch (UTC) for a timestamp in ms. */
export function dayIndex(ms) {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError('ms must be a non-negative integer');
    return Math.floor(ms / DAY_MS);
}

/** 'YYYY-MM-DD' for a day index. */
export function dayString(day) {
    if (!Number.isSafeInteger(day) || day < 0) throw new RangeError('day must be a non-negative integer');
    return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

const paramCache = new Map();

function params(varietyId) {
    let p = paramCache.get(varietyId);
    if (!p) {
        const rng = createRng(hashSeed('market-wave', varietyId));
        p = { amp: rng.int(10, 20), period: rng.int(7, 13), phaseDeg: rng.int(0, 359) };
        if (paramCache.size < 10_000) paramCache.set(varietyId, p);
    }
    return p;
}

/** Demand in percent (60..140) for a variety on a day index. */
export function demandPct(varietyId, day) {
    if (!Number.isSafeInteger(varietyId) || varietyId < 1) throw new RangeError('varietyId must be a positive integer');
    if (!Number.isSafeInteger(day) || day < 0) throw new RangeError('day must be a non-negative integer');
    const { amp, period, phaseDeg } = params(varietyId);
    const angle = (2 * Math.PI * (day % period)) / period + (phaseDeg * Math.PI) / 180;
    const wave = Math.round(100 + amp * Math.sin(angle));
    const noise = createRng(hashSeed('market-noise', varietyId, day)).int(-3, 3);
    return Math.min(DEMAND_MAX_PCT, Math.max(DEMAND_MIN_PCT, wave + noise));
}

/** Change from the previous day in whole percent of the previous price, e.g. +7 or -12. */
export function demandChangePct(varietyId, day) {
    if (day < 1) return 0;
    const today = demandPct(varietyId, day);
    const before = demandPct(varietyId, day - 1);
    return Math.round(((today - before) * 100) / before);
}
