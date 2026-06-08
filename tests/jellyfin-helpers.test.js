import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamUrl, parseMediaStreams } from '../utils/jellyfin.js';

test('streamUrl builds a static (no-transcode) URL with api key', () => {
  const url = streamUrl('abc123', { base: 'https://jf.example.net', apiKey: 'KEY' });
  assert.equal(url, 'https://jf.example.net/Videos/abc123/stream?static=true&api_key=KEY');
});

test('streamUrl strips a trailing slash on the base', () => {
  const url = streamUrl('x', { base: 'https://jf.example.net/', apiKey: 'K' });
  assert.equal(url, 'https://jf.example.net/Videos/x/stream?static=true&api_key=K');
});

test('parseMediaStreams splits audio and subtitle tracks with labels', () => {
  const item = {
    MediaStreams: [
      { Type: 'Video', Index: 0 },
      { Type: 'Audio', Index: 1, DisplayTitle: 'English 5.1', Language: 'eng' },
      { Type: 'Audio', Index: 2, DisplayTitle: 'Japanese', Language: 'jpn' },
      { Type: 'Subtitle', Index: 3, DisplayTitle: 'English (SRT)', Language: 'eng' },
    ],
  };
  const { audio, subtitles } = parseMediaStreams(item);
  assert.deepEqual(audio, [
    { index: 1, label: 'English 5.1' },
    { index: 2, label: 'Japanese' },
  ]);
  assert.deepEqual(subtitles, [{ index: 3, label: 'English (SRT)' }]);
});

test('parseMediaStreams tolerates missing MediaStreams', () => {
  assert.deepEqual(parseMediaStreams({}), { audio: [], subtitles: [] });
});
