/**
 * Bracket engine (core/bracket.js) — pure, so these run anywhere with `node --test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    BYE, key, nextPowerOfTwo, seedPositions, createBracket, replay, toRows, isFinished, placings,
    eliminated, standings, parseScore, normaliseScore, rounds, roundLabel, formatMatchLine, isPlayable,
} from '../core/bracket.js';

const ids = n => Array.from({ length: n }, (_, i) => i + 1); // entrant ids 1..n, seed order

/** Play a bracket to the end, always picking the lower id (= better seed) unless told otherwise. */
function playOut(format, entrants, pick = (a, b) => Math.min(a, b), withdrawn = []) {
    const results = [];
    for (let guard = 0; guard < 500; guard++) {
        const { state } = replay(format, entrants, results, withdrawn);
        const next = [...state.matches.values()].find(isPlayable);
        if (!next) return { state, results };
        results.push({ key: next.key, winner: pick(next.slots[0], next.slots[1]) });
    }
    throw new Error('did not terminate');
}

test('nextPowerOfTwo and seedPositions', () => {
    assert.equal(nextPowerOfTwo(2), 2);
    assert.equal(nextPowerOfTwo(5), 8);
    assert.equal(nextPowerOfTwo(16), 16);
    assert.deepEqual(seedPositions(2), [1, 2]);
    assert.deepEqual(seedPositions(4), [1, 4, 2, 3]);
    assert.deepEqual(seedPositions(8), [1, 8, 4, 5, 2, 7, 3, 6]);
    const s16 = seedPositions(16);
    assert.equal(new Set(s16).size, 16);
    // Every first-round pair sums to size+1.
    for (let i = 0; i < 16; i += 2) assert.equal(s16[i] + s16[i + 1], 17);
});

test('single elimination: byes go to the top seeds and auto-advance', () => {
    const st = createBracket('single', ids(5)); // size 8, 3 byes
    const r1 = toRows(st).filter(r => r.bracket === 'W' && r.round === 1);
    assert.equal(r1.length, 4);
    const byes = r1.filter(r => r.status === 'bye');
    assert.equal(byes.length, 3);
    assert.deepEqual(byes.map(r => r.winner).sort(), [1, 2, 3]);
    const real = r1.find(r => r.status === 'ready');
    assert.deepEqual([real.p1, real.p2], [4, 5]);
    // Seed 1's round-two opponent waits on 4 v 5; seeds 2 and 3 are already paired.
    const r2 = toRows(st).filter(r => r.round === 2);
    assert.deepEqual(r2.map(r => r.status).sort(), ['pending', 'ready']);
    assert.ok(r2.some(r => r.status === 'ready' && [r.p1, r.p2].sort().join() === '2,3'));
});

test('single elimination: a full run produces the right champion and runner-up', () => {
    for (const n of [2, 3, 4, 7, 8, 13, 16, 33]) {
        const { state, results } = playOut('single', ids(n));
        assert.ok(isFinished(state), `n=${n} finished`);
        const { champion, runnerUp } = placings(state);
        assert.equal(champion, 1, `n=${n} best seed wins`);
        assert.equal(runnerUp, 2, `n=${n} second seed is runner-up`);
        assert.equal(results.length, n - 1, `n=${n} plays n-1 real matches`);
        assert.equal(eliminated(state).size, n - 1);
    }
});

test('single elimination: upsets advance the winner into the right slot', () => {
    const st0 = createBracket('single', ids(4)); // (1v4) (2v3)
    const { state } = replay('single', ids(4), [
        { key: key('W', 1, 1), winner: 4 },
        { key: key('W', 1, 2), winner: 3 },
    ]);
    const fin = state.matches.get(key('W', 2, 1));
    assert.deepEqual(fin.slots, [4, 3]);
    assert.ok(isPlayable(fin));
    assert.equal(isFinished(st0), false);
});

test('replay rejects a result for a match that is not ready or a player not in it', () => {
    const bad1 = replay('single', ids(4), [{ key: key('W', 2, 1), winner: 1 }]);
    assert.equal(bad1.ok, false);
    assert.equal(bad1.conflict, key('W', 2, 1));
    const bad2 = replay('single', ids(4), [{ key: key('W', 1, 1), winner: 2 }]);
    assert.equal(bad2.ok, false);
    const dup = replay('single', [1, 1, 2]);
    assert.equal(dup.ok, false);
    const tooFew = replay('single', [1]);
    assert.equal(tooFew.ok, false);
});

test('override: changing an early result conflicts with later ones unless dropped', () => {
    const results = [
        { key: key('W', 1, 1), winner: 1 },
        { key: key('W', 1, 2), winner: 2 },
        { key: key('W', 2, 1), winner: 1 },
    ];
    const edited = results.map(r => (r.key === key('W', 1, 1) ? { ...r, winner: 4 } : r));
    const strict = replay('single', ids(4), edited);
    assert.equal(strict.ok, false);
    assert.equal(strict.conflict, key('W', 2, 1));
    const lenient = replay('single', ids(4), edited, [], { dropConflicts: true });
    assert.equal(lenient.ok, true);
    assert.deepEqual(lenient.dropped, [key('W', 2, 1)]);
    assert.deepEqual(lenient.state.matches.get(key('W', 2, 1)).slots, [4, 2]);
});

test('override: a later result whose winner survives but whose opponent changed is still a conflict', () => {
    // 4 beat 5, then 1 beat 4 in the semi. Overriding round one to "5 beat 4" means the semi was
    // never 1 v 5, so the recorded "1 beat 4" must not silently become "1 beat 5".
    const five = ids(5); // size 8: 4 v 5 meets 1 in the semi
    const results = [
        { key: key('W', 1, 2), winner: 4, loser: 5 },
        { key: key('W', 2, 1), winner: 1, loser: 4 },
    ];
    assert.ok(replay('single', five, results).ok);
    const edited = [{ key: key('W', 1, 2), winner: 5, loser: 4 }, results[1]];
    const strict = replay('single', five, edited);
    assert.equal(strict.ok, false);
    assert.equal(strict.conflict, key('W', 2, 1));
    // Without the loser pin the engine could not tell (kept for callers that do not record it).
    assert.ok(replay('single', five, edited.map(({ loser, ...r }) => r)).ok);
});

test('withdrawn entrants forfeit unplayed matches but keep results already played', () => {
    // 1 beat 4, then 1 is disqualified: 1's final against 2 (or 3) is a forfeit.
    const { state } = replay('single', ids(4), [
        { key: key('W', 1, 1), winner: 1 },
        { key: key('W', 1, 2), winner: 2 },
    ], [1]);
    const r1 = state.matches.get(key('W', 1, 1));
    assert.equal(r1.result, 'played');
    const fin = state.matches.get(key('W', 2, 1));
    assert.equal(fin.result, 'forfeit');
    assert.equal(fin.winner, 2);
    assert.deepEqual(placings(state), { champion: 2, runnerUp: 1 });
});

test('double elimination: structure sizes', () => {
    const st = createBracket('double', ids(8));
    const rows = toRows(st);
    assert.equal(rows.filter(r => r.bracket === 'W').length, 7);
    assert.equal(rows.filter(r => r.bracket === 'L').length, 6); // 2+2+1+1
    assert.equal(rows.filter(r => r.bracket === 'GF').length, 2);
    assert.equal(roundLabel(st, 'L', 4), 'Losers Final');
    assert.equal(roundLabel(st, 'W', 3), 'Winners Final');
});

test('double elimination: favourites run (no reset needed)', () => {
    for (const n of [2, 3, 5, 8, 11, 16]) {
        const { state, results } = playOut('double', ids(n));
        assert.ok(isFinished(state), `n=${n}`);
        assert.deepEqual(placings(state), { champion: 1, runnerUp: 2 }, `n=${n}`);
        assert.equal(state.matches.get(key('GF', 2, 1)).result, 'skipped');
        // Each real match hands out exactly one loss; everyone but the unbeaten champion is out on
        // two losses, so without a reset there are 2(n-1) real matches.
        assert.equal(results.length, 2 * (n - 1), `n=${n} match count`);
        assert.equal(eliminated(state).size, n - 1);
    }
});

test('double elimination: losers-bracket champion forces a bracket reset', () => {
    // Seed 2 beats seed 1 in the winners final, then 1 comes back through the losers bracket
    // and wins grand final game one → reset → 1 wins again.
    const pick = (a, b) => {
        if ([a, b].includes(1) && [a, b].includes(2)) return pickTwo.next().value;
        return Math.min(a, b);
    };
    const pickTwo = (function* () { yield 2; yield 1; yield 1; })();
    const { state } = playOut('double', ids(8), pick);
    const gf2 = state.matches.get(key('GF', 2, 1));
    assert.equal(gf2.result, 'played');
    assert.deepEqual(placings(state), { champion: 1, runnerUp: 2 });
});

test('double elimination: losers dropping from round 2 land in the even losers round', () => {
    const { state } = replay('double', ids(4), [
        { key: key('W', 1, 1), winner: 1 }, // 4 drops to L1
        { key: key('W', 1, 2), winner: 3 }, // 2 drops to L1
    ]);
    assert.deepEqual(state.matches.get(key('L', 1, 1)).slots, [4, 2]);
    const s2 = replay('double', ids(4), [
        { key: key('W', 1, 1), winner: 1 },
        { key: key('W', 1, 2), winner: 3 },
        { key: key('W', 2, 1), winner: 3 }, // 1 drops to the losers final
        { key: key('L', 1, 1), winner: 2 },
    ]).state;
    assert.deepEqual(s2.matches.get(key('L', 2, 1)).slots, [2, 1]);
});

test('round robin: everyone plays everyone once; odd fields sit out', () => {
    for (const n of [2, 3, 4, 5, 6, 9]) {
        const st = createBracket('round_robin', ids(n));
        const rows = toRows(st);
        assert.equal(rows.length, (n * (n - 1)) / 2, `n=${n} pair count`);
        const pairs = new Set(rows.map(r => [r.p1, r.p2].sort((a, b) => a - b).join('-')));
        assert.equal(pairs.size, rows.length, `n=${n} no repeats`);
        // Nobody plays twice in one round.
        const perRound = new Map();
        for (const r of rows) {
            const k = r.round;
            if (!perRound.has(k)) perRound.set(k, new Set());
            const s = perRound.get(k);
            assert.ok(!s.has(r.p1) && !s.has(r.p2), `n=${n} round ${k} double-booked`);
            s.add(r.p1); s.add(r.p2);
        }
        assert.ok(rows.every(r => r.status === 'ready'));
    }
});

test('round robin standings: wins, then head-to-head, then score difference, then seed', () => {
    // 1 beats 2, 2 beats 3, 3 beats 1, and all three beat 4: a three-way tie on two wins with one
    // head-to-head win each, so score difference decides it.
    const res = [
        ['1', '2', 1, '2-1'], ['2', '3', 2, '2-0'], ['3', '1', 3, '5-0'],
        ['1', '4', 1, '1-0'], ['2', '4', 2, '1-0'], ['3', '4', 3, '1-0'],
    ];
    const st0 = createBracket('round_robin', ids(4));
    const results = res.map(([a, b, w, score]) => {
        const m = [...st0.matches.values()].find(x => x.slots.includes(Number(a)) && x.slots.includes(Number(b)));
        return { key: m.key, winner: w, score };
    });
    const { state } = replay('round_robin', ids(4), results);
    assert.ok(isFinished(state));
    const table = standings(state);
    // Differences — 1: +1 (v2) +1 (v4) -5 (v3) = -3; 2: -1 +2 +1 = 2; 3: -2 +5 +1 = 4.
    assert.deepEqual(table.map(r => r.id), [3, 2, 1, 4]);
    assert.deepEqual(placings(state), { champion: 3, runnerUp: 2 });
});

test('round robin head-to-head breaks a two-way tie', () => {
    const st0 = createBracket('round_robin', ids(3));
    const find = (a, b) => [...st0.matches.values()].find(x => x.slots.includes(a) && x.slots.includes(b)).key;
    // 2 beats 1, 2 beats 3, 1 beats 3 → 2 (2 wins), 1 (1), 3 (0).
    const { state } = replay('round_robin', ids(3), [
        { key: find(1, 2), winner: 2 }, { key: find(2, 3), winner: 2 }, { key: find(1, 3), winner: 1 },
    ]);
    assert.deepEqual(standings(state).map(r => r.id), [2, 1, 3]);
});

test('double elimination: a disqualified entrant forfeits in both brackets', () => {
    // 3 is disqualified before playing: forfeits W1 to 2, drops to the losers bracket, forfeits there.
    const { state } = playOut('double', ids(4), (a, b) => Math.min(a, b), [3]);
    assert.ok(isFinished(state));
    assert.equal(placings(state).champion, 1);
    const f = [...state.matches.values()].filter(m => m.result === 'forfeit');
    assert.equal(f.length, 2);
    assert.ok(f.every(m => m.loser === 3));
    assert.ok(eliminated(state).has(3));
});

test('round robin: a withdrawn entrant forfeits the rest', () => {
    const { state } = replay('round_robin', ids(4), [], [4]);
    const forfeits = [...state.matches.values()].filter(m => m.result === 'forfeit');
    assert.equal(forfeits.length, 3);
    assert.ok(forfeits.every(m => m.loser === 4));
});

test('score helpers', () => {
    assert.deepEqual(parseScore('3-1'), [3, 1]);
    assert.deepEqual(parseScore(' 2 : 2 '), [2, 2]);
    assert.equal(parseScore('gg'), null);
    assert.equal(normaliseScore('1-3'), '3-1');
    assert.equal(normaliseScore('best of 3'), 'best of 3');
    assert.equal(normaliseScore(null), null);
});

test('rounds() groups in display order and formatMatchLine renders every state', () => {
    const { state } = replay('single', ids(3), [{ key: key('W', 1, 2), winner: 3 }]);
    const g = rounds(state);
    assert.deepEqual(g.map(x => x.label), ['Semifinals', 'Final']);
    const name = id => `P${id}`;
    const lines = g.flatMap(x => x.matches.map(m => formatMatchLine(m, name)));
    assert.ok(lines.some(l => l.includes('P1 — *bye*')));
    assert.ok(lines.some(l => l.includes('**P3** def. P2')));
    assert.ok(lines.some(l => l === 'P1 vs P3'));
    assert.equal(BYE, 0);
});
