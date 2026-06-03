import { test } from 'node:test';
import assert from 'node:assert';
import { PLATFORM_META, getAdapter, listConnectable } from '../services/platforms/registry.js';

test('declares mode + reviewGated per platform', () => {
  assert.strictEqual(PLATFORM_META.twitch.mode, 'static');
  assert.strictEqual(PLATFORM_META.kick.mode, 'static');
  assert.strictEqual(PLATFORM_META.youtube.mode, 'dynamic');
  assert.strictEqual(PLATFORM_META.facebook.mode, 'dynamic');
  assert.strictEqual(PLATFORM_META.youtube.reviewGated, true);
  assert.strictEqual(PLATFORM_META.twitch.reviewGated, false);
});

test('getAdapter returns an adapter with the required methods', () => {
  const a = getAdapter('twitch');
  for (const m of ['getAuthUrl', 'handleCallback', 'connectDestination', 'resolveAtGoLive']) {
    assert.strictEqual(typeof a[m], 'function', `twitch adapter missing ${m}`);
  }
});

test('listConnectable includes OAuth platforms, excludes review-gated when flag is off', () => {
  const names = listConnectable({ enableGated: false }).map(p => p.platform);
  assert.ok(names.includes('twitch'));
  assert.ok(names.includes('kick'));   // kick OAuth restored (identity connect; key stays manual)
  assert.ok(!names.includes('youtube'));
});

test('kick is OAuth-connectable but has no key API (key entered manually)', () => {
  assert.strictEqual(PLATFORM_META.kick.oauthConnect, true);
  assert.strictEqual(PLATFORM_META.kick.keyApi, false);
});
