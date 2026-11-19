import test from 'node:test';
import assert from 'node:assert/strict';
import { attachPlayLog, livePlays } from '../core/music-play-log.js';

// A stand-in for discord-player: events + a node cache of queues with a current track.
function fakePlayer() {
    const listeners = {};
    return {
        events: { on: (e, fn) => { (listeners[e] ||= []).push(fn); } },
        nodes: { cache: new Map() },
        emit: (e, ...args) => (listeners[e] || []).forEach(fn => fn(...args)),
    };
}

test('livePlays: reports the current track with the player position and its play-log row', async () => {
    const player = fakePlayer();
    attachPlayLog(player, { write: async (sql) => (sql.startsWith('INSERT') ? { insertId: 42 } : {}), now: () => 1_000_000 });
    const track = { title: 'Feather', author: 'Nujabes', url: 'https://youtu.be/x', durationMS: 180_000, thumbnail: 'https://i.ytimg.com/x.jpg',
        requestedBy: { id: '1', username: 'dj', bot: false } };
    let paused = false;
    const queue = {
        guild: { id: 'g1', name: 'Guild One' }, channel: { id: 'v1', name: 'Lounge' }, metadata: {},
        currentTrack: track, tracks: { size: 3 },
        node: { playbackTime: 61_500, isPaused: () => paused },
    };
    player.nodes.cache.set('g1', queue);
    player.emit('playerStart', queue, track);
    await new Promise(r => setImmediate(r)); // let the INSERT resolve

    const [p] = livePlays(1_000_000).filter(x => x.guild_id === 'g1');
    assert.equal(p.playId, 42);
    assert.equal(p.positionMs, 61_500);
    assert.equal(p.durationMs, 180_000);
    assert.equal(p.paused, false);
    assert.equal(p.voice_channel_name, 'Lounge');
    assert.equal(p.upNext, 3);
    assert.equal(p.title, 'Feather');

    paused = true;
    assert.equal(livePlays().find(x => x.guild_id === 'g1').paused, true);
});

test('livePlays: falls back to wall-clock time minus pauses when the player has no position', async () => {
    const player = fakePlayer();
    let clock = 5_000_000;
    attachPlayLog(player, { write: async (sql) => (sql.startsWith('INSERT') ? { insertId: 7 } : {}), now: () => clock });
    const track = { title: 'Song', durationMS: 200_000, requestedBy: null };
    const queue = { guild: { id: 'g2', name: 'Two' }, metadata: {}, currentTrack: track, tracks: { size: 0 }, node: { isPaused: () => false } };
    player.nodes.cache.set('g2', queue);
    player.emit('playerStart', queue, track);
    clock += 30_000;
    player.emit('playerPause', queue);
    clock += 10_000;
    player.emit('playerResume', queue);
    clock += 5_000;
    const p = livePlays(clock).find(x => x.guild_id === 'g2');
    assert.equal(p.positionMs, 35_000); // 45s elapsed, 10s of it paused
});
