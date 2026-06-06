/**
 * WordSeek rules (pure). Plant words in a square letter grid (8 directions:
 * horizontal/vertical/diagonal, forward and reversed), fill the rest with random
 * letters, and let players find them. state = { size, grid:string[][],
 * words:string[] (planted, lowercase), found:string[], boardMessageId }.
 *
 * generate()/initState() take an `rng` so tests are deterministic. Overlapping
 * placements are allowed only where the shared cell already holds the same letter.
 */
const DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export function generate(words, size, rng = Math.random) {
  const grid = Array.from({ length: size }, () => Array(size).fill(null));
  const placed = [];
  const pick = (n) => Math.floor(rng() * n);
  for (const raw of words) {
    const word = String(raw).toLowerCase().replace(/[^a-z]/g, '');
    if (word.length < 2 || word.length > size) continue;
    let done = false;
    for (let attempt = 0; attempt < 200 && !done; attempt++) {
      const [dr, dc] = DIRS[pick(DIRS.length)];
      const rMin = dr < 0 ? word.length - 1 : 0;
      const rMax = dr > 0 ? size - word.length : size - 1;
      const cMin = dc < 0 ? word.length - 1 : 0;
      const cMax = dc > 0 ? size - word.length : size - 1;
      if (rMax < rMin || cMax < cMin) continue;
      const r0 = rMin + pick(rMax - rMin + 1);
      const c0 = cMin + pick(cMax - cMin + 1);
      let ok = true;
      for (let i = 0; i < word.length; i++) {
        const cell = grid[r0 + dr * i][c0 + dc * i];
        if (cell !== null && cell !== word[i]) { ok = false; break; }
      }
      if (!ok) continue;
      for (let i = 0; i < word.length; i++) grid[r0 + dr * i][c0 + dc * i] = word[i];
      placed.push(word);
      done = true;
    }
  }
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c] === null) grid[r][c] = String.fromCharCode(97 + pick(26));
    }
  }
  return { grid, placed: [...new Set(placed)], size };
}

export function initState({ size = 10, words = [], rng = Math.random } = {}) {
  const { grid, placed } = generate(words, size, rng);
  return { size, grid, words: placed, found: [], boardMessageId: null };
}

export function findWord(state, guess) {
  const w = String(guess ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!w || !state.words.includes(w)) return { ok: false, reason: 'not_in_grid' };
  if (state.found.includes(w)) return { ok: false, reason: 'already_found' };
  const found = [...state.found, w];
  return { ok: true, word: w, points: w.length, nextState: { ...state, found }, complete: found.length >= state.words.length };
}

export function remaining(state) {
  return state.words.filter(w => !state.found.includes(w));
}

export function renderGrid(state) {
  return state.grid.map(row => row.map(c => c.toUpperCase()).join(' ')).join('\n');
}
