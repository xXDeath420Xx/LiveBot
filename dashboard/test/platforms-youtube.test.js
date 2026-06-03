import { test } from 'node:test';
import assert from 'node:assert';
import { getAuthUrl, resolveAtGoLive } from '../services/platforms/youtube.js';

test('getAuthUrl requests offline access + youtube scope', () => {
  const url = getAuthUrl('s1');
  assert.ok(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth'));
  assert.ok(url.includes('access_type=offline'));
  assert.ok(url.includes('youtube'));
  assert.ok(url.includes('state=s1'));
});

test('resolveAtGoLive creates stream+broadcast and returns ingestion key', async () => {
  const calls = [];
  const account = { accessToken: 'AT', refreshToken: 'RT', expiresAt: null };
  const fakeFetch = async (u, o) => {
    calls.push(u);
    if (u.includes('/liveStreams')) return { ok: true, json: async () => ({ id: 'S1', cdn: { ingestionInfo: { ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', streamName: 'yt-key-1' } } }) };
    if (u.includes('/liveBroadcasts') && o.method === 'POST' && !u.includes('bind')) return { ok: true, json: async () => ({ id: 'B1' }) };
    if (u.includes('/liveBroadcasts/bind')) return { ok: true, json: async () => ({ id: 'B1' }) };
    return { ok: true, json: async () => ({}) };
  };
  const r = await resolveAtGoLive(account, { title: 'Test', privacy: 'unlisted' }, { fetchFn: fakeFetch, refreshFn: async () => 'AT' });
  assert.strictEqual(r.rtmp_url, 'rtmp://a.rtmp.youtube.com/live2');
  assert.strictEqual(r.key, 'yt-key-1');
  assert.ok(calls.some(u => u.includes('/liveStreams')));
  assert.ok(calls.some(u => u.includes('/liveBroadcasts/bind')));
});
