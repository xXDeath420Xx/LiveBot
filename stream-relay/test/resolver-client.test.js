const { test } = require('node:test');
const assert = require('node:assert');
const { resolveViaDashboard } = require('../src/resolver-client');

test('returns resolver destinations on success', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ destinations: [{ name: 'A', platform: 'twitch', rtmp_url: 'rtmp://t', dest_stream_key: 'k' }] }) });
  const out = await resolveViaDashboard('cf_key', { url: 'http://x', secret: 's', fetchFn: fakeFetch });
  assert.strictEqual(out[0].name, 'A');
});

test('throws on non-200 so caller can fall back', async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(() => resolveViaDashboard('cf_key', { url: 'http://x', secret: 's', fetchFn: fakeFetch }));
});
