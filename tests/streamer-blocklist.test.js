// Per-server blocked streamers (core/streamer-blocklist-logic.js): matching and input parsing, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    findBlock, findBlockByDiscordId, splitBlockedSubscriptions, parseStreamerInput, normLogin,
} from '../core/streamer-blocklist-logic.js';

const lyric = { id: 1, guild_id: 'g1', platform: 'twitch', platform_user_id: '1438198288', username: 'lyricbea420', streamer_discord_id: '1443107821666439328' };
const kickOnly = { id: 2, guild_id: 'g1', platform: 'kick', platform_user_id: null, username: 'SomeKicker' };

test('an entry with a user id matches that id even after a rename', () => {
    assert.equal(findBlock([lyric], { platform: 'twitch', platformUserId: '1438198288', username: 'newname' }), lyric);
});

test('an entry with a user id does not catch a different account that took the old name', () => {
    assert.equal(findBlock([lyric], { platform: 'twitch', platformUserId: '999', username: 'lyricbea420' }), null);
});

test('a streamers row without an id falls back to the login, case-insensitively', () => {
    assert.equal(findBlock([lyric], { platform: 'twitch', username: 'LyricBea420' }), lyric);
    assert.equal(findBlock([kickOnly], { platform: 'kick', platformUserId: '55', username: 'somekicker' }), kickOnly);
});

test('the platform has to match', () => {
    assert.equal(findBlock([lyric], { platform: 'kick', username: 'lyricbea420' }), null);
    assert.equal(findBlock([], { platform: 'twitch', username: 'x' }), null);
    assert.equal(findBlock(null, { platform: 'twitch', username: 'x' }), null);
});

test('the showcase looks entries up by the Discord account', () => {
    assert.equal(findBlockByDiscordId([kickOnly, lyric], '1443107821666439328'), lyric);
    assert.equal(findBlockByDiscordId([kickOnly, lyric], '1'), null);
    assert.equal(findBlockByDiscordId([kickOnly], null), null);
});

test('blocked subscriptions are dropped only in the server that blocked them', () => {
    const byGuild = new Map([['g1', [lyric]]]);
    const subs = [
        { subscription_id: 1, guild_id: 'g1', platform: 'twitch', platform_user_id: '1438198288', username: 'lyricbea420' },
        { subscription_id: 2, guild_id: 'g2', platform: 'twitch', platform_user_id: '1438198288', username: 'lyricbea420' },
        { subscription_id: 3, guild_id: 'g1', platform: 'twitch', platform_user_id: '42', username: 'someoneelse' },
    ];
    const { kept, dropped } = splitBlockedSubscriptions(subs, byGuild);
    assert.deepEqual(dropped.map(s => s.subscription_id), [1]);
    assert.deepEqual(kept.map(s => s.subscription_id), [2, 3]);
});

test('channel links and @names become logins', () => {
    assert.equal(parseStreamerInput('https://www.twitch.tv/LyricBea420?sr=a', 'twitch'), 'lyricbea420');
    assert.equal(parseStreamerInput('@LyricBea420', 'twitch'), 'lyricbea420');
    assert.equal(parseStreamerInput('kick.com/Some_Kicker/videos', 'kick'), 'some_kicker');
    assert.equal(parseStreamerInput('https://www.youtube.com/@Chan.Name', 'youtube'), 'chan.name');
    assert.equal(parseStreamerInput('https://tiktok.com/@tok_er', 'tiktok'), 'tok_er');
    assert.equal(parseStreamerInput('   ', 'twitch'), '');
    assert.equal(parseStreamerInput('<script>', 'twitch'), '');
    assert.equal(normLogin(' @Abc '), 'abc');
});

test('every path that announces a streamer consults the block list', () => {
    const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
    const wired = {
        'core/stream-manager.js': 'dropBlockedSubscriptions(subscriptions)',
        'events/presenceUpdate.js': 'findBlockedStreamer(guildId',
        'utils/streamer-cross-pollinate.js': 'isStreamerIdBlocked(',
        'core/community-support-manager.js': 'findBlockedStreamer(guildId',
        'events/communitySupportTracker.js': 'isDiscordUserBlocked(guildId, mentionedId)',
        'commands/admin/shoutout.js': 'findBlockedStreamer(guildId',
        'core/showcase-manager.js': 'isDiscordUserBlocked(message.guildId',
    };
    for (const [file, needle] of Object.entries(wired)) assert.ok(read(file).includes(needle), `${file} does not check the block list`);
    // the stream manager needs the account id on each subscription row to match renamed accounts
    assert.match(read('core/stream-manager.js'), /s\.profile_image_url, s\.platform_user_id\s+FROM subscriptions sub/);
});
