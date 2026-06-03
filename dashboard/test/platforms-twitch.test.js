import { test } from 'node:test';
import assert from 'node:assert';
import { getAuthUrl, connectDestination, TWITCH_INGEST } from '../services/platforms/twitch.js';

test('getAuthUrl includes the stream-key scope and state', () => {
  const url = getAuthUrl('abc123');
  assert.ok(url.startsWith('https://id.twitch.tv/oauth2/authorize'));
  assert.ok(url.includes('channel%3Aread%3Astream_key'));
  assert.ok(url.includes('state=abc123'));
});

test('connectDestination fetches the key and builds a static destination', async () => {
  const account = { accessToken: 'AT', platformUsername: 'bob', platformUserId: '42' };
  const fakeFetch = async (u, o) => {
    assert.ok(u.includes('/helix/streams/key'));
    return { ok: true, json: async () => ({ data: [{ stream_key: 'live_42_secret' }] }) };
  };
  const dest = await connectDestination(account, { fetchFn: fakeFetch });
  assert.strictEqual(dest.resolution, 'static');
  assert.strictEqual(dest.dest_stream_key, 'live_42_secret');
  assert.strictEqual(dest.rtmp_url, TWITCH_INGEST);
  assert.ok(dest.name.toLowerCase().includes('twitch'));
});
