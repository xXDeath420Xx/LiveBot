import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePlatformSources } from '../core/streamer-sync.js';

test('merges streamer rows + twitch links, deduped by platform:username', () => {
  const streamers = [
    { platform: 'twitch', username: 'xXDeath420Xx', platform_user_id: '111' },
    { platform: 'kick', username: 'death420', platform_user_id: '222' },
    { platform: 'youtube', username: 'xXDeath420Xx', platform_user_id: 'yt' },
    { platform: 'trovo', username: 'xXDeath420Xx', platform_user_id: null },
  ];
  const links = [{ twitch_username: 'xxdeath420xx', twitch_user_id: '111' }]; // dup of twitch (case-insensitive)
  const out = mergePlatformSources(streamers, links);
  assert.equal(out.length, 4); // twitch dup folded
  const platforms = out.map(o => o.platform).sort();
  assert.deepEqual(platforms, ['kick', 'trovo', 'twitch', 'youtube']);
});

test('twitch link is used when no streamer row exists for it', () => {
  const out = mergePlatformSources([], [{ twitch_username: 'someone', twitch_user_id: '999' }]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { platform: 'twitch', username: 'someone', platformUserId: '999' });
});

test('skips rows missing platform or username', () => {
  const out = mergePlatformSources(
    [{ platform: 'twitch', username: null }, { platform: null, username: 'x' }, { platform: 'kick', username: 'ok', platform_user_id: '1' }],
    [{ twitch_username: null }]
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].username, 'ok');
});
