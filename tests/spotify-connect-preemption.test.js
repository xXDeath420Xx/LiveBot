import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { acquire, release } from '../core/spotify-connect-manager.js';
import { spotifyBumpedStop } from '../handlers/music/player.js';

/*
 * H-760: when the bot owner takes the shared Spotify account (go-librespot session) from another server, the BUMPED
 * holder's stop function must run, not the owner's. acquire() used to read session.stopHolder in a microtask after it
 * had already been replaced with the owner's, so the owner's own queue was deleted and the "owner started Spotify"
 * notice went to the owner's channel, while the bumped server was never told.
 *
 * The real acquire() / release() from core/spotify-connect-manager.js on fake in-memory sessions (no go-librespot, no
 * Spotify account), and the Discord queue's real stop function (handlers/music/player.js spotifyBumpedStop) on fake
 * discord-player queues.
 */

const tick = () => new Promise((r) => setImmediate(r));
const session = (id = 'owner') => ({ id, busyGuildId: null, ownerHeld: false, stopHolder: null, activeStream: null });

/** A discord-player queue as spotifyBumpedStop sees it: its guild, its text channel, delete(). */
function fakeQueue(guildId, channelId) {
    const q = {
        sent: [], deleted: 0,
        metadata: { channelId },
        guild: {
            id: guildId,
            client: { channels: { fetch: async (id) => (id === channelId ? { id, send: async (text) => { q.sent.push(text); } } : null) } },
        },
        delete() { q.deleted++; },
    };
    return q;
}

test("the owner preempting a server: the bumped server's stop runs once, the owner's never", async () => {
    const s = session();
    const calls = [];
    let killed = false;
    assert.equal(acquire(s, 'guild-a', { owner: false, stopHolder: (info) => calls.push(['a', info]) }), true);
    s.activeStream = { kill: () => { killed = true; } };
    assert.equal(acquire(s, 'guild-owner', { owner: true, stopHolder: (info) => calls.push(['owner', info]) }), true);
    assert.equal(killed, true, "the bumped server's ffmpeg is killed at once (the FIFO is freed)");
    assert.equal(s.activeStream, null);
    assert.equal(s.busyGuildId, 'guild-owner');
    assert.equal(s.ownerHeld, true);
    await tick();
    assert.deepEqual(calls, [['a', { preempted: true, by: 'guild-owner', from: 'guild-a' }]]);
    assert.equal(typeof s.stopHolder, 'function', "the owner's stop is kept for later");
    s.stopHolder({});
    assert.equal(calls.at(-1)[0], 'owner', 'and it is the one stored now');
});

test("the bumped server's stop cannot free or steal the owner's session", async () => {
    const s = session();
    acquire(s, 'guild-a', { owner: false, stopHolder: () => release(s, 'guild-a') });
    acquire(s, 'guild-owner', { owner: true, stopHolder: () => {} });
    await tick();
    assert.equal(s.busyGuildId, 'guild-owner', 'release() of a guild that no longer holds it changes nothing');
    assert.equal(s.ownerHeld, true);
});

test('no preemption: a non-owner never takes it, the owner never takes it from the owner, the same server re-acquires quietly', async () => {
    const s = session();
    let stops = 0;
    acquire(s, 'guild-a', { owner: false, stopHolder: () => { stops++; } });
    assert.equal(acquire(s, 'guild-b', { owner: false, stopHolder: () => { stops++; } }), false, 'busy for another non-owner');
    assert.equal(acquire(s, 'guild-a', { owner: false, stopHolder: () => { stops++; } }), true, 'the holder itself (next track)');
    await tick();
    assert.equal(stops, 0);
    acquire(s, 'guild-owner', { owner: true, stopHolder: () => {} });
    await tick();
    assert.equal(stops, 1);
    assert.equal(acquire(s, 'guild-owner-2', { owner: true, stopHolder: () => {} }), false, 'one stream per account, even for the owner');
    assert.equal(s.busyGuildId, 'guild-owner');
});

test('a stop function that throws or rejects does not break the preemption', async () => {
    const s = session();
    acquire(s, 'guild-a', { owner: false, stopHolder: () => { throw new Error('boom'); } });
    assert.equal(acquire(s, 'guild-owner', { owner: true }), true);
    const s2 = session('u_x');
    acquire(s2, 'guild-a', { owner: false, stopHolder: async () => { throw new Error('boom'); } });
    assert.equal(acquire(s2, 'guild-owner', { owner: true }), true);
    await tick();
    assert.equal(s.busyGuildId, 'guild-owner');
    assert.equal(s2.busyGuildId, 'guild-owner');
});

test("Discord music: the notice goes to the bumped server's channel and only its queue ends", async () => {
    const s = session();
    const bumped = fakeQueue('guild-a', 'chan-a');
    const ownerQueue = fakeQueue('guild-owner', 'chan-owner');
    acquire(s, 'guild-a', { owner: false, stopHolder: spotifyBumpedStop(bumped) });
    acquire(s, 'guild-owner', { owner: true, stopHolder: spotifyBumpedStop(ownerQueue) });
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(bumped.deleted, 1, "the bumped server's queue ends");
    assert.equal(bumped.sent.length, 1);
    assert.match(bumped.sent[0], /owner started Spotify on the shared account/);
    assert.equal(ownerQueue.deleted, 0, "the owner's own queue keeps playing");
    assert.equal(ownerQueue.sent.length, 0, 'and the owner gets no notice');
    assert.equal(s.busyGuildId, 'guild-owner');
});
