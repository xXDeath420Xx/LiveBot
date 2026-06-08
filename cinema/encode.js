// cinema/encode.js
// Pure builder for the ffmpeg argument vector. The library hands this output to
// ffmpeg; we encode to H.264 + Opus (what Discord accepts), do the single
// transcode here, optionally burn one subtitle, and map one audio track.

/**
 * @param {object} o
 * @param {string} o.streamUrl   Jellyfin static stream URL
 * @param {number} o.width
 * @param {number} o.height
 * @param {number} o.fps
 * @param {number} o.bitrateKbps
 * @param {number} o.startSecs   seek target (0 = start)
 * @param {number|null} o.audioIndex  Jellyfin MediaStream Index for audio
 * @param {number|null} o.subIndex    Jellyfin MediaStream Index for subtitle, or null
 * @returns {string[]} argv for ffmpeg
 */
export function buildFfmpegArgs(o) {
  const args = [];
  // Input-side fast seek: -ss before -i. (No -re — @dank074/discord-video-stream's
  // packetizer paces output frames itself; -re would double-pace.)
  if (o.startSecs > 0) args.push('-ss', String(o.startSecs));
  args.push('-i', o.streamUrl);

  // Stream selection: video + the chosen audio track (fall back to first audio).
  args.push('-map', '0:v:0');
  args.push('-map', o.audioIndex != null ? `0:${o.audioIndex}` : '0:a:0?');

  // Video filter chain: scale, then optionally burn subtitles.
  // Burning a specific subtitle stream uses the subtitles filter's si= option
  // (zero-based index among subtitle streams). For v1 we burn the first text
  // stream (si=0); multi-text refinement is a documented follow-up.
  let vf = `scale=${o.width}:${o.height}`;
  if (o.subIndex != null) {
    // Escape for the ffmpeg filtergraph: backslash FIRST (so we don't double-escape
    // what we add), then single-quote, then the ':' option separator.
    const escUrl = o.streamUrl
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/:/g, '\\:');
    vf += `,subtitles='${escUrl}':si=0`;
  }
  args.push('-vf', vf, '-r', String(o.fps));

  // Video encode — MUST match @dank074/discord-video-stream's expected H264 shape
  // (its LibavDemuxer + packetizer require: no B-frames, IDR-forced keyframes every
  // second, yuv420p). -tune film / -preset superfast mirror the library defaults.
  args.push(
    '-c:v', 'libx264', '-tune', 'film', '-preset', 'superfast', '-forced-idr', '1',
    '-b:v', `${o.bitrateKbps}k`, '-maxrate:v', `${o.bitrateKbps}k`,
    '-bufsize:v', `${Math.round(o.bitrateKbps / 2)}k`,
    '-bf', '0', '-pix_fmt', 'yuv420p',
    '-force_key_frames', 'expr:gte(t,n_forced*1)',
  );

  // Audio encode (Opus 48k stereo) — what Discord accepts.
  args.push('-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-b:a', '128k');
  return args;
}
