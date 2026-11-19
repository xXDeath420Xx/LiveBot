import test from 'node:test';
import assert from 'node:assert/strict';
import { SAFE_DOMAINS, isSafeDomain, normalizeHost } from '../core/safe-domains.js';

test('normalizes what an admin actually pastes into an allowlist box', () => {
  for (const input of [
    'kkinstagram.com',
    'KKInstagram.com',
    'www.kkinstagram.com',
    'https://www.kkinstagram.com/',
    'https://www.kkinstagram.com/reel/Dbt3-k3xU8Z/?igsh=MXdsYWpjdGNyOTU2cg==',
    'http://kkinstagram.com:8080/reel/x',
    'kkinstagram.com.',
  ]) {
    assert.equal(normalizeHost(input), 'kkinstagram.com', `bad normalisation of: ${input}`);
  }
});

test('normalizeHost is empty for input with no host', () => {
  for (const input of ['', null, undefined, '   ']) assert.equal(normalizeHost(input), '');
});

test('embed fixers are never flagged — the reported false positive', () => {
  // kkinstagram.com is on mitchellkrogza/Phishing.Database because it is an
  // instagram.com look-alike; it is the embed fixer that makes reels play in
  // Discord. Community lists cannot tell those two things apart.
  assert.ok(isSafeDomain('kkinstagram.com'));
  assert.ok(isSafeDomain('https://www.kkinstagram.com/reel/Dbt3-k3xU8Z/'));
  for (const d of ['ddinstagram.com', 'vxtwitter.com', 'fxtwitter.com', 'rxddit.com', 'vxtiktok.com']) {
    assert.ok(isSafeDomain(d), `fixer not safe: ${d}`);
  }
});

test('subdomains of a safe domain are safe', () => {
  // Fixers serve media off subdomains, and a platform CDN landing in a feed
  // must not take the platform down with it.
  assert.ok(isSafeDomain('d.ddinstagram.com'));
  assert.ok(isSafeDomain('media.discordapp.net'));
  assert.ok(isSafeDomain('a.b.youtube.com'));
});

test('a look-alike that is NOT on the list stays flaggable', () => {
  // The whole point of the filter — being generous about fixers must not turn
  // into being generous about typosquats.
  for (const d of [
    'instagram-login.com',
    'accounts-instagram.fr',
    'kkinstagram.com.evil.ru',   // safe name as a SUBDOMAIN of a hostile domain
    'kkinstagram.co',
    'discordapp.com.gift',
  ]) {
    assert.equal(isSafeDomain(d), false, `wrongly cleared: ${d}`);
  }
});

test('safe list holds bare hosts only, so lookups can match', () => {
  for (const d of SAFE_DOMAINS) assert.equal(normalizeHost(d), d, `unnormalized entry: ${d}`);
});
