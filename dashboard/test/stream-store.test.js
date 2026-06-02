import { test } from 'node:test';
import assert from 'node:assert';
import { validateDestinationInput, generateStreamKey, MAX_DESTINATIONS } from '../services/stream-store.js';

test('generateStreamKey produces a cf_-prefixed unique-looking key', () => {
  const a = generateStreamKey();
  const b = generateStreamKey();
  assert.match(a, /^cf_[0-9a-f]{32}$/);
  assert.notStrictEqual(a, b);
});

test('rejects unknown platform', () => {
  const r = validateDestinationInput({ platform: 'myspace', name: 'x', rtmp_url: 'rtmp://h', dest_stream_key: 'k' }, 0);
  assert.strictEqual(r.ok, false);
});

test('rejects non-rtmp url', () => {
  const r = validateDestinationInput({ platform: 'custom', name: 'x', rtmp_url: 'http://h', dest_stream_key: 'k' }, 0);
  assert.strictEqual(r.ok, false);
});

test('accepts a valid rtmp(s) destination', () => {
  const r = validateDestinationInput({ platform: 'youtube', name: 'My YT', rtmp_url: 'rtmp://a.rtmp.youtube.com/live2', dest_stream_key: 'abcd' }, 0);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.platform, 'youtube');
});

test('enforces the destination cap', () => {
  const r = validateDestinationInput({ platform: 'custom', name: 'x', rtmp_url: 'rtmp://h', dest_stream_key: 'k' }, MAX_DESTINATIONS);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /limit/i);
});
