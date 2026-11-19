import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * The music play log turns discord-player's events into one row per play. What has to be right:
 *   - every play ends exactly once, whatever order the events arrive in (a manual skip ends the
 *     dispatcher BEFORE playerSkip is emitted; a failed stream emits playerSkip AND playerError)
 *   - the skipper is attributed (from the interaction being handled), pauses don't count as listening
 *   - a track that never streamed still gets a "failed" row with the reason
 *   - plays left "playing" by a restart are closed as "interrupted"
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpl-'));
process.env.LOG_DIR = tmp;
process.env.MUSIC_RESOLVERS = 'server2=http://127.0.0.1:49998|http://127.0.0.1:49999;workstation=http://127.0.0.1:49997';
const log = await import('../core/music-play-log.js');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function harness() {
    const player = { events: new EventEmitter() };
    const writes = [];
    let id = 0, clock = 1_800_000_000_000;
    const write = async (sql, params) => { writes.push({ sql, params }); return sql.startsWith('INSERT') ? { insertId: ++id } : { affectedRows: 1 }; };
    log.attachPlayLog(player, { write, now: () => clock, settleMs: 20 });
    const guild = { id: 'g1', name: 'The Hive' };
    const queue = (extra = {}) => ({ guild, channel: { id: 'vc1' }, metadata: {}, currentTrack: null, ...extra });
    const track = (extra = {}) => ({ title: 'Without Me', author: 'Eminem', url: 'https://open.spotify.com/track/abc', durationMS: 290_000,
        requestedBy: { id: 'u1', username: 'alice', bot: false }, metadata: { explicit: true }, ...extra });
    const emit = (ev, ...args) => player.events.emit(ev, ...args);
    const tick = (ms) => { clock += ms; };
    const settle = () => new Promise(r => setTimeout(r, 60));
    const updates = () => writes.filter(w => w.sql.startsWith('UPDATE music_play_log SET outcome = ?'));
    const inserts = () => writes.filter(w => w.sql.startsWith('INSERT'));
    const row = (w) => Object.fromEntries(w.sql.match(/\(([^)]+)\) VALUES/)[1].split(', ').map((c, i) => [c, w.params[i]]));
    return { emit, tick, settle, queue, track, writes, updates, inserts, row };
}

test('pure helpers: request kind, playback path, completed vs stopped', () => {
    assert.equal(log.classifyQuery('lose yourself eminem'), 'search');
    assert.equal(log.classifyQuery('https://youtu.be/abc'), 'youtube');
    assert.equal(log.classifyQuery('https://music.youtube.com/watch?v=abc'), 'youtube');
    assert.equal(log.classifyQuery('https://open.spotify.com/playlist/x'), 'spotify');
    assert.equal(log.pathOfUrl('http://127.0.0.1:49999/audio/aaaa?expire=1'), 'relay:server2');
    assert.equal(log.pathOfUrl('http://127.0.0.1:49997/audio/aaaa?expire=1'), 'relay:workstation');
    assert.equal(log.pathOfUrl('https://rr1---sn-x.googlevideo.com/videoplayback?x=1'), 'server1-direct');
    assert.equal(log.endOutcome(285, 290), 'completed');
    assert.equal(log.endOutcome(60, 290), 'stopped');
    assert.equal(log.endOutcome(5, null), 'completed');
});

test('a play that runs out is "completed", with who/what/where and how it played', async () => {
    const h = harness();
    const t = h.track();
    log.notePlayback(t, { path: 'spotify', account: 'shared' });
    h.emit('audioTrackAdd', h.queue(), t);
    h.tick(2000);
    h.emit('playerStart', h.queue({ currentTrack: t }), t);
    h.tick(290_000);
    h.emit('playerFinish', h.queue(), t);
    await h.settle();
    const r = h.row(h.inserts()[0]);
    assert.deepEqual([r.guild_name, r.requester_name, r.added_by, r.request_source, r.title, r.explicit, r.playback, r.spotify_account, r.outcome],
        ['The Hive', 'alice', 'user', 'spotify', 'Without Me', 1, 'spotify', 'shared', 'playing']);
    assert.ok(r.requested_at instanceof Date);
    assert.deepEqual(h.updates()[0].params.slice(0, 1).concat(h.updates()[0].params.slice(2, 3)), ['completed', 290]);
});

test('a manual skip is attributed to whoever pressed it — even when the finish event comes first', async () => {
    const h = harness();
    const t = h.track();
    h.emit('playerStart', h.queue({ currentTrack: t }), t);
    h.tick(30_000);
    log.actorContext.run({ userId: 'u2', name: 'bob' }, () => {
        h.emit('playerFinish', h.queue(), t);                  // dispatcher.end() → finish …
        h.emit('playerSkip', h.queue(), t, 'MANUAL', 'The track was skipped manually'); // … then the skip
    });
    await h.settle();
    assert.equal(h.updates().length, 1, 'one outcome per play');
    const [outcome, , listened, reason, by, byName] = h.updates()[0].params;
    assert.deepEqual([outcome, listened, reason, by, byName], ['skipped', 30, 'MANUAL', 'u2', 'bob']);
});

test('a track that never streamed gets one "failed" row with the reason', async () => {
    const h = harness();
    const t = h.track({ url: 'https://youtu.be/dead', source: 'youtube' });
    log.noteRequestKind(t, 'some search words');
    h.emit('playerSkip', h.queue(), t, 'ERR_NO_STREAM', 'Could not extract stream for this track\n\nError: bot wall');
    h.emit('playerError', h.queue(), new Error('Could not extract stream for this track'), t);
    await h.settle();
    assert.equal(h.inserts().length, 1);
    const r = h.row(h.inserts()[0]);
    assert.deepEqual([r.outcome, r.request_source, r.error], ['failed', 'search', 'Could not extract stream for this track']);
    assert.equal(h.updates().length, 0);
});

test('pauses do not count as listening; leaving early is "stopped"', async () => {
    const h = harness();
    const t = h.track();
    const q = h.queue({ currentTrack: t });
    h.emit('playerStart', q, t);
    h.tick(40_000);
    h.emit('playerPause', q);
    h.tick(600_000);                 // paused for 10 minutes
    h.emit('playerResume', q);
    h.tick(20_000);
    h.emit('disconnect', q);
    await h.settle();
    const [outcome, , listened] = h.updates()[0].params;
    assert.deepEqual([outcome, listened], ['stopped', 60]);
});

// discord-player deletes a queue in transition mode: no playerFinish for the playing track, and the deleted
// queue may no longer report it. Only a bot pulled out of voice also emits disconnect (after queueDelete).
test('/stop mid-song: the deleted queue closes its play as "stopped"', async () => {
    const h = harness();
    const t = h.track({ durationMS: 144_000 });
    h.emit('playerStart', h.queue({ currentTrack: t }), t);
    h.tick(27_000);
    h.emit('queueDelete', h.queue());              // currentTrack already gone
    await h.settle();
    assert.equal(h.updates().length, 1);
    const [outcome, , listened] = h.updates()[0].params;
    assert.deepEqual([outcome, listened], ['stopped', 27]);
});

test('bot pulled out of voice: queueDelete then disconnect still close the play once', async () => {
    const h = harness();
    const t = h.track();
    h.emit('playerStart', h.queue({ currentTrack: t }), t);
    h.tick(50_000);
    h.emit('queueDelete', h.queue());
    h.emit('disconnect', h.queue());
    await h.settle();
    assert.equal(h.updates().length, 1, 'one outcome per play');
    assert.equal(h.updates()[0].params[0], 'stopped');
});

test('queue ran out, then the bot left: the play stays "completed"', async () => {
    const h = harness();
    const t = h.track();
    h.emit('playerStart', h.queue({ currentTrack: t }), t);
    h.tick(290_000);
    h.emit('playerFinish', h.queue(), t);
    h.emit('queueDelete', h.queue());              // leave right after the queue ends
    await h.settle();
    assert.equal(h.updates().length, 1);
    assert.equal(h.updates()[0].params[0], 'completed');
});

test('a deleted queue only closes its own guild\'s play', async () => {
    const h = harness();
    const a = h.track({ title: 'A' }), b = h.track({ title: 'B' });
    h.emit('playerStart', h.queue({ currentTrack: a }), a);
    h.emit('playerStart', { ...h.queue({ currentTrack: b }), guild: { id: 'g2', name: 'Other' } }, b);
    h.tick(30_000);
    h.emit('queueDelete', h.queue());              // guild g1 only
    await h.settle();
    assert.equal(h.updates().length, 1);
    assert.equal(h.updates()[0].params.at(-1), 1, 'the g1 row (id 1), not g2');
});

test('autoplay / DJ additions are not attributed to a person', async () => {
    const h = harness();
    const t = h.track({ requestedBy: { id: 'bot', username: 'CertiFried', bot: true } });
    h.emit('playerStart', h.queue({ metadata: { djMode: true } }), t);
    await h.settle();
    const r = h.row(h.inserts()[0]);
    assert.deepEqual([r.requester_id, r.added_by], [null, 'dj']);
});

test('on start-up, plays left "playing" by a restart are closed as "interrupted"', () => {
    const h = harness();
    assert.match(h.writes[0].sql, /SET outcome = 'interrupted'.*WHERE outcome = 'playing' AND logged_at < \?/);
});

test('withActor: interactions and messages carry their user; other events do not', () => {
    const seen = [];
    log.withActor('interactionCreate', [{ user: { id: 'u9', username: 'zed' } }], () => seen.push(log.actorContext.getStore()));
    log.withActor('messageCreate', [{ author: { id: 'u8', globalName: 'Yan' } }], () => seen.push(log.actorContext.getStore()));
    log.withActor('guildMemberAdd', [{}], () => seen.push(log.actorContext.getStore() ?? null));
    assert.deepEqual(seen, [{ userId: 'u9', name: 'zed' }, { userId: 'u8', name: 'Yan' }, null]);
});
