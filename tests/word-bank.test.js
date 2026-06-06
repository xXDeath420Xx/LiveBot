import test from 'node:test';
import assert from 'node:assert/strict';
import * as wordBank from '../core/word-bank.js';

test('load: succeeds and reports loaded', () => {
  assert.equal(wordBank.load(), true);
  assert.equal(wordBank.isLoaded(), true);
});

test('isWord: real words true, junk false', () => {
  assert.equal(wordBank.isWord('bear'), true);
  assert.equal(wordBank.isWord('BEAR'), true);
  assert.equal(wordBank.isWord('  rope '), true);
  assert.equal(wordBank.isWord('zzzqqwx'), false);
  assert.equal(wordBank.isWord(''), false);
  assert.equal(wordBank.isWord(null), false);
});

test('isValidGuess: 5-letter dictionary words only', () => {
  assert.equal(wordBank.isValidGuess('crane'), true);
  assert.equal(wordBank.isValidGuess('cran'), false);   // wrong length
  assert.equal(wordBank.isValidGuess('xxxxx'), false);  // not a word
});

test('randomAnswer: returns a 5-letter dictionary word, deterministic via rng', () => {
  const a = wordBank.randomAnswer(5, () => 0);  // first answer
  assert.equal(typeof a, 'string');
  assert.equal(a.length, 5);
  assert.equal(wordBank.isWord(a), true);
});

test('wordsByLength: returns words within the range', () => {
  const ws = wordBank.wordsByLength(4, 4);
  assert.ok(ws.length > 100);
  assert.ok(ws.every(w => w.length === 4));
});

test('randomWords: distinct real words within the length range', () => {
  const ws = wordBank.randomWords(8, 4, 7);
  assert.equal(ws.length, 8);
  assert.equal(new Set(ws).size, 8); // distinct
  assert.ok(ws.every(w => w.length >= 4 && w.length <= 7 && wordBank.isWord(w)));
});
