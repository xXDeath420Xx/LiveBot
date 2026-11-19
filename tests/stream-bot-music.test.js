import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../utils/db.js';
import { makeTables, makeProfile } from './fixtures/stream-bot-tables.js';
import { musicDdl, MUSIC_TABLES, playLogAlter } from '../migrations/457_stream_bot_music.js';
import { parseRequestInput, trackKeyOf, parseVolume, parseIndex, formatWait, fill, topRange, COMMANDS, DEFAULT_MESSAGES } from '../core/stream-bot/music/text.js';
import { withDefaults, validateSettings, OWNER_PRESET } from '../core/stream-bot/music/settings.js';
import { createMusic } from '../core/stream-bot/music/index.js';
import { createSigner } from '../core/stream-bot/music/audio.js';
import { itemFromEntry, itemFromSpotify, createResolver } from '../core/stream-bot/music/resolve.js';
import { registerMusic, commandInput } from '../core/stream-bot/music/register.js';
import { commandDrafts, seedCommands } from '../core/stream-bot/music/seed.js';
import { musicExport, musicDelete } from '../core/stream-bot/music/privacy.js';
import * as actionsMod from '../core/stream-bot/actions.js';
import * as eventsMod from '../core/stream-bot/events.js';
import * as renderMod from '../core/stream-bot/render.js';
import { createEngine } from '../core/stream-bot/engine.js';
import { createLimiter, validateTrigger } from '../core/stream-bot/conditions.js';
import { normaliseTwitch, normaliseKick } from '../core/stream-bot/events.js';

/*
 * Song requests (core/stream-bot/music, migration 457) on throwaway tables (sbtm…_) and a throwaway copy of
 * music_play_log, with a fake music pipeline (no YouTube, Spotify or resolver is touched), a fake Studio and a fake
 * OBS player: parsing, settings, the VOD gate (Studio's music.vodSafe + an open player + music.prepare before each
 * song), requests with approval / limits / bans / duplicates / length / explicit / allowed sources, every chat
 * command, playback reports, the play log rows (context 'stream'), the "song changed" event and variables, the
 * engine hooks (action, trigger, variables), the seeded commands, and /privacy.
 */

let T, store, profile, PL;
const clock = { t: Date.parse('2026-11-19T12:00:00Z') };
const now = () => clock.t;

// ── fakes ──
const SONGS = {
    'golden hour': { source: 'search', title: 'Golden Hour', artist: 'Maple Hollow Band', url: 'https://open.spotify.com/track/0000000000000000000001', trackKey: 'sp:0000000000000000000001', durationMs: 200_000, explicit: false },
    'night drive': { source: 'search', title: 'Night Drive', artist: 'Bramble', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', trackKey: 'yt:aaaaaaaaaaa', durationMs: 180_000, explicit: null },
    'loud song': { source: 'search', title: 'Loud Song', artist: 'Juniper', url: 'https://open.spotify.com/track/0000000000000000000003', trackKey: 'sp:0000000000000000000003', durationMs: 150_000, explicit: true },
    'long jam': { source: 'search', title: 'Long Jam', artist: 'Bramble', url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', trackKey: 'yt:bbbbbbbbbbb', durationMs: 1_200_000, explicit: null },
    'banned band song': { source: 'search', title: 'Nope', artist: 'Banned Band, Other', url: 'https://www.youtube.com/watch?v=ccccccccccc', trackKey: 'yt:ccccccccccc', durationMs: 100_000, explicit: false },
};
for (let i = 4; i < 12; i++) SONGS[`song ${i}`] = { source: 'search', title: `Song ${i}`, artist: `Artist ${i}`, url: `https://www.youtube.com/watch?v=dddddddd${String(i).padStart(3, '0')}`, trackKey: `yt:dddddddd${String(i).padStart(3, '0')}`, durationMs: 120_000, explicit: i === 7 || i === 8 ? null : false };
const PLAYLIST_ITEMS = [1, 2, 3].map((i) => ({ source: 'spotify', title: `List ${i}`, artist: 'Lister', url: `https://open.spotify.com/track/10000000000000000000000${i}`, trackKey: `sp:10000000000000000000000${i}`, durationMs: 100_000, explicit: false }));

const fakeResolver = {
    looked: [], audio: [], fail: new Set(),
    async lookup(parsed, { max = 1 } = {}) {
        this.looked.push(parsed);
        if (parsed.kind === 'search') { const s = SONGS[parsed.query.toLowerCase()]; return s ? { ok: true, items: [{ ...s }], total: 1 } : { ok: false, error: 'not_found' }; }
        if (parsed.kind === 'spotify' && parsed.type === 'playlist') return { ok: true, items: PLAYLIST_ITEMS.slice(0, max), playlist: 'Road Trip', total: 3 };
        if (parsed.kind === 'spotify' && parsed.type === 'track') return { ok: true, items: [{ ...SONGS['golden hour'] }], total: 1 };
        if (parsed.kind === 'url') return { ok: true, items: [{ source: parsed.platform, title: 'Linked', artist: 'Someone', url: parsed.url, trackKey: trackKeyOf(parsed.url), durationMs: 90_000, explicit: null }], total: 1 };
        return { ok: false, error: 'not_found' };
    },
    async audioFor(item) {
        this.audio.push(item.trackKey);
        if (this.fail.has(item.trackKey)) throw new Error('no playable audio');
        return { url: `http://127.0.0.1:9/audio/${item.trackKey}?expire=9999999999`, playback: 'relay:server2', matchedVia: item.trackKey.startsWith('sp:') ? 'ytmusic' : null, matchedTitle: null };
    },
    prefetch() {},
};

function fakeHub() {
    const hub = {
        studio: { vodSafe: true, vodTrack: 2, reason: null }, online: true, prepareOk: true, prepared: 0,
        connected: (profileId) => (hub.online ? [{ deviceId: 7, kind: 'studio', connectedAt: new Date(now()), state: { music: { ...hub.studio } } }] : []),
        async dispatch(d) {
            if (!hub.online) return { id: null, status: 'none', devices: 0 };
            hub.prepared++;
            const id = `d_test${hub.prepared}_${profile.id}`;
            await store.insertDispatch({ id, profileId: d.profileId, runId: null, target: d.target, capability: d.capability, actionType: d.actionType, params: d.params, status: 'sent', expiresAt: new Date(now() + 30_000) });
            await store.updateDispatch(id, hub.prepareOk ? { status: 'acked', result: { vodSafe: true, vodTrack: 2 } } : { status: 'failed', error: 'vod_unsafe: Desktop Audio is on track 2' });
            return { id, status: 'sent', devices: 1 };
        },
    };
    return hub;
}
const overlay = () => ({ sent: [], send(e, d) { this.sent.push([e, d]); }, close() {}, last(e) { return [...this.sent].reverse().find((x) => x[0] === e)?.[1]; } });
const tick = () => new Promise((r) => setImmediate(r));
async function settle(m) { for (const s of m.service.player._states.values()) await s.chain; await tick(); }

let hub, music, events, player1;
const chat = (text, { id = '201', name = 'MapleFan_88', roles = [] } = {}) => normaliseTwitch('channel.chat.message', {
    broadcaster_user_id: '900000001', chatter_user_id: id, chatter_user_login: name.toLowerCase(), chatter_user_name: name,
    message_id: `m${Math.random()}`, message: { text }, badges: roles.map((r) => ({ set_id: r })) });
const run = async (key, text = '', who = {}) => (await music.commands.run(profile, key, { ev: chat(`!x ${text}`, who), input: text })).reply;
const MOD = { id: '300', name: 'ModJuniper', roles: ['moderator'] };

test.before(async () => {
    T = await makeTables(pool, 'm');
    store = T.store;
    for (const sql of musicDdl(T.prefix)) await pool.query(sql);
    PL = `${T.prefix}play_log`;
    await pool.query(`CREATE TABLE \`${PL}\` LIKE music_play_log`);
    await playLogAlter(pool, PL);
    await playLogAlter(pool, PL);   // idempotent
    profile = await makeProfile(store);
    hub = fakeHub();
    events = [];
    music = createMusic({ db: pool, store, hub, ingest: { studio: async (pid, ev) => { events.push(ev); return 1; } }, encryption: { encrypt: (s) => ({ v: Buffer.from(s).toString('base64') }), decrypt: (o) => Buffer.from(o.v, 'base64').toString() },
        resolver: fakeResolver, direct: null, signer: createSigner({ secret: 'x'.repeat(40), now }), playLogTable: PL, now });
});
test.after(async () => {
    music?.service.close();
    for (const n of [...MUSIC_TABLES].reverse()) await pool.query(`DROP TABLE IF EXISTS \`${T.prefix}${n}\``);
    await pool.query(`DROP TABLE IF EXISTS \`${PL}\``);
    await T.drop();
    const [rows] = await pool.query('SHOW TABLES LIKE ?', [`${T.prefix}%`]);
    assert.equal(rows.length, 0, 'throwaway tables dropped');
    await pool.end().catch(() => {});
});

// ── pure parts ──

test('request input: Spotify, YouTube Music, SoundCloud, other links, podcasts, short links and search text', () => {
    assert.deepEqual(parseRequestInput('https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=x'), { kind: 'spotify', type: 'track', id: '4uLU6hMCjMI75M1A2tKUQC', url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC' });
    assert.equal(parseRequestInput('spotify:album:4uLU6hMCjMI75M1A2tKUQC').type, 'album');
    assert.equal(parseRequestInput('https://open.spotify.com/episode/4uLU6hMCjMI75M1A2tKUQC').kind, 'unsupported');
    assert.equal(parseRequestInput('https://spotify.link/abc').what, 'short_link');
    const ytm = parseRequestInput('https://music.youtube.com/watch?v=dQw4w9WgXcQ&feature=share');
    assert.equal(ytm.platform, 'youtube');
    assert.equal(ytm.playlist, false);
    assert.equal(parseRequestInput('https://www.youtube.com/playlist?list=PLabcdefghij').playlist, true);
    assert.equal(parseRequestInput('https://soundcloud.com/artist/sets/summer').playlist, true);
    assert.equal(parseRequestInput('https://bandcamp.com/track/x').platform, 'other');
    assert.deepEqual(parseRequestInput('  never   gonna give '), { kind: 'search', query: 'never gonna give' });
    assert.equal(parseRequestInput('***').kind, 'censored');
    assert.equal(trackKeyOf('https://youtu.be/dQw4w9WgXcQ'), 'yt:dQw4w9WgXcQ');
    assert.equal(trackKeyOf('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), 'yt:dQw4w9WgXcQ');
    assert.equal(trackKeyOf('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'), 'sp:4uLU6hMCjMI75M1A2tKUQC');
    assert.equal(trackKeyOf('https://soundcloud.com/A/b/'), 'sc:/a/b');
});

test('volume, list numbers, waits, ranges, and placeholders are never read twice', () => {
    assert.deepEqual(parseVolume(''), { kind: 'show' });
    assert.deepEqual(parseVolume('+10'), { kind: 'delta', value: 10 });
    assert.deepEqual(parseVolume('150%'), { kind: 'set', value: 100 });
    assert.equal(parseVolume('loud'), null);
    assert.equal(parseIndex('2', 3), 1);
    assert.equal(parseIndex('4', 3), -1);
    assert.equal(parseIndex('', 3, 0), 0);
    assert.equal(formatWait(3_800_000), '1 hour, 3 minutes, 20 seconds');
    assert.equal(formatWait(0), '0 seconds');
    assert.equal(topRange('short').days, 28);
    assert.equal(fill("'{song}' for {user}", { song: '{user}', user: 'Juniper' }), "'{user}' for Juniper");
    assert.equal(COMMANDS.length, 39);
    for (const c of COMMANDS) assert.ok(c.names.length && c.label, c.key);
    for (const name of ['sr', 'song', 'songLink', 'skip', 'back', 'play', 'pause', 'vol', 'lastSong', 'queue', 'banSong', 'bannedSongs', 'unbanSong', 'changeDevice', 'devices',
        'playPlaylist', 'playlists', 'addSong', 'voteskip', 'remove', 'myQueue', 'requests', 'wrongsong', 'playlist', 'topSongs', 'topArtists', 'myTopSongs', 'myTopArtists',
        'broadcasterTopTracks', 'broadcasterTopArtists', 'addToLikedSongs', 'restart', 'addSongToPlaylistFromInput', 'like', 'unlike', 'likes', 'approve', 'deny', 'pending']) {
        assert.ok(COMMANDS.some((c) => c.names[0] === name), `!${name} is the default name of a command`);
    }
});

test('settings: defaults, clamping, the owner preset, and save errors in plain words', () => {
    const d = withDefaults({ maxPerUser: 999, approval: 'nope', sources: ['youtube', 'bad'], messages: { added: '  ', skipped: 'Gone: {song}', bogus: 'x' } });
    assert.equal(d.maxPerUser, 100);
    assert.equal(d.approval, 'none');
    assert.deepEqual(d.sources, ['youtube']);
    assert.deepEqual(d.messages, { skipped: 'Gone: {song}' });
    assert.equal(withDefaults({ ...OWNER_PRESET }).voteSkip, 10);
    const v = validateSettings({ maxPerUser: 0, sources: [] });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /Songs per viewer/.test(e)));
    assert.ok(v.errors.some((e) => /Allowed sources/.test(e)));
});

test('the real pipeline adapters: yt-dlp entries and Spotify tracks become items (Spotify ones carry the YouTube Music bridge)', async () => {
    const it = itemFromEntry({ webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'X', channel: 'Rick Astley - Topic', duration: 213, thumbnails: [{ url: 'a' }, { url: 'b' }] });
    assert.equal(it.artist, 'Rick Astley');
    assert.equal(it.durationMs, 213_000);
    assert.equal(it.trackKey, 'yt:dQw4w9WgXcQ');
    assert.equal(itemFromEntry({ _type: 'playlist' }), null);
    const sp = itemFromSpotify({ title: 'Lose Yourself', artist: 'Eminem', durationMs: 326_000, explicit: true, url: 'https://open.spotify.com/track/1v7L65Lzy0j0vdpRjJewt1' }, ({ title, artist, explicit }) => `${title} ${artist}${explicit ? ' explicit' : ''}`);
    assert.equal(sp.bridge.query, 'Lose Yourself Eminem explicit');
    assert.deepEqual(sp.bridge.track, { title: 'Lose Yourself', artist: 'Eminem', explicit: true });
    // The resolver hands Spotify songs to extractor.bridge() and others to extractor.stream(); HLS audio is matched on YouTube instead.
    const calls = [];
    const pipeline = {
        extractor: {
            bridge: async (t) => { calls.push(['bridge', t.metadata.bridgeQuery, t.durationMS]); return 'http://127.0.0.1:49999/audio/tok?expire=1'; },
            stream: async (info) => { calls.push(['stream', info.url]); return info.url.includes('soundcloud') ? 'https://cf-hls.sndcdn.com/playlist.m3u8' : 'http://127.0.0.1:49999/audio/t2'; },
            getAudioUrlFromSearch: async (q, d, meta) => { calls.push(['search', q, d, meta.title]); return 'http://127.0.0.1:49999/audio/t3'; },
            _fetchInfoLines: async () => null,
        },
        buildBridgeQuery: ({ title, artist, explicit }) => `${title} ${artist}${explicit ? ' explicit' : ''}`,
        pickFor: () => ({ source: 'ytmusic', title: 'Lose Yourself', channel: 'Eminem - Topic' }), pathOfUrl: () => 'relay:server2', prefetchStream: async () => null,
        resolveSpotify: async () => null, searchSpotifyTrack: async () => null,
    };
    const r = createResolver({ pipeline });
    const a = await r.audioFor({ ...sp, bridge: undefined });
    assert.equal(a.matchedVia, 'ytmusic');
    assert.equal(calls[0][1], 'Lose Yourself Eminem explicit');
    await r.audioFor({ title: 'Wave', artist: 'Someone', url: 'https://soundcloud.com/someone/wave', trackKey: 'sc:/someone/wave', durationMs: 200_000 });
    assert.deepEqual(calls.at(-1), ['search', 'Someone Wave', 200, 'Wave']);
    assert.deepEqual(await r.lookup({ kind: 'url', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', platform: 'youtube' }), { ok: false, error: 'link_failed' });
});

// ── the VOD gate ──

test('no song starts without an open player and Studio confirming VOD protection; chat is told requests are paused', async () => {
    assert.equal(await run('request', 'golden hour'), '@MapleFan_88 Song requests are paused until OBS VOD protection is on.');
    player1 = overlay();
    const detach = music.service.player.attachOverlay(profile.id, 'kh-test', player1);
    await settle(music);
    hub.studio = { vodSafe: false, reason: 'Desktop Audio is on the VOD track.' };
    assert.match(await run('request', 'golden hour'), /paused until OBS VOD protection/);
    const st = await music.service.status(profile.id);
    assert.equal(st.vod.vodSafe, false);
    assert.match(st.vod.reason, /Desktop Audio/);
    hub.studio = { vodSafe: true, vodTrack: 2 };
    assert.equal(music.service.gateOf(profile.id).vodTrack, 2);
    detach();
    music.service.player.attachOverlay(profile.id, 'kh-test', player1);
    await settle(music);
});

test('a request plays at once: music.prepare first, a signed link to the player, a stream row in music_play_log, the song changed event', async () => {
    const before = hub.prepared;
    const reply = await run('request', 'golden hour');
    assert.match(reply, /^@MapleFan_88 'Golden Hour' by Maple Hollow Band is in the queue \(#1, plays in about/);
    await settle(music);
    assert.equal(hub.prepared, before + 1, 'music.prepare dispatched before the song');
    const play = player1.last('play');
    assert.ok(play, 'the player was told to play');
    assert.equal(play.title, 'Golden Hour');
    assert.equal(play.requester, 'MapleFan_88');
    assert.ok(play.sig && play.exp, 'signed');
    assert.equal(JSON.stringify(play).includes('127.0.0.1:9'), false, 'the resolver address never reaches the page');
    assert.equal(music.service.player.upstreamFor(profile.id, play.playId), 'http://127.0.0.1:9/audio/sp:0000000000000000000001?expire=9999999999');
    const [[row]] = await pool.query(`SELECT * FROM \`${PL}\` WHERE id = ?`, [Number(play.playId)]);
    assert.equal(row.context, 'stream');
    assert.equal(row.stream_profile_id, profile.id);
    assert.equal(row.requester_id, null, 'no viewer id in a Discord-id column');
    assert.equal(row.outcome, 'playing');
    assert.equal(row.request_source, 'search');
    assert.equal(row.matched_via, 'ytmusic');
    const ev = events.at(-1);
    assert.equal(ev.type, 'music.song_changed');
    assert.equal(ev.platform, 'studio');
    assert.equal(ev.metadata.requestedBy, 'MapleFan_88');
    assert.equal(music.service.templateValues(profile.id)['music.track'], 'Golden Hour');
    assert.equal(music.service.templateValues(profile.id)['spotify.artist'], 'Maple Hollow Band');
    assert.match(await run('current'), /'Golden Hour' by Maple Hollow Band \(requested by MapleFan_88\)/);
    assert.match(await run('current_link'), /open\.spotify\.com\/track\/0000000000000000000001/);
});

test('a song that fails music.prepare is held, not dropped, and starts when Studio confirms', async () => {
    hub.prepareOk = false;
    await run('request', 'song 4', { id: '202', name: 'Juniper' });
    await music.service.player.skip(profile.id, 'test');
    await settle(music);
    const st = await music.service.status(profile.id);
    assert.equal(st.current, null);
    assert.match(st.held, /Desktop Audio is on track 2/);
    const [q] = await music.mstore.requestsWithStatus(profile.id, 'queued');
    assert.equal(q.title, 'Song 4', 'still queued');
    hub.prepareOk = true;
    await music.service.player.gateChanged(profile.id);
    await settle(music);
    assert.equal(player1.last('play').title, 'Song 4');
});

test('losing VOD protection mid-song pauses the player at once, and it resumes where it was', async () => {
    hub.studio = { vodSafe: false, reason: 'Track check failed' };
    assert.equal(await music.service.player.gateChanged(profile.id), 'paused');
    assert.ok(player1.last('pause'));
    hub.studio = { vodSafe: true, vodTrack: 2 };
    assert.equal(await music.service.player.gateChanged(profile.id), 'resumed');
});

// ── requests ──

test('approval (explicit or unrated), limits, duplicates, length, bans and allowed sources', async () => {
    await music.service.saveSettings(profile.id, { ...withDefaults({}), approval: 'explicit_or_unknown', maxPerUser: 2, maxDurationSec: 600, allowExplicit: true });
    const viewer = { id: '210', name: 'Bramble_Fan' };
    assert.match(await run('request', 'night drive', viewer), /needs mod approval \(#1 waiting\)/, 'YouTube: rating unknown');
    assert.match(await run('request', 'long jam', viewer), /at most 10 minutes long/);
    assert.match(await run('request', 'night drive', { id: '211', name: 'Other' }), /already in the queue/);
    assert.match(await run('request', 'song 5', viewer), /is in the queue/, 'a clean Spotify-rated song goes straight in');
    assert.match(await run('request', 'song 6', viewer), /can't have more than 2 songs/);
    assert.match(await run('request', 'song 6', MOD), /is in the queue/, 'mods skip limits');
    await music.mstore.addBan(profile.id, { kind: 'artist', ref: 'banned band', artist: 'Banned Band' });
    assert.match(await run('request', 'banned band song', { id: '212', name: 'X' }), /Songs by Banned Band are banned/);
    await music.service.saveSettings(profile.id, { ...(await music.service.settingsOf(profile.id)), allowExplicit: false });
    assert.match(await run('request', 'loud song', { id: '213', name: 'Y' }), /is explicit/);
    await music.service.saveSettings(profile.id, { ...(await music.service.settingsOf(profile.id)), sources: ['spotify', 'playlists'] });
    assert.match(await run('request', 'https://www.youtube.com/watch?v=eeeeeeeeeee', { id: '214', name: 'Z' }), /Only songs from the playlists here/);
    assert.match(await run('request', 'golden hour', { id: '214', name: 'Z' }), /Only songs from the playlists here/);
    await music.service.saveSettings(profile.id, { ...(await music.service.settingsOf(profile.id)), sources: ['spotify', 'youtube', 'soundcloud', 'search', 'playlists'], allowExplicit: true });
    assert.equal(await run('request', ''), '@MapleFan_88 Usage: !sr <song name or link>');
});

test('!pending, !approve, !deny (a number, the first, all)', async () => {
    await run('request', 'song 7', { id: '220', name: 'A' });
    await run('request', 'song 8', { id: '221', name: 'B' });
    assert.match(await run('pending', '', MOD), /Waiting \(3\): 1\) Bramble_Fan: Night Drive \| 2\) A: Song 7 \| 3\) B: Song 8/);
    assert.match(await run('approve', '2', MOD), /Approved #2 for A: 'Song 7' by Artist 7 is in the queue\. \d still waiting\./);
    assert.match(await run('approve', '9', MOD), /isn't on the list/);
    assert.match(await run('deny', '', MOD), /Denied #1 \(Bramble_Fan\)/);
    assert.match(await run('deny', 'all', MOD), /Denied all waiting requests/);
    assert.match(await run('pending', '', MOD), /No song requests are waiting/);
});

test('!queue, !myQueue, !requests, !remove, !wrongsong', async () => {
    assert.match(await run('queue'), /The next \d songs: \[1\] '/);
    assert.match(await run('my_queue', '', { id: '210', name: 'Bramble_Fan' }), /'Song 5' - 'Artist 5' \(#\d\).* \|\| Your first song plays in about/);
    assert.match(await run('requests', '', MOD), /requests in the queue, .* in total/);
    assert.match(await run('remove', 'song 6', { id: '230', name: 'Nobody' }), /wasn't requested by you/);
    assert.match(await run('remove', 'song 6', MOD), /'Song 6' by Artist 6 was removed/);
    assert.match(await run('remove', 'zzz', MOD), /No requested song matches 'zzz'/);
    assert.match(await run('wrong_song', '', { id: '210', name: 'Bramble_Fan' }), /'Song 5' by Artist 5 was removed/);
    assert.match(await run('wrong_song', '', { id: '210', name: 'Bramble_Fan' }), /don't have any songs in the queue/);
});

test('!skip (own song only for viewers), !voteskip threshold, playback reports and the play log outcome', async () => {
    const np = music.service.player.nowPlaying(profile.id);
    assert.ok(np, 'something is playing');
    assert.match(await run('skip', '', { id: '999', name: 'Stranger' }), /wasn't requested by you/);
    // The player reports progress, then the song ends naturally: completed, and the next one starts.
    await music.service.player.report(profile.id, { playId: np.playId, event: 'started', positionMs: 0 });
    await music.service.player.report(profile.id, { playId: 'other', event: 'ended' });
    assert.equal(music.service.player.nowPlaying(profile.id).playId, np.playId, 'a report for another play is ignored');
    clock.t += 125_000;
    await music.service.player.report(profile.id, { playId: np.playId, event: 'ended', positionMs: 120_000 });
    await settle(music);
    const [[row]] = await pool.query(`SELECT outcome, listened_sec FROM \`${PL}\` WHERE id = ?`, [Number(np.playId)]);
    assert.equal(row.outcome, 'completed');
    assert.equal(row.listened_sec, 120);
    const next = music.service.player.nowPlaying(profile.id);
    assert.notEqual(next?.playId, np.playId);
    await music.service.saveSettings(profile.id, { ...(await music.service.settingsOf(profile.id)), voteSkip: 2 });
    assert.match(await run('voteskip', '', { id: '240', name: 'V1' }), /Vote to skip counted \(1\/2\)/);
    assert.match(await run('voteskip', '', { id: '240', name: 'V1' }), /already voted/);
    assert.match(await run('voteskip', '', { id: '241', name: 'V2' }), /Enough votes \(2\/2\): skipping/);
    await settle(music);
    const [[skipped]] = await pool.query(`SELECT outcome, skip_reason FROM \`${PL}\` WHERE id = ?`, [Number(next.playId)]);
    assert.deepEqual({ ...skipped }, { outcome: 'skipped', skip_reason: 'vote' });
});

test('a failed song is logged and the next one plays; a player error is retried once with fresh audio', async () => {
    await music.service.player.stop(profile.id);
    for (const r of await music.mstore.activeRequests(profile.id)) await music.service.removeRequest(profile.id, r, 'test');
    fakeResolver.fail.add('yt:dddddddd009');
    await run('request', 'song 9', MOD);
    await run('request', 'song 10', MOD);
    await settle(music);
    assert.equal(music.service.player.nowPlaying(profile.id).item.title, 'Song 10');
    const [[failed]] = await pool.query(`SELECT outcome FROM \`${PL}\` WHERE title = 'Song 9' ORDER BY id DESC LIMIT 1`);
    assert.equal(failed.outcome, 'failed');
    const np = music.service.player.nowPlaying(profile.id);
    assert.equal(await music.service.player.report(profile.id, { playId: np.playId, event: 'error', error: 'network_error' }), 'retried');
    assert.equal(await music.service.player.report(profile.id, { playId: np.playId, event: 'error', error: 'network_error' }), 'failed');
});

test('controls: !pause, !play, !restart, !back, !vol, !lastSong, !devices, !changeDevice', async () => {
    await run('request', 'song 11', MOD);
    await settle(music);
    assert.match(await run('pause', '', MOD), /paused/);
    assert.ok(player1.last('pause'));
    assert.match(await run('play', '', MOD), /playing/);
    assert.match(await run('restart', '', MOD), /started again from the beginning/);
    assert.equal(player1.last('seek').positionMs, 0);
    assert.match(await run('last'), /The previous song was/);
    assert.match(await run('back', '', MOD), /Playing '.+' by .+ again/);
    assert.match(await run('volume', '', MOD), /The volume is at \d+%/);
    assert.match(await run('volume', '+5', MOD), /The volume is now \d+%/);
    assert.ok(player1.last('volume'));
    assert.match(await run('volume', 'loud', MOD), /Use a number from 0 to 100/);
    assert.match(await run('devices', '', MOD), /plays in the OBS source 'CertiFried Music'\. VOD protection is on \(kept off Twitch VOD track 2\)/);
    assert.match(await run('change_device', '', MOD), /Audio Monitoring/);
});

test('bans from chat, likes, the liked list, playlists, !playPlaylist and the empty-queue playlist', async () => {
    assert.match(await run('ban', '', MOD), /is banned from requests/);
    assert.match(await run('banned', '', MOD), /Banned: .*\[1\].*\[2\]/);
    assert.match(await run('unban', '1', MOD), /can be requested again/);
    assert.match(await run('unban', 'x', MOD), /Use !unbanSong <number>/);
    await run('request', 'song 4', MOD);
    await settle(music);
    const cur = music.service.player.nowPlaying(profile.id).item;
    assert.equal(await run('like', '', { id: '250', name: 'Liker' }), `Liker liked '${cur.title}' by ${cur.artist}.`);
    assert.match(await run('like', '', { id: '250', name: 'Liker' }), /already liked/);
    assert.match(await run('likes'), new RegExp(`1 people like '${cur.title}' by ${cur.artist}: Liker`));
    assert.match(await run('unlike', cur.title, { id: '250', name: 'Liker' }), /took back their like/);
    assert.match(await run('save_liked', '', MOD), /added to Maple Hollow's liked songs/);
    assert.match(await run('save_liked', '', MOD), /already in Maple Hollow's liked songs/);
    const imp = await music.service.importPlaylist(profile.id, { url: 'https://open.spotify.com/playlist/4uLU6hMCjMI75M1A2tKUQC', by: 'test' });
    assert.deepEqual([imp.ok, imp.name, imp.added], [true, 'Road Trip', 3]);
    assert.match(await run('playlists', '', MOD), /\[1\] Liked songs \(1 songs\), \[2\] Road Trip \(3 songs\)/);
    assert.match(await run('add_to_playlist', '', MOD), /choose a default playlist/);
    assert.match(await run('add_to_playlist', 'road trip', MOD), /was added to 'Road Trip'/);
    assert.match(await run('add_input_to_playlist', 'night drive | 2', MOD), /'Night Drive' by Bramble was added to 'Road Trip'/);
    assert.match(await run('add_input_to_playlist', 'night drive', MOD), /Usage: !addSongToPlaylistFromInput/);
    for (const r of await music.mstore.activeRequests(profile.id)) await music.service.removeRequest(profile.id, r, 'test');
    await settle(music);
    assert.match(await run('play_playlist', 'road', MOD), /Playing the playlist 'Road Trip'/);
    await settle(music);
    const np = music.service.player.nowPlaying(profile.id);
    assert.equal(np.playlist, 'Road Trip');
    assert.match(await run('current_playlist'), /'Road Trip' \(https:\/\/open\.spotify\.com\/playlist\//);
    const [[row]] = await pool.query(`SELECT added_by, playlist FROM \`${PL}\` WHERE id = ?`, [Number(np.playId)]);
    assert.deepEqual({ ...row }, { added_by: 'autoplay', playlist: 'Road Trip' });
});

test('a playlist link in !sr adds as many songs as the viewer may have', async () => {
    await music.service.player.stop(profile.id);
    await music.service.saveSettings(profile.id, { ...(await music.service.settingsOf(profile.id)), approval: 'none', maxPerUser: 2 });
    assert.match(await run('request', 'https://open.spotify.com/playlist/4uLU6hMCjMI75M1A2tKUQC', { id: '260', name: 'Lister' }), /Added 2 songs from Road Trip/);
});

test('stats come from CertiFried\'s own history: !topSongs, !myTopSongs, !topArtists, !broadcasterTopTracks', async () => {
    assert.match(await run('top_songs'), /^@MapleFan_88 Most requested songs: 1\. .+ by .+ \(\dx\)/);
    assert.match(await run('top_artists'), /Most requested artists: 1\. /);
    assert.match(await run('my_top_songs', '', { id: '202', name: 'Juniper' }), /Your most requested songs: 1\. Song 4 by Artist 4 \(1x\)/);
    assert.match(await run('my_top_artists', '', { id: '999999', name: 'New' }), /no stats yet/);
    assert.match(await run('streamer_top_tracks', 'short'), /Most played on stream in the last 4 weeks: 1\. /);
    assert.match(await run('streamer_top_artists'), /Most played artists on stream in the last year: 1\. /);
});

// ── engine hooks, seeded commands ──

test('the engine runs "Song requests" from a chat command on Twitch and Kick, with {music.*} variables in other automations', async () => {
    const ref = { current: music };
    const reg = registerMusic({ musicRef: ref, actions: actionsMod, events: eventsMod, render: renderMod });
    assert.deepEqual(reg, { action: true, event: true, vars: true });
    assert.deepEqual(registerMusic({ musicRef: ref, actions: actionsMod, events: eventsMod, render: renderMod }), { action: false, event: false, vars: true }, 'registering twice adds nothing');
    assert.ok(actionsMod.actionType('music.command'));
    assert.ok(eventsMod.isEventType('music.song_changed'));
    assert.ok(!eventsMod.STUDIO_EVENT_TYPES.includes('music.song_changed'), 'Studio cannot report a song change itself');
    const v = actionsMod.validateActions([{ type: 'music.command', command: 'nope' }], {});
    assert.equal(v.ok, false);
    const ok = actionsMod.validateActions([{ type: 'music.command', command: 'request', reply: 'yes' }], {});
    assert.deepEqual(ok.value, [{ type: 'music.command', command: 'request', input: '', reply: 'yes' }]);
    assert.equal(validateTrigger('music.song_changed', {}).ok, true);

    const said = [];
    const io = { channelsFor: (id) => store.listChannels(id), sendChat: async (m) => { said.push(m); return { ok: true }; }, postDiscord: async () => ({ ok: true }), postWebhook: async () => ({ status: 204 }), dispatch: async () => ({ id: 'x', status: 'queued' }) };
    const render = renderMod.createRenderer({ variableStore: store.variableStore });
    const engine = createEngine({ store, render, io, now, sleep: async () => {}, limiter: createLimiter({ now }) });
    await store.createAutomation(profile.id, { name: 'sr', enabled: true, trigger_type: 'chat', trigger_config: { match: { mode: 'command', text: '!sr' } }, conditions: [], actions: [{ type: 'music.command', command: 'current', input: '', reply: 'yes' }] });
    await store.createAutomation(profile.id, { name: 'np', enabled: true, trigger_type: 'chat', trigger_config: { match: { mode: 'command', text: '!np' } }, conditions: [], actions: [{ type: 'chat.send', platform: 'event', text: 'Now: {music.track} by {music.artist}' }] });
    await run('request', 'golden hour', MOD);
    await settle(music);
    const [r1] = await engine.handleEvent(profile, chat('!sr'), null);
    assert.equal(r1.status, 'ok');
    assert.equal(said.at(-1).platform, 'twitch');
    const playing = music.service.player.nowPlaying(profile.id).item;
    assert.ok(said.at(-1).text.includes(`'${playing.title}' by ${playing.artist}`));
    const kick = normaliseKick('chat.message.sent', { broadcaster: { user_id: 800000001 }, sender: { user_id: 55, username: 'kickviewer', identity: { badges: [] } }, content: '!np', message_id: 'k1' });
    const [r2] = await engine.handleEvent(profile, kick, null);
    assert.equal(r2.status, 'ok');
    assert.equal(said.at(-1).platform, 'kick');
    assert.equal(said.at(-1).text, `Now: ${playing.title} by ${playing.artist}`);
    assert.equal(commandInput(chat('!sr never gonna')), 'never gonna');
    // Dry run says what it would do and sends nothing.
    const a = (await store.listAutomations(profile.id)).find((x) => x.name === 'sr');
    const dry = await engine.runAutomation(profile, a, chat('!sr hello'), { dryRun: true, test: true });
    assert.equal(dry.steps[0].status, 'dry');
});

test('the commands as automations: every Streamer.bot name for the owner (switched off), one name otherwise; never twice', async () => {
    const owner = commandDrafts({ aliases: true, enabled: false });
    assert.equal(owner.length, COMMANDS.length + 1);
    for (const d of owner) assert.equal(validateTrigger(d.trigger_type, d.trigger_config).ok, true, d.name);
    const skip = owner.find((d) => d.name === 'Song requests: !skip');
    assert.equal(skip.trigger_config.match.text, '^!(?:skip|next|skipSong|nextSong)(?:\\s|$)');
    assert.ok(owner.every((d) => d.enabled === false));
    assert.deepEqual(owner.find((d) => d.name === 'Song requests: !vol').conditions, [{ type: 'role', roles: ['broadcaster', 'moderator'], mode: 'any' }]);
    const plain = commandDrafts({ aliases: false, enabled: true });
    assert.deepEqual(plain.find((d) => d.name === 'Song requests: !skip').trigger_config.match, { mode: 'command', text: '!skip', caseSensitive: false });
    const first = await seedCommands(store, profile.id, { aliases: true });
    const second = await seedCommands(store, profile.id, { aliases: true });
    assert.equal(first.created, COMMANDS.length + 1);
    assert.equal(second.created, 0);
});

// ── privacy ──

test('/privacy: the streamer gets everything back and their stream plays go; a viewer gets their requests and likes, then loses them', async () => {
    await music.mstore.addLike(profile.id, { platform: 'twitch', viewerId: '201', viewerName: 'MapleFan_88', trackKey: 'yt:x', title: 'X' });
    const viewer = [{ platform: 'twitch', id: '201' }];
    const ex = await musicExport(pool, { profileId: profile.id, accounts: viewer, prefix: T.prefix, playLogTable: PL });
    assert.ok(ex.tables[`${T.prefix}music_requests`].length > 5);
    assert.ok(ex.tables[`${T.prefix}music_play_log`].length > 3);
    assert.ok(ex.tables[`${T.prefix}music_requests_by_you`].every((r) => r.viewer_name === 'MapleFan_88'));
    assert.equal(ex.tables[`${T.prefix}music_likes_by_you`].length, 1);
    assert.equal(JSON.stringify(ex).includes('keyEnc'), false);
    const del = await musicDelete(pool, { profileId: null, accounts: viewer, prefix: T.prefix, playLogTable: PL });
    assert.equal(del[`${T.prefix}music_likes`], 1);
    assert.ok(del[`${T.prefix}music_requests`] >= 1);
    const [[left]] = await pool.query(`SELECT COUNT(*) AS n FROM \`${T.prefix}music_requests\` WHERE platform = 'twitch' AND viewer_id = '201'`);
    assert.equal(Number(left.n), 0);
    const own = await musicDelete(pool, { profileId: profile.id, accounts: [], prefix: T.prefix, playLogTable: PL });
    assert.ok(own[PL] > 3);
});

test('the overlay key: made once, read back, rotated (the old one stops working)', async () => {
    const k1 = await music.service.overlayKey(profile.id);
    assert.match(k1, /^sbm_[A-Za-z0-9_-]{32}$/);
    assert.equal(await music.service.overlayKey(profile.id), k1);
    assert.equal((await music.service.profileForKey(k1)).profileId, profile.id);
    const k2 = await music.service.overlayKey(profile.id, { rotate: true });
    assert.notEqual(k2, k1);
    assert.equal(await music.service.profileForKey(k1), null);
    assert.equal((await music.service.profileForKey(k2)).profileId, profile.id);
    assert.equal(await music.service.profileForKey('sbm_short'), null);
    const out = await music.service.onStudioRequest({ profileId: profile.id, deviceId: 7 }, 'music.overlay', {});
    assert.match(out.url, /\/stream\/bot\/overlay\/music\/sbm_[A-Za-z0-9_-]{32}$/);
    await assert.rejects(music.service.onStudioRequest({ profileId: profile.id, deviceId: 7 }, 'music.nope', {}), /Unknown method/);
});
