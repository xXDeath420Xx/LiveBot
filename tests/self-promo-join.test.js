import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLinksBlock, summarize } from '../core/self-promo-join.js';

test('parseLinksBlock: extracts + dedupes platforms from pasted links (any separator)', () => {
  const text = `https://twitch.tv/MyName
  https://kick.com/myname
  https://www.youtube.com/@MyChannel , https://trovo.live/s/MyName
  https://twitch.tv/myname`; // dup of first (case-insensitive)
  const out = parseLinksBlock(text);
  const platforms = out.map(o => o.platform).sort();
  assert.deepEqual(platforms, ['kick', 'trovo', 'twitch', 'youtube']);
});

test('parseLinksBlock: ignores non-stream text', () => {
  assert.deepEqual(parseLinksBlock('hello there, follow me!'), []);
  assert.deepEqual(parseLinksBlock(''), []);
});

test('summarize: empty results → guidance', () => {
  assert.match(summarize([]), /couldn't find any valid/i);
});

test('summarize: groups added / already / invalid', () => {
  const s = summarize([
    { status: 'added', platform: 'twitch', username: 'a' },
    { status: 'added', platform: 'kick', username: 'b', synced: true },
    { status: 'already', platform: 'youtube', username: 'c' },
    { status: 'invalid', platform: 'trovo', username: 'd' },
  ]);
  assert.match(s, /✅ Added: .*twitch.*kick.*auto-linked/s);
  assert.match(s, /Already on the list: .*youtube/);
  assert.match(s, /Couldn't verify.*trovo/);
});
