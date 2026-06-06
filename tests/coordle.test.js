import test from 'node:test';
import assert from 'node:assert/strict';
import { initState, score, applyGuess, renderBoard } from '../core/games/coordle.js';

test('score: exact match is all green', () => {
  assert.deepEqual(score('crane', 'crane'), ['green', 'green', 'green', 'green', 'green']);
});

test('score: no overlap is all gray', () => {
  assert.deepEqual(score('spoil', 'crane'), ['gray', 'gray', 'gray', 'gray', 'gray']);
});

test('score: duplicate guessed letter, single in answer — only one yellow', () => {
  // answer "sober" has one 'e' and one 's'; guess "geese" has three e's
  assert.deepEqual(score('geese', 'sober'), ['gray', 'yellow', 'gray', 'yellow', 'gray']);
});

test('score: green takes priority over yellow for duplicates', () => {
  // answer "abbey": a1 b2 e1 y1 ; guess "bbbaa"
  assert.deepEqual(score('bbbaa', 'abbey'), ['gray', 'green', 'green', 'yellow', 'gray']);
});

test('applyGuess: correct guess wins', () => {
  const r = applyGuess(initState('crane'), 'crane');
  assert.equal(r.ok, true);
  assert.equal(r.status, 'won');
  assert.equal(r.guessesUsed, 1);
});

test('applyGuess: six wrong guesses loses', () => {
  let s = initState('crane');
  for (const w of ['spoil', 'mound', 'fight', 'plumb', 'soggy', 'thumb']) {
    s = applyGuess(s, w).nextState;
  }
  assert.equal(s.status, 'lost');
  assert.equal(s.guesses.length, 6);
});

test('applyGuess: guessing after the game is over is rejected', () => {
  const s = applyGuess(initState('crane'), 'crane').nextState;
  const r = applyGuess(s, 'spoil');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'over');
});

test('renderBoard: shows colored rows + remaining blanks', () => {
  const s = applyGuess(initState('crane'), 'spoil').nextState;
  const board = renderBoard(s);
  assert.ok(board.includes('S P O I L'));
  assert.ok(board.includes('⬜⬜⬜⬜⬜')); // 5 remaining blank rows
  assert.equal(board.split('\n').length, 6);
});
