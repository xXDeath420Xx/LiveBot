// Greenhouse Tycoon (cfx v2): season score. Pure. Points are capped per day, so staff running all day
// cannot outscore a person who plays: the old game ranked by raw XP, which automation always won.
import { SEASON_SCORE } from '../config/game.js';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** UTC day key for a timestamp in ms. */
export function dayKey(ms) {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError('ms must be a non-negative integer');
    return new Date(ms).toISOString().slice(0, 10);
}

/** Points for one action ('harvest', 'sale', 'order', 'quest', 'new_variety') times a count. */
export function pointsFor(action, count = 1) {
    const per = SEASON_SCORE.POINTS[action];
    if (per === undefined) throw new RangeError(`unknown season action ${action}`);
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('count must be a non-negative integer');
    return per * count;
}

/**
 * Add points to a standing, respecting the daily cap.
 *   standing  { score, scoreDay, scoreToday }  (scoreDay null for a new standing)
 * Returns the new standing plus `added` (what actually counted).
 */
export function addPoints(standing, points, day, cap = SEASON_SCORE.DAILY_CAP) {
    if (!DAY_PATTERN.test(day)) throw new RangeError('day must be YYYY-MM-DD');
    if (!Number.isSafeInteger(points) || points < 0) throw new RangeError('points must be a non-negative integer');
    const score = standing?.score ?? 0;
    const sameDay = standing?.scoreDay === day;
    const today = sameDay ? standing.scoreToday : 0;
    const added = Math.max(0, Math.min(points, cap - today));
    return { score: score + added, scoreDay: day, scoreToday: today + added, added };
}

/**
 * Final ranking: score descending, ties share a rank (1, 2, 2, 4), and accounts with no score are left out.
 * Ties are listed by account id so the order is stable. Input rows are not modified.
 */
export function rankStandings(rows) {
    const scored = rows
        .map(r => ({ ...r, score: Number(r.score) || 0 }))
        .filter(r => r.score > 0)
        .sort((a, b) => b.score - a.score || Number(a.account_id) - Number(b.account_id));
    let lastScore = null;
    let lastRank = 0;
    return scored.map((r, i) => {
        const rank = r.score === lastScore ? lastRank : i + 1;
        lastScore = r.score;
        lastRank = rank;
        return { ...r, final_rank: rank };
    });
}

/** A weekly challenge only runs when enough players were active (owner decision: minimum-active rule). */
export function challengeShouldRun({ activePlayers, minActivePlayers }) {
    if (!Number.isSafeInteger(activePlayers) || !Number.isSafeInteger(minActivePlayers)) throw new RangeError('counts must be integers');
    return minActivePlayers > 0 && activePlayers >= minActivePlayers;
}
