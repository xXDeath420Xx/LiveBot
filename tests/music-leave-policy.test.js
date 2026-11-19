import test from 'node:test';
import assert from 'node:assert/strict';
import {
    manageLeave, leaveIfIdle, reasonToStay, scheduleLeave, cancelLeave, sweepIdle, noteActivity,
    holdVoice, releaseVoice, setLeavePolicyDeps, SWEEP_IDLE_MS,
} from '../core/music-leave-policy.js';

const flags = { is247: false, transcribing: false, reading: false };
setLeavePolicyDeps({
    is247: async () => flags.is247,
    transcribing: () => flags.transcribing,
    reading: () => flags.reading,
});
const reset = () => Object.assign(flags, { is247: false, transcribing: false, reading: false });

// A stand-in GuildQueue. Like discord-player, isPlaying() stays true while paused.
function fakeQueue({ id = 'g1', playing = false, paused = false, tracks = 0, metadata = {}, humans = 0 } = {}) {
    const members = new Map([['bot', { user: { bot: true } }]]);
    for (let i = 0; i < humans; i++) members.set(`u${i}`, { user: { bot: false } });
    return {
        guild: { id }, options: { leaveOnEnd: true, leaveOnEmpty: true, leaveOnStop: true }, metadata,
        tracks: { size: tracks }, currentTrack: playing || paused ? { title: 'Song' } : null,
        channel: { members }, deleted: false,
        isPlaying: () => playing || paused,
        node: { isPaused: () => paused },
        delete() { this.deleted = true; },
    };
}
const playerWith = (...queues) => ({ nodes: { cache: new Map(queues.map(q => [q.guild.id, q])), get(id) { return this.cache.get(id); } } });

test('manageLeave switches every discord-player leave timer off and keeps playing to an empty room', () => {
    const q = fakeQueue();
    manageLeave(q);
    assert.equal(q.options.leaveOnEnd, false);
    assert.equal(q.options.leaveOnEmpty, false);
    assert.equal(q.options.leaveOnStop, false);
    assert.equal(q.options.pauseOnEmpty, false);
});

test('leaves an idle queue and runs the cleanup', async () => {
    reset();
    const q = fakeQueue({ humans: 2 });
    const left = [];
    assert.equal(await leaveIfIdle(q, { reason: 'queue ended', onLeft: (g, r) => left.push([g, r]) }), true);
    assert.equal(q.deleted, true);
    assert.deepEqual(left, [['g1', 'queue ended']]);
});

test('stays while music plays, even to an empty room; paused only counts with listeners', async () => {
    reset();
    assert.equal(await reasonToStay(fakeQueue({ playing: true, humans: 0 })), 'playing');
    assert.equal(await reasonToStay(fakeQueue({ paused: true, humans: 1 })), 'paused with listeners');
    const pausedAlone = fakeQueue({ paused: true, humans: 0 });
    assert.equal(await leaveIfIdle(pausedAlone, { requireEmpty: true }), true);
});

test('requireEmpty keeps the bot when people are still in the channel', async () => {
    reset();
    assert.equal(await reasonToStay(fakeQueue({ humans: 1 }), { requireEmpty: true }), 'listeners present');
});

test('24/7, transcription, the chat reader and explicit holds keep the bot in', async () => {
    reset();
    const q = fakeQueue();
    flags.is247 = true;
    assert.equal(await reasonToStay(q), '24/7 mode');
    reset(); flags.transcribing = true;
    assert.equal(await reasonToStay(q), 'transcription running');
    reset(); flags.reading = true;
    assert.equal(await reasonToStay(q), 'chat reader active');
    reset();
    holdVoice('g1', 'recording');
    assert.equal(await reasonToStay(q), 'held by recording');
    releaseVoice('g1', 'recording');
    assert.equal(await reasonToStay(q), null);
});

test('audio from outside the queue (Spotify-direct, reader TTS) on the connection keeps the bot in', async () => {
    reset();
    const q = fakeQueue();
    q.connection = { state: { subscription: { player: { state: { status: 'playing' } } } } };
    assert.equal(await reasonToStay(q), 'other audio on the connection');
    q.connection.state.subscription.player.state.status = 'idle';
    assert.equal(await reasonToStay(q), null);
});

test('queued tracks, a DJ still generating and a voice camp keep the bot in', async () => {
    reset();
    assert.equal(await reasonToStay(fakeQueue({ tracks: 2 })), 'tracks queued');
    assert.equal(await reasonToStay(fakeQueue({ metadata: { isGenerating: true } })), 'AI DJ building a playlist');
    assert.equal(await reasonToStay(fakeQueue({ metadata: { camp: true } })), 'voice camp');
});

test('a check for an old session never ends the guild\'s new queue', async () => {
    reset();
    const old = fakeQueue();
    const current = fakeQueue();
    assert.equal(await leaveIfIdle(old, { player: playerWith(current) }), false);
    assert.equal(old.deleted, false);
    assert.equal(current.deleted, false);
});

test('scheduleLeave fires after the delay; cancelLeave (a new track starting) stops it', async () => {
    reset();
    const kept = fakeQueue({ id: 'g-cancel' });
    scheduleLeave(kept, 20, {});
    cancelLeave('g-cancel');
    const gone = fakeQueue({ id: 'g-fire' });
    scheduleLeave(gone, 20, {});
    await new Promise(r => setTimeout(r, 60));
    assert.equal(kept.deleted, false);
    assert.equal(gone.deleted, true);
});

test('sweepIdle leaves idle unclaimed queues but not recently active ones', async () => {
    reset();
    const now = 10_000_000;
    const stale = fakeQueue({ id: 'g-stale' });
    const fresh = fakeQueue({ id: 'g-fresh' });
    const busy = fakeQueue({ id: 'g-busy', playing: true });
    noteActivity('g-stale', now - SWEEP_IDLE_MS - 1);
    noteActivity('g-fresh', now - 1_000);
    noteActivity('g-busy', now - SWEEP_IDLE_MS - 1);
    const left = await sweepIdle(playerWith(stale, fresh, busy), { now });
    assert.equal(left, 1);
    assert.equal(stale.deleted, true);
    assert.equal(fresh.deleted, false);
    assert.equal(busy.deleted, false);
});
