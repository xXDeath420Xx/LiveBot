import { test } from 'node:test';
import assert from 'node:assert';
import { PLATFORMS, getPreset, isKnownPlatform } from '../services/stream-platforms.js';

test('exposes the required platforms', () => {
  for (const p of ['twitch', 'youtube', 'kick', 'trovo', 'instagram', 'tiktok', 'twitter', 'facebook', 'custom']) {
    assert.ok(PLATFORMS[p], `missing preset: ${p}`);
  }
});

test('getPreset returns rtmp base for youtube', () => {
  assert.strictEqual(getPreset('youtube').rtmpUrl, 'rtmp://a.rtmp.youtube.com/live2');
});

test('custom platform is allowed but has empty base', () => {
  assert.strictEqual(getPreset('custom').rtmpUrl, '');
  assert.ok(isKnownPlatform('custom'));
});

test('unknown platform is rejected', () => {
  assert.strictEqual(isKnownPlatform('myspace'), false);
});
