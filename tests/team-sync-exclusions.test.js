import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseLogin, buildExclusionSet, isExcluded } from '../core/team-sync-exclusions.js';

test('normaliseLogin accepts the ways admins type a Twitch name', () => {
    assert.equal(normaliseLogin('  SomeStreamer '), 'somestreamer');
    assert.equal(normaliseLogin('@SomeStreamer'), 'somestreamer');
    assert.equal(normaliseLogin('https://www.twitch.tv/SomeStreamer/videos'), 'somestreamer');
    assert.equal(normaliseLogin('twitch.tv/some_streamer'), 'some_streamer');
    assert.equal(normaliseLogin('no spaces allowed'), null);
    assert.equal(normaliseLogin('streamer extra words'), null);
    assert.equal(normaliseLogin('x'), null);
    assert.equal(normaliseLogin('bad-name!'), null);
    assert.equal(normaliseLogin(''), null);
});

test('exclusions match a roster member by login or by id, case-insensitively', () => {
    const set = buildExclusionSet([
        { platform: 'twitch', platform_user_id: '12345', username: 'Renamed' },
        { platform: 'twitch', platform_user_id: 'loginonly', username: 'loginonly' },
        { platform: 'kick', platform_user_id: '999', username: 'kickname' },
    ]);
    assert.equal(isExcluded(set, { user_login: 'newname', user_id: '12345' }), true);     // renamed, same id
    assert.equal(isExcluded(set, { user_login: 'RENAMED', user_id: '1' }), true);         // old login row
    assert.equal(isExcluded(set, { username: 'LoginOnly', platform_user_id: '777' }), true); // streamers row shape
    assert.equal(isExcluded(set, { user_login: 'kickname', user_id: '2' }), false);       // other platform
    assert.equal(isExcluded(set, { user_login: 'someoneelse', user_id: '3' }), false);
});

test('an empty exclusion list excludes nobody', () => {
    assert.equal(isExcluded(buildExclusionSet([]), { user_login: 'a', user_id: '' }), false);
    assert.equal(isExcluded(buildExclusionSet(null), { user_login: '', user_id: '' }), false);
});
