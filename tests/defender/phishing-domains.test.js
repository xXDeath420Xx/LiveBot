import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPhishingDomain, extractDomains, _setDomainsForTest } from '../../services/certifried-bot/defender/phishing-domains.js';

_setDomainsForTest(['scam.example', 'evil.co', 'free-nitro.xyz']);

test('returns null for messages with no URL', () => {
    assert.equal(findPhishingDomain('just chatting, no links'), null);
    assert.equal(findPhishingDomain(''), null);
    assert.equal(findPhishingDomain(null), null);
});

test('flags an exact known domain', () => {
    assert.equal(findPhishingDomain('go to https://scam.example/win'), 'scam.example');
});

test('flags a subdomain of a known bad domain', () => {
    assert.equal(findPhishingDomain('https://login.evil.co/account'), 'evil.co');
});

test('strips www and matches', () => {
    assert.equal(findPhishingDomain('https://www.free-nitro.xyz'), 'free-nitro.xyz');
});

test('does not flag unknown/clean domains', () => {
    assert.equal(findPhishingDomain('https://github.com/foo'), null);
    assert.equal(findPhishingDomain('https://twitch.tv/somestreamer'), null);
});

test('extractDomains dedupes and lowercases', () => {
    const out = extractDomains('a https://Foo.com/x and https://foo.com/y and https://bar.com');
    const domains = out.map(o => o.domain).sort();
    assert.deepEqual(domains, ['bar.com', 'foo.com']);
});

// H-697: bare host names (no http/https) are checked against the list too.
test("flags a known domain typed without http(s)", () => {
    assert.equal(findPhishingDomain("claim at free-nitro.xyz now"), "free-nitro.xyz");
    assert.equal(findPhishingDomain("go to login.evil.co/account"), "evil.co");
    assert.equal(findPhishingDomain("(www.scam.example)"), "scam.example");
});

test("bare words with dots that are not on the list are ignored", () => {
    assert.equal(findPhishingDomain("version 1.2.3 is out, see node.js and e.g. this"), null);
    assert.equal(findPhishingDomain("twitch.tv and github.com are fine"), null);
    assert.equal(findPhishingDomain("gg.wp everyone. lol"), null);
});

test("extractDomains marks bare hosts and does not double-count URL hosts", () => {
    const out = extractDomains("https://scam.example/x and scam.example and other.org");
    assert.deepEqual(out.map(d => [d.domain, !!d.bare]), [["scam.example", false], ["other.org", true]]);
});
