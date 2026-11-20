/*
 * Pure rules for the guild boss, the lottery, pray/curse and two-member pair keys.
 */
import { BOSS } from '../data/economy.js';
import { BOSS_TIERS } from '../data/tiers.js';
import { speciesInTier } from '../data/species.js';
import { randInt, pickOne } from './rng.js';

/* ----------------------------------------------------------------------------------------------- pairs */

/** Order two snowflakes numerically (as big integers, never as strings). */
export function orderPair(a, b) {
    const A = BigInt(String(a));
    const B = BigInt(String(b));
    return A <= B ? [String(a), String(b)] : [String(b), String(a)];
}

/* ----------------------------------------------------------------------------------------------- boss */

/**
 * Pick the boss species: walk the boss tiers from legendary down, skipping each with 55% probability; if every
 * tier is skipped, the lowest tier with species is used.
 */
export function pickBossSpecies(rng) {
    const tiers = [...BOSS_TIERS].reverse();
    for (const t of tiers) {
        const list = speciesInTier(t);
        if (list.length && rng() >= BOSS.tierSkipChance) return pickOne(rng, list);
    }
    for (const t of BOSS_TIERS) {
        const list = speciesInTier(t);
        if (list.length) return pickOne(rng, list);
    }
    return null;
}

/** Level 1..100, weighted toward low levels (a uniform roll squared). */
export function rollBossLevel(rng) {
    const u = rng();
    return Math.max(1, Math.min(BOSS.maxLevel, 1 + Math.floor(u * u * BOSS.maxLevel)));
}

export function bossStats(level) {
    return { maxHp: BOSS.hpPerLevel * level + BOSS.hpBase, attack: BOSS.atkPerLevel * level + BOSS.atkBase };
}

/**
 * Simulate one member's strike on the boss: 4 rounds; each round every team critter deals
 * max(1, atk + rand(0..atk/2) - floor(bossAtk/4)); then the boss hits the pooled team HP for
 * max(1, bossAtk + rand(0..bossAtk) - floor(bossAtk/3)). Team HP reaching 0 = wiped.
 * team: [{ atk, maxHp }] (battle stats). Returns { damage (>=1), wiped, teamHpLeft, teamHp }.
 */
export function simulateBossStrike(team, bossAttack, rng) {
    let teamHp = team.reduce((s, c) => s + c.maxHp, 0);
    const start = teamHp;
    let damage = 0;
    let wiped = false;
    for (let round = 0; round < BOSS.rounds; round++) {
        for (const c of team) damage += Math.max(1, c.atk + randInt(rng, 0, Math.floor(c.atk / 2)) - Math.floor(bossAttack / 4));
        teamHp -= Math.max(1, bossAttack + randInt(rng, 0, bossAttack) - Math.floor(bossAttack / 3));
        if (teamHp <= 0) { teamHp = 0; wiped = true; break; }
    }
    return { damage: Math.max(1, damage), wiped, teamHpLeft: teamHp, teamHp: start };
}

/**
 * Payouts when a boss falls. pool = 500*level + 2000. Each fighter gets round(pool * share); the top dealer gets
 * +15% of the pool; everyone gets at least 50.
 * board: [{ userId, damage }]. Returns [{ userId, damage, payout, top }].
 */
export function bossPayouts(level, board) {
    const pool = BOSS.poolPerLevel * level + BOSS.poolBase;
    const total = board.reduce((s, r) => s + Math.max(0, Number(r.damage) || 0), 0);
    let top = null;
    for (const r of board) if (!top || Number(r.damage) > Number(top.damage)) top = r;
    return board.map(r => {
        const share = total > 0 ? Math.max(0, Number(r.damage) || 0) / total : 0;
        let payout = Math.round(pool * share);
        const isTop = r === top;
        if (isTop) payout += Math.round(pool * BOSS.topBonus);
        return { userId: r.userId, damage: Number(r.damage) || 0, payout: Math.max(BOSS.minPayout, payout), top: isTop };
    });
}

export function hpBar(hp, maxHp, cells = BOSS.hpBarCells) {
    const ratio = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
    const full = Math.round(ratio * cells);
    return '█'.repeat(full) + '░'.repeat(cells - full);
}

/* ----------------------------------------------------------------------------------------------- lottery */

/** How much of a request fits: min(requested, room under the cap, balance). */
export function lotteryEntryAmount({ requested, all = false, balance, current, cap }) {
    const room = Math.max(0, cap - Math.max(0, current));
    const want = all ? balance : Math.max(0, Math.floor(Number(requested) || 0));
    const add = Math.max(0, Math.min(want, room, balance));
    return { add, trimmed: add < want, room };
}

/** Weighted winner: each acorn entered is one ticket. entries: [{ userId, amount }]. */
export function pickLotteryWinner(entries, rng) {
    const total = entries.reduce((s, e) => s + Math.max(0, Number(e.amount) || 0), 0);
    if (total <= 0) return null;
    let r = Math.floor(rng() * total);
    for (const e of entries) {
        const a = Math.max(0, Number(e.amount) || 0);
        if (r < a) return e;
        r -= a;
    }
    return entries[entries.length - 1];
}

/** Win chance in percent, truncated to 2 decimals. */
export function winChancePct(mine, pot) {
    if (!pot || pot <= 0) return 0;
    return Math.floor((mine / pot) * 10000) / 100;
}

/* ----------------------------------------------------------------------------------------------- pray / curse */

/**
 * Luck-point changes. Targeting yourself counts as no target.
 * pray self +1; pray X: you -1, X +1; curse self -1; curse X: you +1, X -1.
 */
export function prayDeltas(kind, userId, targetId) {
    const other = targetId && String(targetId) !== String(userId) ? String(targetId) : null;
    if (kind === 'pray') return other ? { self: -1, target: +1, targetId: other } : { self: +1, target: 0, targetId: null };
    if (kind === 'curse') return other ? { self: +1, target: -1, targetId: other } : { self: -1, target: 0, targetId: null };
    throw new Error(`unknown kind ${kind}`);
}
