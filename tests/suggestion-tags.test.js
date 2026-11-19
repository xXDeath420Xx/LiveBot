import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normaliseTagName, normaliseTagColor, normaliseTagEmoji, formatTagList, normaliseFilters,
} from '../core/suggestion-tag-helpers.js';

test('tag names are trimmed, single-spaced and length-checked', () => {
    assert.equal(normaliseTagName('  Bug   report '), 'Bug report');
    assert.equal(normaliseTagName(''), null);
    assert.equal(normaliseTagName('x'.repeat(51)), null);
    assert.equal(normaliseTagName(null), null);
});

test('tag colours accept #rgb / rrggbb and reject junk', () => {
    assert.equal(normaliseTagColor('#ABC'), '#aabbcc');
    assert.equal(normaliseTagColor('3498db'), '#3498db');
    assert.equal(normaliseTagColor('#12345'), null);
    assert.equal(normaliseTagColor('red'), null);
    assert.equal(normaliseTagColor(''), null);
});

test('tag emoji: unicode, keycaps and custom emoji in; words out', () => {
    assert.equal(normaliseTagEmoji('🐛'), '🐛');
    assert.equal(normaliseTagEmoji('1️⃣'), '1️⃣');
    assert.equal(normaliseTagEmoji('<:bug:123456789012345678>'), '<:bug:123456789012345678>');
    assert.equal(normaliseTagEmoji('<a:spin:123456789012345678>'), '<a:spin:123456789012345678>');
    assert.equal(normaliseTagEmoji(''), '');
    assert.equal(normaliseTagEmoji(undefined), '');
    assert.equal(normaliseTagEmoji('bug'), null);
    assert.equal(normaliseTagEmoji('🐛 bug'), null);
});

test('tag list formatting skips the mojibake default emoji', () => {
    assert.equal(formatTagList([]), 'None');
    assert.equal(formatTagList([
        { tag_name: 'Bug', tag_emoji: '🐛' }, { tag_name: 'UI', tag_emoji: '?️' }, { tag_name: 'Docs', tag_emoji: null },
    ]), '🐛 Bug, UI, Docs');
});

test('dashboard filters only pass through known values', () => {
    assert.deepEqual(normaliseFilters({ status: 'approved', tag: '12', sort: 'most_voted' }), { status: 'approved', tagId: 12, sort: 'most_voted' });
    assert.deepEqual(normaliseFilters({ status: "x' OR 1=1", tag: '1;DROP', sort: 'random' }), { status: null, tagId: null, sort: 'newest' });
    assert.deepEqual(normaliseFilters(), { status: null, tagId: null, sort: 'newest' });
});
