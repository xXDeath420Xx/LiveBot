import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, initState, findWord, remaining, renderGrid } from '../core/games/wordseek.js';

const DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// True if `word` can be read somewhere in the grid along one of the 8 directions.
function readable(grid, word) {
  const size = grid.length;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      for (const [dr, dc] of DIRS) {
        let ok = true;
        for (let i = 0; i < word.length; i++) {
          const rr = r + dr * i, cc = c + dc * i;
          if (rr < 0 || cc < 0 || rr >= size || cc >= size || grid[rr][cc] !== word[i]) { ok = false; break; }
        }
        if (ok) return true;
      }
    }
  }
  return false;
}

// Deterministic PRNG so placement is reproducible.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('generate: grid is size x size of single a-z letters', () => {
  const { grid } = generate(['cat', 'dog', 'bird'], 8, mulberry32(1));
  assert.equal(grid.length, 8);
  for (const row of grid) {
    assert.equal(row.length, 8);
    for (const cell of row) assert.match(cell, /^[a-z]$/);
  }
});

test('generate: every placed word is readable in the grid', () => {
  const { grid, placed } = generate(['cat', 'dog', 'bird', 'snake', 'mouse'], 10, mulberry32(42));
  assert.ok(placed.length >= 4);
  for (const w of placed) assert.ok(readable(grid, w), `expected to read "${w}" in the grid`);
});

test('generate: words longer than the grid are skipped', () => {
  const { placed } = generate(['toolongword'], 5, mulberry32(7));
  assert.ok(!placed.includes('toolongword'));
});

test('findWord: matches a planted word and scores by length', () => {
  const s = initState({ size: 10, words: ['planet', 'comet'], rng: mulberry32(3) });
  const target = s.words[0];
  const r = findWord(s, target.toUpperCase());
  assert.equal(r.ok, true);
  assert.equal(r.points, target.length);
  assert.deepEqual(r.nextState.found, [target]);
});

test('findWord: rejects words not in the grid', () => {
  const s = initState({ size: 10, words: ['planet'], rng: mulberry32(3) });
  const r = findWord(s, 'zzzzz');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_in_grid');
});

test('findWord: rejects an already-found word and reports completion', () => {
  let s = initState({ size: 8, words: ['cat'], rng: mulberry32(9) });
  const first = findWord(s, 'cat');
  assert.equal(first.ok, true);
  assert.equal(first.complete, true); // only one word
  s = first.nextState;
  const second = findWord(s, 'cat');
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already_found');
});

test('remaining + renderGrid', () => {
  const s = initState({ size: 8, words: ['cat', 'dog'], rng: mulberry32(11) });
  assert.equal(remaining(s).length, s.words.length);
  const grid = renderGrid(s);
  assert.equal(grid.split('\n').length, 8);
  assert.match(grid, /^[A-Z ]+$/m);
});

test('findWord: accepts a word read in reverse (rood ↔ door)', () => {
  const s = { size: 5, grid: [], words: ['door', 'tiger'], found: [] };
  assert.equal(findWord(s, 'door').ok, true);
  const r = findWord(s, 'ROOD'); // door planted; read backwards + uppercased
  assert.equal(r.ok, true);
  assert.equal(r.word, 'door');
  assert.equal(findWord(s, 'zzzz').ok, false);
});
