/*
 * Stream bot viewers: the settings a streamer edits on Viewers, Settings (stored in the profile's settings JSON under
 * `viewers`, next to `music` and `studio`; no table). Pure.
 *
 *   DEFAULTS                  what a profile starts with (tracking on, points named "points", no ranks, gambling off)
 *   withDefaults(raw)         stored value → complete settings (unknown keys dropped, bad values replaced)
 *   validateSettings(input)   → { ok, errors[], value }   a dashboard save
 *   rankFor(settings, stats)  → { name, index } | null   stats: { watchMinutes, points }
 *   rankCrossed(settings, before, after) → the rank reached when a value crossed a threshold in this change, else null
 *   watchAward(settings, beforeMinutes, addMinutes, isSub) → points earned for watch time
 *   currencyCommand(settings) → the extra command word for the currency ('coins' → !coins), or null
 *   formatWatch(minutes) / formatPoints(n)
 *
 * Points are a tally the streamer keeps for fun. They are not money, cannot be bought or cashed out, and CertiFried never
 * handles a payment (owner rule: money is tracked, never processed).
 * Tested in tests/stream-bot-viewers.test.js.
 */

/** The watch-time sample runs every 5 minutes while live; earning periods are whole multiples of it. */
export const SAMPLE_MINUTES = 5;
export const EARN_PERIODS = Object.freeze([5, 10, 15, 20, 30, 60]);
export const RANK_BASES = Object.freeze(['watch', 'points']);
export const LIMITS = Object.freeze({
    currencyName: 20, earnPoints: [0, 10000], bonus: [0, 100000], multiplier: [1, 10], ranks: 20, rankName: 40,
    rankMin: [0, 100_000_000], gambleBet: [1, 1_000_000_000], winChance: [1, 90], ignore: 100, giveMin: [1, 1_000_000],
});
/** Chat bots that sit in many channels; never counted as viewers unless the streamer removes them from the list. */
export const DEFAULT_IGNORE = Object.freeze([
    'nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot', 'wizebot', 'sery_bot', 'soundalerts', 'commanderroot',
    'kofistreambot', 'creatisbot', 'botrixoficial', 'kickbot', 'pokemoncommunitygame', 'streamstickers', 'blerp',
]);

export const DEFAULTS = Object.freeze({
    tracking: true,
    currency: 'points',
    earn: Object.freeze({ minutes: 10, points: 10, subMultiplier: 1, follow: 50, sub: 250, giftPerSub: 100, bitsPer100: 10, raid: 100 }),
    ranks: Object.freeze({ basis: 'watch', list: Object.freeze([]) }),
    give: Object.freeze({ enabled: true, min: 1 }),
    gamble: Object.freeze({ enabled: false, min: 10, max: 10000, winChance: 45 }),
    ignore: DEFAULT_IGNORE,
});

const int = (v, [lo, hi], d) => {
    if (v === '' || v === null || v === undefined) return d;
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const num1 = (v, [lo, hi], d) => {
    if (v === '' || v === null || v === undefined) return d;
    const n = Math.round(Number(v) * 10) / 10;
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const bool = (v, d) => (v === undefined ? d : v === true || v === 'true' || v === 'on' || v === 1 || v === '1');
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const LOGIN = /^[a-z0-9_]{1,25}$/;

/** A currency name: letters, numbers and spaces, 1-20 characters. */
export function cleanCurrency(v) {
    const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.currencyName);
    return /^[\p{L}\p{N} ]{1,20}$/u.test(s) ? s : null;
}

function cleanRanks(list) {
    const out = [];
    const names = new Set();
    for (const r of Array.isArray(list) ? list.slice(0, LIMITS.ranks) : []) {
        const name = String(r?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.rankName);
        const min = int(r?.min, LIMITS.rankMin, null);
        if (!name || min === null || names.has(name.toLowerCase())) continue;
        names.add(name.toLowerCase());
        out.push({ name, min });
    }
    return out.sort((a, b) => a.min - b.min);
}

function cleanIgnore(v, d) {
    const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : null;
    if (!raw) return [...d];
    return [...new Set(raw.map((s) => String(s).trim().replace(/^@/, '').toLowerCase()).filter((s) => LOGIN.test(s)))].slice(0, LIMITS.ignore);
}

export function withDefaults(raw) {
    const s = obj(raw);
    const e = obj(s.earn), r = obj(s.ranks), g = obj(s.gamble), gv = obj(s.give), D = DEFAULTS;
    const gmin = int(g.min, LIMITS.gambleBet, D.gamble.min);
    return {
        tracking: bool(s.tracking, D.tracking),
        currency: cleanCurrency(s.currency) || D.currency,
        earn: {
            minutes: EARN_PERIODS.includes(Number(e.minutes)) ? Number(e.minutes) : D.earn.minutes,
            points: int(e.points, LIMITS.earnPoints, D.earn.points),
            subMultiplier: num1(e.subMultiplier, LIMITS.multiplier, D.earn.subMultiplier),
            follow: int(e.follow, LIMITS.bonus, D.earn.follow),
            sub: int(e.sub, LIMITS.bonus, D.earn.sub),
            giftPerSub: int(e.giftPerSub, LIMITS.bonus, D.earn.giftPerSub),
            bitsPer100: int(e.bitsPer100, LIMITS.bonus, D.earn.bitsPer100),
            raid: int(e.raid, LIMITS.bonus, D.earn.raid),
        },
        ranks: { basis: RANK_BASES.includes(r.basis) ? r.basis : D.ranks.basis, list: cleanRanks(r.list) },
        give: { enabled: bool(gv.enabled, D.give.enabled), min: int(gv.min, LIMITS.giveMin, D.give.min) },
        gamble: {
            enabled: bool(g.enabled, D.gamble.enabled),
            min: gmin,
            max: Math.max(gmin, int(g.max, LIMITS.gambleBet, D.gamble.max)),
            winChance: int(g.winChance, LIMITS.winChance, D.gamble.winChance),
        },
        ignore: cleanIgnore(s.ignore, D.ignore),
    };
}

/** A save from the dashboard: the same cleaning, plus messages for what was refused. */
export function validateSettings(input) {
    const s = obj(input);
    const errors = [];
    if (s.currency !== undefined && !cleanCurrency(s.currency)) errors.push('The points name may use 1 to 20 letters, numbers and spaces.');
    const e = obj(s.earn);
    if (e.minutes !== undefined && !EARN_PERIODS.includes(Number(e.minutes))) errors.push(`Earn points every ${EARN_PERIODS.join(', ')} minutes.`);
    const r = obj(s.ranks);
    if (Array.isArray(r.list)) {
        if (r.list.length > LIMITS.ranks) errors.push(`At most ${LIMITS.ranks} ranks.`);
        const names = new Set();
        r.list.forEach((x, i) => {
            const name = String(x?.name ?? '').trim();
            if (!name) errors.push(`Rank ${i + 1}: enter a name.`);
            else if (names.has(name.toLowerCase())) errors.push(`Rank ${i + 1}: "${name.slice(0, 40)}" is used twice.`);
            names.add(name.toLowerCase());
            const n = Number(x?.min);
            if (x?.min === '' || x?.min == null || !Number.isFinite(n) || n < 0) errors.push(`Rank ${i + 1}: enter the amount to reach it (0 or more).`);
        });
    }
    const g = obj(s.gamble);
    if (g.min !== undefined && g.max !== undefined && Number(g.max) < Number(g.min)) errors.push('Gambling: the largest bet is below the smallest.');
    if (Array.isArray(s.ignore) || typeof s.ignore === 'string') {
        const raw = Array.isArray(s.ignore) ? s.ignore : String(s.ignore).split(/[\s,]+/);
        const bad = raw.map((x) => String(x).trim().replace(/^@/, '').toLowerCase()).filter((x) => x && !LOGIN.test(x));
        if (bad.length) errors.push(`Not counted: "${bad[0].slice(0, 30)}" is not a channel name.`);
    }
    return { ok: !errors.length, errors, value: withDefaults(s) };
}

/** The rank for a viewer's totals, or null when no rank applies (no ranks, or below the first). */
export function rankFor(settings, { watchMinutes = 0, points = 0 } = {}) {
    const list = settings?.ranks?.list || [];
    const v = settings?.ranks?.basis === 'points' ? Number(points) || 0 : Number(watchMinutes) || 0;
    let hit = null;
    list.forEach((r, i) => { if (v >= r.min) hit = { name: r.name, index: i }; });
    return hit;
}

/** The rank reached when the basis value went from `before` to `after` past a threshold (a real rank-up), else null. */
export function rankCrossed(settings, before, after) {
    const list = settings?.ranks?.list || [];
    let hit = null;
    for (const r of list) if (Number(before) < r.min && Number(after) >= r.min) hit = r.name;
    return hit;
}

/** Points earned for `addMinutes` more minutes watched: `points` for each whole `minutes` period completed. */
export function watchAward(settings, beforeMinutes, addMinutes, isSub = false) {
    const per = Number(settings?.earn?.minutes) || DEFAULTS.earn.minutes;
    const pts = Number(settings?.earn?.points) || 0;
    if (!pts || addMinutes <= 0) return 0;
    const b = Math.max(0, Number(beforeMinutes) || 0);
    const periods = Math.floor((b + addMinutes) / per) - Math.floor(b / per);
    const mult = isSub ? Number(settings?.earn?.subMultiplier) || 1 : 1;
    return Math.max(0, Math.round(periods * pts * mult));
}

/** The currency's own command word when it is not "points" (Coins → !coins). */
export function currencyCommand(settings) {
    const w = String(settings?.currency || '').toLowerCase().replace(/\s+/g, '');
    return /^[a-z0-9_]{1,20}$/.test(w) && w !== 'points' ? w : null;
}

export function formatWatch(minutes) {
    const m = Math.max(0, Math.round(Number(minutes) || 0));
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h.toLocaleString('en-US')}h ${String(m % 60).padStart(2, '0')}m`;
}
export const formatPoints = (n) => (Number(n) || 0).toLocaleString('en-US');

export default { DEFAULTS, DEFAULT_IGNORE, EARN_PERIODS, RANK_BASES, LIMITS, SAMPLE_MINUTES, withDefaults, validateSettings, rankFor, rankCrossed, watchAward, currencyCommand, cleanCurrency, formatWatch, formatPoints };
