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
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import logger from '../utils/logger.js';

const GLR_BIN = '/home/death/go-librespot/bin/go-librespot';
const ACCOUNTS_DIR = '/home/death/go-librespot/accounts';
const USER_IDLE_MS = 5 * 60 * 1000; // tear down an idle user instance after 5 min
let nextUserPort = 3700;            // owner is 3678; per-user instances 3700+
const BOT_OWNER_ID = process.env.BOT_OWNER_ID || '365905620060340224';

export function isOwnerUser(userId) { return !!userId && String(userId) === String(BOT_OWNER_ID); }

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

/**
 * Acquire a session for a guild. Opts:
 *   owner=true       — this is the bot owner; PREEMPT a non-owner holder (priority on
 *                      their own account, in any server).
 *   stopHolder=fn    — how to stop THIS guild's playback; stored so a later owner
 *                      preemption can cleanly bump us.
 * Returns false when the session is taken and we can't preempt (non-owner, or it's
 * the owner already streaming elsewhere — one stream per account, even for the owner).
 */
export function acquire(session, guildId, opts = {}) {
  const { owner = false, stopHolder = null } = opts;
  if (session.busyGuildId && session.busyGuildId !== guildId) {
    if (owner && !session.ownerHeld) {
      logger.info(`[SpotifyConnect] owner preempting ${session.id} from guild ${session.busyGuildId}`);
      try { session.activeStream?.kill('SIGKILL'); } catch {} // free the FIFO immediately
      session.activeStream = null;
      Promise.resolve().then(() => session.stopHolder?.()).catch(() => {}); // stop their queue
    } else {
      return false;
    }
  }
  session.busyGuildId = guildId;
  session.ownerHeld = owner;
  session.stopHolder = stopHolder;
  return true;
}
export function release(session, guildId) {
  if (!guildId || session.busyGuildId === guildId) {
    session.busyGuildId = null; session.ownerHeld = false; session.stopHolder = null;
  }
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
  session.activeStream = ff; // so an owner preemption can free the FIFO instantly
  ff.on('exit', () => { if (session.activeStream === ff) session.activeStream = null; });

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
    if (s.busyGuildId === guildId) {
      pause(s).catch(() => {});
      s.busyGuildId = null; s.ownerHeld = false; s.stopHolder = null; s.activeStream = null;
      markUsed(s.id);
    }
  }
}

// ── Per-user accounts (Spoticord model) ────────────────────────────────────────
// Each linked user gets their own go-librespot instance, spawned on demand from the
// credentials stored (encrypted) in spotify_links, on its own port + FIFO. Idle
// instances are reaped; the owner instance is permanent (PM2) and never reaped.

const userProcs = new Map();    // userId -> { proc, idleTimer }
const pendingLinks = new Map(); // userId -> { proc, apiPort, dir } during /spotify link

function ensureFifo(fifo) { if (!fs.existsSync(fifo)) { try { execFileSync('mkfifo', [fifo]); } catch (e) { logger.error(`[SpotifyConnect] mkfifo ${fifo}: ${e.message}`); } } }

function writeConfig(dir, port, fifo) {
  fs.writeFileSync(path.join(dir, 'config.yml'),
    `device_name: CertiFried\nbitrate: 320\nzeroconf_enabled: false\n` +
    `credentials:\n  type: interactive\n` +
    `audio_backend: pipe\naudio_output_pipe: ${fifo}\naudio_output_pipe_format: s16le\n` +
    `server:\n  enabled: true\n  address: 127.0.0.1\n  port: ${port}\n`);
}

function markUsed(id) {
  const u = userProcs.get(id);
  if (!u) return;
  clearTimeout(u.idleTimer);
  u.idleTimer = setTimeout(() => teardownUser(id), USER_IDLE_MS);
}

function teardownUser(userId) {
  const id = `u_${userId}`;
  const s = sessions.get(id);
  if (s?.busyGuildId) return markUsed(id); // still playing — defer
  const u = userProcs.get(id);
  if (u) { clearTimeout(u.idleTimer); try { u.proc.kill('SIGKILL'); } catch {} userProcs.delete(id); }
  sessions.delete(id);
  logger.info(`[SpotifyConnect] reaped idle user instance ${id}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function spawnUserSession(userId, credentialsJson) {
  const id = `u_${userId}`;
  const dir = path.join(ACCOUNTS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const fifo = path.join(dir, 'audio.pipe');
  ensureFifo(fifo);
  fs.writeFileSync(path.join(dir, 'state.json'), credentialsJson, { mode: 0o600 });
  const port = nextUserPort++;
  writeConfig(dir, port, fifo);

  const proc = spawn(GLR_BIN, ['--config_dir', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  proc.on('exit', () => { sessions.delete(id); userProcs.delete(id); });

  const session = registerSession(id, port, fifo);
  userProcs.set(id, { proc, idleTimer: setTimeout(() => teardownUser(userId), USER_IDLE_MS) });

  for (let i = 0; i < 24; i++) { await sleep(500); if (await isAlive(session)) { logger.info(`[SpotifyConnect] user session ${id} ready on :${port}`); return session; } }
  logger.error(`[SpotifyConnect] user session ${id} never became ready`);
  teardownUser(userId);
  return null;
}

/**
 * Account selection:
 *   - the bot OWNER always gets the owner account (reserved + priority everywhere);
 *   - a linked user gets their OWN account (spawned on demand);
 *   - everyone else falls back to the owner account (shared), which the owner can preempt.
 */
export async function getSessionForUser(userId) {
  if (isOwnerUser(userId)) return sessions.get('owner') || null;
  if (userId) {
    const id = `u_${userId}`;
    const existing = sessions.get(id);
    if (existing && await isAlive(existing)) { markUsed(id); return existing; }
    try {
      const [rows] = await pool.execute('SELECT credentials FROM spotify_links WHERE user_id = ?', [userId]);
      if (rows?.length) {
        const creds = encryption.decrypt(JSON.parse(rows[0].credentials));
        const s = await spawnUserSession(userId, creds);
        if (s) { pool.execute('UPDATE spotify_links SET last_used_at = NOW() WHERE user_id = ?', [userId]).catch(() => {}); return s; }
      }
    } catch (e) { logger.error(`[SpotifyConnect] getSessionForUser(${userId}) failed: ${e.message}`); }
  }
  return sessions.get('owner') || null;
}

export async function isLinked(userId) {
  try { const [r] = await pool.execute('SELECT 1 FROM spotify_links WHERE user_id = ?', [userId]); return !!r?.length; } catch { return false; }
}

/** Step 1 of linking: spawn interactive go-librespot, return the Spotify auth URL. */
export async function startLink(userId) {
  const id = `u_${userId}`;
  const prev = pendingLinks.get(userId);
  if (prev) { try { prev.proc.kill('SIGKILL'); } catch {} pendingLinks.delete(userId); }

  const dir = path.join(ACCOUNTS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  try { fs.unlinkSync(path.join(dir, 'state.json')); } catch {} // force fresh auth
  const fifo = path.join(dir, 'audio.pipe'); ensureFifo(fifo);
  const apiPort = nextUserPort++;
  writeConfig(dir, apiPort, fifo);

  const proc = spawn(GLR_BIN, ['--config_dir', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  const url = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timed out waiting for the Spotify auth link')), 20000);
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/visit the following link:\s*(\S+)/);
      if (m) { clearTimeout(to); resolve(m[1]); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', () => { clearTimeout(to); reject(new Error('go-librespot exited before emitting an auth link')); });
  });
  pendingLinks.set(userId, { proc, apiPort, dir });
  return url;
}

/** Step 2 of linking: the user pastes the 127.0.0.1 redirect URL; we complete it. */
export async function finishLink(userId, redirectUrl) {
  const p = pendingLinks.get(userId);
  if (!p) throw new Error('No pending link — run `/spotify link` first.');

  let u;
  try { u = new URL(redirectUrl.trim()); } catch { throw new Error('That doesn\'t look like the redirect URL.'); }
  if (u.hostname !== '127.0.0.1' || !u.pathname.startsWith('/login') || !u.searchParams.get('code')) {
    throw new Error('Paste the FULL `http://127.0.0.1:…/login?code=…` URL from your browser\'s address bar.');
  }
  // Complete the handshake on the interactive instance (it owns u.port on the server).
  await httpGetText(`http://127.0.0.1:${u.port}${u.pathname}${u.search}`).catch(() => {});

  // Wait for credentials to persist
  let creds = null;
  const sp = path.join(p.dir, 'state.json');
  for (let i = 0; i < 24; i++) { await sleep(300); if (fs.existsSync(sp)) { const c = fs.readFileSync(sp, 'utf8'); if (c.length > 50) { creds = c; break; } } }
  if (!creds) throw new Error('Authorization didn\'t complete — try `/spotify link` again.');

  let username = null;
  try { const st = JSON.parse(await httpGetText(`http://127.0.0.1:${p.apiPort}/status`)); username = st.username || null; } catch {}

  const enc = encryption.encrypt(creds);
  await pool.execute(
    `INSERT INTO spotify_links (user_id, credentials, spotify_user, device_name) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE credentials=VALUES(credentials), spotify_user=VALUES(spotify_user), linked_at=NOW()`,
    [userId, JSON.stringify(enc), username, 'CertiFried']
  );

  try { p.proc.kill('SIGKILL'); } catch {}
  pendingLinks.delete(userId);
  return { username };
}

export async function unlink(userId) {
  teardownUser(userId);
  const p = pendingLinks.get(userId);
  if (p) { try { p.proc.kill('SIGKILL'); } catch {} pendingLinks.delete(userId); }
  await pool.execute('DELETE FROM spotify_links WHERE user_id = ?', [userId]).catch(() => {});
}

function httpGetText(url) {
  return new Promise((resolve, reject) => {
    const r = http.get(url, { timeout: 10000 }, (res) => { let s = ''; res.on('data', c => s += c); res.on('end', () => resolve(s)); });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
  });
}
