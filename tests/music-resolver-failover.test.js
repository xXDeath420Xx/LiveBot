import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * The routing rules for YouTube plays across the residential resolvers (server2, workstation) and
 * the next-track prefetch, exercised against fake resolvers on local ports:
 *   - a dead tunnel moves to the same resolver's next tunnel
 *   - an IP/environment failure (bot wall, auth, slowness) moves to the NEXT resolver
 *   - a per-video failure (unavailable) stops — another network can't fix a removed video
 *   - a resolver that keeps timing out is skipped by the circuit breaker
 * Each test uses fresh ports, because breaker state is per tunnel URL and lives for the process.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mrf-'));
process.env.MUSIC_RESOLVER_ATTEMPT_MIN_MS = '300';
process.env.MUSIC_HEALTH_DATA_DIR = tmp; // the extractor pulls in the monitor; keep it off the live state file
process.env.LOG_DIR = tmp;               // and keep the fake 401s/timeouts out of the bot's real logs
const { callResolver, prefetchStream, takePrefetched, canonicalYouTubeUrl, prefetchExpiry, getPrefetchStats, bridgeTrackMeta } =
    await import('../core/ytdlp-extractor.js');

const servers = [];
/** A fake resolver: `respond(body)` -> { status, json } | 'hang'. Rejects any other bearer secret. */
async function fakeResolver(secret, respond) {
    const fake = { hits: 0, relayStatus: 206 };
    const server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url.startsWith('/audio/')) {   // the audio relay: token in the path, no bearer
            res.writeHead(fake.relayStatus, { 'content-type': 'audio/webm' });
            return res.end(fake.relayStatus === 206 ? 'x' : '');
        }
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', async () => {
            fake.hits++;
            if (req.headers.authorization !== `Bearer ${secret}`) {
                res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"ok":false,"reason":"bad_auth"}');
            }
            const r = await respond(JSON.parse(body || '{}'));
            if (r === 'hang') return; // never answer
            res.writeHead(r.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(r.json));
        });
    });
    await new Promise(ok => server.listen(0, '127.0.0.1', ok));
    servers.push(server);
    fake.base = `http://127.0.0.1:${server.address().port}`;
    return fake;
}
async function deadBase() {
    const s = http.createServer();
    await new Promise(ok => s.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${s.address().port}`;
    await new Promise(ok => s.close(ok));
    return base; // nothing listens here any more -> ECONNREFUSED
}
let n = 0;
function configure(groups) {
    // groups: [{ name, bases[], secret }]
    process.env.MUSIC_RESOLVERS = groups.map(g => `${g.name}=${g.bases.join('|')}`).join(';');
    for (const g of groups) {
        const f = path.join(tmp, `secret-${g.name}-${++n}`);
        fs.writeFileSync(f, g.secret);
        process.env[`MUSIC_RESOLVER_SECRET_FILE_${g.name.toUpperCase()}`] = f;
    }
}
const ok = (audioUrl = 'https://rr1.googlevideo.com/videoplayback?itag=251') => ({ status: 200, json: { ok: true, audioUrl, mode: 'cookies' } });
const fail = (status, reason) => ({ status, json: { ok: false, reason } });

test.after(() => { for (const s of servers) s.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('dead tunnel -> the same resolver\'s next tunnel', async () => {
    const live = await fakeResolver('s2', () => ok());
    configure([{ name: 'alpha', bases: [await deadBase(), live.base], secret: 's2' }]);
    const r = await callResolver('/resolve', { url: 'x' }, 'test', 5000);
    assert.equal(r?.ok, true);
    assert.equal(live.hits, 1);
});

test('bot wall on the first resolver fails over to the next resolver (each gets its own secret)', async () => {
    const first = await fakeResolver('sec-a', () => fail(502, 'bot_wall'));
    const second = await fakeResolver('sec-b', () => ok('https://rr2.googlevideo.com/videoplayback?itag=251'));
    configure([{ name: 'alpha', bases: [first.base], secret: 'sec-a' }, { name: 'beta', bases: [second.base], secret: 'sec-b' }]);
    const r = await callResolver('/resolve', { url: 'x' }, 'test', 5000);
    assert.equal(r?.audioUrl, 'https://rr2.googlevideo.com/videoplayback?itag=251');
    assert.deepEqual([first.hits, second.hits], [1, 1]);
});

test('a per-video failure stops — the next resolver is not asked', async () => {
    const first = await fakeResolver('a', () => fail(502, 'unavailable'));
    const second = await fakeResolver('b', () => ok());
    configure([{ name: 'alpha', bases: [first.base], secret: 'a' }, { name: 'beta', bases: [second.base], secret: 'b' }]);
    assert.equal(await callResolver('/resolve', { url: 'x' }, 'test', 5000), null);
    assert.equal(second.hits, 0);
});

test('a rejected secret (401) moves on to the next resolver', async () => {
    const first = await fakeResolver('right', () => ok());
    const second = await fakeResolver('b', () => ok('https://rr3.googlevideo.com/videoplayback'));
    configure([{ name: 'alpha', bases: [first.base], secret: 'WRONG' }, { name: 'beta', bases: [second.base], secret: 'b' }]);
    const r = await callResolver('/resolve', { url: 'x' }, 'test', 5000);
    assert.equal(r?.audioUrl, 'https://rr3.googlevideo.com/videoplayback');
});

test('a hanging resolver times out to the next one, and after 3 slow failures the breaker skips it', async () => {
    const hung = await fakeResolver('a', () => 'hang');
    const good = await fakeResolver('b', () => ok());
    configure([{ name: 'alpha', bases: [hung.base], secret: 'a' }, { name: 'beta', bases: [good.base], secret: 'b' }]);
    for (let i = 0; i < 3; i++) assert.equal((await callResolver('/resolve', { url: 'x' }, 'test', 2500))?.ok, true);
    assert.equal(hung.hits, 3);
    const t0 = Date.now();
    assert.equal((await callResolver('/resolve', { url: 'x' }, 'test', 2500))?.ok, true);
    assert.equal(hung.hits, 3, 'circuit is open: the hung resolver must not be contacted');
    assert.ok(Date.now() - t0 < 250, 'with the breaker open the play goes straight to the healthy resolver');
});

test('only "all resolvers failed" reaches the caller as null', async () => {
    const a = await fakeResolver('a', () => fail(502, 'bot_wall'));
    const b = await fakeResolver('b', () => fail(504, 'ytdlp_timeout'));
    configure([{ name: 'alpha', bases: [a.base], secret: 'a' }, { name: 'beta', bases: [b.base], secret: 'b' }]);
    assert.equal(await callResolver('/resolve', { url: 'x' }, 'test', 5000), null);
    assert.deepEqual([a.hits, b.hits], [1, 1]);
});

test('canonicalYouTubeUrl: every YouTube URL shape keys on the video id', () => {
    const want = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    for (const u of ['https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDxyz&index=3',
        'https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/shorts/dQw4w9WgXcQ']) {
        assert.equal(canonicalYouTubeUrl(u), want, u);
    }
    assert.equal(canonicalYouTubeUrl('https://open.spotify.com/track/abc'), null);
    assert.equal(canonicalYouTubeUrl('not a url'), null);
});

test('prefetchExpiry: googlevideo expire minus 10 min, capped at 1 hour', () => {
    const now = 1_800_000_000_000;
    const soon = `https://x/videoplayback?expire=${Math.floor(now / 1000) + 30 * 60}`;
    assert.equal(prefetchExpiry(soon, now), now + 20 * 60 * 1000);
    const far = `https://x/videoplayback?expire=${Math.floor(now / 1000) + 6 * 3600}`;
    assert.equal(prefetchExpiry(far, now), now + 60 * 60 * 1000);
});

test('prefetch: resolved once, taken once; a take during the prefetch waits for it instead of re-resolving', async () => {
    const expire = Math.floor(Date.now() / 1000) + 6 * 3600;
    const audioUrl = `https://rr9.googlevideo.com/videoplayback?expire=${expire}&itag=251`;
    const slow = await fakeResolver('p', () => new Promise(r => setTimeout(() => r(ok(audioUrl)), 300)));
    configure([{ name: 'alpha', bases: [slow.base], secret: 'p' }]);
    const before = getPrefetchStats();

    prefetchStream({ url: 'https://youtu.be/AAAAAAAAAAA', title: 'next song' }); // not awaited: still in flight
    const got = await takePrefetched('https://www.youtube.com/watch?v=AAAAAAAAAAA&list=RDx');
    assert.equal(got, audioUrl);
    assert.equal(slow.hits, 1, 'the take must reuse the in-flight prefetch, not resolve again');
    assert.equal(await takePrefetched('https://youtu.be/AAAAAAAAAAA'), null, 'a prefetched URL is single-use');

    const after = getPrefetchStats();
    assert.equal(after.hits - before.hits, 1);
    assert.equal(after.awaitedInFlight - before.awaitedInFlight, 1);
});

test('bridge: Spotify metadata reaches the resolver intact, explicit only when actually known', async () => {
    assert.deepEqual(bridgeTrackMeta({ title: 'Without Me', author: 'Eminem', metadata: { explicit: true } }),
        { title: 'Without Me', artist: 'Eminem', explicit: true });
    assert.deepEqual(bridgeTrackMeta({ title: 'Circles', author: 'Post Malone' }), { title: 'Circles', artist: 'Post Malone' });
    assert.equal(bridgeTrackMeta({ author: 'x' }), null);

    let seen;
    const r = await fakeResolver('m', (body) => { seen = body; return ok(); });
    configure([{ name: 'alpha', bases: [r.base], secret: 'm' }]);
    await callResolver('/resolve', { searchQuery: 'Without Me Eminem explicit', expectedDurationSec: 290,
        track: bridgeTrackMeta({ title: 'Without Me', author: 'Eminem', metadata: { explicit: true } }) }, 'test', 5000);
    assert.deepEqual([seen.expectedDurationSec, seen.track], [290, { title: 'Without Me', artist: 'Eminem', explicit: true }]);
});

test('the resolver\'s relay is what plays (via the tunnel that answered), and its expire still times the prefetch cache', async () => {
    const expire = Math.floor(Date.now() / 1000) + 6 * 3600;
    const relay = `/audio/${'a'.repeat(32)}?expire=${expire}`;
    const r = await fakeResolver('rl', () => ({ status: 200,
        json: { ok: true, audioUrl: `https://rr1.googlevideo.com/videoplayback?expire=${expire}&itag=251`, streamPath: relay } }));
    configure([{ name: 'alpha', bases: [await deadBase(), r.base], secret: 'rl' }]);   // first tunnel dead: relay must use the live one
    prefetchStream({ url: 'https://youtu.be/CCCCCCCCCCC', title: 'relay song' });
    const got = await takePrefetched('https://www.youtube.com/watch?v=CCCCCCCCCCC');
    assert.equal(got, `${r.base}${relay}`);
    assert.ok(prefetchExpiry(got) >= Date.now() + 59 * 60 * 1000, 'expire= in the relay URL keeps the 1h cache window');

    // The resolver restarted between prefetch and play: its token is gone, so the cached link is not used.
    prefetchStream({ url: 'https://youtu.be/DDDDDDDDDDD', title: 'stale relay' });
    await new Promise(ok => setTimeout(ok, 200));
    r.relayStatus = 404;
    const before = getPrefetchStats().stale;
    assert.equal(await takePrefetched('https://youtu.be/DDDDDDDDDDD'), null);
    assert.equal(getPrefetchStats().stale - before, 1);
});

test('prefetch: Spotify tracks and unresolved tracks are ignored', async () => {
    assert.equal(await prefetchStream({ url: 'https://open.spotify.com/track/abc' }), null);
    assert.equal(await prefetchStream({ url: 'https://youtu.be/BBBBBBBBBBB', raw: { ytdlpUnresolved: true } }), null);
});
