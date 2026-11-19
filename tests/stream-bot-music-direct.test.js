import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import express from 'express';
import pool from '../utils/db.js';
import { makeTables, makeProfile } from './fixtures/stream-bot-tables.js';
import { musicDdl, MUSIC_TABLES, playLogAlter } from '../migrations/457_stream_bot_music.js';
import { createSpotifyDirect, ffmpegMp3 } from '../core/stream-bot/music/spotify-direct.js';
import { createMusic } from '../core/stream-bot/music/index.js';
import { createSigner } from '../core/stream-bot/music/audio.js';
import { withDefaults } from '../core/stream-bot/music/settings.js';

/*
 * Spotify-direct for stream song requests (core/stream-bot/music/spotify-direct.js) against a FAKE session manager and a
 * pass-through encoder: no go-librespot, no Spotify account (the owner's included) is touched. Covered: who may use it
 * (the owner, linked streamers; never the shared fallback account), acquire as a non-owner so Discord voice is never
 * preempted (busy → the YouTube Music match), the owner taking the session back for Discord, pause / resume / seek sent
 * to go-librespot, pause before the FIFO reader is retired, back-pressure when nothing reads, the player's live stream
 * over HTTP, early ends and the 30-minute rest, the play log (playback 'spotify', context 'stream'), and the Music page
 * status. One test runs the real ffmpeg MP3 encoder on synthetic audio.
 */

const SP = 'sp:4uLU6hMCjMI75M1A2tKUQC';
const clock = { t: Date.parse('2026-11-19T17:00:00Z') };
const now = () => clock.t;

/**
 * The manager's acquire / release rules (core/spotify-connect-manager.js), on in-memory sessions, as they are: an owner
 * preemption kills the holder's streamTrack ffmpeg (session.activeStream) and calls session.stopHolder in a microtask,
 * after the new holder's stopHolder has replaced it.
 */
function fakeManager({ owner = 'owner-1', linked = ['linked-2'], brokenLinked = [] } = {}) {
    const sessions = { owner: { id: 'owner', busyGuildId: null }, 'u_linked-2': { id: 'u_linked-2', busyGuildId: null } };
    const m = {
        calls: [], streams: [], sessions,
        isOwnerUser: (id) => id === owner,
        isLinked: async (id) => linked.includes(id) || brokenLinked.includes(id),
        getSessionForUser: async (id) => (id === owner ? sessions.owner : linked.includes(id) ? sessions[`u_${id}`] : sessions.owner),
        acquire(session, guildId, { owner: isOwner = false, stopHolder = null } = {}) {
            m.calls.push(['acquire', session.id, guildId, isOwner]);
            if (session.busyGuildId && session.busyGuildId !== guildId) {
                if (isOwner && !session.ownerHeld) {
                    try { session.activeStream?.kill('SIGKILL'); } catch { /* gone */ }
                    session.activeStream = null;
                    Promise.resolve().then(() => session.stopHolder?.()).catch(() => {});
                } else return false;
            }
            Object.assign(session, { busyGuildId: guildId, ownerHeld: isOwner, stopHolder });
            return true;
        },
        release(session, guildId) { m.calls.push(['release', session.id, guildId]); if (!guildId || session.busyGuildId === guildId) Object.assign(session, { busyGuildId: null, ownerHeld: false, stopHolder: null }); },
        streamTrack: async (session, uri) => {
            m.calls.push(['streamTrack', session.id, uri]);
            if (m.noAudio) return null;
            const s = new PassThrough();
            m.streams.push(s);
            session.activeStream = { kill: () => s.end() };
            return s;
        },
        pause: async (session) => { m.calls.push(['pause', session.id]); },
        resume: async (session) => { m.calls.push(['resume', session.id]); },
        seek: async (session, ms) => { m.calls.push(['seek', session.id, ms]); },
    };
    return m;
}
function fakeEncoder() {
    const made = [];
    const encode = () => { const pt = new PassThrough(); const e = { stdin: pt, stdout: pt, killed: false, kill() { e.killed = true; } }; made.push(e); return e; };
    return { encode, made };
}
const names = (m) => m.calls.map((c) => c[0]);
const item = (extra = {}) => ({ trackKey: SP, title: 'Golden Hour', artist: 'Maple Hollow Band', durationMs: 200_000, ...extra });
const tick = () => new Promise((r) => setImmediate(r));

test('who may use it: the owner and linked streamers; anyone else, or a song not from Spotify, never reaches a session', async () => {
    const m = fakeManager();
    const d = createSpotifyDirect({ manager: m, encode: fakeEncoder().encode, now });
    assert.deepEqual(await d.eligible('owner-1'), { ok: true, why: 'owner' });
    assert.deepEqual(await d.eligible('linked-2'), { ok: true, why: 'linked' });
    assert.deepEqual(await d.eligible('someone'), { ok: false, why: 'not_linked' });
    assert.equal((await d.open({ profileId: 1, discordUserId: 'someone', item: item() })).reason, 'not_linked');
    assert.equal((await d.open({ profileId: 1, discordUserId: 'owner-1', item: item({ trackKey: 'yt:aaaaaaaaaaa' }) })).reason, 'not_spotify');
    assert.equal(m.calls.length, 0, 'no session was asked for');
});

test("a linked streamer whose own instance did not start is never given the shared owner account", async () => {
    const m = fakeManager({ linked: [], brokenLinked: ['linked-3'] });
    const d = createSpotifyDirect({ manager: m, encode: fakeEncoder().encode, now });
    assert.equal((await d.open({ profileId: 1, discordUserId: 'linked-3', item: item() })).reason, 'no_audio');
    assert.ok(!names(m).includes('acquire'));
});

test('Discord voice holding the session: the stream does not take it (busy), and the Discord holder is untouched', async () => {
    const m = fakeManager();
    let stopped = false;
    m.acquire(m.sessions.owner, 'guild-9', { owner: false, stopHolder: () => { stopped = true; } });
    const d = createSpotifyDirect({ manager: m, encode: fakeEncoder().encode, now });
    const r = await d.open({ profileId: 1, discordUserId: 'owner-1', item: item() });
    assert.equal(r.reason, 'busy');
    assert.deepEqual(m.calls.find((c) => c[2] === 'stream:1'), ['acquire', 'owner', 'stream:1', false], 'always as a non-owner: never preempts');
    assert.equal(m.sessions.owner.busyGuildId, 'guild-9');
    await tick();
    assert.equal(stopped, false);
    assert.ok(!names(m).includes('streamTrack'));
});

test('a live song streams to one player over HTTP, follows pause / resume / seek, ends naturally and releases the session', async () => {
    const m = fakeManager();
    const enc = fakeEncoder();
    const d = createSpotifyDirect({ manager: m, encode: enc.encode, now });
    const r = await d.open({ profileId: 2, discordUserId: 'linked-2', item: item() });
    assert.ok(r.ok);
    assert.equal(r.live.account, 'linked');
    assert.equal(m.sessions['u_linked-2'].busyGuildId, 'stream:2');
    assert.deepEqual(m.calls.find((c) => c[0] === 'streamTrack'), ['streamTrack', 'u_linked-2', 'spotify:track:4uLU6hMCjMI75M1A2tKUQC']);
    const app = express();
    app.get('/a', (req, res) => r.live.attach(req, res));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((x) => server.once('listening', x));
    const wav = m.streams[0];
    wav.write(Buffer.from('frame-1'));
    const resp = await fetch(`http://127.0.0.1:${server.address().port}/a`, { headers: { range: 'bytes=100-' } });
    assert.equal(resp.status, 200, 'a live stream ignores Range');
    assert.equal(resp.headers.get('content-type'), 'audio/mpeg');
    assert.equal(resp.headers.get('accept-ranges'), 'none');
    await r.live.pause();
    await r.live.resume();
    await r.live.seek(0);
    assert.deepEqual(m.calls.filter((c) => ['pause', 'resume', 'seek'].includes(c[0])), [['pause', 'u_linked-2'], ['resume', 'u_linked-2'], ['seek', 'u_linked-2', 0]]);
    wav.write(Buffer.from('frame-2'));
    clock.t += 199_000;
    wav.end();
    const body = Buffer.from(await resp.arrayBuffer()).toString();
    assert.equal(body, 'frame-1frame-2');
    const done = await r.live.done;
    assert.deepEqual(done, { why: 'ended', early: false, preempted: false });
    assert.equal(m.sessions['u_linked-2'].busyGuildId, null, 'released');
    assert.equal(d.suspension(2), null);
    server.close();
});

test('a skip pauses go-librespot before the readers go (never an EPIPE), and is not taken as someone else using the account', async () => {
    const m = fakeManager();
    const enc = fakeEncoder();
    const d = createSpotifyDirect({ manager: m, encode: enc.encode, now });
    const r = await d.open({ profileId: 3, discordUserId: 'owner-1', item: item() });
    const done = await r.live.close('skipped');
    assert.equal(done.why, 'skipped');
    assert.equal(done.early, false);
    const iPause = m.calls.findIndex((c) => c[0] === 'pause');
    assert.ok(iPause >= 0, 'paused');
    assert.equal(enc.made[0].killed, false, 'the encoder is still alive right after the pause');
    await new Promise((x) => setTimeout(x, 300));
    assert.equal(enc.made[0].killed, true, 'then retired');
    assert.equal(m.sessions.owner.busyGuildId, null);
    assert.equal(d.suspension(3), null);
});

test('the owner taking the session for Discord ends the stream song and rests Spotify-direct for 30 minutes', async () => {
    const m = fakeManager();
    const d = createSpotifyDirect({ manager: m, encode: fakeEncoder().encode, now });
    const r = await d.open({ profileId: 4, discordUserId: 'owner-1', item: item() });
    assert.equal(m.acquire(m.sessions.owner, 'guild-owner', { owner: true }), true);
    const done = await r.live.done;
    assert.equal(done.preempted, true, 'seen from the session holder: our audio ended because the owner took it');
    assert.equal(m.sessions.owner.busyGuildId, 'guild-owner', 'the stream did not release the Discord holder');
    assert.match(d.suspension(4).why, /taken for Discord/);
    assert.equal((await d.open({ profileId: 4, discordUserId: 'owner-1', item: item() })).reason, 'suspended');
    clock.t += 31 * 60_000;
    assert.equal(d.suspension(4), null);
});

test('Spotify stopping early (the account started playing elsewhere) rests Spotify-direct; no audio at all is a plain fallback', async () => {
    const m = fakeManager();
    const d = createSpotifyDirect({ manager: m, encode: fakeEncoder().encode, now });
    const r = await d.open({ profileId: 5, discordUserId: 'owner-1', item: item() });
    clock.t += 10_000;
    m.streams.at(-1).end();
    const done = await r.live.done;
    assert.equal(done.early, true);
    assert.match(d.suspension(5).why, /playing somewhere else/);
    m.noAudio = true;
    assert.equal((await d.open({ profileId: 6, discordUserId: 'owner-1', item: item() })).reason, 'no_audio');
    assert.equal(m.sessions.owner.busyGuildId, null, 'released after a failed start');
});

test('nothing reading: the buffer stops at its cap and the pipe pushes back; no player at all closes the song', async () => {
    const m = fakeManager();
    const enc = fakeEncoder();
    const d = createSpotifyDirect({ manager: m, encode: enc.encode, now, limits: { bufferBytes: 1024, attachWaitMs: 50 } });
    const r = await d.open({ profileId: 7, discordUserId: 'owner-1', item: item() });
    m.streams.at(-1).write(Buffer.alloc(4096));
    await tick();
    assert.equal(enc.made[0].stdout.isPaused(), true, 'reading stopped above the cap');
    const done = await r.live.done;
    assert.equal(done.why, 'no_player');
    assert.ok(names(m).includes('pause'));
});

test('the real encoder turns 48 kHz WAV into MP3', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, async () => {
    const gen = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-ac', '2', '-f', 'wav', 'pipe:1'], { maxBuffer: 8 << 20 });
    assert.equal(gen.status, 0);
    const e = ffmpegMp3();
    const chunks = [];
    e.stdout.on('data', (c) => chunks.push(c));
    const ended = new Promise((r) => e.stdout.on('end', r));
    e.stdin.end(gen.stdout);
    await ended;
    const mp3 = Buffer.concat(chunks);
    assert.ok(mp3.length > 10_000, `${mp3.length} bytes`);
    const sync = mp3.indexOf(Buffer.from([0xff]));
    assert.ok(mp3.subarray(0, 3).toString() === 'ID3' || (sync >= 0 && (mp3[sync + 1] & 0xe0) === 0xe0), 'an MP3 stream');
});

// ── through the player, on throwaway tables ──

test('in the player: a Spotify request plays live (playback spotify, context stream); busy falls back to YouTube Music and the Music page says why', async () => {
    const T = await makeTables(pool, 'd');
    const PL = `${T.prefix}play_log`;
    try {
        for (const sql of musicDdl(T.prefix)) await pool.query(sql);
        await pool.query(`CREATE TABLE \`${PL}\` LIKE music_play_log`);
        await playLogAlter(pool, PL);
        const profile = await makeProfile(T.store, 'owner-1');
        const m = fakeManager();
        const d = createSpotifyDirect({ manager: m, encode: fakeEncoder().encode, now });
        const resolved = [];
        const resolver = {
            lookup: async () => ({ ok: true, items: [{ source: 'spotify', title: 'Golden Hour', artist: 'Maple Hollow Band', url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', trackKey: SP, durationMs: 200_000, explicit: false }], total: 1 }),
            audioFor: async (it) => { resolved.push(it.trackKey); return { url: 'http://127.0.0.1:9/audio/x', playback: 'relay:server2', matchedVia: 'ytmusic' }; },
            prefetch() {},
        };
        let n = 0;
        const hub = {
            connected: () => [{ deviceId: 1, kind: 'studio', connectedAt: new Date(now()), state: { music: { vodSafe: true, vodTrack: 2 } } }],
            dispatch: async (x) => {
                const id = `d_direct${++n}_${profile.id}`;
                await T.store.insertDispatch({ id, profileId: x.profileId, target: 'studio', capability: 'obs', actionType: x.actionType, params: {}, status: 'sent', expiresAt: new Date(now() + 30_000) });
                await T.store.updateDispatch(id, { status: 'acked', result: { vodSafe: true, vodTrack: 2 } });
                return { id, status: 'sent' };
            },
        };
        const music = createMusic({ db: pool, store: T.store, hub, ingest: null, resolver, direct: d, signer: createSigner({ secret: 'y'.repeat(40), now }), playLogTable: PL, now });
        const page = { sent: [], send(e, x) { this.sent.push([e, x]); }, close() {} };
        music.service.player.attachOverlay(profile.id, 'kh', page);
        await music.service.saveSettings(profile.id, { ...withDefaults({}), spotifyDirect: true });
        const settle = async () => { for (const s of music.service.player._states.values()) await s.chain; await tick(); };

        await music.service.submit(profile, { input: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', viewer: { platform: 'dashboard' }, roles: ['broadcaster'], via: 'dashboard' });
        await settle();
        const play = page.sent.filter((x) => x[0] === 'play').at(-1)[1];
        assert.equal(play.live, true);
        assert.equal(resolved.length, 0, 'no YouTube Music match needed');
        assert.ok(music.service.player.liveFor(profile.id, play.playId));
        assert.equal(music.service.player.upstreamFor(profile.id, play.playId), null);
        const [[row]] = await pool.query(`SELECT context, playback, spotify_account, matched_via FROM \`${PL}\` WHERE id = ?`, [Number(play.playId)]);
        assert.deepEqual({ ...row }, { context: 'stream', playback: 'spotify', spotify_account: 'owner', matched_via: null });
        assert.equal((await music.service.spotifyStatus(profile)).playingLive, true);

        await music.service.player.pause(profile.id);
        await music.service.player.resume(profile.id);
        await music.service.player.restart(profile.id);
        assert.deepEqual(m.calls.filter((c) => ['pause', 'resume', 'seek'].includes(c[0])).map((c) => c[0]), ['pause', 'resume', 'seek']);

        // Discord voice takes the session between songs: the next Spotify song plays from YouTube Music, and the page says so.
        await music.service.player.skip(profile.id, 'test');
        await settle();
        m.acquire(m.sessions.owner, 'guild-9', { owner: false });
        await music.service.submit(profile, { input: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', viewer: { platform: 'dashboard' }, roles: ['broadcaster'], via: 'dashboard' });
        await settle();
        const play2 = page.sent.filter((x) => x[0] === 'play').at(-1)[1];
        assert.equal(play2.live, false);
        assert.deepEqual(resolved, [SP]);
        const st = await music.service.spotifyStatus(profile);
        assert.equal(st.linked, true);
        assert.match(st.note, /^'Golden Hour' played from YouTube Music: your Spotify was in use by the Discord music bot\.$/);
        const [[row2]] = await pool.query(`SELECT playback, matched_via FROM \`${PL}\` WHERE id = ?`, [Number(play2.playId)]);
        assert.deepEqual({ ...row2 }, { playback: 'relay:server2', matched_via: 'ytmusic' });
        assert.equal(m.sessions.owner.busyGuildId, 'guild-9', 'the Discord holder kept it');
        music.service.close();
    } finally {
        for (const n2 of [...MUSIC_TABLES].reverse()) await pool.query(`DROP TABLE IF EXISTS \`${T.prefix}${n2}\``);
        await pool.query(`DROP TABLE IF EXISTS \`${PL}\``);
        await T.drop();
        await pool.end().catch(() => {});
    }
});
