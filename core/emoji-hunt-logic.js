/*
 * Emoji hunt rules — pure, dependency-free (tests/emoji-hunt-logic.test.js).
 *
 * A hunt hides N copies of a target emoji: at scheduled moments the bot reacts with it on a
 * random recent member message in one of the hunt channels. Members scroll back, spot the
 * reaction and add the same reaction themselves; the first `finders` people on each spot claim it.
 *
 * Spots live in emoji_hunts.emojis_json as an array of:
 *   { i, at, ch, msg, placed, gone, claims: [{ u, t }] }
 *     i       index (stable id within the hunt)
 *     at      when the spot is due to be placed (ms)
 *     ch/msg  channel and message it was placed on (null until placed)
 *     placed  when the bot's reaction landed (ms) — find time is measured from here
 *     gone    true when placement failed for good or the message disappeared
 *     claims  who found it and when
 */

const CUSTOM_RE = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{15,25})>$/;
const PICTO_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
const EMOJI_ONLY_RE = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣)+$/u;

/**
 * Validate what an admin typed as the hunt emoji.
 * @returns {{kind:'custom', value:string, id:string, name:string, animated:boolean}
 *          |{kind:'unicode', value:string}|null}
 */
export function parseEmoji(input) {
    const s = String(input ?? '').trim();
    if (!s || s.length > 64) return null;
    const c = s.match(CUSTOM_RE);
    if (c) return { kind: 'custom', value: s, id: c[3], name: c[2], animated: c[1] === 'a' };
    if (EMOJI_ONLY_RE.test(s) && PICTO_RE.test(s) && [...s].length <= 10) return { kind: 'unicode', value: s };
    return null;
}

export const isPlaced = s => s.placed !== null && s.placed !== undefined;

const stripVs = s => String(s ?? '').replace(/️/g, '');

/** Does a reaction's emoji ({ id, name } as discord.js reports it) match the hunt target? */
export function emojiMatches(target, reactionEmoji) {
    const t = typeof target === 'string' ? parseEmoji(target) : target;
    if (!t || !reactionEmoji) return false;
    if (t.kind === 'custom') return String(reactionEmoji.id ?? '') === t.id;
    if (reactionEmoji.id) return false;
    return stripVs(reactionEmoji.name) === stripVs(t.value);
}

/** What message.react() wants: the id for a custom emoji, the character(s) otherwise. */
export function reactArg(target) {
    const t = typeof target === 'string' ? parseEmoji(target) : target;
    if (!t) return null;
    return t.kind === 'custom' ? t.id : t.value;
}

/**
 * When to hide each spot: spread over the first 75% of the hunt so the last ones still have time
 * to be found, with jitter so the timing cannot be predicted. Sorted ascending.
 */
export function scheduleSpots(count, startMs, durationMs, rand = Math.random) {
    const n = Math.max(1, Math.floor(count));
    const window = Math.max(60_000, durationMs * 0.75);
    const width = window / n;
    const out = [];
    for (let i = 0; i < n; i++) {
        // The first spot goes out within the first minute so the hunt visibly starts.
        const jitter = i === 0 ? Math.min(width, 60_000) * rand() : width * 0.8 * rand();
        out.push(Math.round(startMs + i * width + jitter));
    }
    return out.sort((a, b) => a - b).map((at, i) => ({ i, at, ch: null, msg: null, placed: null, gone: false, claims: [] }));
}

/**
 * Choose a message to hide a spot on.
 * @param {Array<{id:string, bot:boolean, system?:boolean, createdAt:number, hasTarget?:boolean}>} candidates
 * @param {Set<string>} used  message ids already used in this hunt
 */
export function pickMessage(candidates, used, nowMs, maxAgeMs, rand = Math.random) {
    const ok = candidates.filter(c =>
        !c.bot && !c.system && !c.hasTarget && !used.has(c.id) && nowMs - c.createdAt <= maxAgeMs);
    if (!ok.length) return null;
    return ok[Math.floor(rand() * ok.length)] ?? ok[0];
}

/**
 * Try to claim spot `index` for `userId`. Pure: returns a new spots array on success.
 * @returns {{ok:true, spots:Array, findMs:number, fullyClaimed:boolean}|{ok:false, reason:string}}
 */
export function claimSpot(spots, index, userId, nowMs, finders = 1) {
    const spot = spots.find(s => s.i === index);
    if (!spot || !isPlaced(spot) || spot.gone) return { ok: false, reason: 'not_placed' };
    if (spot.claims.some(c => c.u === userId)) return { ok: false, reason: 'already_claimed' };
    if (spot.claims.length >= finders) return { ok: false, reason: 'full' };
    const findMs = Math.max(0, nowMs - spot.placed);
    const claims = [...spot.claims, { u: userId, t: nowMs }];
    const next = spots.map(s => (s.i === index ? { ...s, claims } : s));
    return { ok: true, spots: next, findMs, fullyClaimed: claims.length >= finders };
}

/** Counts for status displays. */
export function summarise(spots, finders = 1) {
    let placed = 0, found = 0, claims = 0, gone = 0, waiting = 0;
    for (const s of spots) {
        if (s.gone) { gone++; continue; }
        if (!isPlaced(s)) { waiting++; continue; }
        placed++;
        claims += s.claims.length;
        if (s.claims.length >= finders) found++;
    }
    return { total: spots.length, placed, found, claims, gone, waiting, hidden: placed - found };
}

/** Nothing left to find and nothing left to place → the hunt can end early. */
export function isComplete(spots, finders = 1) {
    return spots.length > 0 && spots.every(s => s.gone || (isPlaced(s) && s.claims.length >= finders));
}

/** Spots due to be placed now. */
export function dueSpots(spots, nowMs) {
    return spots.filter(s => !isPlaced(s) && !s.gone && s.at <= nowMs);
}

/** Per-user totals for this hunt, best first: [{ userId, finds, fastestMs }]. */
export function standings(spots) {
    const by = new Map();
    for (const s of spots) {
        for (const c of s.claims) {
            const r = by.get(c.u) || { userId: c.u, finds: 0, fastestMs: null, last: 0 };
            r.finds++;
            const ms = isPlaced(s) ? Math.max(0, c.t - s.placed) : null;
            if (ms !== null && (r.fastestMs === null || ms < r.fastestMs)) r.fastestMs = ms;
            r.last = Math.max(r.last, c.t);
            by.set(c.u, r);
        }
    }
    return [...by.values()].sort((a, b) =>
        (b.finds - a.finds) || ((a.fastestMs ?? Infinity) - (b.fastestMs ?? Infinity)) || (a.last - b.last));
}

/** "1m 05s" / "42s" / "850ms" */
export function formatDuration(ms) {
    if (ms === null || ms === undefined) return '—';
    if (ms < 1000) return `${ms}ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
