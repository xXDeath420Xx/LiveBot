import test from 'node:test';
import assert from 'node:assert/strict';
import {
    pseudonymFor, sanitizeUserText, formatCurrency, truncate, generateConnectionToken
} from '../core/fourthwall-helpers.js';

test('pseudonymFor is stable for same inputs', () => {
    const a = pseudonymFor('cust_123', 'guild_456');
    const b = pseudonymFor('cust_123', 'guild_456');
    assert.equal(a, b);
});

test('pseudonymFor differs across guilds', () => {
    const a = pseudonymFor('cust_123', 'guild_A');
    const b = pseudonymFor('cust_123', 'guild_B');
    assert.notEqual(a, b);
});

test('pseudonymFor returns Supporter # in 4-digit range', () => {
    const p = pseudonymFor('cust_123', 'guild_456');
    assert.match(p, /^Supporter #\d{4}$/);
});

test('sanitizeUserText strips role/everyone mentions', () => {
    const out = sanitizeUserText('hi @everyone and <@&123>');
    assert.doesNotMatch(out, /@everyone/);
    assert.doesNotMatch(out, /<@&123>/);
});

test('sanitizeUserText escapes markdown', () => {
    const out = sanitizeUserText('**bold** and `code`');
    assert.match(out, /\\\*\\\*/);
});

test('sanitizeUserText handles null/undefined', () => {
    assert.equal(sanitizeUserText(null), '');
    assert.equal(sanitizeUserText(undefined), '');
});

test('truncate respects Discord field limit', () => {
    const long = 'a'.repeat(2000);
    const out = truncate(long, 1024);
    assert.ok(out.length <= 1024);
    assert.match(out, /…$/);
});

test('truncate leaves short strings alone', () => {
    assert.equal(truncate('hi', 1024), 'hi');
});

test('formatCurrency uses Intl with currency code', () => {
    assert.equal(formatCurrency(1999, 'USD'), '$19.99');
});

test('formatCurrency handles missing currency gracefully', () => {
    const out = formatCurrency(1234, null);
    assert.match(out, /12\.34/);
});

test('generateConnectionToken returns ~32-char base64url', () => {
    const t = generateConnectionToken();
    assert.match(t, /^[A-Za-z0-9_-]{30,}$/);
});

test('generateConnectionToken returns unique values', () => {
    assert.notEqual(generateConnectionToken(), generateConnectionToken());
});
