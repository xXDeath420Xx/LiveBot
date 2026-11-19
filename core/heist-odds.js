/*
 * Heist maths — dependency-free so it can be unit tested (tests/heist.test.js).
 *
 * A heist is a crew bet: every member puts a stake in escrow, the crew rolls once, and on success
 * every member gets stake x multiplier back; on failure every stake is lost. The odds are:
 *
 *   chance = base(target)
 *          + crew bonus     0.03 per member beyond the minimum crew (capped at 5 extra members)
 *          + level bonus    0.002 per average leveling level of the crew (capped at +0.05, level 25)
 *          - funding gap    up to -0.10 when the pot is below the target's recommended total
 *   with both bonuses scaled by the target's bonusFactor (1.0 easy, 0.6 medium, 0.36 hard,
 *   0.24 extreme) and the funding gap by max(bonusFactor, 0.5), clamped to [0.05, 0.85].
 *
 * bonusFactor is chosen so every target has the same ceiling: expected value (chance x multiplier)
 * is below 1 for a minimum crew (~0.88-0.96) and reaches ~1.19-1.20 for a full, well-funded,
 * level-25 crew. Crews are worth assembling; the per-member and per-guild cooldowns keep it from
 * being a money printer.
 */

export const MIN_CREW = 2;
export const DEFAULT_CREW = 6;
export const MAX_CREW = 10;
export const DEFAULT_WINDOW_MINUTES = 3;
export const MAX_WINDOW_MINUTES = 15;
/** After a heist resolves, the guild waits this long before another can start. */
export const GUILD_COOLDOWN_MINUTES = 10;
/** After a heist a member took part in resolves, they wait this long before joining/starting another. */
export const USER_COOLDOWN_MINUTES = 60;

export const TARGETS = Object.freeze({
    easy: Object.freeze({ key: 'easy', name: 'Corner Store', emoji: '🏪', base: 0.55, multiplier: 1.6, minStake: 50, recommendedTotal: 500, bonusFactor: 1.0 }),
    medium: Object.freeze({ key: 'medium', name: 'Armored Truck', emoji: '🚚', base: 0.42, multiplier: 2.2, minStake: 100, recommendedTotal: 1500, bonusFactor: 0.6 }),
    hard: Object.freeze({ key: 'hard', name: 'City Bank', emoji: '🏦', base: 0.30, multiplier: 3.2, minStake: 250, recommendedTotal: 4000, bonusFactor: 0.36 }),
    extreme: Object.freeze({ key: 'extreme', name: 'Federal Reserve', emoji: '🏛️', base: 0.17, multiplier: 5.5, minStake: 500, recommendedTotal: 10000, bonusFactor: 0.24 }),
});

export function getTarget(key) {
    return TARGETS[key] || null;
}

/** Largest stake one member may put in: 20x the target's minimum. */
export function maxStake(target) {
    return target.minStake * 20;
}

export function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
}

/**
 * Success chance for a crew.
 * @param {object} target       one of TARGETS
 * @param {number} crewSize     members with a stake in
 * @param {number} avgLevel     average leveling level of the crew (0 when unknown)
 * @param {number} totalStake   sum of stakes
 * @returns {number} probability in [0.05, 0.85]
 */
export function successChance(target, crewSize, avgLevel = 0, totalStake = 0) {
    const factor = Number(target.bonusFactor ?? 1);
    const extra = clamp(Math.floor(crewSize) - MIN_CREW, 0, 5);
    const crewBonus = 0.03 * extra * factor;
    const levelBonus = clamp((Number(avgLevel) || 0) * 0.002, 0, 0.05) * factor;
    const funded = target.recommendedTotal > 0 ? clamp((Number(totalStake) || 0) / target.recommendedTotal, 0, 1) : 1;
    const fundingPenalty = 0.10 * Math.max(factor, 0.5) * (1 - funded);
    const chance = target.base + crewBonus + levelBonus - fundingPenalty;
    return Math.round(clamp(chance, 0.05, 0.85) * 10000) / 10000;
}

/** What one member receives back on success (stake included). */
export function payoutFor(stake, multiplier) {
    return Math.floor(Number(stake) * Number(multiplier));
}

/**
 * Validate a stake for a target. Returns an error string, or null when it is fine.
 */
export function stakeError(target, stake) {
    if (!Number.isInteger(stake) || stake <= 0) return 'Your stake must be a whole number above 0.';
    if (stake < target.minStake) return `The minimum stake for the ${target.name} is ${target.minStake.toLocaleString()}.`;
    if (stake > maxStake(target)) return `The maximum stake for the ${target.name} is ${maxStake(target).toLocaleString()}.`;
    return null;
}

/**
 * Decide the outcome. `roll` is a number in [0, 1) (Math.random() in production); the heist
 * succeeds when roll < chance.
 */
export function decideOutcome(chance, roll) {
    return Number(roll) < Number(chance);
}

/** Minutes left on a cooldown that started at `since` (Date|string|null), or 0 when it is over. */
export function cooldownMinutesLeft(since, cooldownMinutes, now = Date.now()) {
    if (!since) return 0;
    const t = new Date(since).getTime();
    if (!Number.isFinite(t)) return 0;
    const leftMs = t + cooldownMinutes * 60_000 - now;
    return leftMs > 0 ? Math.ceil(leftMs / 60_000) : 0;
}

export default {
    MIN_CREW, DEFAULT_CREW, MAX_CREW, DEFAULT_WINDOW_MINUTES, MAX_WINDOW_MINUTES,
    GUILD_COOLDOWN_MINUTES, USER_COOLDOWN_MINUTES, TARGETS,
    getTarget, maxStake, clamp, successChance, payoutFor, stakeError, decideOutcome, cooldownMinutesLeft,
};
