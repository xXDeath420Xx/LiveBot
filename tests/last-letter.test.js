import test from 'node:test';
import assert from 'node:assert/strict';
import { initState, normalize, validateMove } from '../core/games/last-letter.js';

test('normalize: first token, letters only, lowercased', () => {
  assert.equal(normalize('Bear'), 'bear');
  assert.equal(normalize('  rope! please'), 'rope');
  assert.equal(normalize('123'), '');
});

test('seed: any real word starts the chain', () => {
  const r = validateMove('bear', initState());
  assert.equal(r.ok, true);
  assert.equal(r.nextState.lastLetter, 'r');
  assert.equal(r.nextState.count, 1);
});

test('valid chain: first letter must match previous last letter', () => {
  let s = validateMove('bear', initState()).nextState;     // ends 'r'
  const good = validateMove('rope', s);                    // starts 'r'
  assert.equal(good.ok, true);
  assert.equal(good.nextState.lastLetter, 'e');
});

test('wrong letter is rejected with expected letter', () => {
  const s = validateMove('bear', initState()).nextState;   // ends 'r'
  const bad = validateMove('apple', s);                    // starts 'a'
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'wrong_letter');
  assert.equal(bad.expected, 'r');
});

test('non-word is rejected when dictionary required', () => {
  const bad = validateMove('zzzqq', initState());
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'not_a_word');
});

test('repeat word is rejected', () => {
  let s = validateMove('bear', initState()).nextState;     // ends 'r'
  s = validateMove('rope', s).nextState;                   // ends 'e'
  s = validateMove('echo', s).nextState;                   // ends 'o'
  s = validateMove('open', s).nextState;                   // ends 'n'
  s = validateMove('nadir', s).nextState;                  // ends 'r'
  const dup = validateMove('rope', s);                     // already used
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'repeat');
});

test('degraded mode accepts non-words if the letter rule holds', () => {
  const s = validateMove('bear', initState()).nextState;   // ends 'r'
  const r = validateMove('rxqz', s, { requireDictionary: false });
  assert.equal(r.ok, true);
  assert.equal(r.nextState.lastLetter, 'z');
});

test('used-set is capped at 500', () => {
  let s = initState();
  s.used = Array.from({ length: 500 }, (_, i) => 'w' + i);
  s.lastLetter = 'r';
  const r = validateMove('rope', s);
  assert.equal(r.ok, true);
  assert.equal(r.nextState.used.length, 500);
  assert.equal(r.nextState.used.includes('rope'), true);
  assert.equal(r.nextState.used.includes('w0'), false); // oldest dropped
});
