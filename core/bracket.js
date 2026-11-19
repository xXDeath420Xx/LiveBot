/*
 * Bracket engine for /tournament — pure and dependency-free (no discord.js, no DB), so every rule
 * here is unit-tested in tests/bracket.test.js and the manager (core/tournament-manager.js) only
 * persists what this module decides.
 *
 * ## Formats
 *   single       single elimination. Field padded to the next power of two; the top seeds get the
 *                byes, using standard seeding (1 v 16, 8 v 9, …) so the top two can only meet in
 *                the final.
 *   double       double elimination: winners bracket, losers bracket, grand final, and a bracket
 *                reset (second grand final) if the losers-bracket champion wins the first one.
 *   round_robin  everyone plays everyone once (circle method); standings decide the winner.
 *
 * ## Why results are REPLAYED rather than mutated in place
 *
 * The persistent truth is small: the seeded entrant list, the set of withdrawn entrants and the
 * real results in the order they were recorded. `replay()` rebuilds the whole bracket from those.
 * That one code path then covers normal reporting (append a result), staff overrides (edit a
 * result and see whether anything downstream conflicts), disqualifications (add to `withdrawn`)
 * and recovery after a restart — there is no second, incremental path to drift out of step.
 *
 * ## Slots
 *   null  — not decided yet (waiting for an earlier match)
 *   BYE   — permanently empty. A real entrant facing a BYE advances automatically; BYE v BYE
 *           sends a BYE onward (this happens in the losers bracket when two byes meet).
 *   other — an entrant id (the manager uses tournament_participants.id).
 *
 * A withdrawn (disqualified) entrant forfeits every match they have not already played.
 */

export const BYE = 0;
export const FORMATS = ['single', 'double', 'round_robin'];

export const MAX_ENTRANTS = Object.freeze({ single: 64, double: 32, round_robin: 16 });

export function key(bracket, round, match) {
    return `${bracket}-${round}-${match}`;
}

export function nextPowerOfTwo(n) {
    let p = 1;
    while (p < n) p *= 2;
    return p;
}

/**
 * Seeds in bracket-line order for a power-of-two field. size 8 → [1, 8, 4, 5, 2, 7, 3, 6]:
 * round-one pairs are (1,8) (4,5) (2,7) (3,6), and seeds 1 and 2 sit in opposite halves.
 */
export function seedPositions(size) {
    let order = [1];
    while (order.length < size) {
        const n = order.length * 2;
        const next = [];
        for (const s of order) next.push(s, n + 1 - s);
        order = next;
    }
    return order;
}

function newMatch(bracket, round, match) {
    return {
        key: key(bracket, round, match),
        bracket, round, match,
        slots: [null, null],
        winner: null,
        loser: null,
        result: null,      // null | 'played' | 'bye' | 'forfeit' | 'skipped'
        winnerTo: null,    // { key, slot } | null
        loserTo: null,     // { key, slot } | null (null = eliminated, or champion path)
    };
}

/** The empty graph for an elimination bracket of `size` (a power of two, >= 2). */
function skeleton(format, size) {
    const k = Math.log2(size);
    const matches = new Map();
    const add = (b, r, m) => { const x = newMatch(b, r, m); matches.set(x.key, x); return x; };
    const isDouble = format === 'double';

    for (let r = 1; r <= k; r++) {
        for (let m = 1; m <= size / 2 ** r; m++) add('W', r, m);
    }
    const lbRounds = isDouble ? 2 * (k - 1) : 0;
    for (let j = 1; j <= lbRounds; j++) {
        const count = 2 ** (k - 1 - Math.ceil(j / 2));
        for (let m = 1; m <= count; m++) add('L', j, m);
    }
    if (isDouble) {
        add('GF', 1, 1);
        add('GF', 2, 1);
    }

    for (const x of matches.values()) {
        const half = { slot: x.match % 2 === 1 ? 0 : 1, m: Math.ceil(x.match / 2) };
        if (x.bracket === 'W') {
            if (x.round < k) x.winnerTo = { key: key('W', x.round + 1, half.m), slot: half.slot };
            else if (isDouble) x.winnerTo = { key: key('GF', 1, 1), slot: 0 };
            if (isDouble) {
                if (x.round === 1) {
                    x.loserTo = k >= 2
                        ? { key: key('L', 1, half.m), slot: half.slot }
                        : { key: key('GF', 1, 1), slot: 1 };
                } else {
                    // Drop into the even losers round, reversing order every other round so a
                    // dropped player does not immediately meet someone from their own quarter.
                    const count = size / 2 ** x.round;
                    const idx = x.round % 2 === 0 ? count - x.match + 1 : x.match;
                    x.loserTo = { key: key('L', 2 * (x.round - 1), idx), slot: 1 };
                }
            }
        } else if (x.bracket === 'L') {
            if (x.round === lbRounds) x.winnerTo = { key: key('GF', 1, 1), slot: 1 };
            else if (x.round % 2 === 1) x.winnerTo = { key: key('L', x.round + 1, x.match), slot: 0 };
            else x.winnerTo = { key: key('L', x.round + 1, half.m), slot: half.slot };
        }
        // GF matches are wired by decide().
    }
    return { format, size, rounds: k, matches };
}

function decide(state, m, winnerSlot, how) {
    m.winner = m.slots[winnerSlot];
    m.loser = m.slots[1 - winnerSlot];
    m.result = how;
    if (m.bracket === 'GF' && m.round === 1) {
        const reset = state.matches.get(key('GF', 2, 1));
        if (winnerSlot === 0) {
            reset.result = 'skipped';
        } else {
            // The losers-bracket champion won: both now have one loss, so they play again.
            reset.slots = [m.slots[0], m.slots[1]];
        }
        return;
    }
    if (m.winnerTo) state.matches.get(m.winnerTo.key).slots[m.winnerTo.slot] = m.winner;
    if (m.loserTo) state.matches.get(m.loserTo.key).slots[m.loserTo.slot] = m.loser;
}

/**
 * Resolve everything that needs no human: byes, and forfeits by withdrawn entrants. A match that
 * has a recorded result waiting to be replayed is left alone so the real result wins.
 */
function settle(state, ctx) {
    let changed = true;
    while (changed) {
        changed = false;
        for (const m of state.matches.values()) {
            if (m.result) continue;
            const [a, b] = m.slots;
            if (a === null || b === null) continue;
            if (a === BYE || b === BYE) {
                decide(state, m, a === BYE ? 1 : 0, 'bye');
                changed = true;
                continue;
            }
            if (ctx.recorded.has(m.key)) continue;
            const wa = ctx.withdrawn.has(a);
            const wb = ctx.withdrawn.has(b);
            if (wa || wb) {
                decide(state, m, wa && !wb ? 1 : 0, 'forfeit');
                changed = true;
            }
        }
    }
}

/** Round-robin pairings by the circle method. Odd fields get a sit-out each round (no row). */
function roundRobinSkeleton(entrants) {
    const list = entrants.slice();
    if (list.length % 2 === 1) list.push(BYE);
    const n = list.length;
    const matches = new Map();
    let arr = list.slice();
    for (let r = 1; r <= n - 1; r++) {
        let mNo = 0;
        for (let i = 0; i < n / 2; i++) {
            const a = arr[i];
            const b = arr[n - 1 - i];
            if (a === BYE || b === BYE) continue;
            const x = newMatch('RR', r, ++mNo);
            x.slots = [a, b];
            matches.set(x.key, x);
        }
        arr = [arr[0], arr[n - 1], ...arr.slice(1, n - 1)];
    }
    return { format: 'round_robin', size: entrants.length, rounds: n - 1, matches };
}

/**
 * Build the bracket for `entrants` (ids in seed order, best seed first) with no results applied.
 * Returns the state object every other function here takes.
 */
export function createBracket(format, entrants, withdrawn = []) {
    return replay(format, entrants, [], withdrawn).state;
}

function validateEntrants(format, entrants) {
    if (!FORMATS.includes(format)) return `Unknown format "${format}"`;
    if (!Array.isArray(entrants) || entrants.length < 2) return 'A tournament needs at least 2 entrants';
    if (entrants.length > MAX_ENTRANTS[format]) return `${format} brackets support at most ${MAX_ENTRANTS[format]} entrants`;
    const seen = new Set();
    for (const e of entrants) {
        if (e === BYE || e === null || e === undefined) return 'Entrant ids must be non-zero';
        if (seen.has(e)) return `Duplicate entrant ${e}`;
        seen.add(e);
    }
    return null;
}

function applyOne(state, r) {
    const m = state.matches.get(r.key);
    if (!m) return `No match ${r.key}`;
    if (m.result) return `Match ${r.key} is already decided`;
    const [a, b] = m.slots;
    if (a === null || b === null || a === BYE || b === BYE) return `Match ${r.key} is not ready to be played`;
    const slot = r.winner === a ? 0 : r.winner === b ? 1 : -1;
    if (slot < 0) return `${r.winner} is not playing in match ${r.key}`;
    // A recorded result is about two people. If an upstream change swapped the loser out, the
    // result no longer describes this match and must not silently carry over.
    if (r.loser !== undefined && r.loser !== null && m.slots[1 - slot] !== r.loser) {
        return `Match ${r.key} was played against ${r.loser}, who is no longer in it`;
    }
    decide(state, m, slot, 'played');
    m.score = r.score ?? null;
    return null;
}

/**
 * Rebuild a bracket from scratch.
 *
 * @param {string} format     'single' | 'double' | 'round_robin'
 * @param {Array} entrants    entrant ids in seed order
 * @param {Array<{key:string, winner:*, loser?:*, score?:string}>} results  recorded results, oldest
 *        first. `loser` (optional but recommended) pins the result to both players, so a result
 *        whose opponent changed after an upstream override is reported as a conflict.
 * @param {Array} withdrawn   entrant ids that forfeit everything they have not played
 * @param {{dropConflicts?: boolean}} [opts]
 *        dropConflicts — skip results that no longer fit (e.g. after an upstream override) and
 *        list them in `dropped`, instead of failing.
 * @returns {{ok:boolean, error?:string, conflict?:string, dropped:string[], state:object}}
 */
export function replay(format, entrants, results = [], withdrawn = [], opts = {}) {
    const bad = validateEntrants(format, entrants);
    if (bad) return { ok: false, error: bad, dropped: [], state: null };

    let state;
    if (format === 'round_robin') {
        state = roundRobinSkeleton(entrants);
    } else {
        const size = nextPowerOfTwo(Math.max(2, entrants.length));
        state = skeleton(format, size);
        const lines = seedPositions(size);
        for (let m = 1; m <= size / 2; m++) {
            const s1 = lines[2 * m - 2];
            const s2 = lines[2 * m - 1];
            state.matches.get(key('W', 1, m)).slots = [
                s1 <= entrants.length ? entrants[s1 - 1] : BYE,
                s2 <= entrants.length ? entrants[s2 - 1] : BYE,
            ];
        }
    }
    state.entrants = entrants.slice();
    state.withdrawn = new Set(withdrawn);

    const ctx = { recorded: new Set(results.map(r => r.key)), withdrawn: state.withdrawn };
    settle(state, ctx);
    const dropped = [];
    for (const r of results) {
        const err = applyOne(state, r);
        if (err) {
            if (!opts.dropConflicts) return { ok: false, error: err, conflict: r.key, dropped, state };
            dropped.push(r.key);
            ctx.recorded.delete(r.key);
        }
        settle(state, ctx);
    }
    return { ok: true, dropped, state };
}

/** Is a match waiting for its two (real) players to play it? */
export function isPlayable(m) {
    return !m.result && m.slots[0] !== null && m.slots[1] !== null && m.slots[0] !== BYE && m.slots[1] !== BYE;
}

/** Row status as stored in tournament_matches.status. */
export function statusOf(m) {
    if (m.result === 'played') return 'completed';
    if (m.result) return m.result; // bye | forfeit | skipped
    return isPlayable(m) ? 'ready' : 'pending';
}

/** Flat row view of a state, in display order. */
export function toRows(state) {
    return orderedMatches(state).map(m => ({
        key: m.key,
        bracket: m.bracket,
        round: m.round,
        match: m.match,
        p1: m.slots[0],
        p2: m.slots[1],
        winner: m.result && m.result !== 'skipped' ? m.winner : null,
        status: statusOf(m),
        score: m.score ?? null,
    }));
}

const BRACKET_ORDER = { W: 0, L: 1, GF: 2, RR: 3 };

export function orderedMatches(state) {
    return [...state.matches.values()].sort((a, b) =>
        (BRACKET_ORDER[a.bracket] - BRACKET_ORDER[b.bracket]) || (a.round - b.round) || (a.match - b.match));
}

/** RR results: wins, then head-to-head among the tied, then score difference, then seed. */
export function standings(state) {
    const seedOf = new Map(state.entrants.map((e, i) => [e, i + 1]));
    const row = new Map(state.entrants.map(e => [e, { id: e, seed: seedOf.get(e), played: 0, wins: 0, losses: 0, diff: 0 }]));
    const beat = new Map(); // `${a}>${b}`
    for (const m of state.matches.values()) {
        if (!m.result || m.result === 'skipped' || m.result === 'bye') continue;
        const w = row.get(m.winner);
        const l = row.get(m.loser);
        if (!w || !l) continue;
        w.played++; l.played++;
        w.wins++; l.losses++;
        beat.set(`${m.winner}>${m.loser}`, true);
        const sc = parseScore(m.score);
        if (sc) {
            const margin = Math.abs(sc[0] - sc[1]);
            w.diff += margin;
            l.diff -= margin;
        }
    }
    const all = [...row.values()];
    const byWins = new Map();
    for (const r of all) {
        if (!byWins.has(r.wins)) byWins.set(r.wins, []);
        byWins.get(r.wins).push(r);
    }
    for (const group of byWins.values()) {
        for (const r of group) {
            r.h2h = group.filter(o => o !== r && beat.get(`${r.id}>${o.id}`)).length;
        }
    }
    return all.sort((a, b) => (b.wins - a.wins) || (b.h2h - a.h2h) || (b.diff - a.diff) || (a.seed - b.seed));
}

/** "3-1", "3:1" or "3 – 1" → [3, 1]; anything else → null. */
export function parseScore(s) {
    if (s === null || s === undefined) return null;
    const m = String(s).match(/^\s*(\d{1,4})\s*[-:–]\s*(\d{1,4})\s*$/);
    return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Normalise a reported score so the winner's number comes first ("1-3" by the winner → "3-1"). */
export function normaliseScore(s) {
    const p = parseScore(s);
    if (!p) return s ? String(s).trim().slice(0, 50) : null;
    const [a, b] = p;
    return `${Math.max(a, b)}-${Math.min(a, b)}`;
}

export function isFinished(state) {
    if (state.format === 'round_robin') {
        return [...state.matches.values()].every(m => m.result);
    }
    if (state.format === 'single') {
        return !!state.matches.get(key('W', state.rounds, 1)).result;
    }
    // Game one decides it unless the losers-bracket champion won it; then the reset decides it.
    // Either way the reset match ends up with a result ('skipped' or a real one).
    return !!state.matches.get(key('GF', 2, 1)).result;
}

/** { champion, runnerUp } once finished, otherwise nulls. */
export function placings(state) {
    if (!isFinished(state)) return { champion: null, runnerUp: null };
    if (state.format === 'round_robin') {
        const s = standings(state);
        return { champion: s[0]?.id ?? null, runnerUp: s[1]?.id ?? null };
    }
    let final;
    if (state.format === 'single') final = state.matches.get(key('W', state.rounds, 1));
    else {
        const gf2 = state.matches.get(key('GF', 2, 1));
        final = gf2.result === 'skipped' ? state.matches.get(key('GF', 1, 1)) : gf2;
    }
    const clean = v => (v === BYE ? null : v);
    return { champion: clean(final.winner), runnerUp: clean(final.loser) };
}

/** Entrants who can no longer win (out of the bracket). Not meaningful for round robin. */
export function eliminated(state) {
    const out = new Set();
    if (state.format === 'round_robin') return out;
    for (const m of state.matches.values()) {
        if (!m.result || m.result === 'skipped') continue;
        if (m.loser === BYE || m.loser === null) continue;
        if (m.bracket === 'GF' && m.round === 1) {
            // Only the losers-bracket champion can be knocked out by game one.
            if (m.winner === m.slots[0]) out.add(m.loser);
            continue;
        }
        if (!m.loserTo) out.add(m.loser);
    }
    return out;
}

/** Human label for a round, e.g. "Semifinals", "Losers R3", "Grand Final". */
export function roundLabel(state, bracket, round) {
    if (bracket === 'RR') return `Round ${round}`;
    if (bracket === 'GF') return round === 1 ? 'Grand Final' : 'Grand Final (reset)';
    if (bracket === 'L') {
        return round === 2 * (state.rounds - 1) ? 'Losers Final' : `Losers R${round}`;
    }
    const fromEnd = state.rounds - round;
    const prefix = state.format === 'double' ? 'Winners ' : '';
    if (fromEnd === 0) return `${prefix}Final`;
    if (fromEnd === 1) return state.format === 'double' ? 'Winners Semis' : 'Semifinals';
    if (fromEnd === 2 && state.format !== 'double') return 'Quarterfinals';
    return `${prefix}Round ${round}`;
}

/** Matches grouped by round in display order: [{ bracket, round, label, matches }]. */
export function rounds(state) {
    const out = [];
    for (const m of orderedMatches(state)) {
        let g = out[out.length - 1];
        if (!g || g.bracket !== m.bracket || g.round !== m.round) {
            g = { bracket: m.bracket, round: m.round, label: roundLabel(state, m.bracket, m.round), matches: [] };
            out.push(g);
        }
        g.matches.push(m);
    }
    return out;
}

/**
 * One line of bracket text for a match. `nameOf(id)` renders an entrant; BYE and TBD are handled
 * here. The line never exceeds ~200 characters for sane names.
 */
export function formatMatchLine(m, nameOf, label = null) {
    const show = v => (v === null ? '*TBD*' : v === BYE ? '*bye*' : nameOf(v));
    const tag = label ? `\`${label}\` ` : '';
    const [a, b] = m.slots;
    if (m.result === 'skipped') return `${tag}~~not needed~~`;
    if (m.result === 'bye') {
        return m.winner === BYE ? `${tag}*bye*` : `${tag}${show(m.winner)} — *bye*`;
    }
    if (m.result === 'forfeit') return `${tag}**${show(m.winner)}** def. ${show(m.loser)} *(forfeit)*`;
    if (m.result === 'played') {
        return `${tag}**${show(m.winner)}** def. ${show(m.loser)}${m.score ? ` (${m.score})` : ''}`;
    }
    return `${tag}${show(a)} vs ${show(b)}`;
}
