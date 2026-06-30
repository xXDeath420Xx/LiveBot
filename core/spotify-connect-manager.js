/**
 * Spotify Connect manager — drives go-librespot instances (real Spotify audio).
 *
 * Each "session" is one authenticated go-librespot process (one Spotify account):
 *   - REST API on 127.0.0.1:<port>  (play/pause/resume/status)
 *   - raw s16le 44.1k stereo PCM written to its FIFO when playing
 *
 * The owner account is registered at boot. Per-user accounts (Spoticord model) get
 * registered later when users link their own. One session = one concurrent stream,
 * so a session is "acquired" by a guild while it plays and released when it stops.
 *
 * See memory: project_spotify_direct_librespot.
 */
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import logger from '../utils/logger.js';

const sessions = new Map(); // id -> { id, port, fifo, busyGuildId }

export function registerSession(id, port, fifo) {
  sessions.set(id, { id, port, fifo, busyGuildId: null });
  logger.info(`[SpotifyConnect] registered session "${id}" on :${port}`);
  return sessions.get(id);
}

// Owner account (the shared fallback). Lives under PM2 as "spotify-owner".
registerSession('owner', 3678, '/home/death/go-librespot/accounts/owner/audio.pipe');

function req(session, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      { host: '127.0.0.1', port: session.port, path, method, timeout: 10000,
        headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => { let s = ''; res.on('data', c => s += c); res.on('end', () => resolve({ code: res.statusCode, body: s })); }
    );
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(new Error('go-librespot API timeout')); });
    if (data) r.write(data);
    r.end();
  });
}

export async function play(session, uri)   { return req(session, 'POST', '/player/play', { uri }); }
export async function pause(session)        { return req(session, 'POST', '/player/pause'); }
export async function resume(session)       { return req(session, 'POST', '/player/resume'); }
export async function stop(session)         { return req(session, 'POST', '/player/pause').catch(() => {}); }
export async function getStatus(session)    { const r = await req(session, 'GET', '/status'); try { return JSON.parse(r.body); } catch { return null; } }

export async function isAlive(session) {
  try { const r = await req(session, 'GET', '/status'); return r.code === 200; } catch { return false; }
}

/** Pick a session for a user: their own linked account (later) → owner if free → null. */
export function pickSession(/* userId */) {
  const owner = sessions.get('owner');
  return owner || null;
}

export function acquire(session, guildId) {
  if (session.busyGuildId && session.busyGuildId !== guildId) return false;
  session.busyGuildId = guildId;
  return true;
}
export function release(session, guildId) {
  if (!guildId || session.busyGuildId === guildId) session.busyGuildId = null;
}
export function isFree(session) { return !session.busyGuildId; }

/**
 * Open a 48kHz/stereo/16-bit raw PCM stream from a session's FIFO, ready for
 * @discordjs/voice (StreamType.Raw). ffmpeg resamples 44.1k→48k. Returns the ffmpeg
 * child + its stdout; the FIFO is opened with O_NONBLOCK-style ordering by letting
 * ffmpeg block on the read until go-librespot (the writer) starts.
 */
export function openPcmStream(session) {
  const ff = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', session.fifo,
    '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  ff.stderr.on('data', d => { const s = d.toString().trim(); if (s) logger.debug(`[SpotifyConnect ffmpeg] ${s}`); });
  ff.on('error', e => logger.error(`[SpotifyConnect] ffmpeg spawn error: ${e.message}`));
  return ff;
}

export function getSession(id) { return sessions.get(id); }

/** open.spotify.com/<type>/<id> (or a spotify: URI) → spotify:<type>:<id>. */
export function uriFromUrl(url) {
  if (!url) return null;
  if (url.startsWith('spotify:')) return url;
  const m = String(url).match(/spotify\.com\/(track|playlist|album|artist|episode|show)\/([A-Za-z0-9]+)/);
  return m ? `spotify:${m[1]}:${m[2]}` : null;
}

/**
 * Play one Spotify URI on a session and return a self-describing WAV Readable for
 * discord-player (48k stereo). The stream ENDS itself when go-librespot reports the
 * track finished (`not_playing`/`stopped` on the /events WS), so the discord-player
 * queue advances to the next track. We pause go-librespot on finish so its context
 * autoplay doesn't bleed into the FIFO before the next track's play() takes over.
 */
export async function streamTrack(session, uri) {
  await play(session, uri).catch(() => {}); // 500-on-success; state is the truth

  // raw FIFO (s16le 44.1k) → 48k stereo WAV on stdout
  const ff = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', session.fifo,
    '-ar', '48000', '-ac', '2', '-f', 'wav', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  ff.stderr.on('data', () => {});
  ff.on('error', e => logger.error(`[SpotifyConnect] streamTrack ffmpeg error: ${e.message}`));

  let ws = null, started = false, ended = false;
  const endStream = (why) => {
    if (ended) return; ended = true;
    logger.info(`[SpotifyConnect] track stream ending (${why})`);
    pause(session).catch(() => {});          // stop autoplay bleed
    setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} }, 250); // flush tail
    try { ws?.close(); } catch {}
  };
  try {
    ws = new WebSocket(`ws://127.0.0.1:${session.port}/events`);
    ws.on('message', (raw) => {
      let e; try { e = JSON.parse(raw.toString()); } catch { return; }
      if (e.type === 'playing' || e.type === 'metadata' || e.type === 'will_play') started = true;
      if (started && (e.type === 'not_playing' || e.type === 'stopped')) endStream(e.type);
    });
    ws.on('error', () => {}); // WS optional; if it dies the queue can still be /skip'd
  } catch {}

  ff.stdout.on('close', () => { try { ws?.close(); } catch {} });
  return ff.stdout;
}

/** Release whatever session a guild is holding (queue end / disconnect / stop). */
export function releaseGuild(guildId) {
  for (const s of sessions.values()) {
    if (s.busyGuildId === guildId) { pause(s).catch(() => {}); s.busyGuildId = null; }
  }
}
