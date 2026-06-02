import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBirthday, computeAge, parseIntStrict } from '../core/birthday-helpers.js';

test('validateBirthday: valid dates pass', () => {
    assert.equal(validateBirthday(3, 15, null).ok, true);
    assert.equal(validateBirthday(2, 29, null).ok, true); // leap day allowed
    assert.equal(validateBirthday(12, 31, 1998).ok, true);
});

test('validateBirthday: bad month/day fail', () => {
    assert.equal(validateBirthday(0, 10, null).ok, false);
    assert.equal(validateBirthday(13, 10, null).ok, false);
    assert.equal(validateBirthday(4, 31, null).ok, false); // April has 30
    assert.equal(validateBirthday(2, 30, null).ok, false); // Feb max 29
    assert.equal(validateBirthday(6, 0, null).ok, false);
});

test('validateBirthday: year bounds', () => {
    assert.equal(validateBirthday(1, 1, 1899).ok, false); // too old
    assert.equal(validateBirthday(1, 1, 3000).ok, false); // future
    assert.equal(validateBirthday(1, 1, 2000).ok, true);
});

test('computeAge: year present vs null', () => {
    assert.equal(computeAge(2000, new Date('2026-06-02T00:00:00Z')), 26);
    assert.equal(computeAge(null, new Date('2026-06-02T00:00:00Z')), null);
    assert.equal(computeAge(undefined, new Date('2026-06-02T00:00:00Z')), null);
});

test('parseIntStrict: only clean integers', () => {
    assert.equal(parseIntStrict('15'), 15);
    assert.equal(parseIntStrict('  7 '), 7);
    assert.equal(parseIntStrict('1998'), 1998);
    assert.equal(parseIntStrict('1a'), null);
    assert.equal(parseIntStrict(''), null);
    assert.equal(parseIntStrict('-3'), null);
});
