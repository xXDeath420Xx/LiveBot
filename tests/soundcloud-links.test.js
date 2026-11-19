import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * H-666: SoundCloud links. The yt-dlp extractor plays SoundCloud's own audio (SoundCloud does not block this
 * server); a track SoundCloud serves only with DRM or as a 30-second Go+ preview is queued with its real title
 * and matched on YouTube when it plays; a dead link says SoundCloud, not YouTube. No network: yt-dlp and the
 * YouTube search are stubbed.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scl-'));
process.env.MUSIC_HEALTH_DATA_DIR = tmp;
process.env.LOG_DIR = tmp;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const X = await import('../core/ytdlp-extractor.js');
const pool = (await import('../utils/processPool.js')).default;

test('soundcloudPlayability: full audio, DRM only, preview only', () => {
    assert.deepEqual(X.soundcloudPlayability({ url: 'https://playback.media-streaming.soundcloud.cloud/x/aac_160k/a/playlist.m3u8', format_id: 'hls_aac_160k', formats: [{}, {}] }),
        { status: 'ok', url: 'https://playback.media-streaming.soundcloud.cloud/x/aac_160k/a/playlist.m3u8' });
    assert.deepEqual(X.soundcloudPlayability({ title: 'Bloom', formats: [] }), { status: 'drm' });
    assert.deepEqual(X.soundcloudPlayability({ title: 'Style', formats: [{ format_id: 'hls_mp3_1_0_preview' }, { format_id: 'hls_opus_preview' }] }), { status: 'preview' });
    assert.equal(X.soundcloudPlayability({ url: 'https://x/preview.m3u8', format_id: 'hls_mp3_preview', formats: [{}] }).status, 'preview');
});

test('isSoundCloudUrl and titleFromSlug', () => {
    assert.ok(X.isSoundCloudUrl('https://soundcloud.com/odesza/bloom'));
    assert.ok(X.isSoundCloudUrl('https://m.soundcloud.com/odesza/bloom'));
    assert.ok(!X.isSoundCloudUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
    assert.ok(!X.isSoundCloudUrl('https://evil.example/soundcloud.com/x'));
    assert.equal(X.titleFromSlug('city-ports'), 'City Ports');
    assert.equal(X.titleFromSlug(''), null);
});

test('classifyFailure names SoundCloud for SoundCloud errors', () => {
    const notFound = X.classifyFailure('ERROR: [soundcloud] odesza/nope: Unable to download JSON metadata: HTTP Error 404: Not Found');
    assert.match(notFound, /SoundCloud can't find that link/);
    assert.doesNotMatch(notFound, /YouTube/);
    assert.match(X.classifyFailure('ERROR: [soundcloud:set] a/sets/b: HTTP Error 403: Forbidden'), /private/);
    // YouTube errors are unchanged.
    assert.match(X.classifyFailure('ERROR: [youtube] abc: Private video'), /private/);
});

/** Run fn with ytdlpPool.execute answering `answer(args)`; records the calls. */
async function withPool(answer, fn) {
    const real = pool.execute;
    const calls = [];
    pool.execute = async (args) => { calls.push(args); return answer(args); };
    try { return await fn(calls); } finally { pool.execute = real; }
}

function extractor() {
    const ext = Object.create(X.YtDlpExtractor.prototype);
    ext.searched = [];
    ext.getAudioUrlFromSearch = async (query, durationSec, meta) => { ext.searched.push({ query, durationSec, meta }); return 'https://rr1---sn-test.googlevideo.com/videoplayback?expire=1'; };
    return ext;
}

const track = (over = {}) => ({ title: 'Bloom', author: 'ODESZA', url: 'https://soundcloud.com/odesza/bloom', duration: '3:15', raw: { title: 'Bloom', author: 'ODESZA' }, ...over });

test('stream: a playable SoundCloud track plays SoundCloud audio, no YouTube search', async () => {
    const ext = extractor();
    const audio = 'https://playback.media-streaming.soundcloud.cloud/x/aac_160k/a/playlist.m3u8';
    await withPool(() => ({ code: 0, stdout: JSON.stringify({ title: 'Faded', uploader: 'ODESZA', duration: 238, url: audio, format_id: 'hls_aac_160k', formats: [{}] }) + '\n', stderr: '' }), async (calls) => {
        assert.equal(await ext._stream(track({ url: 'https://soundcloud.com/odesza/zhu-faded-odesza-remix' })), audio);
        assert.ok(calls[0].includes('--ignore-no-formats-error'));
    });
    assert.equal(ext.searched.length, 0);
});

test('stream: a DRM-only SoundCloud track is matched on YouTube by artist, title and length', async () => {
    const ext = extractor();
    await withPool(() => ({ code: 0, stdout: JSON.stringify({ title: 'Bloom', uploader: 'ODESZA', duration: 195.7, formats: [] }) + '\n', stderr: 'WARNING: This video is DRM protected' }), async () => {
        assert.match(await ext._stream(track()), /googlevideo/);
    });
    assert.deepEqual(ext.searched, [{ query: 'ODESZA Bloom', durationSec: 196, meta: { title: 'Bloom', artist: 'ODESZA' } }]);
});

test('stream: a track queued as a preview skips the lookup and searches without the clip length', async () => {
    const ext = extractor();
    await withPool(() => { throw new Error('yt-dlp must not run'); }, async () => {
        await ext._stream(track({ title: 'Style', author: 'Taylor Swift', duration: '0:00', url: 'https://soundcloud.com/taylorswiftofficial/style', raw: { title: 'Style', author: 'Taylor Swift', scBridge: 'preview' } }));
    });
    assert.deepEqual(ext.searched, [{ query: 'Taylor Swift Style', durationSec: null, meta: { title: 'Style', artist: 'Taylor Swift' } }]);
});

test('stream: a set entry listed without a title gets its real title before the YouTube match', async () => {
    const ext = extractor();
    await withPool(() => ({ code: 0, stdout: JSON.stringify({ title: 'A Moment Apart', uploader: 'ODESZA', duration: 234, formats: [] }) + '\n', stderr: '' }), async () => {
        await ext._stream(track({ title: 'A Moment Apart', author: 'ODESZA', duration: '0:00', url: 'https://soundcloud.com/odesza/a-moment-apart', raw: {} }));
    });
    assert.equal(ext.searched[0].durationSec, 234);
});

test('stream: a dead SoundCloud link fails with the SoundCloud reason', async () => {
    const ext = extractor();
    await withPool(() => ({ code: 1, stdout: '', stderr: 'ERROR: [soundcloud] a/b: Unable to download JSON metadata: HTTP Error 404: Not Found' }), async () => {
        await assert.rejects(ext._stream(track({ url: 'https://soundcloud.com/a/b', raw: {} })), /SoundCloud can't find that link/);
    });
    assert.equal(ext.searched.length, 0);
});

test('the music guide and command no longer disagree about SoundCloud', async () => {
    const guide = (await import('../dashboard/content/guides/music.js')).default;
    const text = JSON.stringify(guide);
    assert.doesNotMatch(text, /not played/i);
    assert.match(text, /SoundCloud links play/);
    assert.match(fs.readFileSync(path.join(root, 'commands/music/music.js'), 'utf8'), /YouTube, Spotify, or SoundCloud/);
});
