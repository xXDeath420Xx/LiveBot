const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createStatusServer } = require('../src/status-api');
const { StatusRegistry } = require('../src/status');

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
}

test('health and status endpoints respond', async () => {
  const reg = new StatusRegistry();
  reg.startStream('s', { keyId: 11, startedAt: 1000 });
  reg.setDestination('s', 'Twitch', { state: 'live' });

  const server = createStatusServer({
    registry: reg,
    resolveKeyId: async (streamKey) => (streamKey === 'good' ? 11 : null),
    activeCount: () => reg.size()
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const health = await get(port, '/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.ok, true);
    assert.strictEqual(health.body.active, 1);

    const live = await get(port, '/status?key=good');
    assert.strictEqual(live.status, 200);
    assert.strictEqual(live.body.live, true);
    assert.strictEqual(live.body.destinations[0].name, 'Twitch');

    const unknown = await get(port, '/status?key=bad');
    assert.strictEqual(unknown.body.live, false);
  } finally {
    server.close();
  }
});
