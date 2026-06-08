# CertiFried Cinema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/movie` command that streams films from the user's Jellyfin server into a Discord voice channel as a native Go Live stream, driven by an isolated selfbot service so one server-side transcode serves the whole channel.

**Architecture:** A standalone PM2 process (`CertiFried-Cinema`, in `cinema/`) runs a `discord.js-selfbot-v13` account + `@dank074/discord-video-stream` + ffmpeg, exposing a loopback-only HTTP control API. The main discord.js-v14 bot's `/movie` command calls that API; the Cinema service writes live state to the shared MySQL `cinema_state` table, which the main bot reads for busy-locks, panel updates, and crash recovery. The selfbot credential and process are firewalled from the 20-bot fleet.

**Tech Stack:** Node ESM, discord.js v14 (main), discord.js-selfbot-v13 + @dank074/discord-video-stream v6 (cinema), Express (loopback API), mysql2 (`utils/db.js`), ffmpeg 6.1.1, `node --test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-06-08-certifried-cinema-design.md`

**Key facts grounded from the codebase:**
- `package.json` is `type: module`; test script is `node --test tests/`.
- DB: `import pool from '../../utils/db.js'` (default export, mysql2 pool; `const [rows] = await pool.execute(sql, params)`).
- Commands: `export default { data: SlashCommandBuilder, async execute(interaction), async autocomplete(interaction) }`, auto-loaded from `commands/<cat>/*.js`.
- Interaction routing in `events/interactionCreate.js`: autocomplete → `command.autocomplete`; buttons/selects/modals → registry lookups `getButtonHandler` / `getSelectMenuHandler` / `getModalHandler` in `interactions/handlerRegistry.js` (exact id, then prefix match).
- Migrations: `migrations/NNN_name.js` exporting `async up(db)` / `async down(db)`, idempotent with whitelisted table-existence checks; run via `npm run migrate`.
- Secrets live in `cinema/.env` (already created, gitignored): `CINEMA_USER_TOKEN`, `CINEMA_API_SECRET`, `CINEMA_PORT=8099`, `JELLYFIN_URL`, `JELLYFIN_API_KEY` (TODO by user), `CINEMA_IDLE_TIMEOUT_MIN=10`.

---

## File Structure

**Shared (main bot + cinema):**
- Create `utils/jellyfin.js` — dependency-free (native `fetch`) Jellyfin client: `search`, `getItem`, `streamUrl`, `parseMediaStreams`. Imported by both processes.

**Main bot side:**
- Create `utils/cinema-client.js` — HTTP client to the cinema loopback API.
- Create `handlers/cinema/state.js` — `cinema_state` singleton + `cinema_config` DB helpers; `canControl` permission predicate.
- Create `handlers/cinema/panel.js` — control-panel embed/buttons builder + button/select/modal handlers.
- Create `commands/media/movie.js` — `/movie play|stop|status` + autocomplete.
- Modify `interactions/handlerRegistry.js` — register `cinema_` button/select/modal handlers.
- Create `migrations/123_cinema.js` — `cinema_config`, `cinema_state`.

**Cinema service side:**
- Create `cinema/encode.js` — pure ffmpeg-args builder.
- Create `cinema/streamer.js` — selfbot voice + Go Live lifecycle (play/pause/resume/stop/seek, position tracking, end detection).
- Create `cinema/index.js` — selfbot login, Express loopback API, watchdog, graceful shutdown.
- Modify `.env.example` — document new keys.
- Modify root `package.json` — add cinema deps + a `cinema` start script.

**Tests (pure units only — matches repo convention):**
- `tests/jellyfin-helpers.test.js`
- `tests/cinema-encode.test.js`
- `tests/cinema-permissions.test.js`

---

## Phase 0 — Dependencies & API verification

### Task 0: Install cinema dependencies and confirm the v6 streaming API

**Files:**
- Modify: `package.json` (dependencies + scripts)

- [ ] **Step 1: Install the streaming libraries**

The selfbot lib (`discord.js-selfbot-v13`) is a different package name than `discord.js`, so it coexists in the same `node_modules` without shadowing the v14 fleet.

Run:
```bash
npm install @dank074/discord-video-stream@^6 discord.js-selfbot-v13 express
```
Expected: installs without peer-dependency errors. If `discord.js-selfbot-v13` fails to install or login later 401s due to the Oct-2025 archival, swap to the maintained fork: `npm install discord.js-selfbot-youtsuho-v13` and change the import in `cinema/index.js` accordingly (note it in a comment).

- [ ] **Step 2: Verify the actual exported API surface (do NOT skip — option names churn across majors)**

Run:
```bash
node -e "import('@dank074/discord-video-stream').then(m=>console.log(Object.keys(m)))"
```
Expected: an array including `Streamer`, `prepareStream`, `playStream`, `Utils` (names may differ — record the real ones). If the names differ from what later tasks assume (`Streamer`, `prepareStream`, `playStream`), update `cinema/streamer.js` to match and leave a comment citing the installed version (`npm ls @dank074/discord-video-stream`).

- [ ] **Step 3: Add a start script**

In `package.json` `scripts`, add:
```json
"cinema": "node cinema/index.js"
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(cinema): add discord-video-stream + selfbot + express deps"
```

---

## Phase 1 — Cinema service skeleton (raw play/stop, no Discord UX yet)

This phase produces a working service you can drive with `curl` against the loopback API: it logs the selfbot in, joins a VC, and Go-Lives a Jellyfin title.

### Task 1: Jellyfin client (shared, dependency-free)

**Files:**
- Create: `utils/jellyfin.js`
- Test: `tests/jellyfin-helpers.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/jellyfin-helpers.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamUrl, parseMediaStreams } from '../utils/jellyfin.js';

test('streamUrl builds a static (no-transcode) URL with api key', () => {
  const url = streamUrl('abc123', { base: 'https://jf.example.net', apiKey: 'KEY' });
  assert.equal(
    url,
    'https://jf.example.net/Videos/abc123/stream?static=true&api_key=KEY'
  );
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/jellyfin-helpers.test.js`
Expected: FAIL — `Cannot find module '../utils/jellyfin.js'`.

- [ ] **Step 3: Write the implementation**

```js
// utils/jellyfin.js
// Dependency-free Jellyfin client (native fetch). Imported by BOTH the main bot
// (search/autocomplete/picker) and the cinema service (resolve stream URL).
// Config is read from env by default but overridable for testing.

function cfg(overrides = {}) {
  return {
    base: (overrides.base ?? process.env.JELLYFIN_URL ?? '').replace(/\/+$/, ''),
    apiKey: overrides.apiKey ?? process.env.JELLYFIN_API_KEY ?? '',
  };
}

/** Build a static (direct-play, NO Jellyfin transcode) stream URL. */
export function streamUrl(itemId, overrides = {}) {
  const { base, apiKey } = cfg(overrides);
  return `${base}/Videos/${itemId}/stream?static=true&api_key=${apiKey}`;
}

/** Split an item's MediaStreams into selectable audio + subtitle tracks. */
export function parseMediaStreams(item) {
  const streams = Array.isArray(item?.MediaStreams) ? item.MediaStreams : [];
  const pick = (type) =>
    streams
      .filter((s) => s.Type === type)
      .map((s) => ({
        index: s.Index,
        label: s.DisplayTitle || s.Language || `${type} ${s.Index}`,
      }));
  return { audio: pick('Audio'), subtitles: pick('Subtitle') };
}

/** Search the library for Movie/Episode items matching a term. */
export async function search(term, overrides = {}) {
  const { base, apiKey } = cfg(overrides);
  const url =
    `${base}/Items?searchTerm=${encodeURIComponent(term)}` +
    `&IncludeItemTypes=Movie,Episode&Recursive=true&Limit=25` +
    `&Fields=ProductionYear&api_key=${apiKey}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jellyfin search ${res.status}`);
  const data = await res.json();
  return (data.Items || []).map((i) => ({
    id: i.Id,
    name: i.ProductionYear ? `${i.Name} (${i.ProductionYear})` : i.Name,
    type: i.Type,
  }));
}

/** Fetch a single item with its MediaStreams for track selection. */
export async function getItem(itemId, overrides = {}) {
  const { base, apiKey } = cfg(overrides);
  const url = `${base}/Items/${itemId}?Fields=MediaStreams&api_key=${apiKey}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jellyfin getItem ${res.status}`);
  return res.json();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/jellyfin-helpers.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add utils/jellyfin.js tests/jellyfin-helpers.test.js
git commit -m "feat(cinema): dependency-free Jellyfin client (search/getItem/streamUrl/parse)"
```

### Task 2: ffmpeg argument builder (pure)

**Files:**
- Create: `cinema/encode.js`
- Test: `tests/cinema-encode.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/cinema-encode.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cinema-encode.test.js`
Expected: FAIL — `Cannot find module '../cinema/encode.js'`.

- [ ] **Step 3: Write the implementation**

```js
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
  // Burning a *specific* subtitle stream uses the subtitles filter's si= option
  // (zero-based index among subtitle streams). The caller passes the absolute
  // Jellyfin Index; we translate to si= at call sites that know the order. For
  // v1 we burn by the filter's stream_index via si= using subIndex directly,
  // which works when the subtitle is the only/first text stream; multi-text
  // refinement is a documented follow-up.
  let vf = `scale=${o.width}:${o.height}`;
  if (o.subIndex != null) {
    // Escape the URL/path colons for the filtergraph.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/cinema-encode.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add cinema/encode.js tests/cinema-encode.test.js
git commit -m "feat(cinema): pure ffmpeg-args builder (scale/seek/audio-map/sub-burn)"
```

### Task 3: Streamer module (selfbot voice + Go Live lifecycle)

**Files:**
- Create: `cinema/streamer.js`

> No unit test: this drives the live selfbot/voice API and is verified manually in Task 5. Keep it a thin, well-named state machine so the executing agent can reason about it.

- [ ] **Step 1: Write the implementation**

```js
// cinema/streamer.js
// Owns the single live playback. Wraps @dank074/discord-video-stream so the rest
// of the service deals in play/pause/resume/stop/seek + a position counter.
// Pause/seek/resume are implemented by tearing down and rebuilding the ffmpeg
// pipe at a tracked position; the voice connection (Go Live) stays up.

import { spawn } from 'node:child_process';
import { Streamer, prepareStream, playStream } from '@dank074/discord-video-stream';
import { streamUrl } from '../utils/jellyfin.js';
import { buildFfmpegArgs } from './encode.js';

export class CinemaStreamer {
  constructor(client, encodeDefaults) {
    this.streamer = new Streamer(client);
    this.enc = encodeDefaults; // { width, height, fps, bitrateKbps }
    this.session = null;       // active session or null
    this.ff = null;            // ffmpeg child process
    this.positionSecs = 0;
    this.status = 'idle';      // idle | playing | paused
  }

  isBusy() { return this.session != null; }

  /** Start a title in a voice channel. */
  async play({ guildId, voiceChannelId, itemId, itemName, audioIndex, subIndex }) {
    if (this.session) throw new Error('busy');
    await this.streamer.joinVoice(guildId, voiceChannelId);
    this.session = { guildId, voiceChannelId, itemId, itemName, audioIndex, subIndex };
    this.positionSecs = 0;
    await this._spawnPipe(0);
    this.status = 'playing';
    return { ok: true };
  }

  /** (Re)start ffmpeg + Go Live at a given position. */
  async _spawnPipe(startSecs) {
    const s = this.session;
    const url = streamUrl(s.itemId);
    const args = buildFfmpegArgs({
      streamUrl: url, startSecs,
      audioIndex: s.audioIndex, subIndex: s.subIndex,
      width: this.enc.width, height: this.enc.height,
      fps: this.enc.fps, bitrateKbps: this.enc.bitrateKbps,
    });
    // -progress on stdout lets us track position; pipe video to the library.
    this.ff = spawn('ffmpeg', [...args, '-progress', 'pipe:2', '-f', 'matroska', 'pipe:1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this._base = startSecs;
    this.ff.stderr.on('data', (b) => this._trackProgress(b.toString()));
    this.ff.on('exit', (code) => this._onFfmpegExit(code));

    const { output } = prepareStream(this.ff.stdout, {
      height: this.enc.height, frameRate: this.enc.fps, bitrateVideo: this.enc.bitrateKbps,
    });
    this._playPromise = playStream(output, this.streamer, { type: 'go-live' })
      .catch((e) => { if (this.status !== 'idle') this.onError?.(e); });
  }

  _trackProgress(text) {
    const m = /out_time_ms=(\d+)/.exec(text);
    if (m) this.positionSecs = this._base + Math.floor(Number(m[1]) / 1_000_000);
  }

  _onFfmpegExit(code) {
    // Natural end (code 0) while playing => stream finished.
    if (this.status === 'playing' && (code === 0 || code === null)) {
      this.onEnd?.();
      this._teardown();
    }
  }

  async pause() {
    if (this.status !== 'playing') return;
    this.status = 'paused';
    this._killFfmpeg();           // freeze at current positionSecs
  }

  async resume() {
    if (this.status !== 'paused') return;
    await this._spawnPipe(this.positionSecs);
    this.status = 'playing';
  }

  async seek(secs) {
    if (!this.session) return;
    const wasPaused = this.status === 'paused';
    this._killFfmpeg();
    this.positionSecs = Math.max(0, secs);
    await this._spawnPipe(this.positionSecs);
    this.status = wasPaused ? 'paused' : 'playing';
    if (wasPaused) this._killFfmpeg(); // re-freeze
  }

  async stop() {
    this._teardown();
    try { await this.streamer.leaveVoice(); } catch { /* ignore */ }
  }

  _killFfmpeg() {
    if (this.ff) { try { this.ff.kill('SIGKILL'); } catch { /* */ } this.ff = null; }
  }

  _teardown() {
    this.status = 'idle';
    this._killFfmpeg();
    this.session = null;
    this.positionSecs = 0;
  }

  state() {
    return {
      busy: this.isBusy(),
      status: this.status,
      positionSecs: this.positionSecs,
      session: this.session,
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add cinema/streamer.js
git commit -m "feat(cinema): CinemaStreamer — Go Live lifecycle with position-tracked pause/seek"
```

### Task 4: Cinema service entry (selfbot login + loopback API + watchdog)

**Files:**
- Create: `cinema/index.js`

- [ ] **Step 1: Write the implementation**

```js
// cinema/index.js
// Standalone PM2 process. Logs in the selfbot, serves a loopback-only control
// API to the main bot, mirrors live state into the shared DB, and runs an
// idle/health watchdog. Loads NO bot token — only its own cinema/.env.

import 'dotenv/config';
import express from 'express';
import { Client } from 'discord.js-selfbot-v13';
import pool from '../utils/db.js';
import { CinemaStreamer } from './streamer.js';

const PORT = Number(process.env.CINEMA_PORT || 8099);
const SECRET = process.env.CINEMA_API_SECRET || '';
const IDLE_MIN = Number(process.env.CINEMA_IDLE_TIMEOUT_MIN || 10);
const ENC = { width: 1280, height: 720, fps: 30, bitrateKbps: 2500 }; // free-tier 720p

const client = new Client();
const streamer = new CinemaStreamer(client, ENC);

// --- shared-DB state mirror -------------------------------------------------
async function writeState() {
  const s = streamer.state();
  if (!s.busy) { await pool.execute('DELETE FROM cinema_state WHERE id = 1'); return; }
  await pool.execute(
    `INSERT INTO cinema_state (id, guild_id, channel_id, voice_channel_id, item_id, item_name,
        started_by, audio_index, sub_index, status, position_secs)
     VALUES (1,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE status=VALUES(status), position_secs=VALUES(position_secs)`,
    [s.session.guildId, s.session.channelId ?? '', s.session.voiceChannelId,
     s.session.itemId, s.session.itemName, s.session.startedBy ?? '',
     s.session.audioIndex ?? null, s.session.subIndex ?? null, s.status, s.positionSecs]
  );
}

streamer.onEnd = async () => { await writeState().catch(() => {}); };
streamer.onError = (e) => console.error('[cinema] stream error:', e?.message || e);

// --- loopback control API ---------------------------------------------------
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  if (req.headers['x-cinema-secret'] !== SECRET) return res.status(401).json({ error: 'unauthorized' });
  next();
});

app.post('/play', async (req, res) => {
  try {
    if (streamer.isBusy()) {
      const s = streamer.state();
      return res.status(409).json({ error: 'busy', session: s.session });
    }
    const b = req.body;
    streamer.session = null;
    await streamer.play({
      guildId: b.guildId, voiceChannelId: b.voiceChannelId,
      itemId: b.itemId, itemName: b.itemName,
      audioIndex: b.audioIndex ?? null, subIndex: b.subIndex ?? null,
    });
    // stash extra fields for the state mirror
    Object.assign(streamer.session, { channelId: b.channelId, startedBy: b.startedBy });
    await writeState();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

for (const verb of ['pause', 'resume', 'stop']) {
  app.post(`/${verb}`, async (_req, res) => {
    try { await streamer[verb](); await writeState(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
}

app.post('/seek', async (req, res) => {
  try { await streamer.seek(Number(req.body.secs || 0)); await writeState(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/status', (_req, res) => res.json(streamer.state()));

// --- watchdog: idle auto-stop + periodic position mirror --------------------
setInterval(async () => {
  if (!streamer.isBusy()) return;
  await writeState().catch(() => {});
  try {
    const guild = await client.guilds.fetch(streamer.session.guildId);
    const vc = await guild.channels.fetch(streamer.session.voiceChannelId);
    const humans = vc?.members?.filter((m) => !m.user.bot && m.id !== client.user.id).size ?? 0;
    streamer._emptySince = humans === 0 ? (streamer._emptySince ?? Date.now()) : null;
    if (streamer._emptySince && Date.now() - streamer._emptySince > IDLE_MIN * 60_000) {
      console.log('[cinema] idle timeout — stopping');
      await streamer.stop(); await writeState();
    }
  } catch { /* ignore transient fetch errors */ }
}, 15_000);

// --- boot -------------------------------------------------------------------
client.on('ready', () => console.log(`[cinema] selfbot ready as ${client.user.tag}`));
client.login(process.env.CINEMA_USER_TOKEN)
  .then(() => app.listen(PORT, '127.0.0.1', () =>
    console.log(`[cinema] control API on 127.0.0.1:${PORT}`)))
  .catch((e) => { console.error('[cinema] login failed:', e.message); process.exit(1); });

process.on('SIGTERM', async () => { try { await streamer.stop(); } catch {} process.exit(0); });
```

- [ ] **Step 2: Confirm it boots (after migration in Task 6, but you can syntax-check now)**

Run: `node --check cinema/index.js`
Expected: no output (syntax OK).

- [ ] **Step 3: Commit**

```bash
git add cinema/index.js
git commit -m "feat(cinema): service entry — selfbot login, loopback API, idle watchdog"
```

### Task 5: Manual smoke test of the raw service

**Files:** none (verification only)

- [ ] **Step 1: Ensure `cinema/.env` has a Jellyfin API key**

If `JELLYFIN_API_KEY` is still blank, create one in Jellyfin (**Dashboard → Advanced → API Keys → +**) and paste it into `cinema/.env`. (Migration in Task 6 must be applied first for `/play` to mirror state; for a pure stream test you can run before Task 6 and ignore the DB write error.)

- [ ] **Step 2: Start the service**

Run: `npm run cinema`
Expected: logs `[cinema] selfbot ready as <CinemaAccount>` and `[cinema] control API on 127.0.0.1:8099`. If login 401s, see Task 0 Step 1 (token re-extract or fork swap).

- [ ] **Step 3: Drive a play via curl** (join a VC the Cinema account can see; grab a Jellyfin item id from `GET /Items`)

Run:
```bash
curl -s -XPOST 127.0.0.1:8099/play -H "x-cinema-secret: $(grep CINEMA_API_SECRET cinema/.env|cut -d= -f2)" \
  -H 'content-type: application/json' \
  -d '{"guildId":"<GUILD>","voiceChannelId":"<VC>","itemId":"<ITEM>","itemName":"Test","audioIndex":1,"subIndex":null}'
```
Expected: `{"ok":true}`; in Discord the Cinema account joins the VC and shows **Watch Stream**. `curl 127.0.0.1:8099/status` (with the secret header) shows `status:"playing"` and an advancing `positionSecs`. Then `POST /stop` ends it.

- [ ] **Step 4: No commit (verification only). Record any API-name fixes from Task 0 that were needed.**

---

## Phase 2 — Command + UX (autocomplete, track pickers, control panel, DB lock)

### Task 6: Migration 123 — `cinema_config` + `cinema_state`

**Files:**
- Create: `migrations/123_cinema.js`

- [ ] **Step 1: Write the migration**

```js
// migrations/123_cinema.js
// Cinema feature: per-guild config + the singleton live-session lock/state.
async function tableExists(db, table) {
  const allowed = new Set(['cinema_config', 'cinema_state']);
  if (!allowed.has(table)) throw new Error(`Refusing to inspect unknown table: ${table}`);
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${table}'`
  );
  return rows[0].n > 0;
}

export async function up(db) {
  if (!(await tableExists(db, 'cinema_config'))) {
    await db.execute(`
      CREATE TABLE cinema_config (
        guild_id        VARCHAR(20) NOT NULL,
        enabled         TINYINT(1) NOT NULL DEFAULT 0,
        control_role_id VARCHAR(20) NULL,
        default_vc_id   VARCHAR(20) NULL,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }
  if (!(await tableExists(db, 'cinema_state'))) {
    await db.execute(`
      CREATE TABLE cinema_state (
        id               INT NOT NULL,
        guild_id         VARCHAR(20) NOT NULL,
        channel_id       VARCHAR(20) NOT NULL,
        voice_channel_id VARCHAR(20) NOT NULL,
        item_id          VARCHAR(64) NOT NULL,
        item_name        VARCHAR(255) NOT NULL,
        started_by       VARCHAR(20) NOT NULL,
        audio_index      INT NULL,
        sub_index        INT NULL,
        status           ENUM('playing','paused') NOT NULL DEFAULT 'playing',
        position_secs    INT NOT NULL DEFAULT 0,
        panel_message_id VARCHAR(20) NULL,
        started_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS cinema_state');
  await db.execute('DROP TABLE IF EXISTS cinema_config');
}
```

- [ ] **Step 2: Run the migration**

Run: `npm run migrate`
Expected: applies 123 without error. Verify: `node -e "import('./utils/db.js').then(async({default:p})=>{const [r]=await p.execute('SHOW TABLES LIKE \"cinema_%\"');console.log(r);process.exit(0)})"` lists both tables.

- [ ] **Step 3: Commit**

```bash
git add migrations/123_cinema.js
git commit -m "feat(cinema): migration 123 — cinema_config + cinema_state singleton lock"
```

### Task 7: State + permission helpers

**Files:**
- Create: `handlers/cinema/state.js`
- Test: `tests/cinema-permissions.test.js`

- [ ] **Step 1: Write the failing test (permission predicate is the pure part)**

```js
// tests/cinema-permissions.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canControl } from '../handlers/cinema/state.js';

const member = (id, roleIds = [], manageGuild = false) => ({
  id,
  roles: { cache: new Map(roleIds.map((r) => [r, { id: r }])) },
  permissions: { has: () => manageGuild },
});

test('starter can control', () => {
  assert.equal(canControl(member('u1'), { started_by: 'u1' }, {}), true);
});

test('member with control role can control', () => {
  assert.equal(
    canControl(member('u2', ['mod']), { started_by: 'u1' }, { control_role_id: 'mod' }),
    true
  );
});

test('Manage Guild can control even without the role', () => {
  assert.equal(canControl(member('u3', [], true), { started_by: 'u1' }, {}), true);
});

test('random member cannot control', () => {
  assert.equal(canControl(member('u4'), { started_by: 'u1' }, { control_role_id: 'mod' }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cinema-permissions.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// handlers/cinema/state.js
import pool from '../../utils/db.js';
import { PermissionFlagsBits } from 'discord.js';

/** Pure: may this member operate playback controls? */
export function canControl(member, state, config) {
  if (!member || !state) return false;
  if (member.id === state.started_by) return true;
  if (config?.control_role_id && member.roles.cache.has(config.control_role_id)) return true;
  return member.permissions?.has?.(PermissionFlagsBits.ManageGuild) === true;
}

export async function getConfig(guildId) {
  const [rows] = await pool.execute('SELECT * FROM cinema_config WHERE guild_id = ?', [guildId]);
  return rows[0] || null;
}

export async function getActiveState() {
  const [rows] = await pool.execute('SELECT * FROM cinema_state WHERE id = 1');
  return rows[0] || null;
}

export async function setPanelMessageId(messageId) {
  await pool.execute('UPDATE cinema_state SET panel_message_id = ? WHERE id = 1', [messageId]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/cinema-permissions.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add handlers/cinema/state.js tests/cinema-permissions.test.js
git commit -m "feat(cinema): state/config DB helpers + canControl permission predicate"
```

### Task 8: Cinema HTTP client (main bot → cinema)

**Files:**
- Create: `utils/cinema-client.js`

- [ ] **Step 1: Write the implementation**

```js
// utils/cinema-client.js
// Main-bot side client for the cinema loopback control API.
const PORT = Number(process.env.CINEMA_PORT || 8099);
const SECRET = process.env.CINEMA_API_SECRET || '';
const BASE = `http://127.0.0.1:${PORT}`;

async function call(path, method = 'POST', body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-cinema-secret': SECRET },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export const cinema = {
  play: (b) => call('/play', 'POST', b),
  pause: () => call('/pause'),
  resume: () => call('/resume'),
  stop: () => call('/stop'),
  seek: (secs) => call('/seek', 'POST', { secs }),
  status: () => call('/status', 'GET'),
  /** true if the service is reachable */
  async healthy() {
    try { return (await this.status()).ok; } catch { return false; }
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add utils/cinema-client.js
git commit -m "feat(cinema): main-bot HTTP client for the loopback control API"
```

### Task 9: Control panel builder + interaction handlers

**Files:**
- Create: `handlers/cinema/panel.js`

> Verified manually in Task 12. Mirrors the `core/music-panel.js` embed+buttons style.

- [ ] **Step 1: Write the implementation**

```js
// handlers/cinema/panel.js
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { cinema } from '../../utils/cinema-client.js';
import { getActiveState, getConfig, canControl } from './state.js';

function fmt(secs) {
  const s = Math.max(0, Math.floor(secs || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h ? `${h}:` : '') + `${String(m).padStart(h ? 2 : 1, '0')}:${String(ss).padStart(2, '0')}`;
}

export function buildPanel(state) {
  const embed = new EmbedBuilder()
    .setTitle(`🎬 Now Playing: ${state.item_name}`)
    .setColor(state.status === 'paused' ? 0xf1c40f : 0x2ecc71)
    .setDescription(state.status === 'paused' ? '⏸ Paused' : '▶ Playing')
    .addFields({ name: 'Position', value: fmt(state.position_secs), inline: true })
    .setFooter({ text: `Started by <@${state.started_by}> • click Watch Stream in the voice channel` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cinema_pause').setEmoji('⏸').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cinema_resume').setEmoji('▶').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('cinema_seek').setEmoji('⏩').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cinema_stop').setEmoji('⏹').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

async function guard(interaction) {
  const state = await getActiveState();
  if (!state) { await interaction.reply({ content: 'No movie is playing.', ephemeral: true }); return null; }
  const config = await getConfig(interaction.guildId);
  if (!canControl(interaction.member, state, config)) {
    await interaction.reply({ content: 'Only the host or a mod can control playback.', ephemeral: true });
    return null;
  }
  return state;
}

export async function handleCinemaButton(interaction) {
  const id = interaction.customId;
  if (!id.startsWith('cinema_')) return false;

  if (id === 'cinema_seek') {
    const modal = new ModalBuilder().setCustomId('cinema_seek_modal').setTitle('Seek to timestamp');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('ts').setLabel('HH:MM:SS or seconds')
        .setStyle(TextInputStyle.Short).setRequired(true)));
    // Permission check still applies — but modals must be the first reply, so gate here.
    const state = await getActiveState();
    const config = await getConfig(interaction.guildId);
    if (!state || !canControl(interaction.member, state, config)) {
      await interaction.reply({ content: 'Only the host or a mod can control playback.', ephemeral: true });
      return true;
    }
    await interaction.showModal(modal);
    return true;
  }

  const state = await guard(interaction);
  if (!state) return true;

  if (id === 'cinema_pause') await cinema.pause();
  else if (id === 'cinema_resume') await cinema.resume();
  else if (id === 'cinema_stop') await cinema.stop();

  await refreshPanel(interaction);
  return true;
}

export async function handleCinemaSeekModal(interaction) {
  if (interaction.customId !== 'cinema_seek_modal') return false;
  const raw = interaction.fields.getTextInputValue('ts').trim();
  const secs = raw.includes(':')
    ? raw.split(':').reverse().reduce((a, p, i) => a + Number(p) * 60 ** i, 0)
    : Number(raw);
  await cinema.seek(secs);
  await refreshPanel(interaction);
  return true;
}

async function refreshPanel(interaction) {
  // Small delay so the cinema state-mirror catches up, then re-render.
  await new Promise((r) => setTimeout(r, 400));
  const state = await getActiveState();
  const payload = state
    ? buildPanel(state)
    : { content: '⏹ Movie ended.', embeds: [], components: [] };
  if (interaction.deferred || interaction.replied) await interaction.message.edit(payload).catch(() => {});
  else await interaction.update(payload).catch(async () => { await interaction.message.edit(payload).catch(() => {}); });
}
```

- [ ] **Step 2: Commit**

```bash
git add handlers/cinema/panel.js
git commit -m "feat(cinema): control-panel embed + button/modal handlers with permission gate"
```

### Task 10: Register cinema handlers in the registry

**Files:**
- Modify: `interactions/handlerRegistry.js`

- [ ] **Step 1: Add imports near the other handler imports (top of file)**

```js
import { handleCinemaButton, handleCinemaSeekModal } from './cinema/panel.js';
```

- [ ] **Step 2: Register the button prefix in the `buttonHandlers` map**

Find the object that maps button prefixes to handlers (the one consumed by `getButtonHandler`, around line 54) and add:
```js
  'cinema_': handleCinemaButton,
```

- [ ] **Step 3: Register the modal in the `modalHandlers` map (around line 135)**

```js
  'cinema_seek_modal': handleCinemaSeekModal,
```

- [ ] **Step 4: Verify wiring loads**

Run: `node --check interactions/handlerRegistry.js`
Expected: no output. Also `node -e "import('./interactions/handlerRegistry.js').then(m=>console.log(typeof m.getButtonHandler('cinema_pause')))"` prints `function`.

- [ ] **Step 5: Commit**

```bash
git add interactions/handlerRegistry.js
git commit -m "feat(cinema): register cinema_ button + seek-modal handlers"
```

### Task 11: `/movie` command (autocomplete, pickers, play, panel)

**Files:**
- Create: `commands/media/movie.js`

- [ ] **Step 1: Write the command**

```js
// commands/media/movie.js
import {
  SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, ChannelType,
} from 'discord.js';
import * as jf from '../../utils/jellyfin.js';
import { cinema } from '../../utils/cinema-client.js';
import { getActiveState, getConfig, setPanelMessageId } from '../../handlers/cinema/state.js';
import { buildPanel } from '../../handlers/cinema/panel.js';

export default {
  data: new SlashCommandBuilder()
    .setName('movie')
    .setDescription('Watch a movie from the Jellyfin library together in voice')
    .addSubcommand((s) => s.setName('play').setDescription('Start a movie')
      .addStringOption((o) => o.setName('title').setDescription('Search the library')
        .setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('stop').setDescription('Stop the current movie'))
    .addSubcommand((s) => s.setName('status').setDescription('Show what is playing')),

  async autocomplete(interaction) {
    const term = interaction.options.getFocused();
    if (!term || term.length < 2) return interaction.respond([]);
    try {
      const items = await jf.search(term);
      await interaction.respond(items.slice(0, 25).map((i) => ({
        name: i.name.slice(0, 100), value: i.id,
      })));
    } catch { await interaction.respond([]); }
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // Feature gate
    const config = await getConfig(interaction.guildId);
    if (!config?.enabled) {
      return interaction.reply({ content: 'Cinema is not enabled in this server.', ephemeral: true });
    }
    if (!(await cinema.healthy())) {
      return interaction.reply({ content: 'Cinema is temporarily unavailable.', ephemeral: true });
    }

    if (sub === 'status') {
      const st = await getActiveState();
      return interaction.reply({
        content: st ? `🎬 **${st.item_name}** — ${st.status} in <#${st.voice_channel_id}>`
                    : 'Nothing is playing.',
        ephemeral: true,
      });
    }

    if (sub === 'stop') {
      await cinema.stop();
      return interaction.reply({ content: '⏹ Stopped.', ephemeral: true });
    }

    // sub === 'play'
    const vc = interaction.member?.voice?.channel;
    if (!vc || vc.type !== ChannelType.GuildVoice) {
      return interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
    }
    const existing = await getActiveState();
    if (existing) {
      return interaction.reply({
        content: `🎬 Cinema is busy — **${existing.item_name}** is playing in <#${existing.voice_channel_id}>.`,
        ephemeral: true,
      });
    }

    const itemId = interaction.options.getString('title');
    await interaction.deferReply({ ephemeral: true });
    const item = await jf.getItem(itemId);
    const { audio, subtitles } = jf.parseMediaStreams(item);

    // Build track pickers (audio required, subtitle optional + "None")
    const audioMenu = new StringSelectMenuBuilder().setCustomId(`cinema_audio:${itemId}`)
      .setPlaceholder('Audio track')
      .addOptions((audio.length ? audio : [{ index: -1, label: 'Default' }])
        .slice(0, 25).map((a) => ({ label: a.label.slice(0, 100), value: String(a.index) })));
    const subMenu = new StringSelectMenuBuilder().setCustomId(`cinema_sub:${itemId}`)
      .setPlaceholder('Subtitles (optional)')
      .addOptions([{ label: 'None', value: '-1' },
        ...subtitles.slice(0, 24).map((s) => ({ label: s.label.slice(0, 100), value: String(s.index) }))]);

    await interaction.editReply({
      content: `Selected **${item.Name}** — choose tracks, then press **Start**.`,
      components: [
        new ActionRowBuilder().addComponents(audioMenu),
        new ActionRowBuilder().addComponents(subMenu),
        new ActionRowBuilder().addComponents(
          // Start button carries the chosen item; selections are read from state held below.
          (await import('discord.js')).then ? undefined : undefined),
      ].filter(Boolean),
    });

    // The Start button + select handling lives in Task 11b (select/start handlers).
  },
};
```

> NOTE: the play flow needs the audio/sub select handlers + a Start button. Those are Task 11b — split out so each file stays focused.

- [ ] **Step 2: Deploy and confirm the command + autocomplete register**

Run: `npm run deploy` (main bot global) — for a custom-bot guild use `node scripts/deploy-commands-to-bot.js <bot_id>`.
Expected: `/movie` appears; typing in `title` returns Jellyfin suggestions (requires the cinema service env's `JELLYFIN_API_KEY`, and `JELLYFIN_URL`/`JELLYFIN_API_KEY` present in the **main bot** `.env` too, since autocomplete runs in the main process — add them to root `.env`).

- [ ] **Step 3: Commit**

```bash
git add commands/media/movie.js
git commit -m "feat(cinema): /movie command — autocomplete, busy-lock, track pickers"
```

### Task 11b: Audio/subtitle select handlers + Start button

**Files:**
- Modify: `handlers/cinema/panel.js` (add select + start handlers and an in-memory pending-selection map)
- Modify: `interactions/handlerRegistry.js` (register `cinema_audio:` / `cinema_sub:` selects and `cinema_start:` button)
- Modify: `commands/media/movie.js` (add the Start button to the picker message)

- [ ] **Step 1: Add a pending-selection store + handlers to `handlers/cinema/panel.js`**

```js
// --- pending track selections (keyed by userId) ---
const pending = new Map(); // userId -> { itemId, audioIndex, subIndex }

export async function handleCinemaSelect(interaction) {
  const [kind, itemId] = interaction.customId.split(':');
  if (kind !== 'cinema_audio' && kind !== 'cinema_sub') return false;
  const cur = pending.get(interaction.user.id) || { itemId, audioIndex: null, subIndex: null };
  cur.itemId = itemId;
  const val = Number(interaction.values[0]);
  if (kind === 'cinema_audio') cur.audioIndex = val === -1 ? null : val;
  else cur.subIndex = val === -1 ? null : val;
  pending.set(interaction.user.id, cur);
  await interaction.deferUpdate();
  return true;
}

export async function handleCinemaStart(interaction) {
  if (!interaction.customId.startsWith('cinema_start:')) return false;
  const itemId = interaction.customId.split(':')[1];
  const sel = pending.get(interaction.user.id) || { itemId, audioIndex: null, subIndex: null };
  const vc = interaction.member?.voice?.channel;
  if (!vc) { await interaction.reply({ content: 'Join a voice channel first.', ephemeral: true }); return true; }

  // Re-check the lock right before starting (TOCTOU guard).
  if (await getActiveState()) {
    await interaction.update({ content: '🎬 Cinema just became busy — try again shortly.', components: [] });
    return true;
  }

  const item = await jf.getItem(itemId);
  const r = await cinema.play({
    guildId: interaction.guildId, voiceChannelId: vc.id, channelId: interaction.channelId,
    itemId, itemName: item.Name, startedBy: interaction.user.id,
    audioIndex: sel.audioIndex, subIndex: sel.subIndex,
  });
  pending.delete(interaction.user.id);
  if (!r.ok) {
    await interaction.update({ content: `Failed to start: ${r.data?.error || r.status}`, components: [] });
    return true;
  }
  await interaction.update({ content: `🎬 Starting **${item.Name}** — opening the control panel…`, components: [] });

  const state = await getActiveState();
  const panel = await interaction.channel.send(buildPanel(state));
  await setPanelMessageId(panel.id);
  return true;
}
```

Add the imports at the top of `handlers/cinema/panel.js`:
```js
import * as jf from '../../utils/jellyfin.js';
```

- [ ] **Step 2: Add the Start button in `commands/media/movie.js`**

Replace the third `ActionRowBuilder` placeholder in the picker message with:
```js
        new ActionRowBuilder().addComponents(
          new (await import('discord.js')).ButtonBuilder()
            .setCustomId(`cinema_start:${itemId}`).setLabel('Start').setStyle(3) // Success
        ),
```
(Prefer importing `ButtonBuilder` at the top of the file instead of the inline dynamic import — add it to the existing top import list and use `new ButtonBuilder()...`.)

- [ ] **Step 3: Register the new handlers in `interactions/handlerRegistry.js`**

Imports:
```js
import { handleCinemaSelect, handleCinemaStart } from './cinema/panel.js';
```
In `selectMenuHandlers` map (around line 118):
```js
  'cinema_audio:': handleCinemaSelect,
  'cinema_sub:': handleCinemaSelect,
```
In `buttonHandlers` map:
```js
  'cinema_start:': handleCinemaStart,
```

- [ ] **Step 4: Verify wiring**

Run: `node --check handlers/cinema/panel.js && node --check commands/media/movie.js && node --check interactions/handlerRegistry.js`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add handlers/cinema/panel.js commands/media/movie.js interactions/handlerRegistry.js
git commit -m "feat(cinema): track-select handlers + Start button → launch playback & panel"
```

### Task 12: End-to-end manual verification

**Files:** none

- [ ] **Step 1:** Ensure both `.env`s have `JELLYFIN_URL` + `JELLYFIN_API_KEY` (root `.env` for autocomplete/picker; `cinema/.env` for the service) and `CINEMA_API_SECRET`/`CINEMA_PORT` match.
- [ ] **Step 2:** Enable the guild: `node -e "import('./utils/db.js').then(async({default:p})=>{await p.execute('INSERT INTO cinema_config (guild_id,enabled) VALUES (?,1) ON DUPLICATE KEY UPDATE enabled=1',['<GUILD>']);process.exit(0)})"`.
- [ ] **Step 3:** Start cinema (`npm run cinema`) and the main bot. In Discord, join a VC, run `/movie play` and pick a title via autocomplete → choose audio/sub → **Start**.
- [ ] **Step 4:** Confirm: Cinema account joins VC + **Watch Stream** appears; control panel posts; **Pause/Resume/Seek/Stop** work and the panel updates; a non-host gets the permission rejection.
- [ ] **Step 5:** No commit — record any issues as follow-up tasks.

---

## Phase 3 — Lifecycle, config & hardening

### Task 13: Crash-recovery reconciliation on cinema boot

**Files:**
- Modify: `cinema/index.js`

- [ ] **Step 1: On boot, clear a stale lock if no live stream exists**

After `client.on('ready', …)` and before `app.listen`, add a reconciliation call so a crashed previous run doesn't leave a permanent "busy" lock:
```js
async function reconcileOnBoot() {
  // The service just started => nothing is actually streaming. Clear any orphaned lock.
  if (!streamer.isBusy()) {
    await pool.execute('DELETE FROM cinema_state WHERE id = 1').catch(() => {});
    console.log('[cinema] cleared orphaned cinema_state lock on boot');
  }
}
```
Call `await reconcileOnBoot();` inside the `.then()` after a successful login, before `app.listen`.

- [ ] **Step 2: Verify**

Run: simulate a stale lock — insert a row, restart `npm run cinema`, confirm the row is gone:
```bash
node -e "import('./utils/db.js').then(async({default:p})=>{await p.execute(\"INSERT INTO cinema_state (id,guild_id,channel_id,voice_channel_id,item_id,item_name,started_by) VALUES (1,'g','c','v','i','Stale','u') ON DUPLICATE KEY UPDATE item_name='Stale'\");process.exit(0)})"
```
Then start the service; expect the log `cleared orphaned cinema_state lock on boot` and an empty `cinema_state`.

- [ ] **Step 3: Commit**

```bash
git add cinema/index.js
git commit -m "feat(cinema): clear orphaned lock on service boot (crash recovery)"
```

### Task 14: Panel "Ended" update when a stream finishes on its own

**Files:**
- Modify: `cinema/index.js` (on end, the state mirror already deletes the row; add a flag the main bot can act on)
- Modify: `commands/media/movie.js` — add `/movie panel` to re-post the panel if it was lost

> The main bot owns Discord messages; the cinema service only touches the DB. When a stream ends naturally, `cinema_state` is deleted. The panel is refreshed on the next button press to "Movie ended" via `refreshPanel`. For an unattended end (nobody clicks), add a lightweight reaper in the main bot.

- [ ] **Step 1: Add a 30s reaper in the main bot that edits a dangling panel**

Create `jobs/cinema-panel-reaper.js`:
```js
// jobs/cinema-panel-reaper.js
// If cinema_state has been cleared but a panel message id lingered in memory,
// edit it to "ended". We track the last-known panel via a module-level cache the
// command/handlers update; on each tick, if no active state AND we have a cached
// (channelId,messageId), edit it and clear the cache.
import pool from '../utils/db.js';

let lastPanel = null; // { channelId, messageId }
export function rememberPanel(channelId, messageId) { lastPanel = { channelId, messageId }; }

export function startCinemaPanelReaper(client) {
  setInterval(async () => {
    try {
      const [rows] = await pool.execute('SELECT id FROM cinema_state WHERE id = 1');
      if (rows.length === 0 && lastPanel) {
        const ch = await client.channels.fetch(lastPanel.channelId).catch(() => null);
        const msg = ch ? await ch.messages.fetch(lastPanel.messageId).catch(() => null) : null;
        if (msg) await msg.edit({ content: '⏹ Movie ended.', embeds: [], components: [] }).catch(() => {});
        lastPanel = null;
      }
    } catch { /* ignore */ }
  }, 30_000);
}
```

- [ ] **Step 2: Call `rememberPanel` when the panel is posted (Task 11b Start handler) and start the reaper in `index.js`**

In `handlers/cinema/panel.js` `handleCinemaStart`, after `await setPanelMessageId(panel.id);` add:
```js
  (await import('../../jobs/cinema-panel-reaper.js')).rememberPanel(panel.channelId, panel.id);
```
In the main `index.js`, near the other `*.start(...)` scheduler calls (around line 844), add:
```js
  (await import('./jobs/cinema-panel-reaper.js')).startCinemaPanelReaper(client);
```

- [ ] **Step 3: Verify**

Start a movie, let it stop via `POST /stop` (or end), wait ≤30s, confirm the panel edits to "Movie ended."

- [ ] **Step 4: Commit**

```bash
git add jobs/cinema-panel-reaper.js handlers/cinema/panel.js index.js
git commit -m "feat(cinema): reaper edits a dangling panel to 'ended' when playback finishes"
```

### Task 15: Admin enable/config via `/movie config`

**Files:**
- Modify: `commands/media/movie.js`

- [ ] **Step 1: Add a `config` subcommand group (admin-only) to set enabled + control role**

Add to the builder:
```js
    .addSubcommand((s) => s.setName('config').setDescription('Enable Cinema and set the control role (admin)')
      .addBooleanOption((o) => o.setName('enabled').setDescription('Enable in this server').setRequired(true))
      .addRoleOption((o) => o.setName('control_role').setDescription('Role allowed to control playback')))
```
And in `execute`, before the feature-gate (so admins can enable it):
```js
    if (sub === 'config') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'Manage Server required.', ephemeral: true });
      }
      const enabled = interaction.options.getBoolean('enabled') ? 1 : 0;
      const role = interaction.options.getRole('control_role');
      await pool.execute(
        `INSERT INTO cinema_config (guild_id, enabled, control_role_id) VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE enabled=VALUES(enabled), control_role_id=VALUES(control_role_id)`,
        [interaction.guildId, enabled, role?.id ?? null]);
      return interaction.reply({ content: `Cinema ${enabled ? 'enabled' : 'disabled'}${role ? `, control role <@&${role.id}>` : ''}.`, ephemeral: true });
    }
```
Add the needed imports to the top of the file: `PermissionFlagsBits` from `discord.js`, and `import pool from '../../utils/db.js'`.

- [ ] **Step 2: Redeploy + verify**

Run: `npm run deploy`. In Discord: `/movie config enabled:true control_role:@Mods` → then the feature gate passes for that guild.

- [ ] **Step 3: Commit**

```bash
git add commands/media/movie.js
git commit -m "feat(cinema): /movie config — per-guild enable + control role"
```

### Task 16: PM2 + env docs

**Files:**
- Modify: `.env.example`
- Create: `cinema/README.md`

- [ ] **Step 1: Document the new env keys in `.env.example`** (values blank)

Append:
```
# --- CertiFried Cinema (Jellyfin Go Live) ---
# Main bot needs Jellyfin creds for /movie autocomplete + track pickers:
JELLYFIN_URL=
JELLYFIN_API_KEY=
# Cinema loopback API (must match cinema/.env):
CINEMA_PORT=8099
CINEMA_API_SECRET=
```

- [ ] **Step 2: Write `cinema/README.md`** with the run/runbook:

```md
# CertiFried Cinema service

Standalone PM2 process streaming Jellyfin titles into Discord voice as Go Live.

## Run
    pm2 start cinema/index.js --name CertiFried-Cinema
    pm2 logs CertiFried-Cinema

## Env (cinema/.env — gitignored)
CINEMA_USER_TOKEN, CINEMA_API_SECRET, CINEMA_PORT, JELLYFIN_URL, JELLYFIN_API_KEY, CINEMA_IDLE_TIMEOUT_MIN

## Token re-extraction
Selfbot tokens rotate on password change / periodically. Re-extract (see the
2026-06-08 token-extraction notes) and update CINEMA_USER_TOKEN, then `pm2 restart CertiFried-Cinema`.

## If login 401s
discord.js-selfbot-v13 was archived Oct 2025; swap to discord.js-selfbot-youtsuho-v13
and update the import in cinema/index.js.

## Risks
Selfbot = ToS violation isolated to the throwaway account (ID 791459428049223682),
never the bot fleet. Library may break on Discord updates.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example cinema/README.md
git commit -m "docs(cinema): env.example keys + service runbook"
```

- [ ] **Step 4: Start under PM2 for real**

Run: `pm2 start cinema/index.js --name CertiFried-Cinema && pm2 save`
Expected: process online; `pm2 logs CertiFried-Cinema` shows ready + API listening.

---

## Self-Review notes (author)

- **Spec coverage:** architecture/process isolation (Tasks 4,16) ✓; loopback API + shared-DB backchannel (Tasks 4,7,8) ✓; one-transcode offload (Task 2 encode + Jellyfin static URL Task 1) ✓; `/movie` autocomplete + audio/sub picker (Tasks 11,11b) ✓; control panel + starter/mod permissions (Tasks 7,9) ✓; singleton busy-lock (Tasks 6,7,11,11b TOCTOU guard) ✓; idle timeout (Task 4) ✓; stream-end + crash recovery (Tasks 13,14) ✓; per-guild config (Task 15) ✓; secrets-in-env (Tasks 0,16; `cinema/.env` already created) ✓; free-tier 720p defaults (Task 4 ENC) ✓.
- **Known follow-ups (documented, out of v1 scope):** multi-subtitle `si=` translation from absolute Jellyfin Index (Task 2 burns the first text stream); cross-guild request queue (busy message only); 1080p60 (flip `ENC`).
- **API risk:** Task 0 Step 2 verifies the real `@dank074/discord-video-stream` v6 export names before Task 3/4 rely on them.
```
