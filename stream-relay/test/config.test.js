const { test } = require('node:test');
const assert = require('node:assert');

test('loadConfig applies defaults when env is empty', () => {
  const { loadConfig } = require('../src/config');
  const cfg = loadConfig({});
  assert.strictEqual(cfg.rtmpPort, 1936);
  assert.strictEqual(cfg.statusPort, 4090);
  assert.strictEqual(cfg.maxDestinationsPerKey, 8);
  assert.strictEqual(cfg.maxConcurrentStreams, 10);
  assert.strictEqual(cfg.destRetryLimit, 5);
  assert.strictEqual(cfg.publicHost, 'certifriedmultitool.com');
});

test('loadConfig parses numeric env values', () => {
  const { loadConfig } = require('../src/config');
  const cfg = loadConfig({ RTMP_PORT: '2000', MAX_DESTINATIONS: '3' });
  assert.strictEqual(cfg.rtmpPort, 2000);
  assert.strictEqual(cfg.maxDestinationsPerKey, 3);
});
