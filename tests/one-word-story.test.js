import test from 'node:test';
import assert from 'node:assert/strict';
import { initState, renderStory, validateMove } from '../core/games/one-word-story.js';

test('single word is accepted and appended', () => {
  const r = validateMove('Once', initState(), { authorId: 'a' });
  assert.equal(r.ok, true);
  assert.equal(r.word, 'Once');
  assert.deepEqual(r.nextState.words, ['Once']);
  assert.equal(r.nextState.lastAuthorId, 'a');
});

test('renderStory joins words with spaces', () => {
  let s = initState();
  for (const [w, a] of [['Once', 'a'], ['upon', 'b'], ['a', 'a'], ['time', 'b']]) {
    s = validateMove(w, s, { authorId: a }).nextState;
  }
  assert.equal(renderStory(s), 'Once upon a time');
});

test('multi-word message is rejected (not_one_word) so it can fall through', () => {
  const r = validateMove('once upon', initState(), { authorId: 'a' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_one_word');
});

test('URL is rejected as not_a_word (must not be swallowed)', () => {
  const r = validateMove('http://evil.com', initState(), { authorId: 'a' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_a_word');
});

test('pure number is rejected as not_a_word', () => {
  const r = validateMove('123', initState(), { authorId: 'a' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_a_word');
});

test('word with trailing punctuation, apostrophe and hyphen are allowed', () => {
  assert.equal(validateMove('dragon,', initState(), { authorId: 'a' }).ok, true);
  assert.equal(validateMove("don't", initState(), { authorId: 'a' }).ok, true);
  assert.equal(validateMove('well-known', initState(), { authorId: 'a' }).ok, true);
});

test('same author twice in a row is rejected when no-double-post is on', () => {
  const s = validateMove('Once', initState(), { authorId: 'a' }).nextState;
  const r = validateMove('upon', s, { authorId: 'a' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'double_post');
});

test('same author twice is allowed when no-double-post is off', () => {
  const s = validateMove('Once', initState(), { authorId: 'a', noDoublePost: false }).nextState;
  const r = validateMove('upon', s, { authorId: 'a', noDoublePost: false });
  assert.equal(r.ok, true);
});

test('different authors consecutively is fine', () => {
  const s = validateMove('Once', initState(), { authorId: 'a' }).nextState;
  const r = validateMove('upon', s, { authorId: 'b' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.nextState.words, ['Once', 'upon']);
});

test('empty/whitespace is rejected as empty', () => {
  assert.equal(validateMove('   ', initState(), { authorId: 'a' }).reason, 'empty');
});

import { removeEntryByMessage } from '../core/games/one-word-story.js';

test('deleting a word removes it and reverts lastAuthor so a correction is allowed', () => {
  let s = initState();
  s = validateMove('A', s, { authorId: 'uA', messageId: 'x1' }).nextState;
  s = validateMove('There', s, { authorId: 'uB', messageId: 'x2' }).nextState;
  // before deletion, uB is blocked from correcting (double-post)
  assert.equal(validateMove('Demon', s, { authorId: 'uB', messageId: 'x3' }).reason, 'double_post');
  const del = removeEntryByMessage(s, 'x2');
  assert.equal(del.ok, true);
  s = del.nextState;
  assert.deepEqual(s.words, ['A']);
  assert.equal(s.lastAuthorId, 'uA');
  // now the corrected word is accepted
  const fix = validateMove('Demon', s, { authorId: 'uB', messageId: 'x4' });
  assert.equal(fix.ok, true);
  assert.deepEqual(fix.nextState.words, ['A', 'Demon']);
});

test('renderStory: capitalizes sentences, attaches punctuation, one sentence per line', () => {
  let s = initState();
  for (const [w, a] of [['it', 'u1'], ['was', 'u2'], ['dark.', 'u1'], ['a', 'u2'], ['demon', 'u1'], ['appeared!', 'u2']]) {
    s = validateMove(w, s, { authorId: a, messageId: w }).nextState;
  }
  assert.equal(renderStory(s), 'It was dark.\nA demon appeared!');
});

test('standalone punctuation and paragraph markers are valid moves', () => {
  let s = initState();
  s = validateMove('Hello', s, { authorId: 'u1', messageId: 'p1' }).nextState;
  s = validateMove('---', s, { authorId: 'u2', messageId: 'p2' }).nextState; // paragraph break
  s = validateMove('world', s, { authorId: 'u1', messageId: 'p3' }).nextState;
  s = validateMove('!', s, { authorId: 'u2', messageId: 'p4' }).nextState;   // standalone punctuation
  assert.equal(renderStory(s), 'Hello\n\nWorld!');
});
