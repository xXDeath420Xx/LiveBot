/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 * Rules ported from OwO Bot for Discord, Copyright (C) Christopher Thai, licensed under
 * Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International:
 *   - give caps            src/commands/commandList/economy/utils/cowoncyUtils.js (getUserLimits)
 *   - lottery              src/commands/commandList/gamble/lottery.js (maxBet, jackpot = pot + 500)
 *   - rings                src/data/rings.json, social/util/ringUtil.js (sell at 75%)
 *   - marriage daily bonus src/commands/commandList/economy/daily.js (calculateMarriageBonus)
 *   - takedown tracker     src/commands/commandList/battle/WeaponInterface.js (ttChance = 0.1)
 *   - pray / curse         src/commands/commandList/social/pray.js (5 minute cooldown, lines)
 *   - battle settings      src/commands/commandList/battle/battleSetting.js
 *
 * Pure functions and constants only — no database, no discord.js — so the maths behind the OwO
 * social/economy features can be unit-tested on their own (tests/owo-social.test.js).
 */

// ── Pray / curse ─────────────────────────────────────────────────────────────

/** Upstream's pray/curse share one 5-minute cooldown (CommandInterface cooldown: 300000). */
export const PRAY_COOLDOWN_MS = 5 * 60 * 1000;

export const PRAY_LINES = [
    'May luck be in your favor.',
    'You feel lucky!',
    'You feel very lucky!',
    'You can feel the luck within you!',
    'Fortune favors you!',
    'Luck is on your side!',
];

export const CURSE_LINES = [
    'You feel unlucky...',
    'You feel very unlucky.',
    'Oh no.',
    'You should be careful...',
    "I've got a bad feeling about this...",
    'oh boy.',
    'rip',
];

/**
 * Luck-point deltas for a pray/curse, exactly as upstream: praying for someone else costs you a
 * point and gives them one; cursing someone gives YOU a point and costs them one; praying for
 * yourself is +1, cursing yourself is -1.
 * @returns {{author: number, target: number}}
 */
export function prayDeltas(kind, hasTarget) {
    if (kind === 'pray') return hasTarget ? { author: -1, target: 1 } : { author: 1, target: 0 };
    if (kind === 'curse') return hasTarget ? { author: 1, target: -1 } : { author: -1, target: 0 };
    throw new Error(`unknown pray kind: ${kind}`);
}

// ── Day boundaries ───────────────────────────────────────────────────────────

/**
 * The most recent local midnight, the same boundary core/owo/daily-drop.js uses for lootboxes and
 * crates, so every "once a day" OwO thing (cookies, give caps, marriage bonus, lottery draw) resets
 * together.
 */
export function lastMidnight(now = new Date()) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function nextMidnight(now = new Date()) {
    const m = lastMidnight(now);
    return new Date(m.getFullYear(), m.getMonth(), m.getDate() + 1);
}

/** True when `since` is missing or falls before the last midnight — i.e. the daily window reset. */
export function isNewDay(since, now = new Date()) {
    if (!since) return true;
    const t = new Date(since).getTime();
    if (!Number.isFinite(t)) return true;
    return t < lastMidnight(now).getTime();
}

/** "5H 3M 12S" until the next midnight — upstream's countdown wording. */
export function untilMidnightText(now = new Date()) {
    let s = Math.max(0, Math.trunc((nextMidnight(now) - now) / 1000));
    const sec = s % 60; s = Math.trunc(s / 60);
    const min = s % 60; const hr = Math.trunc(s / 60);
    return `${hr}H ${min}M ${sec}S`;
}

// ── Give caps ────────────────────────────────────────────────────────────────

/**
 * Daily cowoncy send/receive caps for a user level (upstream getUserLimits, verbatim formula).
 * Upstream reads OwO's own text-XP level; here it is the member's server level (user_levels),
 * 0 when the server has no leveling.
 */
export function giveLimitsForLevel(level) {
    const lvl = Math.max(0, Math.trunc(Number(level) || 0));
    const tens = Math.floor(lvl / 10);
    const limit = 50000 + lvl * 14000 + tens * 5000000;
    return { send: limit, receive: Math.ceil(limit * (tens / 2 + 1)) };
}

/**
 * How much of today's cap is already used, from an owo_cowoncy_limit row.
 * A row whose `reset` stamp predates the last midnight counts as zero (the day rolled over).
 */
export function usedToday(row, field, now = new Date()) {
    if (!row || isNewDay(row.reset, now)) return 0;
    return Math.max(0, Number(row[field]) || 0);
}

/** @returns {{ok: boolean, remaining: number}} */
export function checkAllowance({ used, amount, limit }) {
    const remaining = Math.max(0, limit - used);
    return { ok: amount <= remaining, remaining };
}

// ── Lottery ──────────────────────────────────────────────────────────────────

/** Most cowoncy one member can have in a single lottery round (upstream maxBet). */
export const LOTTERY_MAX_BET = 250_000;
/** Upstream shows the jackpot as pot + 500: the house tops every pot up. */
export const LOTTERY_HOUSE_BONUS = 500;
/**
 * A round with a single entrant rolls over instead of paying out. Upstream's lottery is global
 * and never has one player; per server it would let one member enter 1 cowoncy and collect the
 * 500 house bonus every night.
 */
export const LOTTERY_MIN_ENTRANTS = 2;

/** How much more `prevBet` may add this round, given a request (null = everything they have). */
export function lotteryAddable({ requested, prevBet, balance }) {
    const room = Math.max(0, LOTTERY_MAX_BET - (Number(prevBet) || 0));
    const want = requested == null ? Number(balance) || 0 : Number(requested) || 0;
    return Math.max(0, Math.min(want, room, Number(balance) || 0));
}

/** Winning chance in percent, truncated to two decimals like upstream. */
export function winChance(bet, total) {
    if (!total || total <= 0) return bet > 0 ? 100 : 0;
    let chance = (bet / total) * 100;
    if (chance >= 0.01) chance = Math.trunc(chance * 100) / 100;
    return chance;
}

/**
 * Weighted draw: each cowoncy entered is one ticket.
 * @param {Array<{id: string, amount: number}>} entries
 * @param {() => number} rand  0 <= rand() < 1
 * @returns {{id: string, amount: number}|null}
 */
export function pickWeightedWinner(entries, rand = Math.random) {
    const pool = (entries || []).filter(e => Number(e.amount) > 0);
    const total = pool.reduce((s, e) => s + Number(e.amount), 0);
    if (total <= 0) return null;
    let ticket = Math.floor(rand() * total); // 0 .. total-1
    for (const e of pool) {
        ticket -= Number(e.amount);
        if (ticket < 0) return e;
    }
    return pool[pool.length - 1];
}

// ── Rings & marriage ─────────────────────────────────────────────────────────

/** upstream src/data/rings.json — "All rings are the same, there are no extra benefits for a better ring." */
export const RINGS = Object.freeze({
    1: { id: 1, name: 'Common Ring',    rarity: 'common',    price: 10,         emoji: '💍' },
    2: { id: 2, name: 'Uncommon Ring',  rarity: 'uncommon',  price: 100,        emoji: '💍' },
    3: { id: 3, name: 'Rare Ring',      rarity: 'rare',      price: 1000,       emoji: '💍' },
    4: { id: 4, name: 'Epic Ring',      rarity: 'epic',      price: 10000,      emoji: '💍' },
    5: { id: 5, name: 'Mythical Ring',  rarity: 'mythical',  price: 100000,     emoji: '💍' },
    6: { id: 6, name: 'Legendary Ring', rarity: 'legendary', price: 1000000,    emoji: '💍' },
    7: { id: 7, name: 'Fabled Ring',    rarity: 'fabled',    price: 10000000,   emoji: '💍' },
});

export const RING_SELL_RATE = 0.75;

export function ringSellPrice(rid) {
    const ring = RINGS[rid];
    return ring ? Math.round(ring.price * RING_SELL_RATE) : 0;
}

/**
 * Cowoncy each partner gets when both claimed their daily today (upstream calculateMarriageBonus,
 * minus the Valentine's doubling): 100–199 plus 12.5 per combined streak day, capped at 1000.
 */
export function marriageBonus(streakSum, rand = Math.random) {
    const gain = Math.round(100 + Math.floor(rand() * 100) + (Number(streakSum) || 0) * 12.5);
    return Math.min(gain, 1000);
}

/** Order two snowflakes numerically so a pair always maps to the same (user1, user2) row. */
export function sortPair(a, b) {
    const x = BigInt(String(a)); const y = BigInt(String(b));
    return x <= y ? [String(a), String(b)] : [String(b), String(a)];
}

// ── Weapons ──────────────────────────────────────────────────────────────────

/** Chance a crate-opened weapon carries a takedown tracker (upstream ttChance). */
export const TT_CHANCE = 0.1;

// ── Friendly battles ─────────────────────────────────────────────────────────

/** Largest stake each side may put on a friendly battle. */
export const MAX_BATTLE_BET = 250_000;
/** How long the opponent has to accept (matches core/owo/battle-pvp.js BATTLE_CHALLENGE_TIMEOUT_MS). */
export const BATTLE_CHALLENGE_MS = 60_000;

export const BATTLE_DISPLAYS = ['text', 'compact'];
export const BATTLE_SPEEDS = ['instant', 'short', 'lengthy'];

/** owo_battle_settings row -> settings object with upstream defaults filled in. */
export function normalizeBattleSettings(row) {
    const display = BATTLE_DISPLAYS.includes(row?.display) ? row.display : 'text';
    const speedIdx = Number(row?.speed);
    const speed = BATTLE_SPEEDS[Number.isInteger(speedIdx) && speedIdx >= 0 && speedIdx <= 2 ? speedIdx : 0];
    return { display, speed, logs: Number(row?.logs) === 1 };
}

/**
 * Parse upstream's `owo battlesetting display=compact` syntax (also `speed=short`, `logs=true`).
 * @returns {{field: 'display'|'speed'|'logs', value: string|number}|{error: string}}
 */
export function parseBattleSetting(input) {
    const parts = String(input || '').replace(/\s+/g, '').toLowerCase().split(/[=:]/);
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return { error: 'The correct command is `owo battlesetting {settingName=setting}` — e.g. `display=compact`, `speed=short`, `logs=true`.' };
    }
    const [name, val] = parts;
    if (name === 'display') {
        if (BATTLE_DISPLAYS.includes(val)) return { field: 'display', value: val };
        if (val === 'image') return { error: 'Image battles aren\'t available here — use `text` or `compact`.' };
        return { error: 'The display setting can only be `text` or `compact`.' };
    }
    if (name === 'speed') {
        const map = { 0: 0, instant: 0, 1: 1, short: 1, 2: 2, lengthy: 2 };
        if (val in map) return { field: 'speed', value: map[val] };
        return { error: 'The speed setting can only be `instant`, `short`, or `lengthy`.' };
    }
    if (name === 'log' || name === 'logs') {
        if (val === 'true' || val === 'on') return { field: 'logs', value: 1 };
        if (val === 'false' || val === 'off') return { field: 'logs', value: 0 };
        return { error: 'The logs setting can only be `true` or `false`.' };
    }
    return { error: 'The settings are `display`, `speed`, and `logs`.' };
}

/**
 * Split a battle log into progressive frames for the `short`/`lengthy` speeds: each frame is the
 * log up to the end of a turn. Always ends with the full log.
 */
export function battleFrames(log, speed) {
    const lines = Array.isArray(log) ? log : [];
    const want = speed === 'lengthy' ? 4 : speed === 'short' ? 1 : 0;
    if (!want) return [lines];
    const turnEnds = [];
    lines.forEach((l, i) => { if (i > 0 && /^\*\*Turn \d+\*\*/.test(l)) turnEnds.push(i); });
    if (!turnEnds.length) return [lines];
    const frames = [];
    const step = Math.max(1, Math.ceil(turnEnds.length / (want + 1)));
    for (let k = step - 1; k < turnEnds.length && frames.length < want; k += step) {
        frames.push(lines.slice(0, turnEnds[k]));
    }
    frames.push(lines);
    return frames;
}

// ── Wallpapers ───────────────────────────────────────────────────────────────

/** Upstream shop ids: 1-7 rings, 200 + bid for wallpapers. */
export const WALLPAPER_SHOP_OFFSET = 200;
export const WALLPAPER_STYLES = ['solid', 'gradient', 'stars', 'waves', 'stripes'];

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** "#112233,#445566" -> ['#112233', '#445566'] (invalid entries dropped; at least one colour). */
export function parseColorList(colors, fallback = '#2c2f33') {
    const list = String(colors || '').split(',').map(s => s.trim()).filter(s => HEX_RE.test(s));
    return list.length ? list : [fallback];
}

/** Upstream stores name colours as "r,g,b,a" (a in 0-255). */
export function rgbaFromNameColor(nameColor) {
    const p = String(nameColor || '').split(',').map(n => Number(n));
    if (p.length < 3 || p.slice(0, 3).some(n => !Number.isFinite(n))) return 'rgba(255,255,255,1)';
    const [r, g, b] = p.map(n => Math.max(0, Math.min(255, Math.round(n))));
    const a = Number.isFinite(p[3]) ? Math.max(0, Math.min(255, p[3])) / 255 : 1;
    return `rgba(${r},${g},${b},${Math.round(a * 100) / 100})`;
}

/** First wallpaper colour as an embed colour integer. */
export function colorInt(hex) {
    const n = parseInt(String(hex || '').replace('#', ''), 16);
    return Number.isFinite(n) ? n : 0xF0A500;
}

/** Shop id typed by a user (e.g. 203) -> what it refers to. */
export function resolveShopId(id) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return null;
    if (RINGS[n]) return { kind: 'ring', rid: n };
    if (n > WALLPAPER_SHOP_OFFSET && n <= WALLPAPER_SHOP_OFFSET + 255) return { kind: 'wallpaper', bid: n - WALLPAPER_SHOP_OFFSET };
    return null;
}

/** Deterministic PRNG (mulberry32) so a wallpaper's star field looks the same every render. */
export function seededRandom(seed) {
    let t = (Number(seed) >>> 0) || 1;
    return () => {
        t += 0x6D2B79F5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}
