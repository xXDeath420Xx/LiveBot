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
  // Input-side fast seek: -ss before -i.
  if (o.startSecs > 0) args.push('-ss', String(o.startSecs));
  args.push('-re', '-i', o.streamUrl);

  // Video filter chain: scale, then optionally burn subtitles.
  // Burning a specific subtitle stream uses the subtitles filter's si= option
  // (zero-based index among subtitle streams). For v1 we burn the first text
  // stream (si=0); multi-text refinement is a documented follow-up.
  let vf = `scale=${o.width}:${o.height}`;
  if (o.subIndex != null) {
    vf += `,subtitles='${o.streamUrl.replace(/:/g, '\\:').replace(/'/g, "\\'")}':si=0`;
  }

  args.push('-vf', vf, '-r', String(o.fps));

  // Audio mapping: video stream 0 + chosen audio index.
  args.push('-map', '0:v:0');
  if (o.audioIndex != null) args.push('-map', `0:${o.audioIndex}`);

  // Encoders tuned for low-latency live.
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-b:v', `${o.bitrateKbps}k`, '-maxrate', `${o.bitrateKbps}k`,
    '-bufsize', `${o.bitrateKbps * 2}k`, '-pix_fmt', 'yuv420p',
    '-g', String(o.fps * 2),
    '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2',
  );
  return args;
}
