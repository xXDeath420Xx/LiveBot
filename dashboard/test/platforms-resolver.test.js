import { test } from 'node:test';
import assert from 'node:assert';
import { resolveDestinations } from '../services/platforms/resolver.js';

function ctx(destinations, accounts = {}, adapters = {}) {
  return {
    db: {
      query: async (sql, params) => {
        if (/FROM stream_keys/i.test(sql)) return [{ id: 7 }];
        if (/FROM stream_destinations/i.test(sql)) return destinations;
        return [];
      },
    },
    accountStore: { getAccountById: async (id) => accounts[id] || null },
    getAdapter: (p) => adapters[p],
  };
}

test('passes through static destinations unchanged', async () => {
  const out = await resolveDestinations(ctx([
    { id: 1, name: 'My Twitch', platform: 'twitch', resolution: 'static', rtmp_url: 'rtmp://t/app', dest_stream_key: 'k1', account_id: null, config_json: null },
  ]), 'cf_key');
  assert.deepStrictEqual(out, [{ name: 'My Twitch', platform: 'twitch', rtmp_url: 'rtmp://t/app', dest_stream_key: 'k1' }]);
});

test('runs adapter.resolveAtGoLive for dynamic destinations', async () => {
  const adapters = { youtube: { resolveAtGoLive: async () => ({ rtmp_url: 'rtmp://yt/live2', key: 'yt-fresh' }) } };
  const out = await resolveDestinations(ctx([
    { id: 2, name: 'YT', platform: 'youtube', resolution: 'dynamic', rtmp_url: null, dest_stream_key: null, account_id: 5, config_json: null },
  ], { 5: { id: 5, platform: 'youtube' } }, adapters), 'cf_key');
  assert.deepStrictEqual(out, [{ name: 'YT', platform: 'youtube', rtmp_url: 'rtmp://yt/live2', dest_stream_key: 'yt-fresh' }]);
});

test('skips a dynamic destination whose adapter throws (isolation)', async () => {
  const adapters = {
    youtube: { resolveAtGoLive: async () => { throw new Error('boom'); } },
    twitch: { resolveAtGoLive: async () => ({ rtmp_url: 'rtmp://t', key: 'k' }) },
  };
  const out = await resolveDestinations(ctx([
    { id: 2, name: 'YT', platform: 'youtube', resolution: 'dynamic', account_id: 5, config_json: null },
    { id: 1, name: 'Tw', platform: 'twitch', resolution: 'static', rtmp_url: 'rtmp://t', dest_stream_key: 'k', account_id: null },
  ], { 5: { id: 5, platform: 'youtube' } }, adapters), 'cf_key');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'Tw');
});
