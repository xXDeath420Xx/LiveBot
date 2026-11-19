import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * Pure checks for the fun/games fixes:
 *   - the hangman seed (migration 260) covers every category x difficulty /arcade hangman offers,
 *     with words whose length matches the difficulty labels and that the game can complete (a-z)
 *   - the music quiz accepts the song title case/punctuation-insensitively, but not near-misses,
 *     substrings of other words, or a spammed list of titles
 */

const { seedRows } = await import('../migrations/260_word_list_guild_scope_and_seed.js');

const CATEGORIES = ['food', 'nature', 'music', 'sports', 'animals', 'technology', 'general'];
const LENGTHS = { easy: [4, 5], medium: [6, 8], hard: [9, 20] };

test('hangman seed: 20 words for every category x difficulty the command offers', () => {
  const rows = seedRows();
  assert.equal(rows.length, CATEGORIES.length * 3 * 20);
  for (const category of CATEGORIES) {
    for (const difficulty of Object.keys(LENGTHS)) {
      const cell = rows.filter(r => r[2] === category && r[1] === difficulty);
      assert.equal(cell.length, 20, `${category}/${difficulty}`);
    }
  }
});

test('hangman seed: lengths match the difficulty labels, letters only, definitions present', () => {
  for (const [word, difficulty, category, definition] of seedRows()) {
    const [min, max] = LENGTHS[difficulty];
    assert.match(word, /^[a-z]+$/, `${category}/${word}`);
    assert.ok(word.length >= min && word.length <= max, `${word} (${word.length}) is not ${difficulty}`);
    assert.ok(definition && definition.length > 0 && definition.length <= 120, `definition for ${word}`);
  }
});

test('hangman seed: no word appears twice', () => {
  const words = seedRows().map(r => r[0]);
  assert.equal(new Set(words).size, words.length);
});

test('music quiz: answer matching', async () => {
  const { isCorrectAnswer, normalizeAnswer } = await import('../commands/games/arcade-musicquiz-handler.js');

  assert.equal(normalizeAnswer('  AC/DC & Friends!! '), 'ac dc and friends');

  assert.ok(isCorrectAnswer('hey jude', 'Hey Jude'));
  assert.ok(isCorrectAnswer('HEY JUDE!!!', 'Hey Jude'));
  assert.ok(isCorrectAnswer('Sweet Child o’ Mine', 'Sweet Child O Mine'));
  assert.ok(isCorrectAnswer('bohemian rhapsody by queen', 'Bohemian Rhapsody'));
  assert.ok(isCorrectAnswer('Stairway To Heaven.', 'Stairway to Heaven'));

  assert.ok(!isCorrectAnswer('creepy', 'Creep'));
  assert.ok(!isCorrectAnswer('smells like teen spirt', 'Smells Like Teen Spirit'));
  assert.ok(!isCorrectAnswer('', 'Creep'));
  assert.ok(!isCorrectAnswer('hey jude bohemian rhapsody billie jean smells like teen spirit creep', 'Creep'));
});
