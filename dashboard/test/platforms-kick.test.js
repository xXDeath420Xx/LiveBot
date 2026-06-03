import { test } from 'node:test';
import assert from 'node:assert';
import { getAuthUrl, connectDestination, KICK_INGEST } from '../services/platforms/kick.js';

test('getAuthUrl points at Kick authorize with state', () => {
  const url = getAuthUrl('s1');
  assert.ok(url.startsWith('https://id.kick.com/oauth/authorize'));
  assert.ok(url.includes('state=s1'));
});

test('connectDestination returns ingest URL with empty key (manual)', async () => {
  const dest = await connectDestination({ platformUsername: 'bob' });
  assert.strictEqual(dest.resolution, 'static');
  assert.strictEqual(dest.rtmp_url, KICK_INGEST);
  assert.strictEqual(dest.dest_stream_key, '');
  assert.strictEqual(dest.needsKey, true);
});
