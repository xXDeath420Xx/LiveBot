'use strict';

function buildDestinationUrl(dest) {
  const base = String(dest.rtmp_url || '').replace(/\/+$/, '');
  const key = String(dest.dest_stream_key || '').trim();
  return key ? `${base}/${key}` : base;
}

function buildFfmpegArgs(inputUrl, outputUrl) {
  return [
    '-i', inputUrl,
    '-c', 'copy',
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    outputUrl
  ];
}

module.exports = { buildDestinationUrl, buildFfmpegArgs };
