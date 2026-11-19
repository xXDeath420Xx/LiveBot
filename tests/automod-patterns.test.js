import test from 'node:test';
import assert from 'node:assert/strict';
import {
    findDangerousConstruct, validatePattern, safeRegexTest, matchPattern, extractHostnames,
    normaliseDomain, compilePattern, effectivenessScore, MAX_REGEX_LENGTH,
} from '../core/automod-patterns.js';

/*
 * Custom automod patterns are admin-supplied code run against every message in the process
 * that also serves every other guild, so the refusals below are the safety contract.
 */

test('dangerous regex shapes are refused', () => {
    for (const src of ['(a+)+$', '(a|a)*', '(.*a){20}', '(a?){20}a{20}', '(\\d{3}-)+', '([a-z]+\\.)+com', '(?:x+)*y']) {
        assert.ok(findDangerousConstruct(src), `expected ${src} to be refused`);
    }
});

test('ordinary regexes are accepted', () => {
    for (const src of [
        '\\bfree\\s+nitro\\b', 'disc[o0]rd\\.(gift|gg)', '(\\d{3})-\\d{4}', '[(]+x', 'https?://bit\\.ly/\\w+',
        '(?<word>hello)', '(?<=@)everyone', 'a{2,5}b', 'x{', 'steam(community)?\\.ru',
    ]) {
        assert.equal(findDangerousConstruct(src), null, `expected ${src} to be accepted`);
        // A generous probe budget: this is about which shapes are accepted, not the machine's load.
        assert.equal(validatePattern('regex', src, { regexTimeoutMs: 2000 }).ok, true, `validatePattern(${src})`);
    }
});

test('backreferences and unbalanced groups are refused', () => {
    assert.match(findDangerousConstruct('(a)\\1'), /backreference/);
    assert.match(findDangerousConstruct('(?<x>a)\\k<x>'), /backreference/);
    assert.match(findDangerousConstruct('(abc'), /unclosed/);
    assert.match(findDangerousConstruct('abc)'), /unbalanced/);
    assert.match(findDangerousConstruct('[abc'), /unclosed/);
});

test('a regex that matches the empty message is refused', () => {
    for (const src of ['.*', 'a*', '^', 'x?', '(?:)']) {
        const r = validatePattern('regex', src);
        assert.equal(r.ok, false, src);
    }
});

test('regex length cap and invalid syntax', () => {
    assert.equal(validatePattern('regex', 'a'.repeat(MAX_REGEX_LENGTH + 1)).ok, false);
    const bad = validatePattern('regex', '[z-a]');
    assert.equal(bad.ok, false);
    assert.match(bad.error, /Invalid regex/);
});

test('safeRegexTest times out instead of hanging on polynomial backtracking', () => {
    const started = Date.now();
    const r = safeRegexTest(/\d+\d+\d+\d+$/i, '1'.repeat(3000) + 'x', 25);
    assert.equal(r.timedOut, true);
    assert.equal(r.matched, false);
    assert.ok(Date.now() - started < 2000);
    assert.equal(safeRegexTest(/hello/i, 'say HELLO', 2000).matched, true);
});

test('contains needs three characters; exact and contains are case-insensitive', () => {
    assert.equal(validatePattern('contains', 'ab').ok, false);
    assert.equal(validatePattern('contains', 'abc').ok, true);
    assert.equal(matchPattern({ pattern_type: 'contains', pattern: 'Free Nitro' }, 'get FREE nitro here').matched, true);
    assert.equal(matchPattern({ pattern_type: 'exact', pattern: 'hi' }, '  HI ').matched, true);
    assert.equal(matchPattern({ pattern_type: 'exact', pattern: 'hi' }, 'hi there').matched, false);
});

test('domains are normalised and matched on hostname, including subdomains, not substrings', () => {
    assert.equal(normaliseDomain('https://WWW.Example.com/path?q=1'), 'example.com');
    assert.equal(normaliseDomain('*.grabify.link'), 'grabify.link');
    assert.equal(validatePattern('domain', 'not a domain').ok, false);
    const p = { pattern_type: 'domain', pattern: 'example.com' };
    assert.equal(matchPattern(p, 'see https://example.com/x').matched, true);
    assert.equal(matchPattern(p, 'see <https://cdn.example.com>').matched, true);
    assert.equal(matchPattern(p, 'bare example.com works too').matched, true);
    assert.equal(matchPattern(p, 'https://notexample.com').matched, false);
    assert.equal(matchPattern(p, 'https://example.com.evil.io').matched, false);
    assert.equal(matchPattern(p, 'example dot com').matched, false);
});

test('extractHostnames handles markdown links, ports, credentials and trailing punctuation', () => {
    const hosts = extractHostnames('[click](https://user:pw@Bit.ly:8080/abc), also www.discord.gg/x.');
    assert.deepEqual(hosts.sort(), ['bit.ly', 'discord.gg']);
});

test('compilePattern and effectiveness score', () => {
    assert.ok(compilePattern({ pattern_type: 'regex', pattern: 'abc' }) instanceof RegExp);
    assert.equal(compilePattern({ pattern_type: 'regex', pattern: '[' }), null);
    assert.equal(compilePattern({ pattern_type: 'contains', pattern: 'abc' }), null);
    assert.equal(effectivenessScore(1, 0), 50);
    assert.equal(Math.round(effectivenessScore(9, 0)), 90);
    assert.equal(effectivenessScore(0, 3), 0);
});
