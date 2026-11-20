import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import logger from '../utils/logger.js';
import activitiesRouter from '../dashboard/routes/activities/index.js';
import { signSession } from '../core/activities/discord-auth.js';
import { cleanDiag, diagLine } from '../core/activities/watch/diagnostics.js';
import { snapshot, bufferTracks, createWatchDiag, countOutputs } from '../frontend/activities/src/watch-diag.js';

/*
 * Watch Together sound: the "Tap for sound" button and the playback diagnostics ([WatchDiag]) the player sends once
 * playback starts and 20 s later. The page side (frontend/activities/src/watch-diag.js) is pure over fakes; the server
 * side keeps a fixed shape, needs the Activity session and writes one log line per report.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const G = '100000000000000001', C = '100000000000000002';
const USER = { id: '100000000000000011', name: 'Ash', avatar: null };

const fakeVideo = (o = {}) => ({ muted: false, volume: 0.8, paused: false, readyState: 4, currentTime: 12.345, audioTracks: undefined, ...o });
const env = {
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Discord', mediaSession: {}, mediaDevices: { enumerateDevices: async () => [{ kind: 'audiooutput', label: '' }, { kind: 'audioinput', label: '' }, { kind: 'audiooutput', label: '' }] } },
    MediaSource: { isTypeSupported: (t) => t === 'audio/mp4; codecs="mp4a.40.2"' },
    document: { featurePolicy: { allowsFeature: (f) => f !== 'speaker-selection' } },
};

test('the page report: hls.js SourceBuffers, errors, autoplay and the audio facts', async () => {
    assert.deepEqual(bufferTracks({ tracks: { audio: { container: 'audio/mp4', codec: 'mp4a.40.2' }, video: { container: 'video/mp4', levelCodec: 'avc1.640028' } } }), [
        { type: 'audio', container: 'audio/mp4', codec: 'mp4a.40.2' },
        { type: 'video', container: 'video/mp4', codec: 'avc1.640028' },
    ]);
    assert.deepEqual(bufferTracks(null), []);
    const s = snapshot(fakeVideo({ muted: true, webkitAudioDecodedByteCount: 0 }), { phase: 'start', player: 'hls.js', autoplay: 'NotAllowedError: retried muted', outputs: await countOutputs(env), env });
    assert.equal(s.muted, true);
    assert.equal(s.volume, 0.8);
    assert.equal(s.currentTime, 12.3);
    assert.equal(s.webkitAudioDecodedByteCount, 0);
    assert.equal(s.mozHasAudio, null);
    assert.equal(s.audioTracks, null);
    assert.equal(s.mediaSession, true);
    assert.equal(s.aacSupported, true);
    assert.equal(s.speakerSelection, false);
    assert.equal(s.setSinkId, false);
    assert.deepEqual(s.outputs, { count: 2, labelled: 0 }, 'counts only, never names or ids');
    assert.equal(snapshot(fakeVideo(), { phase: 'start', env: {} }).aacSupported, null, 'no MediaSource: unknown, not false');
});

test('the page sends once when playback starts and once 20 s later, per title', async () => {
    const sent = [];
    const handlers = {};
    const hls = { on: (ev, fn) => { handlers[ev] = fn; } };
    const Hls = { Events: { BUFFER_CREATED: 'bc', ERROR: 'err' } };
    const d = createWatchDiag(fakeVideo(), { send: (b) => sent.push(b), delayMs: 30, env });
    d.reset();
    d.attachHls(hls, Hls);
    handlers.bc(null, { tracks: { audiovideo: { container: 'video/mp2t', codec: 'avc1.64001f,mp4a.40.2' } } });
    handlers.err(null, { type: 'networkError', details: 'fragLoadError', fatal: false });
    d.started();
    d.started(); // a second 'playing' (after a pause) sends nothing new
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(sent.map((b) => b.phase), ['start', 'later']);
    assert.equal(sent[0].player, 'hls.js');
    assert.deepEqual(sent[0].sourceBuffers, [{ type: 'audiovideo', container: 'video/mp2t', codec: 'avc1.64001f,mp4a.40.2' }]);
    assert.deepEqual(sent[0].hlsErrors, [{ type: 'networkError', details: 'fragLoadError', fatal: false }]);
    // A new title starts over; closing the player cancels the pending 20 s report.
    d.reset();
    d.started();
    d.stop();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(sent.length, 2, 'the start report of the new title was cut off by stop() before it was built');
});

test('the server keeps a fixed shape and refuses anything that is not a report', () => {
    assert.equal(cleanDiag(null), null);
    assert.equal(cleanDiag([]), null);
    assert.equal(cleanDiag({ phase: 'whenever' }), null);
    const c = cleanDiag({
        phase: 'later', player: 'evil', userAgent: 'UA\n[WatchDiag] forged'.padEnd(500, 'x'), muted: 'yes', volume: '0.5', readyState: 9,
        sourceBuffers: [{ type: 'audio', codec: 'mp4a.40.2', extra: 'x' }, 'junk'], hlsErrors: Array.from({ length: 40 }, () => ({ type: 'mediaError', details: 'x', fatal: true })),
        outputs: { count: 3, labelled: 1, names: ['Speakers'] }, email: 'someone@example.invalid',
    });
    assert.equal(c.player, null);
    assert.equal(c.userAgent.length, 300);
    assert.ok(!c.userAgent.includes('\n'), 'no line breaks reach the log');
    assert.equal(c.muted, null);
    assert.equal(c.volume, 0.5);
    assert.equal(c.readyState, 4);
    assert.deepEqual(c.sourceBuffers, [{ type: 'audio', container: null, codec: 'mp4a.40.2' }]);
    assert.equal(c.hlsErrors.length, 20);
    assert.deepEqual(c.outputs, { count: 3, labelled: 1 });
    assert.ok(!('email' in c));
    const line = diagLine({ userId: USER.id, session: { id: 's1', guildId: G, channelId: C, media: { itemId: 'a'.repeat(32), label: 'Film', remux: true } }, diag: c });
    assert.ok(line.startsWith('[WatchDiag] {'));
    const j = JSON.parse(line.slice('[WatchDiag] '.length));
    assert.equal(j.userId, USER.id);
    assert.deepEqual(j.session, { id: 's1', guildId: G, channelId: C, itemId: 'a'.repeat(32), title: 'Film', remux: true });
    assert.equal(j.phase, 'later');
});

test('POST api/watch/diag needs the session and writes one [WatchDiag] line per report', async () => {
    const cfg = {
        enabled: true, appId: '100000000000000999', clientSecret: 'cs', botToken: 'bt', publicKey: '', sessionSecret: 's'.repeat(43), siteUrl: 'https://example.invalid', sessionTtlSec: 3600,
        watch: { maxSessions: 2, maxViewers: 10, maxBitrateKbps: 6000, cacheMb: 8, idleEndSec: 120, hostHandoverSec: 60 },
        jellyfin: { base: 'https://jf.invalid', apiKey: 'k'.repeat(32), userId: '' },
    };
    const app = express();
    app.use('/activity', activitiesRouter({ getCfg: () => cfg, db: { execute: async () => [[]] }, fetchImpl: async () => ({ status: 404, json: async () => ({}) }), media: {}, store: null, startTicker: false }));
    const srv = app.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const url = `http://127.0.0.1:${srv.address().port}/activity/api/watch/diag`;
    const tok = signSession({ user: USER, instance: { instanceId: `i-100000000000000009-gc-${G}-${C}`, guildId: G, channelId: C }, cfg });
    const lines = [];
    const info = logger.info;
    logger.info = (msg, ...rest) => { if (String(msg).startsWith('[WatchDiag]')) lines.push(String(msg)); else info.call(logger, msg, ...rest); };
    try {
        const post = (body, auth = true) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body) });
        assert.equal((await post({ phase: 'start' }, false)).status, 401);
        assert.equal((await post({ hello: 1 })).status, 400);
        const r = await post({ phase: 'start', player: 'hls.js', muted: true, volume: 1, userAgent: 'Android' });
        assert.equal(r.status, 200);
        assert.equal(lines.length, 1);
        const j = JSON.parse(lines[0].slice('[WatchDiag] '.length));
        assert.equal(j.userId, USER.id);
        assert.equal(j.session.guildId, G);
        assert.equal(j.muted, true);
        // A flood from one viewer is cut down to a few lines (6 in a burst, then one per 20 s).
        for (let i = 0; i < 10; i++) await post({ phase: 'later' });
        assert.equal(lines.length, 6);
    } finally {
        logger.info = info;
        srv.close();
    }
});

test('the player shows Tap for sound, retries a refused autoplay muted, and explains where the sound goes', () => {
    const src = fs.readFileSync(path.join(root, 'frontend/activities/src/watch.js'), 'utf8');
    assert.ok(src.includes("'Tap for sound'"));
    assert.ok(/e\?\.name === 'NotAllowedError' && !video\.muted/.test(src), 'a refused autoplay retries muted');
    assert.ok(/video\.muted \|\| video\.volume === 0/.test(src), 'the button shows while muted or at volume 0');
    assert.ok(src.includes("'api/watch/diag'"));
    assert.ok(src.includes("\"Can't hear anything?\"") && src.includes('Volume mixer'));
    const guide = fs.readFileSync(path.join(root, 'dashboard/content/guides/watch-together.js'), 'utf8');
    assert.ok(/Tap for sound/.test(guide) && /Volume mixer/.test(guide), 'the guide says the same');
});
