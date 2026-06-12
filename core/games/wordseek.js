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
  const placements = {}; // word -> [[r,c],...] path, so found words can be struck through on the image
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
      const cells = [];
      for (let i = 0; i < word.length; i++) {
        const rr = r0 + dr * i, cc = c0 + dc * i;
        grid[rr][cc] = word[i];
        cells.push([rr, cc]);
      }
      placed.push(word);
      if (!placements[word]) placements[word] = cells;
      done = true;
    }
  }
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c] === null) grid[r][c] = String.fromCharCode(97 + pick(26));
    }
  }
  return { grid, placed: [...new Set(placed)], size, placements };
}

export function initState({ size = 10, words = [], rng = Math.random } = {}) {
  const { grid, placed, placements } = generate(words, size, rng);
  return { size, grid, words: placed, found: [], bonus: [], lines: [], placements, boardMessageId: null };
}

/**
 * If `word` (or its reverse) can be read as a straight line in the grid in any of
 * the 8 directions, return its path `{ cells: [[r,c],...] }`; otherwise null. Used
 * both to validate a guess and to strike the found word through on the image.
 */
export function traceWord(grid, word) {
  const w = String(word ?? '').toLowerCase();
  if (w.length < 2) return null;
  const size = grid.length;
  const targets = [w, [...w].reverse().join('')];
  for (const t of targets) {
    if (t.length > size) continue;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        for (const [dr, dc] of DIRS) {
          let ok = true;
          const cells = [];
          for (let i = 0; i < t.length; i++) {
            const rr = r + dr * i, cc = c + dc * i;
            if (rr < 0 || cc < 0 || rr >= size || cc >= size || String(grid[rr][cc] || '').toLowerCase() !== t[i]) { ok = false; break; }
            cells.push([rr, cc]);
          }
          if (ok) return { cells };
        }
      }
    }
  }
  return null;
}

/**
 * True if `word` (or its reverse) can be read in the grid. Lets players claim ANY
 * real word they actually spot — not just the planted targets.
 */
export function canTrace(grid, word) {
  return traceWord(grid, word) !== null;
}

export function findWord(state, guess) {
  const w = String(guess ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return { ok: false, reason: 'not_in_grid' };
  // Words are planted in 8 directions incl. reversed, so accept the guess read
  // EITHER way — typing what you see backwards (rood) finds the planted word (door).
  const rev = [...w].reverse().join('');
  const match = state.words.includes(w) ? w : (state.words.includes(rev) ? rev : null);
  if (!match) return { ok: false, reason: 'not_in_grid' };
  if (state.found.includes(match)) return { ok: false, reason: 'already_found' };
  const found = [...state.found, match];
  // Record the word's grid path so the image can strike it through.
  const cells = state.placements?.[match] || traceWord(state.grid, match)?.cells;
  const lines = cells ? [...(state.lines || []), { word: match, cells }] : (state.lines || []);
  return { ok: true, word: match, points: match.length, nextState: { ...state, found, lines }, complete: found.length >= state.words.length };
}

export function remaining(state) {
  return state.words.filter(w => !state.found.includes(w));
}

export function renderGrid(state) {
  return state.grid.map(row => row.map(c => c.toUpperCase()).join(' ')).join('\n');
}
