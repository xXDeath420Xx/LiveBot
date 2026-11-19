// Greenhouse Tycoon (cfx v2): the meta game, pure (phase 4). Quests, achievements, season windows and
// rewards, weekly challenges and Replant. No I/O: store/meta.js and the simulator call these.
import { QUESTS, SEASON, REPLANT, DAY_MS, LIMITS, SEASON_SCORE } from '../config/game.js';
import { QUESTS_CATALOG, CHALLENGES_CATALOG, ACHIEVEMENTS, SEASON_TIERS, DECORATIONS } from '../config/catalog.js';
import { QUEST_TEXT } from '../config/copy.js';
import { createRng, hashSeed } from './rng.js';

function assertInt(name, value, min = 0, max = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer in [${min}, ${max}]`);
}

const iso = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);

// ------------------------------------------------------------------ periods

/** Monday-start week index for a day index (day 0, 1970-01-01, was a Thursday). */
export function weekOfDay(day) {
    assertInt('day', day);
    return Math.floor((day + 3) / 7);
}

/** ISO 8601 week key 'w2026-47' for a week index. */
export function weekKey(week) {
    assertInt('week', week);
    const thursday = week * 7; // Monday (week*7 - 3) + 3
    const d = new Date(thursday * DAY_MS);
    const year = d.getUTCFullYear();
    const jan1 = Math.floor(Date.UTC(year, 0, 1) / DAY_MS);
    const n = Math.floor((thursday - jan1) / 7) + 1;
    return `w${year}-${String(n).padStart(2, '0')}`;
}

/**
 * The quest periods at a moment: { dayIndex, weekIndex, daily: 'd2026-11-18', weekly: 'w2026-47',
 * dailyEndsAtMs, weeklyEndsAtMs }. Days and weeks are UTC; weeks start on Monday.
 */
export function periodsAt(ms) {
    assertInt('ms', ms);
    const day = Math.floor(ms / DAY_MS);
    const week = weekOfDay(day);
    return {
        dayIndex: day,
        weekIndex: week,
        daily: `d${iso(day)}`,
        weekly: weekKey(week),
        dailyEndsAtMs: (day + 1) * DAY_MS,
        weeklyEndsAtMs: (week * 7 - 3 + 7) * DAY_MS
    };
}

// ------------------------------------------------------------------ quests

/** Target of a quest template at a level. */
export function questTarget(def, level) {
    assertInt('level', level, 1, LIMITS.MAX_LEVEL);
    return Math.min(def.max, def.base + Math.floor((level * def.num) / def.den));
}

/** Reward of a quest made at a level: { cash, xp }. */
export function questReward(period, level) {
    assertInt('level', level, 1, LIMITS.MAX_LEVEL);
    const r = period === 'weekly' ? QUESTS.WEEKLY_REWARD : QUESTS.DAILY_REWARD;
    return { cash: r.cashBase + r.cashPerLevel * level, xp: r.xpBase + r.xpPerLevel * level };
}

/** Season points for claiming a quest of this period. */
export function questSeasonPoints(period) {
    const n = period === 'weekly' ? QUESTS.WEEKLY_SEASON_QUESTS : period === 'challenge' ? QUESTS.CHALLENGE_SEASON_QUESTS : 1;
    return SEASON_SCORE.POINTS.quest * n;
}

/** Display line for a quest or challenge: "Harvest 8 plants". */
export function questTitle(metric, target) {
    const fn = QUEST_TEXT[metric];
    return fn ? fn(target) : `${metric} ${target}`;
}

/**
 * The quests an account gets for one period (deterministic: the same account, period and level always give
 * the same list, so creating them twice changes nothing).
 *   period 'daily' | 'weekly'; index = day index or week index; level = the account's level now
 * Returns [{ code, period, metric, target, reward: { cash, xp } }], distinct metrics.
 */
export function questsFor({ accountId, period, index, level }) {
    assertInt('accountId', accountId, 1);
    assertInt('index', index);
    assertInt('level', level, 1, LIMITS.MAX_LEVEL);
    if (period !== 'daily' && period !== 'weekly') throw new RangeError('period must be daily or weekly');
    const count = period === 'daily' ? QUESTS.DAILY_COUNT : QUESTS.WEEKLY_COUNT;
    const pool = QUESTS_CATALOG.filter(d => d.period === period && d.minLevel <= level);
    const rng = createRng(hashSeed('quests', period, accountId, index));
    const picked = [];
    const metrics = new Set();
    const left = [...pool];
    while (picked.length < count && left.length) {
        const def = left.splice(rng.int(0, left.length - 1), 1)[0];
        if (metrics.has(def.metric)) continue;
        metrics.add(def.metric);
        picked.push({ code: def.code, period, metric: def.metric, target: questTarget(def, level), reward: questReward(period, level) });
    }
    return picked.sort((x, y) => x.code.localeCompare(y.code));
}

/** New progress after `amount` more of the quest's metric: { progress, justCompleted }. */
export function advance({ progress, target, completed }, amount) {
    assertInt('amount', amount);
    if (completed || progress >= target) return { progress: Math.min(progress, target), justCompleted: false };
    const next = Math.min(target, progress + amount);
    return { progress: next, justCompleted: next >= target };
}

// ------------------------------------------------------------------ achievements

/**
 * Every achievement with its progress from lifetime stats.
 *   stats { harvests, units_sold, cash_earned, orders_filled, hybrids_bred, base_varieties, best_level,
 *           staff_claims, quests_claimed, best_streak, replants, decorations, challenges_completed }
 * Returns [{ code, stat, target, progress, met }].
 */
export function achievementProgress(stats) {
    return ACHIEVEMENTS.map(a => {
        const have = Math.max(0, Number(stats?.[a.stat]) || 0);
        return { code: a.code, stat: a.stat, target: a.target, progress: Math.min(have, a.target), met: have >= a.target };
    });
}

// ------------------------------------------------------------------ seasons and challenges

/** The window of a season that starts at a UTC midnight: { startsAtMs, endsAtMs }. */
export function seasonWindow(startDay) {
    assertInt('startDay', startDay);
    return { startsAtMs: startDay * DAY_MS, endsAtMs: (startDay + SEASON.LENGTH_DAYS) * DAY_MS };
}

/** The weekly challenges of a season: [{ week, code, metric, target, startsAtMs, endsAtMs }]. */
export function challengesFor({ seasonNumber, startsAtMs }) {
    assertInt('seasonNumber', seasonNumber, 1);
    assertInt('startsAtMs', startsAtMs);
    const rng = createRng(hashSeed('challenges', seasonNumber));
    const left = [...CHALLENGES_CATALOG];
    const out = [];
    for (let week = 1; week <= SEASON.CHALLENGE_WEEKS && left.length; week++) {
        const def = left.splice(rng.int(0, left.length - 1), 1)[0];
        const startsAt = startsAtMs + (week - 1) * 7 * DAY_MS;
        out.push({ week, code: def.code, metric: def.metric, target: def.target, startsAtMs: startsAt, endsAtMs: startsAt + 7 * DAY_MS });
    }
    return out;
}

/**
 * The reward tier for a final rank (1-based, ties share a rank) among `ranked` players, or null.
 * Returns { tier, cash, decoration, badge } where badge is 's<n>_<tier>'.
 */
export function seasonRewardFor({ seasonNumber, rank, ranked, score }) {
    assertInt('seasonNumber', seasonNumber, 1);
    assertInt('rank', rank, 1);
    assertInt('ranked', ranked, 1);
    assertInt('score', score);
    if (score < SEASON.PARTICIPATION_MIN_SCORE) return null;
    for (const t of SEASON_TIERS) {
        const ok = (t.maxRank != null && rank <= t.maxRank)
            || (t.topPct != null && rank <= Math.ceil((ranked * t.topPct) / 100))
            || (t.minScore != null && score >= t.minScore);
        if (ok) return { tier: t.tier, cash: t.cash, decoration: t.decoration, badge: `s${seasonNumber}_${t.tier}` };
    }
    return null;
}

/** Podium places for a closed challenge: finishers ordered by finish time, then account id. */
export function challengePodium(finishers, places = SEASON.CHALLENGE_PODIUM.places) {
    return [...finishers]
        .sort((x, y) => x.completedAtMs - y.completedAtMs || Number(x.accountId) - Number(y.accountId))
        .slice(0, places)
        .map((f, i) => ({ ...f, place: i + 1 }));
}

/** Season points for a sale of `cash`. */
export function salePoints(cash) {
    assertInt('cash', cash);
    return Math.floor(cash / SEASON_SCORE.SALE_CASH_PER_POINT) * SEASON_SCORE.POINTS.sale;
}

// ------------------------------------------------------------------ Replant

/** The permanent bonus of `prestige` replants: { pricePct, xpPct }. */
export function replantBonus(prestige) {
    assertInt('prestige', prestige, 0, 65535);
    const counted = Math.min(prestige, REPLANT.MAX_COUNTED);
    return { pricePct: counted * REPLANT.PRICE_PCT, xpPct: counted * REPLANT.XP_PCT };
}

/** Can the account replant now? */
export function canReplant({ level }) {
    return Number.isSafeInteger(level) && level >= REPLANT.MIN_LEVEL;
}

/** Upgrade effects with the Replant bonus added (price_pct, and xp_pct for addXp). */
export function withPrestige(effects, prestige) {
    const b = replantBonus(prestige);
    return { ...effects, price_pct: (effects.price_pct || 0) + b.pricePct, xp_pct: (effects.xp_pct || 0) + b.xpPct };
}

/** XP after the Replant bonus. */
export function boostedXp(amount, xpPct) {
    assertInt('amount', amount);
    assertInt('xpPct', xpPct, 0, 1000);
    return Math.floor((amount * (100 + xpPct)) / 100);
}

/**
 * Split item removals into ledger operations of at most `maxLines` lines and `maxDelta` per line (a Replant
 * clears the whole inventory, which can be more lines than one ledger operation takes).
 *   items [{ kind, itemId, quality, quantity }] -> [[{ kind, itemId, quality, delta }]]
 */
export function clearingOps(items, { maxLines = LIMITS.MAX_LINES_PER_OP, maxDelta = LIMITS.MAX_ITEM_DELTA } = {}) {
    const lines = [];
    for (const it of items) {
        let left = Number(it.quantity);
        let part = 0;
        while (left > 0) {
            const take = Math.min(left, maxDelta);
            lines.push({ part, line: { kind: it.kind, itemId: Number(it.itemId), quality: Number(it.quality || 0), delta: -take } });
            left -= take;
            part++;
        }
    }
    // An item may appear once per operation: group by part first, then chunk.
    const byPart = new Map();
    for (const l of lines) {
        if (!byPart.has(l.part)) byPart.set(l.part, []);
        byPart.get(l.part).push(l.line);
    }
    const ops = [];
    for (const part of [...byPart.keys()].sort((x, y) => x - y)) {
        const list = byPart.get(part);
        for (let i = 0; i < list.length; i += maxLines) ops.push(list.slice(i, i + maxLines));
    }
    return ops;
}

/** Decorations sold in the shop (price set). */
export const SOLD_DECORATIONS = Object.freeze(DECORATIONS.filter(x => x.price != null));
