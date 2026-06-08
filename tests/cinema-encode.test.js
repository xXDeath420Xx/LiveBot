import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFfmpegArgs } from '../cinema/encode.js';

const base = {
  streamUrl: 'http://jf/Videos/x/stream?static=true',
  width: 1280, height: 720, fps: 30, bitrateKbps: 2500,
  startSecs: 0, audioIndex: 1, subIndex: null,
};

test('maps the chosen audio track and scales to target resolution', () => {
  const args = buildFfmpegArgs(base);
  const s = args.join(' ');
  assert.ok(s.includes('-map 0:1'), 'maps audio index 1');
  assert.ok(s.includes('scale=1280:720'));
  assert.ok(s.includes('-r 30'));
  assert.ok(s.includes('libx264'));
});

test('seeks with -ss BEFORE -i when startSecs > 0', () => {
  const args = buildFfmpegArgs({ ...base, startSecs: 42 });
  const ssIdx = args.indexOf('-ss');
  const iIdx = args.indexOf('-i');
  assert.ok(ssIdx !== -1 && ssIdx < iIdx, '-ss precedes -i for fast seek');
  assert.equal(args[ssIdx + 1], '42');
});

test('burns the chosen subtitle into the video filter chain', () => {
  const args = buildFfmpegArgs({ ...base, subIndex: 3 });
  const vf = args[args.indexOf('-vf') + 1];
  assert.ok(vf.includes('subtitles='), 'has subtitles filter');
  assert.ok(vf.includes("si=") || vf.includes(':stream_index=3') || vf.includes('si=0'),
    'targets a subtitle stream');
});

test('omits subtitles filter when subIndex is null', () => {
  const args = buildFfmpegArgs(base);
  const vf = args[args.indexOf('-vf') + 1];
  assert.ok(!vf.includes('subtitles='));
});
