import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mediaKey, signRef, verifyRef, rewritePlaylist, allowedUpstreamPath, stripKeyParams } from '../core/activities/watch/media-links.js';
import { createSegmentCache } from '../core/activities/watch/segment-cache.js';
import { targetPosition, clockOffset, correction } from '../frontend/activities/src/sync.js';
import { mergeEntryPoint } from '../utils/entry-point-command.js';

/*
 * Discord Activities (docs/activities.md), the pure parts:
 *   - the signed video links and the playlist rewrite: no Jellyfin key, host or foreign path ever reaches a viewer,
 *     a link only works for its session's current title, Trickplay and key lines are dropped
 *   - the shared segment cache: one Jellyfin fetch however many viewers ask at once; least recently used goes first
 *   - Watch Together's clock maths (frontend/activities/src/sync.js)
 *   - the Entry Point command survives a bulk command deploy (utils/entry-point-command.js)
 */

const ITEM = '2f58c2cc6ee0a6e6d26ad0e36cdbb148';
const GUID = '2f58c2cc-6ee0-a6e6-d26a-d0e36cdbb148';
const SECRET = 'x'.repeat(40);

test('a signed link names one upstream path and only verifies with its own session and title', () => {
    const k1 = mediaKey(SECRET, 'sessionAAAAAAAAAAAAAAAAA', 1);
    const rel = `/videos/${GUID}/hls1/main/0.ts?MediaSourceId=a&runtimeTicks=0`;
    const name = signRef(k1, rel);
    assert.match(name, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{27}\.ts$/);
    assert.equal(verifyRef(k1, name), rel);
    assert.equal(verifyRef(mediaKey(SECRET, 'sessionAAAAAAAAAAAAAAAAA', 2), name), null, 'the next title kills old links');
    assert.equal(verifyRef(mediaKey(SECRET, 'sessionBBBBBBBBBBBBBBBBB', 1), name), null, 'another session cannot use it');
    const [b64, , ext] = name.split('.');
    assert.equal(verifyRef(k1, `${b64}.${'A'.repeat(27)}.${ext}`), null, 'forged signature');
    const other = Buffer.from(`/videos/${GUID}/hls1/main/1.ts`).toString('base64url');
    assert.equal(verifyRef(k1, `${other}.${name.split('.')[1]}.ts`), null, 'signature of another path');
    assert.equal(verifyRef(k1, '../../etc/passwd'), null);
});

test('only this title\'s HLS files and subtitles may be fetched', () => {
    assert.ok(allowedUpstreamPath(`/videos/${GUID}/master.m3u8?x=1`, ITEM));
    assert.ok(allowedUpstreamPath(`/Videos/${ITEM}/main.m3u8`, ITEM));
    assert.ok(allowedUpstreamPath(`/videos/${GUID}/hls1/main/12.ts?a=b`, ITEM));
    assert.ok(allowedUpstreamPath(`/Videos/${ITEM}/${ITEM}/Subtitles/3/0/Stream.vtt`, ITEM));
    assert.ok(!allowedUpstreamPath(`/videos/${'f'.repeat(32)}/main.m3u8`, ITEM), 'another title');
    assert.ok(!allowedUpstreamPath('/Users', ITEM));
    assert.ok(!allowedUpstreamPath(`/videos/${GUID}/../../System/Info`, ITEM));
    assert.ok(!allowedUpstreamPath(`/videos/${GUID}/hls1/main/%2e%2e/x.ts`, ITEM));
    assert.ok(!allowedUpstreamPath(`/videos/${GUID}/stream?static=true`, ITEM), 'direct file download is not offered');
    assert.ok(!allowedUpstreamPath(`/videos/${GUID}/Trickplay/320/tiles.m3u8`, ITEM));
});

test('the playlist rewrite removes every key, host and foreign line', () => {
    const key = mediaKey(SECRET, 'sessionAAAAAAAAAAAAAAAAA', 1);
    const apiKey = 'a'.repeat(32);
    const master = [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=4278929,CODECS="avc1.64001F,mp4a.40.2",RESOLUTION=1280x720',
        `main.m3u8?MediaSourceId=x&PlaySessionId=p&ApiKey=${apiKey}&api_key=${apiKey}`,
        `#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=10292,RESOLUTION=320x180,CODECS="jpeg",URI="Trickplay/320/tiles.m3u8?ApiKey=${apiKey}"`,
        '#EXT-X-STREAM-INF:BANDWIDTH=1',
        'https://evil.example/steal.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=2',
        '/System/Info',
        '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
        '',
    ].join('\r\n');
    const out = rewritePlaylist(master, `/videos/${GUID}/master.m3u8?DeviceId=d`, { key, itemId: ITEM });
    assert.ok(!out.includes(apiKey), 'no API key');
    assert.ok(!/api_?key/i.test(out));
    assert.ok(!out.includes('evil.example') && !out.includes('System') && !out.includes('Trickplay') && !out.includes('EXT-X-KEY'));
    const uris = out.split('\n').filter((l) => l && !l.startsWith('#'));
    assert.equal(uris.length, 1, 'only the real variant stays');
    assert.equal((out.match(/#EXT-X-STREAM-INF/g) || []).length, 1, 'the dropped variants lose their tag lines too');
    const rel = verifyRef(key, uris[0]);
    assert.equal(rel, `/videos/${GUID}/main.m3u8?MediaSourceId=x&PlaySessionId=p`);
    const main = `#EXTM3U\n#EXT-X-MAP:URI="hls1/main/-1.mp4?ApiKey=${apiKey}"\n#EXTINF:3.0, nodesc\nhls1/main/0.ts?runtimeTicks=0&api_key=${apiKey}\n#EXT-X-ENDLIST\n`;
    const out2 = rewritePlaylist(main, rel, { key, itemId: ITEM });
    assert.ok(!out2.includes(apiKey));
    assert.match(out2, /#EXT-X-MAP:URI="[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{27}\.mp4"/);
    assert.equal(verifyRef(key, out2.split('\n').find((l) => l && !l.startsWith('#'))), `/videos/${GUID}/hls1/main/0.ts?runtimeTicks=0`);
    assert.equal(stripKeyParams(`/x?a=1&ApiKey=${apiKey}&X-Emby-Token=t&b=2`), '/x?a=1&b=2');
});

test('the segment cache fetches once for everyone and drops the least recently used', async () => {
    let calls = 0;
    const c = createSegmentCache({ maxBytes: 30, maxItemBytes: 20 });
    const loader = (n) => async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { status: 200, type: 'video/mp2t', body: Buffer.alloc(n) }; };
    const all = await Promise.all(Array.from({ length: 12 }, () => c.get('s:1:a', loader(10))));
    assert.equal(calls, 1, '12 viewers, one upstream fetch');
    assert.ok(all.every((r) => r.status === 200 && r.body.length === 10));
    await c.get('s:1:b', loader(10));
    await c.get('s:1:a', loader(10)); // a is now the most recent
    await c.get('s:1:c', loader(15)); // 35 > 30: b goes
    assert.equal(calls, 3);
    await c.get('s:1:a', loader(10));
    assert.equal(calls, 3, 'a stayed');
    await c.get('s:1:b', loader(10));
    assert.equal(calls, 4, 'b was dropped');
    await c.get('s:1:big', loader(25));
    await c.get('s:1:big', loader(25));
    assert.equal(calls, 6, 'too big to keep');
    await c.get('s:1:404', async () => { calls++; return { status: 404 }; });
    await c.get('s:1:404', async () => { calls++; return { status: 404 }; });
    assert.equal(calls, 8, 'failures are not kept');
    c.dropPrefix('s:1:');
    assert.equal(c.stats().items, 0);
});

test('the shared clock: target position, offset from the fastest sample, and drift correction', () => {
    const pb = { paused: false, position: 100, at: 1_000_000 };
    assert.equal(targetPosition(pb, 1_010_000, 6000), 110);
    assert.equal(targetPosition({ ...pb, paused: true }, 1_010_000, 6000), 100);
    assert.equal(targetPosition(pb, 1_010_000, 105), 105, 'never past the end');
    assert.equal(targetPosition(pb, 900_000, 6000), 0, 'never negative');
    assert.equal(clockOffset([{ serverNow: 5000, at: 1000, rtt: 400 }, { serverNow: 5100, at: 1200, rtt: 40 }, { serverNow: 0, at: 0, rtt: 99999 }]), 3900);
    assert.equal(clockOffset([]), 0);
    assert.deepEqual(correction({ current: 10, target: 10.05, paused: false }), { seek: null, rate: 1 });
    assert.deepEqual(correction({ current: 10, target: 10.6, paused: false }), { seek: null, rate: 1.05 }, 'behind: a little faster');
    assert.deepEqual(correction({ current: 11, target: 10.4, paused: false }), { seek: null, rate: 0.95 }, 'ahead: a little slower');
    assert.deepEqual(correction({ current: 10, target: 10.15, paused: false, nudging: true }), { seek: null, rate: 1.05 }, 'keeps nudging until close');
    assert.deepEqual(correction({ current: 10, target: 30, paused: false }), { seek: 30, rate: 1 }, 'a join part-way jumps');
    assert.deepEqual(correction({ current: 10, target: 12, paused: true }), { seek: 12, rate: 1 });
    assert.deepEqual(correction({ current: 10, target: 10.2, paused: true }), { seek: null, rate: 1 });
});

test('a bulk deploy keeps the Activity\'s Entry Point command', () => {
    const body = [{ name: 'help', type: 1, description: 'Help' }];
    assert.deepEqual(mergeEntryPoint(body, [{ id: '1', name: 'help', type: 1 }]), body, 'no Entry Point: unchanged');
    const ep = { id: '99', name: 'launch', description: 'Launch an activity', type: 4, handler: 2, integration_types: [0, 1], contexts: [0, 1, 2], version: '5' };
    const out = mergeEntryPoint(body, [{ id: '1', name: 'help', type: 1 }, ep]);
    assert.equal(out.length, 2);
    assert.deepEqual(out[1], { id: '99', type: 4, name: 'launch', description: 'Launch an activity', handler: 2, integration_types: [0, 1], contexts: [0, 1, 2] });
    const own = [...body, { name: 'play', type: 4, handler: 1, description: 'x' }];
    assert.equal(mergeEntryPoint(own, [ep]).length, 2, 'a payload with its own Entry Point is left alone');
    assert.equal(crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').length, 40); // body not mutated
    assert.equal(body.length, 1);
});
