import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * Queue restore snapshots (core/music-queue-snapshot.js). What has to be right:
 *   - a queue round-trips through the music_queues row: current track + position, upcoming tracks,
 *     volume, repeat mode, paused state and the DJ-mode metadata
 *   - things that can't come back are left out (DJ voice clips are local files), huge queues are capped
 *   - titles are not double-escaped (discord-player escapes markdown in Track.title)
 *   - resume position: a few seconds back; Spotify tracks from the start; a nearly-finished track
 *     moves on to the next; old snapshots expire
 */
const s = await import('../core/music-queue-snapshot.js');

function track(over = {}) {
    return {
        title: 'Never Gonna Give You Up', author: 'Rick Astley', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        thumbnail: 'https://i.ytimg.com/x.jpg', duration: '3:33', durationMS: 213000, source: 'youtube',
        queryType: 'youtubeVideo', extractor: { identifier: 'com.certifried.ytdlp-universal' },
        requestedBy: { id: '111', username: 'alice', globalName: 'Alice', bot: false },
        metadata: { artist: 'Rick Astley', nested: { a: 1 } }, raw: { title: 'Never Gonna Give You Up' },
        ...over,
    };
}

function queue(over = {}) {
    const tracks = over.tracks ?? [track({ title: 'Africa', url: 'https://www.youtube.com/watch?v=FTQbiNvZqaY', raw: {} })];
    return {
        guild: { id: 'g1', client: { user: { id: 'bot1' } } },
        channel: { id: 'vc1' },
        currentTrack: 'currentTrack' in over ? over.currentTrack : track(),
        tracks: { toArray: () => tracks, size: tracks.length },
        node: { playbackTime: over.position ?? 95_000, isPaused: () => !!over.paused, volume: over.volume ?? 65 },
        isPlaying: () => true,
        repeatMode: over.repeatMode ?? 2,
        metadata: over.metadata ?? {
            channelId: 'tc1', djMode: true, inputSong: 'Africa', inputArtist: 'Toto', prompt: 'yacht rock',
            djInitiatorId: '111', isGenerating: true, playedTracks: [{ title: 'Rosanna', playedAt: 5 }],
            secret: { token: 'x' },
        },
    };
}

test('a queue round-trips through the music_queues row', () => {
    const snap = s.buildSnapshot(queue(), { describe: () => ({ requestSource: 'search' }) });
    const row = s.rowFromSnapshot(snap, 'pid-1');
    assert.equal(row.guild_id, 'g1');
    assert.equal(row.voice_channel_id, 'vc1');
    assert.equal(row.text_channel_id, 'tc1');
    assert.equal(row.bot_user_id, 'bot1');
    assert.equal(row.position_ms, 95_000);
    assert.equal(row.volume, 65);
    assert.equal(row.repeat_mode, 2);
    assert.equal(row.instance_id, 'pid-1');

    const back = s.snapshotFromRow({ ...row, age_sec: 30 });
    assert.equal(back.current.title, 'Never Gonna Give You Up');
    assert.equal(back.current.extractor, 'com.certifried.ytdlp-universal');
    assert.equal(back.current.requestSource, 'search');
    assert.deepEqual(back.current.requestedBy, { id: '111', username: 'alice', globalName: 'Alice', bot: false });
    assert.deepEqual(back.current.metadata, { artist: 'Rick Astley' });   // the nested object is dropped
    assert.equal(back.upcoming.length, 1);
    assert.equal(back.upcoming[0].title, 'Africa');
    assert.equal(back.positionMs, 95_000);
    assert.equal(back.meta.djMode, true);
    assert.equal(back.meta.prompt, 'yacht rock');
    assert.equal(back.meta.isGenerating, undefined);
    assert.equal(back.meta.secret, undefined);
    assert.deepEqual(back.meta.playedTracks, [{ title: 'Rosanna', playedAt: 5 }]);
    assert.equal(back.totalUpcoming, 1);
});

test('titles are not escaped twice', () => {
    const t = track({ title: 'Some\\_Song \\*live\\*', raw: {} });
    assert.equal(s.serializeTrack(t).title, 'Some_Song *live*');
    assert.equal(s.serializeTrack(track({ title: 'esc\\_aped', raw: { title: 'real_title' } })).title, 'real_title');
});

test('DJ voice clips and local files are not kept; huge queues are capped', () => {
    assert.equal(s.serializeTrack(track({ url: '/home/death/temp_audio/x.wav' })), null);
    assert.equal(s.serializeTrack(track({ metadata: { isDJCommentary: true } })), null);
    const many = Array.from({ length: 700 }, (_, i) => track({ title: `T${i}`, url: `https://youtu.be/${i}` }));
    many.splice(3, 0, track({ url: 'C:/local.wav' }));
    const snap = s.buildSnapshot(queue({ tracks: many }));
    assert.equal(snap.upcoming.length, s.MAX_SAVED_TRACKS);
    assert.equal(snap.totalUpcoming, 701);
});

test('nothing to restore → no snapshot (but a DJ session between batches is kept)', () => {
    assert.equal(s.buildSnapshot(queue({ currentTrack: null, tracks: [], metadata: { camp: true } })), null);
    const dj = s.buildSnapshot(queue({ currentTrack: null, tracks: [], metadata: { djMode: true, channelId: 't' } }));
    assert.ok(dj);
    const plan = s.planRestore(s.snapshotFromRow(s.rowFromSnapshot(dj, 'x')), { ageMs: 0 });
    assert.equal(plan.action, 'restore');
    assert.equal(plan.djRefill, true);
    assert.equal(plan.current, null);
});

test('resume position', () => {
    const yt = { url: 'https://youtu.be/x', durationMS: 200_000, source: 'youtube' };
    assert.deepEqual(s.resumePosition(yt, 95_000), { seekMs: 92_000, skip: false });
    assert.deepEqual(s.resumePosition(yt, 2_000), { seekMs: 0, skip: false });       // barely started
    assert.deepEqual(s.resumePosition(yt, 195_000), { seekMs: 0, skip: true });      // all but over
    assert.deepEqual(s.resumePosition(yt, 195_000, { repeatMode: 1 }), { seekMs: 192_000, skip: false });
    const sp = { url: 'https://open.spotify.com/track/abc', durationMS: 200_000, source: 'spotify' };
    assert.deepEqual(s.resumePosition(sp, 95_000), { seekMs: 0, skip: false });
    assert.deepEqual(s.resumePosition({ url: 'https://x/live', durationMS: 0 }, 60_000), { seekMs: 57_000, skip: false });
    assert.deepEqual(s.resumePosition(null, 5), { seekMs: 0, skip: false });
});

test('planRestore: expiry, a finished current track, and an empty queue', () => {
    const snap = s.snapshotFromRow(s.rowFromSnapshot(s.buildSnapshot(queue()), 'x'));
    assert.equal(s.planRestore(snap, { ageMs: 31 * 60_000 }).action, 'expired');
    const ok = s.planRestore(snap, { ageMs: 60_000 });
    assert.equal(ok.action, 'restore');
    assert.equal(ok.current.title, 'Never Gonna Give You Up');
    assert.equal(ok.seekMs, 92_000);
    assert.equal(ok.upcoming.length, 1);

    const nearEnd = s.snapshotFromRow(s.rowFromSnapshot(s.buildSnapshot(queue({ position: 210_000 })), 'x'));
    const moved = s.planRestore(nearEnd, { ageMs: 0 });
    assert.equal(moved.current.title, 'Africa');
    assert.equal(moved.seekMs, 0);
    assert.equal(moved.upcoming.length, 0);
    assert.equal(moved.skippedCurrent, true);

    const lastAndDone = s.snapshotFromRow(s.rowFromSnapshot(s.buildSnapshot(queue({ position: 210_000, tracks: [], metadata: {} })), 'x'));
    assert.equal(s.planRestore(lastAndDone, { ageMs: 0 }).action, 'empty');
    assert.equal(s.planRestore(null, { ageMs: 0 }).action, 'empty');
});

test('rows from the old, never-used schema and bad JSON are tolerated', () => {
    assert.equal(s.snapshotFromRow(null), null);
    const old = s.snapshotFromRow({ guild_id: 'g', queue: 'not json', is_playing: 1, is_paused: 0, now_playing: null });
    assert.deepEqual(old.upcoming, []);
    assert.equal(old.current, null);
    assert.equal(s.planRestore(old, { ageMs: 0 }).action, 'empty');
});

test('row signature ignores the playback position', () => {
    const a = s.rowFromSnapshot(s.buildSnapshot(queue({ position: 10_000 })), 'x');
    const b = s.rowFromSnapshot(s.buildSnapshot(queue({ position: 50_000, paused: true })), 'x');
    assert.equal(s.rowSignature(a), s.rowSignature(b));
    const c = s.rowFromSnapshot(s.buildSnapshot(queue({ volume: 20 })), 'x');
    assert.notEqual(s.rowSignature(a), s.rowSignature(c));
});

test('restore notice', () => {
    assert.equal(s.formatClock(83_000), '1:23');
    assert.equal(s.formatClock(3_723_000), '1:02:03');
    const n = s.restoreNotice({ title: 'Africa', author: 'Toto', seekMs: 83_000, upcomingCount: 4, droppedCount: 2, djMode: true, paused: true });
    assert.match(n, /\*\*Africa\*\* by Toto from \*\*1:23\*\*, with \*\*4\*\* tracks still queued\./);
    assert.match(n, /2 queued tracks could not be kept/);
    assert.match(n, /AI DJ session carries on/);
    assert.match(n, /\/music resume/);
    assert.match(s.restoreNotice({ title: 'X', seekMs: 0, upcomingCount: 0, spotifyRestart: true }), /from the start/);
});
