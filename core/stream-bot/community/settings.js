/*
 * Stream bot community features (Wave 2 group B; design §15): the settings a streamer edits on Community, and the pure maths
 * behind the chat games. No database, no I/O. Stored in the profile's settings JSON under their own keys (JSON_SET per key,
 * so a save on one page never overwrites another): `games`, `tts`, `mediashare` (the overlay key lives there too) and
 * `viewerQueue` (the live line-up).
 *
 *   gamesWithDefaults(raw) / validateGames(input)       slots, duel, heist, raffle and line-up settings
 *   ttsWithDefaults(raw) / validateTts(input)           text to speech: voice, the profanity mask, length, volume
 *   mediaWithDefaults(raw) / validateMedia(input)       media share: open, approval, longest video, limits, points cost
 *   spin(symbols, rng) / slotsResult(reels, settings)   the slot machine
 *   heistOutcome(entries, settings, rng)                each member's escape roll on the chosen target (core/heist-odds.js)
 *   drawRaffle(entries, winners, rng)                   winners weighted by tickets, never the same person twice
 *   youtubeVideoId(url)                                 the 11-character id of a YouTube video link, else null
 *
 * Points are a free channel tally. Nothing here is bought with money, and CertiFried never handles a payment
 * (owner rule: memory feedback_certifried_no_user_charging). Games, the store and media share are off until the streamer
 * turns them on.
 * Tested in tests/stream-bot-community.test.js.
 */
import { TARGETS, successChance } from '../../heist-odds.js';

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
const bool = (v, d) => (v === undefined || v === null ? d : v === true || v === 'true' || v === 'on' || v === 1 || v === '1');
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const words = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,]+/));

export const HEIST_TARGETS = Object.freeze(Object.keys(TARGETS));
export const HEIST_LABEL = Object.freeze(Object.fromEntries(Object.values(TARGETS).map((t) => [t.key, t.name])));
export const LIMITS = Object.freeze({
    bet: [1, 1_000_000_000], payout: [1, 100], symbols: [3, 10], symbol: 25, duelSec: [15, 300], heistJoin: [15, 300], heistCooldown: [0, 120],
    tickets: [1, 1000], ticketCost: [0, 1_000_000_000], winners: [1, 20], raffleSec: [0, 3600], lineupMax: [1, 500], ttsChars: [20, 400],
    volume: [0, 100], maskWords: 200, maskWord: 40, mediaSeconds: [15, 900], perUser: [1, 20], mediaQueue: [1, 100], mediaCost: [0, 1_000_000_000],
});
export const DEFAULT_SYMBOLS = Object.freeze(['Kappa', 'PogChamp', 'LUL', 'BibleThump', 'SeemsGood']);

export const GAMES_DEFAULTS = Object.freeze({
    slots: Object.freeze({ enabled: false, min: 10, max: 1000, symbols: DEFAULT_SYMBOLS, payout3: 10, payout2: 1.5 }),
    duel: Object.freeze({ enabled: false, min: 10, max: 10000, expirySec: 60 }),
    heist: Object.freeze({ enabled: false, min: 10, max: 5000, joinSec: 60, target: 'easy', cooldownMin: 5 }),
    raffle: Object.freeze({ ticketCost: 10, maxTickets: 10, winners: 1, autoDrawSec: 0 }),
    lineup: Object.freeze({ max: 50, subsFirst: false }),
});

/** Slot symbols: emote names, letters and numbers, 1-25 characters, 3 to 10 different ones. */
export function cleanSymbols(v) {
    const out = [];
    for (const w of words(v)) {
        const s = String(w).trim();
        if (/^[\p{L}\p{N}_:]{1,25}$/u.test(s) && !out.includes(s)) out.push(s);
        if (out.length >= LIMITS.symbols[1]) break;
    }
    return out;
}

export function gamesWithDefaults(raw) {
    const r = obj(raw);
    const D = GAMES_DEFAULTS;
    const sl = obj(r.slots); const du = obj(r.duel); const he = obj(r.heist); const ra = obj(r.raffle); const li = obj(r.lineup);
    const symbols = cleanSymbols(sl.symbols ?? D.slots.symbols);
    const out = {
        slots: { enabled: bool(sl.enabled, D.slots.enabled), min: int(sl.min, LIMITS.bet, D.slots.min), max: int(sl.max, LIMITS.bet, D.slots.max),
            symbols: symbols.length >= LIMITS.symbols[0] ? symbols : [...D.slots.symbols], payout3: num1(sl.payout3, LIMITS.payout, D.slots.payout3), payout2: num1(sl.payout2, LIMITS.payout, D.slots.payout2) },
        duel: { enabled: bool(du.enabled, D.duel.enabled), min: int(du.min, LIMITS.bet, D.duel.min), max: int(du.max, LIMITS.bet, D.duel.max), expirySec: int(du.expirySec, LIMITS.duelSec, D.duel.expirySec) },
        heist: { enabled: bool(he.enabled, D.heist.enabled), min: int(he.min, LIMITS.bet, D.heist.min), max: int(he.max, LIMITS.bet, D.heist.max),
            joinSec: int(he.joinSec, LIMITS.heistJoin, D.heist.joinSec), target: HEIST_TARGETS.includes(he.target) ? he.target : D.heist.target, cooldownMin: int(he.cooldownMin, LIMITS.heistCooldown, D.heist.cooldownMin) },
        raffle: { ticketCost: int(ra.ticketCost, LIMITS.ticketCost, D.raffle.ticketCost), maxTickets: int(ra.maxTickets, LIMITS.tickets, D.raffle.maxTickets),
            winners: int(ra.winners, LIMITS.winners, D.raffle.winners), autoDrawSec: int(ra.autoDrawSec, LIMITS.raffleSec, D.raffle.autoDrawSec) },
        lineup: { max: int(li.max, LIMITS.lineupMax, D.lineup.max), subsFirst: bool(li.subsFirst, D.lineup.subsFirst) },
    };
    for (const k of ['slots', 'duel', 'heist']) if (out[k].max < out[k].min) out[k].max = out[k].min;
    if (out.slots.payout2 > out.slots.payout3) out.slots.payout2 = out.slots.payout3;
    return out;
}

/** A dashboard save: the same cleaning, plus messages for what had to change. */
export function validateGames(input) {
    const errors = [];
    const r = obj(input);
    const value = gamesWithDefaults(r);
    const sl = obj(r.slots);
    if (sl.symbols !== undefined && cleanSymbols(sl.symbols).length < LIMITS.symbols[0]) errors.push('Slots: enter at least 3 different symbols (emote names), one per line.');
    for (const [k, label] of [['slots', 'Slots'], ['duel', 'Duels'], ['heist', 'Heists']]) {
        const g = obj(r[k]);
        if (g.min !== undefined && g.max !== undefined && Number(g.max) < Number(g.min)) errors.push(`${label}: the largest bet is smaller than the smallest.`);
    }
    if (sl.payout2 !== undefined && sl.payout3 !== undefined && Number(sl.payout2) > Number(sl.payout3)) errors.push('Slots: two matching symbols cannot pay more than three.');
    return { ok: !errors.length, errors, value };
}

// ── text to speech ──
export const TTS_DEFAULTS = Object.freeze({ voice: 'ryan', mask: true, words: Object.freeze([]), maxChars: 200, volume: 80, readNames: true });
const VOICE = /^[a-z0-9_-]{1,50}$/i;
export function cleanMaskWords(v) {
    const out = [];
    for (const w of words(v)) {
        const s = String(w).toLowerCase().trim().replace(/\s+/g, ' ');
        if (s.replace(/\*/g, '') && s.length <= LIMITS.maskWord && !out.includes(s)) out.push(s);
        if (out.length >= LIMITS.maskWords) break;
    }
    return out;
}
export function ttsWithDefaults(raw) {
    const r = obj(raw);
    return {
        voice: VOICE.test(String(r.voice || '')) ? String(r.voice) : TTS_DEFAULTS.voice,
        mask: bool(r.mask, TTS_DEFAULTS.mask),
        words: cleanMaskWords(r.words ?? []),
        maxChars: int(r.maxChars, LIMITS.ttsChars, TTS_DEFAULTS.maxChars),
        volume: int(r.volume, LIMITS.volume, TTS_DEFAULTS.volume),
        readNames: bool(r.readNames, TTS_DEFAULTS.readNames),
    };
}
export function validateTts(input, { voices = null } = {}) {
    const errors = [];
    const value = ttsWithDefaults(input);
    if (voices && !voices.includes(value.voice)) errors.push('Pick one of the voices in the list.');
    return { ok: !errors.length, errors, value };
}

// ── media share ──
export const APPROVAL = Object.freeze(['all', 'mods_skip', 'none']);
export const APPROVAL_LABEL = Object.freeze({ all: 'Every video waits for a moderator', mods_skip: 'Moderators and VIPs skip the wait', none: 'No approval (not recommended)' });
export const MEDIA_DEFAULTS = Object.freeze({ open: false, approval: 'all', maxSeconds: 180, maxPerUser: 2, maxQueue: 20, cost: 0, showCard: true });
export function mediaWithDefaults(raw) {
    const r = obj(raw);
    return {
        open: bool(r.open, MEDIA_DEFAULTS.open),
        approval: APPROVAL.includes(r.approval) ? r.approval : MEDIA_DEFAULTS.approval,
        maxSeconds: int(r.maxSeconds, LIMITS.mediaSeconds, MEDIA_DEFAULTS.maxSeconds),
        maxPerUser: int(r.maxPerUser, LIMITS.perUser, MEDIA_DEFAULTS.maxPerUser),
        maxQueue: int(r.maxQueue, LIMITS.mediaQueue, MEDIA_DEFAULTS.maxQueue),
        cost: int(r.cost, LIMITS.mediaCost, MEDIA_DEFAULTS.cost),
        showCard: bool(r.showCard, MEDIA_DEFAULTS.showCard),
    };
}
export function validateMedia(input) {
    const value = mediaWithDefaults(input);
    const errors = [];
    if (obj(input).approval !== undefined && !APPROVAL.includes(obj(input).approval)) errors.push('Pick who has to wait for approval.');
    return { ok: !errors.length, errors, value };
}

/** The 11-character id of a YouTube video link (watch, youtu.be, shorts, live, embed, music), else null. Playlists and channels: null. */
export function youtubeVideoId(input) {
    let u;
    try { u = new URL(String(input || '').trim()); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
    const ok = (id) => (/^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null);
    if (host === 'youtu.be') return ok(u.pathname.split('/')[1]);
    if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
    if (u.pathname === '/watch') return ok(u.searchParams.get('v'));
    const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/);
    return m ? ok(m[1]) : null;
}

// ── slots ──
export function spin(symbols, rng = Math.random) {
    const list = symbols && symbols.length ? symbols : DEFAULT_SYMBOLS;
    return [0, 1, 2].map(() => list[Math.min(list.length - 1, Math.floor(rng() * list.length))]);
}
/** { kind: 'three' | 'two' | 'none', multiplier } — the multiplier is what the bet comes back as (0 = lost). */
export function slotsResult(reels, s) {
    const [a, b, c] = reels;
    if (a === b && b === c) return { kind: 'three', multiplier: s.slots.payout3 };
    if (a === b || b === c || a === c) return { kind: 'two', multiplier: s.slots.payout2 };
    return { kind: 'none', multiplier: 0 };
}
/** Net change of points for a bet: winnings minus the bet, rounded down. */
export const slotsNet = (bet, multiplier) => Math.floor(bet * multiplier) - bet;

// ── heist ──
/**
 * entries: [{ key, bet }]. Each member escapes on their own roll with the crew's chance on the target (core/heist-odds.js
 * successChance, the same table as the Discord heist); an escape pays bet x multiplier back, a catch loses the bet.
 * → { chance, multiplier, target, results: [{ key, bet, escaped, net }] }
 */
export function heistOutcome(entries, s, rng = Math.random) {
    const target = TARGETS[s.heist.target] || TARGETS.easy;
    const total = entries.reduce((a, e) => a + e.bet, 0);
    const chance = successChance(target, entries.length, 0, total);
    const results = entries.map((e) => {
        const escaped = rng() < chance;
        return { key: e.key, bet: e.bet, escaped, net: escaped ? Math.floor(e.bet * target.multiplier) - e.bet : -e.bet };
    });
    return { chance, multiplier: target.multiplier, target: target.name, results };
}

// ── raffle ──
/** entries: [{ key, tickets }]. Up to `winners` different people, each draw weighted by tickets. */
export function drawRaffle(entries, winners, rng = Math.random) {
    const pool = entries.filter((e) => e.tickets > 0).map((e) => ({ ...e }));
    const out = [];
    while (out.length < winners && pool.length) {
        const total = pool.reduce((a, e) => a + e.tickets, 0);
        let r = rng() * total;
        let i = 0;
        for (; i < pool.length - 1; i++) { r -= pool[i].tickets; if (r < 0) break; }
        out.push(pool[i]);
        pool.splice(i, 1);
    }
    return out;
}

export default {
    gamesWithDefaults, validateGames, ttsWithDefaults, validateTts, mediaWithDefaults, validateMedia, youtubeVideoId, spin, slotsResult, slotsNet,
    heistOutcome, drawRaffle, cleanSymbols, cleanMaskWords, GAMES_DEFAULTS, TTS_DEFAULTS, MEDIA_DEFAULTS, HEIST_TARGETS, HEIST_LABEL, APPROVAL, APPROVAL_LABEL, LIMITS,
};
