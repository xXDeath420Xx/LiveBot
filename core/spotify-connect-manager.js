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
