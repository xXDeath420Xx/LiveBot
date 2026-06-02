const { test } = require('node:test');
const assert = require('node:assert');
const { StatusRegistry } = require('../src/status');

test('tracks a stream and its destination states', () => {
  const reg = new StatusRegistry();
  reg.startStream('streamA', { keyId: 1, startedAt: 1000 });
  reg.setDestination('streamA', 'Twitch', { state: 'connecting' });
  reg.setDestination('streamA', 'Twitch', { state: 'live' });
  reg.setDestination('streamA', 'YouTube', { state: 'failed', lastError: 'boom' });

  const snap = reg.snapshotByKeyId(1);
  assert.strictEqual(snap.live, true);
  assert.strictEqual(snap.startedAt, 1000);
  const twitch = snap.destinations.find(d => d.name === 'Twitch');
  const youtube = snap.destinations.find(d => d.name === 'YouTube');
  assert.strictEqual(twitch.state, 'live');
  assert.strictEqual(youtube.state, 'failed');
  assert.strictEqual(youtube.lastError, 'boom');
});

test('reports not-live for unknown key', () => {
  const reg = new StatusRegistry();
  assert.deepStrictEqual(reg.snapshotByKeyId(999), { live: false, destinations: [] });
});

test('removing a stream clears its status', () => {
  const reg = new StatusRegistry();
  reg.startStream('s', { keyId: 5, startedAt: 1 });
  reg.endStream('s');
  assert.strictEqual(reg.snapshotByKeyId(5).live, false);
});
