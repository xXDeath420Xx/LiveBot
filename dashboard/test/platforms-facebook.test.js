import { test } from 'node:test';
import assert from 'node:assert';
import { getAuthUrl, resolveAtGoLive } from '../services/platforms/facebook.js';

test('getAuthUrl requests publish_video scope + state', () => {
  const url = getAuthUrl('s1');
  assert.ok(url.startsWith('https://www.facebook.com/'));
  assert.ok(url.includes('publish_video'));
  assert.ok(url.includes('state=s1'));
});

test('resolveAtGoLive creates a live video and returns its stream_url', async () => {
  const account = { accessToken: 'AT', platformUserId: 'me' };
  const fakeFetch = async (u, o) => {
    assert.ok(u.includes('/live_videos'));
    return { ok: true, json: async () => ({ id: 'LV1', stream_url: 'rtmps://live-api-s.facebook.com:443/rtmp/FB-key-xyz' }) };
  };
  const r = await resolveAtGoLive(account, { title: 'Test' }, { fetchFn: fakeFetch });
  assert.strictEqual(r.rtmp_url, 'rtmps://live-api-s.facebook.com:443/rtmp/FB-key-xyz');
  assert.strictEqual(r.key, '');
});
