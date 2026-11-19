import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createSigner, proxyAudio, newOverlayKey, keyHash, isKeyShape, audioPath, defaultSecret } from '../core/stream-bot/music/audio.js';

/*
 * The song request audio path (core/stream-bot/music/audio.js): overlay keys, short-lived signed links bound to the
 * profile, the key and the play, and the proxy that streams the resolver relay's audio to the OBS player with Range
 * requests passed through and nothing else (no cookies, no upstream address). A local server stands in for the relay.
 */

const BODY = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
let upstream, upstreamUrl, app, appServer, base, seen = [];

test.before(async () => {
    upstream = http.createServer((req, res) => {
        seen.push({ url: req.url, range: req.headers.range || null, cookie: req.headers.cookie || null });
        if (req.url === '/fail') { res.writeHead(500); return res.end('boom'); }
        const m = String(req.headers.range || '').match(/^bytes=(\d+)-(\d*)$/);
        const head = { 'content-type': 'audio/webm', 'accept-ranges': 'bytes', 'set-cookie': 'secret=1', 'x-resolver': 'server2' };
        if (m) {
            const start = Number(m[1]), end = m[2] ? Number(m[2]) : BODY.length - 1;
            res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${BODY.length}`, 'content-length': end - start + 1 });
            return res.end(BODY.subarray(start, end + 1));
        }
        res.writeHead(200, { ...head, 'content-length': BODY.length });
        return res.end(BODY);
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
    app = express();
    app.get('/a/:path', (req, res) => proxyAudio(req, res, `${upstreamUrl}/${req.params.path}`));
    app.get('/dead', (req, res) => proxyAudio(req, res, 'http://127.0.0.1:1/never'));
    appServer = app.listen(0, '127.0.0.1');
    await new Promise((r) => appServer.once('listening', r));
    base = `http://127.0.0.1:${appServer.address().port}`;
});
test.after(async () => { appServer?.close(); upstream?.close(); });

test('overlay keys: shape, hash, and nothing else accepted', () => {
    const k = newOverlayKey();
    assert.ok(isKeyShape(k));
    assert.equal(keyHash(k).length, 64);
    assert.notEqual(newOverlayKey(), k);
    for (const bad of ['', 'sbm_', `sbm_${'a'.repeat(31)}`, `sbx_${'a'.repeat(32)}`, `sbm_${'a'.repeat(31)}/`]) assert.equal(isKeyShape(bad), false, bad);
});

test('signed links: bound to profile, key and play, and they expire', () => {
    const clock = { t: 1_763_500_000_000 };
    const s = createSigner({ secret: 'k'.repeat(40), now: () => clock.t });
    const a = s.sign({ profileId: 4, keyHash: 'kh', playId: '77', ttlMs: 10 * 60_000 });
    assert.equal(s.verify({ profileId: 4, keyHash: 'kh', playId: '77', ...a }), true);
    assert.equal(s.verify({ profileId: 5, keyHash: 'kh', playId: '77', ...a }), false, 'another profile');
    assert.equal(s.verify({ profileId: 4, keyHash: 'other', playId: '77', ...a }), false, 'another key (rotated)');
    assert.equal(s.verify({ profileId: 4, keyHash: 'kh', playId: '78', ...a }), false, 'another play');
    assert.equal(s.verify({ profileId: 4, keyHash: 'kh', playId: '77', exp: a.exp + 1, sig: a.sig }), false, 'a longer life');
    assert.equal(s.verify({ profileId: 4, keyHash: 'kh', playId: '77', exp: a.exp, sig: 'x' }), false);
    clock.t += 11 * 60_000;
    assert.equal(s.verify({ profileId: 4, keyHash: 'kh', playId: '77', ...a }), false, 'expired');
    assert.throws(() => createSigner({ secret: 'short' }));
    assert.match(audioPath('sbm_x', '9', a), /^\/stream\/bot\/overlay\/music\/sbm_x\/audio\/9\?exp=\d+&sig=/);
    assert.ok(defaultSecret({ SESSION_SECRET: 'abc' }).length >= 32);
    assert.equal(defaultSecret({ STREAM_BOT_MUSIC_SECRET: 'z'.repeat(32) }), 'z'.repeat(32));
});

test('the proxy streams the whole song, and a Range request gets 206 with its bytes', async () => {
    seen = [];
    const full = await fetch(`${base}/a/song`, { headers: { cookie: 'connect.sid=abc' } });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'audio/webm');
    assert.equal(full.headers.get('set-cookie'), null, 'upstream cookies are not passed on');
    assert.equal(full.headers.get('x-resolver'), null, 'nothing about the upstream is passed on');
    assert.equal(full.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), BODY);
    assert.equal(seen[0].cookie, null, "the viewer's cookies never go upstream");
    const part = await fetch(`${base}/a/song`, { headers: { range: 'bytes=100-199' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 100-199/1000');
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), BODY.subarray(100, 200));
    assert.equal(seen[1].range, 'bytes=100-199');
    await fetch(`${base}/a/song`, { headers: { range: 'items=1-2' } }).then((r) => r.arrayBuffer());
    assert.equal(seen[2].range, null, 'odd Range values are dropped');
});

test('an upstream error or an unreachable relay is a 502, never the upstream body', async () => {
    const r = await fetch(`${base}/a/fail`);
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { ok: false, error: 'audio_upstream' });
    const d = await fetch(`${base}/dead`);
    assert.equal(d.status, 502);
    assert.equal((await d.json()).error, 'audio_unreachable');
});
