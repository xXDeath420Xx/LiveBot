const { test } = require('node:test');
const assert = require('node:assert');
const { buildDestinationUrl, buildFfmpegArgs } = require('../src/destinations');

test('joins base url and key with a single slash', () => {
  assert.strictEqual(
    buildDestinationUrl({ rtmp_url: 'rtmp://a.rtmp.youtube.com/live2', dest_stream_key: 'abcd-1234' }),
    'rtmp://a.rtmp.youtube.com/live2/abcd-1234'
  );
});

test('does not double a trailing slash on the base url', () => {
  assert.strictEqual(
    buildDestinationUrl({ rtmp_url: 'rtmp://a.rtmp.youtube.com/live2/', dest_stream_key: 'abcd' }),
    'rtmp://a.rtmp.youtube.com/live2/abcd'
  );
});

test('returns base url unchanged when no key is provided', () => {
  assert.strictEqual(
    buildDestinationUrl({ rtmp_url: 'rtmp://host/app/key-already-in-url', dest_stream_key: '' }),
    'rtmp://host/app/key-already-in-url'
  );
});

test('builds passthrough ffmpeg args', () => {
  assert.deepStrictEqual(
    buildFfmpegArgs('rtmp://127.0.0.1:1936/live/K', 'rtmp://dest/app/key'),
    ['-i', 'rtmp://127.0.0.1:1936/live/K', '-c', 'copy', '-f', 'flv',
     '-flvflags', 'no_duration_filesize', 'rtmp://dest/app/key']
  );
});
