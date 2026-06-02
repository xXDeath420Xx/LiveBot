const { test } = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');
const { Multistreamer } = require('../src/multistream');

// Fake ffmpeg child: an EventEmitter with a .kill() and .stderr.
function makeFakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

test('spawns one process per destination and reports live', () => {
  const spawned = [];
  const states = [];
  const ms = new Multistreamer({
    retryLimit: 3,
    retryBaseMs: 10,
    spawn: (bin, args) => { const c = makeFakeChild(); spawned.push({ bin, args, child: c }); return c; },
    scheduleRetry: () => {}, // never fire in this test
    onState: (name, patch) => states.push({ name, patch })
  });

  ms.start('stream1', 'rtmp://127.0.0.1:1936/live/K', [
    { name: 'Twitch', rtmp_url: 'rtmp://t/app', dest_stream_key: 'k1' },
    { name: 'YouTube', rtmp_url: 'rtmp://y/live2', dest_stream_key: 'k2' }
  ]);

  assert.strictEqual(spawned.length, 2);
  assert.strictEqual(spawned[0].bin, 'ffmpeg');
  assert.ok(spawned[0].args.includes('rtmp://t/app/k1'));
  // both reported connecting->live
  assert.ok(states.some(s => s.name === 'Twitch' && s.patch.state === 'live'));
});

test('retries a destination that exits with failure, up to the limit', () => {
  const spawned = [];
  const states = [];
  let pendingRetry = null;
  const ms = new Multistreamer({
    retryLimit: 2,
    retryBaseMs: 10,
    spawn: (bin, args) => { const c = makeFakeChild(); spawned.push(c); return c; },
    scheduleRetry: (fn) => { pendingRetry = fn; }, // capture instead of timer
    onState: (name, patch) => states.push({ name, patch })
  });

  ms.start('s', 'rtmp://in/live/K', [
    { name: 'Kick', rtmp_url: 'rtmp://k/app', dest_stream_key: 'x' }
  ]);
  assert.strictEqual(spawned.length, 1);

  // First process dies with non-zero -> a retry is scheduled
  spawned[0].emit('close', 1);
  assert.strictEqual(typeof pendingRetry, 'function');
  pendingRetry(); // fire retry #1
  assert.strictEqual(spawned.length, 2);

  // Second dies too -> retry #2 (still within limit of 2)
  spawned[1].emit('close', 1);
  pendingRetry();
  assert.strictEqual(spawned.length, 3);

  // Third dies -> exceeds retryLimit (2) -> marked failed, no more spawns
  spawned[2].emit('close', 1);
  assert.ok(states.some(s => s.name === 'Kick' && s.patch.state === 'failed'));
});

test('stop() kills all child processes', () => {
  const children = [];
  const ms = new Multistreamer({
    retryLimit: 3, retryBaseMs: 10,
    spawn: () => { const c = makeFakeChild(); children.push(c); return c; },
    scheduleRetry: () => {}, onState: () => {}
  });
  ms.start('s', 'rtmp://in', [
    { name: 'A', rtmp_url: 'rtmp://a', dest_stream_key: '1' },
    { name: 'B', rtmp_url: 'rtmp://b', dest_stream_key: '2' }
  ]);
  ms.stop('s');
  assert.ok(children.every(c => c.killed));
});
