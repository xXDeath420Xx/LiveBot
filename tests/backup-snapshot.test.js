import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';

/*
 * createSnapshot() is used by the weekly auto-backup AND the dashboard's "create backup" button.
 * discord.js keeps active threads in guild.channels.cache; a thread has no permissionOverwrites, so
 * one open thread used to abort the whole backup ("Cannot read properties of undefined (reading
 * 'cache')" — 6 of 86 guilds on 2026-10-04). Threads are conversations, not structure: left out.
 */

process.env.LOG_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'bk-'));
const { createSnapshot } = await import('../utils/backup-utils.js');

const bits = (n) => ({ bitfield: BigInt(n) });
const overwrites = (...ows) => ({ cache: new Collection(ows.map(o => [o.id, o])) });
const channel = (id, type, extra = {}) => ({ id, name: `ch-${id}`, type, position: Number(id), parentId: null, isThread: () => false,
    permissionOverwrites: overwrites({ id: 'r1', type: 0, allow: bits(1024), deny: bits(0) }), ...extra });
const thread = (id) => ({ id, name: `thread-${id}`, type: 11, position: 0, parentId: '2', isThread: () => true }); // no overwrites

function fakeGuild(channels) {
    const everyone = { id: 'g', name: '@everyone', managed: false, position: 0, permissions: bits(0), members: new Collection() };
    return {
        id: 'g', name: 'Test Guild', client: { user: { id: 'bot' } }, memberCount: 0,
        description: null, verificationLevel: 0, defaultMessageNotifications: 0, explicitContentFilter: 0,
        systemChannelId: null, systemChannelFlags: { bitfield: 0 }, rulesChannelId: null, publicUpdatesChannelId: null,
        afkChannelId: null, afkTimeout: 300, preferredLocale: 'en-US', premiumProgressBarEnabled: false,
        iconURL: () => null, bannerURL: () => null, splashURL: () => null,
        roles: { cache: new Collection([['g', everyone]]), everyone },
        members: { cache: new Collection(), fetch: async () => {} },
        channels: { cache: new Collection(channels.map(c => [c.id, c])) },
        emojis: { cache: new Collection() }, stickers: { cache: new Collection() },
    };
}

test('a guild with an active thread backs up; the thread is not saved as a channel', async () => {
    const snap = await createSnapshot(fakeGuild([channel('1', 4), channel('2', 0, { parentId: '1' }), thread('99')]));
    const s = snap.discord ?? snap;
    assert.deepEqual(s.categories.map(c => c.id), ['1']);
    assert.deepEqual(s.channels.map(c => c.id), ['2']);
    assert.deepEqual(s.channels[0].permissionOverwrites, [{ id: 'r1', type: 0, allow: '1024', deny: '0' }]);
});

test('a channel type without overwrites contributes none instead of aborting the backup', async () => {
    const odd = { ...channel('5', 0), permissionOverwrites: undefined };
    const snap = await createSnapshot(fakeGuild([odd]));
    assert.deepEqual((snap.discord ?? snap).channels[0].permissionOverwrites, []);
});
