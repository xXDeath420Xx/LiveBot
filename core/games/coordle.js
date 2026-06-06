/**
 * Coordle (collaborative Wordle) rules (pure). One shared board per channel.
 * state = { answer, guesses:[{word,marks}], status:'active'|'won'|'lost',
 *           maxGuesses, participants:[userId], boardMessageId }.
 *
 * score() implements the real Wordle duplicate-letter rule: greens are assigned
 * first and consume a letter from the answer's tally; only then are yellows
 * assigned left-to-right against the REMAINING tally, so a letter guessed more
 * times than it appears in the answer goes gray once the tally is exhausted.
 */
const MAX_GUESSES = 6;
const SQ = { green: '🟩', yellow: '🟨', gray: '⬛' };

export function initState(answer) {
  return {
    answer: String(answer).toLowerCase(),
    guesses: [],
    status: 'active',
    maxGuesses: MAX_GUESSES,
    participants: [],
    boardMessageId: null,
  };
}

export function score(guess, answer) {
  const g = String(guess).toLowerCase();
  const a = String(answer).toLowerCase();
  const marks = new Array(5).fill('gray');
  const counts = {};
  for (const ch of a) counts[ch] = (counts[ch] || 0) + 1;
  for (let i = 0; i < 5; i++) {
    if (g[i] === a[i]) { marks[i] = 'green'; counts[g[i]]--; }
  }
  for (let i = 0; i < 5; i++) {
    if (marks[i] === 'green') continue;
    const c = g[i];
    if (counts[c] > 0) { marks[i] = 'yellow'; counts[c]--; }
  }
  return marks;
}

export function applyGuess(state, guess) {
  if (state.status !== 'active') return { ok: false, reason: 'over' };
  const g = String(guess).toLowerCase();
  const marks = score(g, state.answer);
  const guesses = [...state.guesses, { word: g, marks }];
  let status = 'active';
  if (g === state.answer) status = 'won';
  else if (guesses.length >= state.maxGuesses) status = 'lost';
  const nextState = { ...state, guesses, status };
  return { ok: true, marks, status, nextState, guessesUsed: guesses.length };
}

export function renderBoard(state) {
  const rows = [];
  for (const g of state.guesses) {
    rows.push(g.marks.map(m => SQ[m]).join('') + '  ' + g.word.toUpperCase().split('').join(' '));
  }
  for (let i = state.guesses.length; i < state.maxGuesses; i++) rows.push('⬜⬜⬜⬜⬜');
  return rows.join('\n');
}
