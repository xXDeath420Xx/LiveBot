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
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import logger from '../utils/logger.js';

const GLR_BIN = '/home/death/go-librespot/bin/go-librespot';
const ACCOUNTS_DIR = '/home/death/go-librespot/accounts';
const USER_IDLE_MS = 5 * 60 * 1000; // tear down an idle user instance after 5 min
// How long streamTrack waits for real audio on the FIFO before giving up on the Spotify route.
// Generous enough for a slow track load, short enough that a failed play falls back promptly.
const STREAM_START_TIMEOUT_MS = Number(process.env.SPOTIFY_STREAM_START_TIMEOUT_MS) || 5000;
// owner is 3678; per-user instances get a free port from this range (bgutil sits at 4416, so an
// ever-incrementing counter would eventually have walked into it).
const USER_PORT_MIN = 3700, USER_PORT_MAX = 3799;
// After a natural track end: FIFO (64KB ≈ 0.37s) + ffmpeg's internal buffering still hold audio.
const NATURAL_END_FLUSH_MS = Number(process.env.SPOTIFY_NATURAL_END_FLUSH_MS) || 1200;
const BOT_OWNER_ID = process.env.BOT_OWNER_ID || '365905620060340224';

export function isOwnerUser(userId) { return !!userId && String(userId) === String(BOT_OWNER_ID); }

const sessions = new Map(); // id -> { id, port, fifo, busyGuildId }

export function registerSession(id, port, fifo) {
  sessions.set(id, { id, port, fifo, busyGuildId: null, events: new EventEmitter(), ws: null, wsReady: null });
  logger.info(`[SpotifyConnect] registered session "${id}" on :${port}`);
  return sessions.get(id);
}

/**
 * One long-lived /events socket per session, shared by every track. Opening one per track made
 * go-librespot log "websocket connection errored" on every song change (it logs any client close
 * at ERROR), and left a window where early events were missed. A drop of this socket means the
 * go-librespot process itself went away, which subscribers treat as end-of-stream.
 */
function eventSocket(session) {
  if (session.ws && session.ws.readyState === WebSocket.OPEN) return Promise.resolve(true);
  if (session.ws && session.ws.readyState === WebSocket.CONNECTING && session.wsReady) return session.wsReady;
  const ws = new WebSocket(`ws://127.0.0.1:${session.port}/events`);
  session.ws = ws;
  session.wsReady = new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 3000);
    ws.once('open', () => { clearTimeout(t); resolve(true); });
    ws.once('error', () => { clearTimeout(t); resolve(false); });
  });
  ws.on('message', (raw) => {
    let e; try { e = JSON.parse(raw.toString()); } catch { return; }
    session.events.emit('event', e);
  });
  ws.on('error', () => {});
  ws.on('close', () => {
    if (session.ws === ws) { session.ws = null; session.wsReady = null; }
    session.events.emit('disconnected');
  });
  return session.wsReady;
}

function closeEventSocket(session) {
  try { session.ws?.close(1000, 'session closed'); } catch {}
  session.ws = null; session.wsReady = null;
}

/**
 * Prepare the FIFO for a new track and return a READ fd for ffmpeg's stdin.
 *
 * O_RDWR on a FIFO never blocks on Linux and makes a reader exist immediately, so by the time
 * play() is sent go-librespot's O_WRONLY|O_NONBLOCK open cannot fail with ENXIO and its writes
 * cannot EPIPE while ffmpeg is still starting up. (The old fixed 150ms sleep lost that race
 * whenever ffmpeg was slow: the output device died with "broken pipe", the track was silent,
 * and after STREAM_START_TIMEOUT_MS the bot bridged to YouTube.)
 *
 * go-librespot's writer now survives across tracks, so the kernel pipe buffer may still hold up
 * to 64KB (~0.37s) of the previous track's tail. Drain it non-blockingly before handing the pipe
 * to the new ffmpeg. The returned fd is opened first so a reader exists throughout the drain.
 */
function openFifoReader(fifo) {
  const fd = fs.openSync(fifo, fs.constants.O_RDWR);
  const drain = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  try {
    const buf = Buffer.allocUnsafe(65536);
    for (;;) { if (fs.readSync(drain, buf, 0, buf.length, null) <= 0) break; }
  } catch (e) {
    if (e.code !== 'EAGAIN') { fs.closeSync(drain); fs.closeSync(fd); throw e; }
  }
  fs.closeSync(drain);
  return fd;
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
/** Jump within the playing track (stream bot song requests keep go-librespot in step with the OBS player). */
export async function seek(session, positionMs) { return req(session, 'POST', '/player/seek', { position: Math.max(0, Math.round(Number(positionMs) || 0)), relative: false }); }
export async function next(session)         { return req(session, 'POST', '/player/next').catch(() => {}); }
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
 * child + its stdout. The FIFO is drained and held open for reading before return (see
 * openFifoReader), so go-librespot can start writing the moment play() is sent. ffmpeg does not
 * see EOF when playback stops; /spotify mode ends via teardown, never via EOF.
 */
export function openPcmStream(session) {
  const readFd = openFifoReader(session.fifo);
  const ff = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0',
    '-af', 'aresample=resampler=soxr:precision=28', '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1',
  ], { stdio: [readFd, 'pipe', 'pipe'] });
  fs.closeSync(readFd);
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
  // A FIFO has ONE stream of bytes: a previous track's ffmpeg that's still draining would split
  // the new track's audio with it. Retire it before opening a new reader.
  if (session.activeStream) {
    try { session.activeStream.kill('SIGKILL'); } catch {}
    session.activeStream = null;
  }

  // Subscribe to events BEFORE play() so nothing (notably a fast playback_error) is missed.
  const eventsOk = await eventSocket(session);
  if (!eventsOk) logger.warn(`[SpotifyConnect] /events socket on :${session.port} unavailable; end-of-track detection degraded`);

  // READER FIRST, deterministically (see openFifoReader). raw FIFO (s16le 44.1k) → 48k stereo WAV.
  let readFd;
  try { readFd = openFifoReader(session.fifo); }
  catch (e) { logger.error(`[SpotifyConnect] cannot open FIFO ${session.fifo}: ${e.message}`); return null; }
  const ff = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0',
    // soxr: high-quality 44.1k→48k resample (ffmpeg's default swr is audibly worse on music).
    '-af', 'aresample=resampler=soxr:precision=28', '-ar', '48000', '-ac', '2', '-f', 'wav', 'pipe:1',
  ], { stdio: [readFd, 'pipe', 'pipe'] });
  fs.closeSync(readFd); // ffmpeg holds its own copy
  ff.stderr.on('data', () => {});
  ff.on('error', e => logger.error(`[SpotifyConnect] streamTrack ffmpeg error: ${e.message}`));
  session.activeStream = ff; // so an owner preemption can free the FIFO instantly
  ff.on('exit', () => { if (session.activeStream === ff) session.activeStream = null; });

  let started = false, ended = false, failFast = null;
  const onEvent = (e) => {
    const evUri = e.data?.uri || e.data?.track?.uri;
    // v0.10.2+: go-librespot says WHY playback failed. Before any audio, that means fall back to
    // YouTube now instead of waiting out STREAM_START_TIMEOUT_MS on a silent pipe.
    if (e.type === 'playback_error' && (!evUri || evUri === uri)) {
      const reason = JSON.stringify(e.data || {}).slice(0, 300);
      if (started) endStream(`playback_error ${reason}`);
      else failFast?.(`playback_error ${reason}`);
      return;
    }
    // go-librespot moves straight on to the next track in the context (or Spotify autoplay)
    // WITHOUT a not_playing in between, so the next song kept flowing into this stream —
    // "Spyro" (3:15) ran 5:18 with "Get Dressed" tacked on. Any event naming a different
    // track means ours is over.
    if (started && evUri && evUri.startsWith('spotify:track:') && evUri !== uri
        && (e.type === 'metadata' || e.type === 'will_play' || e.type === 'playing')) {
      endStream(`track_changed → ${evUri}`);
      return;
    }
    if (e.type === 'playing' || e.type === 'metadata' || e.type === 'will_play') started = true;
    // not_playing = our track decoded to the end. Its last ~0.4s is still in flight (FIFO buffer +
    // ffmpeg), so give it time to reach Discord instead of clipping the ending.
    if (started && e.type === 'not_playing') endStream(e.type, NATURAL_END_FLUSH_MS);
    else if (started && e.type === 'stopped') endStream(e.type);
  };
  // ffmpeg holds the FIFO O_RDWR, so it never sees EOF if go-librespot dies mid-track. The events
  // socket dropping is that signal: end the stream so the queue advances instead of hanging.
  const onDisconnected = () => { if (started) endStream('events_socket_lost'); else failFast?.('events_socket_lost'); };
  const detach = () => {
    session.events.off('event', onEvent);
    session.events.off('disconnected', onDisconnected);
  };
  session.events.on('event', onEvent);
  session.events.on('disconnected', onDisconnected);

  function endStream(why, flushMs = 250) {
    if (ended) return; ended = true;
    detach();
    logger.info(`[SpotifyConnect] track stream ending (${why})`);
    // Pause first so no further audio (autoplay / next context track) enters the FIFO, then retire
    // the reader after flushMs. Capped so a hung API can't leave bleed flowing into this stream.
    Promise.race([pause(session).catch(() => {}), sleep(1000)])
      .then(() => setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} }, flushMs));
  }

  ff.stdout.on('close', detach);

  await play(session, uri).catch(() => {}); // 500-on-success; state is the truth

  // Prove audio is actually FLOWING before handing this to discord-player.
  //
  // play() above returns 500-on-success, so its result tells us nothing and we swallow it. If
  // playback genuinely failed (the account is playing on another device, the device never became
  // active, the track is unavailable), go-librespot writes nothing to the FIFO — ffmpeg then blocks
  // on the pipe forever and this stdout emits not one byte. discord-player would sit on that silent
  // resource indefinitely: track queued, bot in the voice channel, no audio and NO error. The `ws`
  // handler above cannot save us either, since it only ends a stream that already started.
  //
  // 'readable' fires when bytes are buffered WITHOUT consuming them, so the stream we return is
  // still intact. No bytes in time → tear down and return null, and the caller bridges to
  // YouTube/SoundCloud instead of playing silence.
  let failReason = `no audio within ${STREAM_START_TIMEOUT_MS}ms`;
  const startedOk = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; failFast = null; resolve(v); } };
    const timer = setTimeout(() => done(false), STREAM_START_TIMEOUT_MS);
    failFast = (why) => { failReason = why; clearTimeout(timer); done(false); };
    ff.stdout.once('readable', () => { clearTimeout(timer); done(true); });
    ff.once('exit', () => { failReason = 'ffmpeg exited'; clearTimeout(timer); done(false); });
    ff.stdout.once('error', () => { clearTimeout(timer); done(false); });
  });

  if (!startedOk) {
    logger.warn(`[SpotifyConnect] Spotify route failed for ${uri} (${failReason}) `
      + '— abandoning it so the track can bridge to YouTube');
    ended = true;                                   // suppress the normal end-of-track path
    detach();
    pause(session).catch(() => {});
    try { ff.kill('SIGKILL'); } catch {}
    if (session.activeStream === ff) session.activeStream = null;
    return null;
  }

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

function portBindable(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** First port in the user range that no session/link holds and nothing else is bound to. */
async function allocPort() {
  const held = new Set([...sessions.values()].map(s => s.port));
  for (const p of pendingLinks.values()) held.add(p.apiPort);
  for (let port = USER_PORT_MIN; port <= USER_PORT_MAX; port++) {
    if (!held.has(port) && await portBindable(port)) return port;
  }
  throw new Error(`no free go-librespot API port in ${USER_PORT_MIN}-${USER_PORT_MAX}`);
}

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
  if (s) closeEventSocket(s);
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
  const port = await allocPort();
  writeConfig(dir, port, fifo);

  const proc = spawn(GLR_BIN, ['--config_dir', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  proc.on('exit', () => {
    const s = sessions.get(id);
    if (s) closeEventSocket(s);
    sessions.delete(id); userProcs.delete(id);
  });

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
  const apiPort = await allocPort();
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
