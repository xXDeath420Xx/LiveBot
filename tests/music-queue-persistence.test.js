import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * Queue restore across restarts (core/music-queue-persistence.js) against a fake player and a fake SQL
 * executor. Needs node_modules (discord.js / discord-player) — run on the server:
 *   BOT_ENCRYPTION_KEY=<any 64 hex> node --test tests/music-queue-persistence.test.js
 * What has to be right:
 *   - a queue change is saved; a position-only change is a light UPDATE; a stop deletes the row
 *   - a stop is never overtaken by a save that was already in flight (stopped music must not come back)
 *   - at shutdown, the final snapshot is written and the teardown's disconnects delete nothing
 *   - a restore takes only rows from an earlier process, drops expired / empty-channel ones, waits for
 *     the bot that was playing, and rebuilds the queue: tracks, position, volume, repeat, DJ metadata
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mqp-'));
process.env.LOG_DIR = tmp;
process.env.BOT_ENCRYPTION_KEY ||= 'a'.repeat(64);
process.env.MUSIC_QUEUE_SNAPSHOT_MS = '3600000';   // no periodic snapshots during the tests
const p = await import('../core/music-queue-persistence.js');
const snap = await import('../core/music-queue-snapshot.js');
test.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    // The bot modules this pulls in keep timers alive (config cache sweeps, the DB pool): end the run.
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
});

// Timers are driven through p._testing (fireSaves / flushSaves / settle / runRestorePass): no test
// waits for wall-clock time, so a loaded machine cannot fail one.
const NEVER = 3_600_000;   // a first restore pass that never fires on its own
const turns = () => new Promise(r => setImmediate(r));   // let queued microtasks and I/O callbacks run

function harness({ selectRows = [] } = {}) {
    p._testing.reset();
    const calls = [];
    p._testing.setExecutor(async (sql, params) => {
        calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        if (/^\s*SELECT/i.test(sql)) return selectRows;
        return { affectedRows: 1, insertId: 1 };
    });
    const player = { events: new EventEmitter(), nodes: { cache: new Map(), get(id) { return this.cache.get(id); } } };
    return { calls, player };
}

function track(title, extra = {}) {
    return { title, author: 'Artist', url: `https://www.youtube.com/watch?v=${title}`, duration: '3:00', durationMS: 180000,
        source: 'youtube', raw: { title }, requestedBy: { id: '111', username: 'alice', bot: false }, ...extra };
}

function liveQueue({ position = 60_000 } = {}) {
    const tracks = [track('next1'), track('next2')];
    return {
        guild: { id: 'g1', client: { user: { id: 'bot1' } } },
        channel: { id: 'vc1' },
        currentTrack: track('now'),
        tracks: { toArray: () => tracks, size: tracks.length },
        node: { playbackTime: position, isPaused: () => false, volume: 70 },
        isPlaying: () => true,
        repeatMode: 0,
        metadata: { channelId: 'tc1' },
    };
}

test('changes are saved, position-only changes are light, a stop deletes the row', async () => {
    const { calls, player } = harness();
    p.attachQueuePersistence(player);
    const q = liveQueue();
    player.nodes.cache.set('g1', q);

    player.events.emit('playerStart', q);
    await p._testing.flushSaves();
    const insert = calls.find(c => c.sql.startsWith('INSERT INTO music_queues'));
    assert.ok(insert, 'snapshot written');
    assert.equal(insert.params[0], 'g1');
    assert.equal(insert.params[5], 'vc1');
    assert.equal(insert.params[8], 60_000);
    assert.equal(insert.params[12], p.INSTANCE_ID);

    q.node.playbackTime = 75_000;
    player.events.emit('playerPause', q);
    await p._testing.flushSaves();
    const light = calls.filter(c => c.sql.startsWith('UPDATE music_queues SET position_ms'));
    assert.equal(light.length, 1, 'position-only change is an UPDATE');
    assert.equal(light[0].params[0], 75_000);

    player.nodes.cache.delete('g1');
    player.events.emit('queueDelete', q);
    await p._testing.settle();
    assert.ok(calls.at(-1).sql.startsWith('DELETE FROM music_queues WHERE guild_id = ?'));
    assert.deepEqual(calls.at(-1).params, ['g1']);
});

test('a stop is never overtaken by a save already in flight', async () => {
    const { calls, player } = harness();
    let release;
    const gate = new Promise(r => { release = r; });
    p._testing.setExecutor(async (sql, params) => {
        calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        if (sql.includes('INSERT INTO music_queues')) await gate;    // a slow write
        return { affectedRows: 1 };
    });
    p.attachQueuePersistence(player);
    const q = liveQueue();
    player.nodes.cache.set('g1', q);
    player.events.emit('playerStart', q);
    p._testing.fireSaves();
    await turns();
    assert.ok(calls.some(c => c.sql.startsWith('INSERT INTO music_queues')), 'the INSERT is in flight');
    player.nodes.cache.delete('g1');
    player.events.emit('queueDelete', q);
    await turns();
    assert.ok(!calls.some(c => c.sql.startsWith('DELETE')), 'DELETE waits for the in-flight save');
    release();
    await p._testing.settle();
    assert.ok(calls.at(-1).sql.startsWith('DELETE FROM music_queues'), 'and runs after it');
});

test('shutdown: final snapshot, then the teardown deletes nothing', async () => {
    const { calls, player } = harness();
    p.attachQueuePersistence(player);
    const q = liveQueue();
    player.nodes.cache.set('g1', q);
    player.events.emit('playerStart', q);
    await p._testing.flushSaves();
    q.node.playbackTime = 99_000;
    const saved = await p.freezeQueuePersistence(1000);
    assert.equal(saved, 1);
    assert.equal(calls.at(-1).params[0], 99_000, 'final position written');
    const before = calls.length;
    player.nodes.cache.delete('g1');
    player.events.emit('disconnect', q);
    player.events.emit('queueDelete', q);
    player.events.emit('playerStart', q);
    await p._testing.flushSaves();
    assert.equal(calls.length, before, 'nothing written or deleted after the freeze');
});

/** A fake guild with a voice channel holding `humans` people, served by `client`. */
function world({ humans = 2, ready = true } = {}) {
    const sent = [];
    const textChannel = { id: 'tc1', isTextBased: () => true, send: async (m) => { sent.push(m.content); return {}; } };
    const members = Array.from({ length: humans }, (_, i) => ({ user: { bot: false, id: `u${i}` } })).concat([{ user: { bot: true } }]);
    const voice = {
        id: 'vc1', name: 'Music', isVoiceBased: () => true,
        members: { filter: fn => ({ size: members.filter(fn).length }) },
        permissionsFor: () => ({ has: () => true }),
    };
    const guild = { id: 'g1', members: { me: { id: 'bot1' } }, channels: { cache: new Map([['vc1', voice], ['tc1', textChannel]]) } };
    const client = {
        user: { id: 'bot1', bot: true }, isReady: () => ready,
        guilds: { cache: new Map([['g1', guild]]) },
        users: { cache: new Map(), fetch: async () => null },
    };
    return { sent, guild, client, voice };
}

function savedRow(extra = {}) {
    const live = liveQueue({ position: 90_000 });
    live.repeatMode = 2;
    live.node.volume = 55;
    live.metadata = { channelId: 'tc1', djMode: true, prompt: 'yacht rock', djInitiatorId: '111', playedTracks: [{ title: 'x', playedAt: 1 }] };
    const row = snap.rowFromSnapshot(snap.buildSnapshot(live), 'old-process');
    return { ...row, age_sec: 40, ...extra };
}

test('restore: expired rows are discarded, rows from this process are never loaded', async () => {
    const { calls, player } = harness({ selectRows: [savedRow({ age_sec: 31 * 60 })] });
    const n = await p.startMusicQueueRestore({ player, client: null, firstDelayMs: 10 });
    assert.equal(n, 0);
    const select = calls.find(c => c.sql.startsWith('SELECT'));
    assert.match(select.sql, /instance_id IS NULL OR instance_id <> \?/);
    assert.deepEqual(select.params, [p.INSTANCE_ID]);
    assert.ok(calls.some(c => c.sql.startsWith('DELETE FROM music_queues') && c.params[0] === 'g1'));
});

test('restore: nobody left in the channel → dropped', async () => {
    const { calls, player } = harness({ selectRows: [savedRow()] });
    const w = world({ humans: 0 });
    global.botManager = { getAllClients: () => [w.client], getClientForGuild: () => w.client };
    assert.equal(await p.startMusicQueueRestore({ player, client: w.client, firstDelayMs: NEVER }), 1);
    await p._testing.runRestorePass();
    assert.deepEqual(p.pendingRestores(), []);
    assert.ok(calls.some(c => c.sql.startsWith('DELETE FROM music_queues')));
    delete global.botManager;
});

test('restore: waits for the bot that was playing, then rebuilds the queue', async () => {
    const { calls, player } = harness({ selectRows: [savedRow()] });
    const w = world({ humans: 2, ready: false });
    global.botManager = { getAllClients: () => [w.client], getClientForGuild: () => w.client };
    const created = [];
    player.extractors = { get: () => null };
    player.nodes.create = (guild, opts) => {
        const q = {
            guild, options: { ...opts }, metadata: opts.metadata, tracks: [], connection: null, channel: null, repeat: null, played: null,
            setMetadata(m) { this.metadata = m; },
            async connect(ch) { this.connection = {}; this.channel = ch; },
            addTrack(t) { this.tracks.push(...(Array.isArray(t) ? t : [t])); },
            setRepeatMode(m) { this.repeat = m; },
            node: { volume: null, setVolume(v) { this.volume = v; }, async play(t, o) { q.played = { t, o }; }, setPaused() {} },
        };
        created.push(q);
        player.nodes.cache.set(guild.id, q);
        return q;
    };
    await p.startMusicQueueRestore({ player, client: w.client, firstDelayMs: NEVER });
    await p._testing.runRestorePass();
    assert.deepEqual(p.pendingRestores(), ['g1'], 'bot not ready yet: still pending');
    assert.equal(created.length, 0);

    w.client.isReady = () => true;
    // The next pass now instead of waiting 30 s; awaited, so the rebuild has finished (no sleep).
    await p._testing.runRestorePass();
    assert.equal(created.length, 1, 'queue created');
    const q = created[0];
    assert.equal(q.channel.id, 'vc1');
    assert.equal(q.node.volume, 55);
    assert.equal(q.repeat, 2);
    assert.equal(q.metadata.djMode, true);
    assert.equal(q.metadata.prompt, 'yacht rock');
    assert.equal(q.metadata.isGenerating, false);
    assert.equal(q.tracks.length, 2);
    assert.equal(q.played.t.title, 'now');
    assert.equal(q.played.o.seek, 87_000);
    assert.equal(q.played.o.queue, false);
    assert.equal(q.options.leaveOnEnd, false);
    assert.match(w.sent[0], /picking the music back up: \*\*now\*\* by Artist from \*\*1:27\*\*, with \*\*2\*\* tracks/);
    assert.ok(calls.some(c => c.sql.startsWith('DELETE FROM music_queues') && /instance_id <> \?/.test(c.sql)), 'old row cleared');
    assert.deepEqual(p.pendingRestores(), []);
    delete global.botManager;
});
