# CertiFried Multicast — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a free RTMP multi-streaming relay where users push one feed to `certifriedmultitool.com:1936/live/<key>` and it fans out (passthrough, no re-encode) to every platform they configure, managed at `certifriedmultitool.com/stream`.

**Architecture:** Two packages. **(A)** A standalone CommonJS relay service (`stream-relay/`, own PM2 app) running `node-media-server` on port 1936; on publish it validates the stream key against MariaDB and spawns one `ffmpeg -c copy` per enabled destination, exposing a localhost-only read-only HTTP status endpoint on 4090. **(B)** Additions to the existing ESM dashboard (`dashboard/`): a `/stream` route group (Discord auth + guest mode), an EJS page, and a client that manages destinations and polls live status (the dashboard proxies the relay's `:4090/status`).

**Tech Stack:** Node 20, `node-media-server` v2 + `ffmpeg` (relay, CommonJS); Express 4 + EJS + `mysql2` + Passport-Discord (dashboard, ESM); MariaDB `CertiFriedUtility`; PM2; `node:test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-06-02-certifried-multicast-rtmp-design.md`

**Live-status note:** The spec mentioned socket.io push. For v1 this plan uses 2-second browser polling of a dashboard endpoint that proxies the relay's localhost `/status`. Same UX, simpler, more restart-robust, and keeps the relay fully decoupled. socket.io push can be a v1.1 enhancement.

---

## File Structure

**Part A — Relay service (new, CommonJS):**
```
stream-relay/
  package.json            # deps: node-media-server, mysql2, dotenv
  .gitignore              # node_modules, .env
  .env.example
  ecosystem.config.js     # PM2 app definition
  sql/001_stream_tables.sql
  src/
    config.js             # env → typed config + caps (pure-ish)
    db.js                 # mysql2 pool + query() helper (returns rows)
    destinations.js       # buildDestinationUrl(), buildFfmpegArgs() (pure)
    keys.js               # validateStreamKey(db, key) (logic)
    sessions.js           # createSession/endSession/recordTarget (DB writes)
    status.js             # in-memory live-status registry (pure)
    multistream.js        # start/stop fan-out + per-dest retry (injectable spawn)
    status-api.js         # http server :4090 — GET /status?key, GET /health
    relay.js              # NodeMediaServer + prePublish/postPublish/donePublish
    server.js             # entry: wire everything + graceful shutdown
  test/
    config.test.js
    destinations.test.js
    keys.test.js
    status.test.js
    multistream.test.js
    status-api.test.js
```

**Part B — Dashboard additions (existing, ESM):**
```
dashboard/
  services/stream-platforms.js   # platform presets + lookup (pure)
  services/relay-client.js       # fetch relay status over localhost http
  services/stream-store.js       # key issuance + destination validation/CRUD
  routes/stream.js               # express.Router: pages + JSON API
  views/stream.ejs               # the /stream page
  public/js/stream.js            # client: copy key, CRUD destinations, poll status
  test/stream-platforms.test.js
  test/stream-store.test.js
  server.js                      # MODIFY: import + mount streamRouter
```

Part A produces a working relay on its own (testable via OBS + a manually inserted key). Part B adds the management UI.

---

## PART A — Relay service

### Task 1: Scaffold relay package + config module

**Files:**
- Create: `stream-relay/package.json`
- Create: `stream-relay/.gitignore`
- Create: `stream-relay/.env.example`
- Create: `stream-relay/src/config.js`
- Test: `stream-relay/test/config.test.js`

- [ ] **Step 1: Create `stream-relay/package.json`**

```json
{
  "name": "certifried-stream-relay",
  "version": "1.0.0",
  "description": "Free RTMP multistreaming relay for certifriedmultitool.com",
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test"
  },
  "dependencies": {
    "dotenv": "^16.4.7",
    "mysql2": "^3.11.5",
    "node-media-server": "^2.7.0"
  }
}
```

- [ ] **Step 2: Create `stream-relay/.gitignore`**

```
node_modules/
.env
*.log
```

- [ ] **Step 3: Create `stream-relay/.env.example`**

```
# RTMP ingest port (1935 is taken by another tenant on this box)
RTMP_PORT=1936
# Localhost-only status API the dashboard reads
STATUS_PORT=4090
# Public host shown to users in their ingest URL
PUBLIC_HOST=certifriedmultitool.com
# Abuse caps
MAX_DESTINATIONS=8
MAX_CONCURRENT=10
# Per-destination ffmpeg retry policy
DEST_RETRY_LIMIT=5
DEST_RETRY_BASE_MS=2000
# Database (copy values from the repo-root .env that utils/db.js loads; cert_ prefix)
DB_HOST=localhost
DB_PORT=3306
DB_USER=cert_CertiFriedDB
DB_PASSWORD=
DB_NAME=cert_CertiFriedUtility
```

- [ ] **Step 4: Write the failing test `stream-relay/test/config.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');

test('loadConfig applies defaults when env is empty', () => {
  const { loadConfig } = require('../src/config');
  const cfg = loadConfig({});
  assert.strictEqual(cfg.rtmpPort, 1936);
  assert.strictEqual(cfg.statusPort, 4090);
  assert.strictEqual(cfg.maxDestinationsPerKey, 8);
  assert.strictEqual(cfg.maxConcurrentStreams, 10);
  assert.strictEqual(cfg.destRetryLimit, 5);
  assert.strictEqual(cfg.publicHost, 'certifriedmultitool.com');
});

test('loadConfig parses numeric env values', () => {
  const { loadConfig } = require('../src/config');
  const cfg = loadConfig({ RTMP_PORT: '2000', MAX_DESTINATIONS: '3' });
  assert.strictEqual(cfg.rtmpPort, 2000);
  assert.strictEqual(cfg.maxDestinationsPerKey, 3);
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cd stream-relay && node --test test/config.test.js`
Expected: FAIL — `Cannot find module '../src/config'`.

- [ ] **Step 6: Implement `stream-relay/src/config.js`**

```js
'use strict';
require('dotenv').config();

function int(val, def) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : def;
}

function loadConfig(env = process.env) {
  return {
    rtmpPort: int(env.RTMP_PORT, 1936),
    statusPort: int(env.STATUS_PORT, 4090),
    publicHost: env.PUBLIC_HOST || 'certifriedmultitool.com',
    maxDestinationsPerKey: int(env.MAX_DESTINATIONS, 8),
    maxConcurrentStreams: int(env.MAX_CONCURRENT, 10),
    destRetryLimit: int(env.DEST_RETRY_LIMIT, 5),
    destRetryBaseMs: int(env.DEST_RETRY_BASE_MS, 2000),
    db: {
      host: env.DB_HOST || 'localhost',
      port: int(env.DB_PORT, 3306),
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME || 'CertiFriedUtility'
    }
  };
}

module.exports = { loadConfig, config: loadConfig() };
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd stream-relay && node --test test/config.test.js`
Expected: PASS (2 tests).

- [ ] **Step 8: Install dependencies**

Run: `cd stream-relay && npm install`
Expected: `node-media-server`, `mysql2`, `dotenv` installed, no errors.

- [ ] **Step 9: Commit**

```bash
cd /home/death/CertiFriedUtility
git add stream-relay/package.json stream-relay/package-lock.json stream-relay/.gitignore stream-relay/.env.example stream-relay/src/config.js stream-relay/test/config.test.js
git commit -m "feat(relay): scaffold stream-relay package + config module"
```

---

### Task 2: Database migration

**Files:**
- Create: `stream-relay/sql/001_stream_tables.sql`

- [ ] **Step 1: Write the migration `stream-relay/sql/001_stream_tables.sql`**

```sql
-- CertiFried Multicast schema (MariaDB, database: CertiFriedUtility)

CREATE TABLE IF NOT EXISTS stream_keys (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_type    ENUM('discord','guest') NOT NULL,
  owner_id      VARCHAR(64) NOT NULL,
  stream_key    VARCHAR(80) NOT NULL,
  label         VARCHAR(120) DEFAULT NULL,
  enabled       TINYINT(1) NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME DEFAULT NULL,
  last_used_at  DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_stream_key (stream_key),
  KEY idx_owner (owner_type, owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stream_destinations (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  stream_key_id   BIGINT UNSIGNED NOT NULL,
  platform        VARCHAR(40) NOT NULL,
  name            VARCHAR(120) NOT NULL,
  rtmp_url        VARCHAR(500) NOT NULL,
  dest_stream_key VARCHAR(500) NOT NULL DEFAULT '',
  enabled         TINYINT(1) NOT NULL DEFAULT 1,
  priority        INT NOT NULL DEFAULT 100,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_key (stream_key_id),
  CONSTRAINT fk_dest_key FOREIGN KEY (stream_key_id)
    REFERENCES stream_keys (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stream_sessions (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  stream_key_id      BIGINT UNSIGNED NOT NULL,
  started_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at           DATETIME DEFAULT NULL,
  duration_seconds   INT DEFAULT NULL,
  destinations_count INT NOT NULL DEFAULT 0,
  status             ENUM('active','ended','error') NOT NULL DEFAULT 'active',
  error_message      VARCHAR(500) DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_key (stream_key_id),
  CONSTRAINT fk_sess_key FOREIGN KEY (stream_key_id)
    REFERENCES stream_keys (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stream_session_targets (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id        BIGINT UNSIGNED NOT NULL,
  destination_id    BIGINT UNSIGNED DEFAULT NULL,
  platform          VARCHAR(40) NOT NULL,
  state             ENUM('connecting','live','failed','ended') NOT NULL DEFAULT 'connecting',
  last_error        VARCHAR(500) DEFAULT NULL,
  bytes_transferred BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_session (session_id),
  CONSTRAINT fk_target_session FOREIGN KEY (session_id)
    REFERENCES stream_sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- [ ] **Step 2: Apply the migration**

Run (use the repo-root `.env` creds — NOT dashboard/.env which is stale. Tip: `MYSQL_PWD=$(grep ^DB_PASSWORD= .env|cut -d= -f2-)` to avoid quoting):
```bash
mysql -u cert_CertiFriedDB -p cert_CertiFriedUtility < stream-relay/sql/001_stream_tables.sql
```

- [ ] **Step 3: Verify tables exist**

Run:
```bash
mysql -u cert_CertiFriedDB -p cert_CertiFriedUtility -e "SHOW TABLES LIKE 'stream\_%';"
```
Expected: 4 rows — `stream_destinations`, `stream_keys`, `stream_session_targets`, `stream_sessions`.

- [ ] **Step 4: Commit**

```bash
git add stream-relay/sql/001_stream_tables.sql
git commit -m "feat(relay): add multicast DB schema (keys, destinations, sessions, targets)"
```

---

### Task 3: Database access module

**Files:**
- Create: `stream-relay/src/db.js`

> No unit test: this is a thin wrapper over `mysql2`'s real pool. It is exercised by the integration test in Task 12. Keep it tiny so there is nothing to unit-test.

- [ ] **Step 1: Implement `stream-relay/src/db.js`**

```js
'use strict';
const mysql = require('mysql2/promise');
const { config } = require('./config');

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Returns the rows array directly (drops mysql2's [rows, fields] tuple).
async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

module.exports = { pool, query };
```

- [ ] **Step 2: Smoke-check it connects**

Run (after Task 1 `.env` exists — see Task 11; if not yet, skip until then):
```bash
cd stream-relay && node -e "require('./src/db').query('SELECT 1 AS ok').then(r=>{console.log(r);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})"
```
Expected: `[ { ok: 1 } ]`.

- [ ] **Step 3: Commit**

```bash
git add stream-relay/src/db.js
git commit -m "feat(relay): add mysql2 pool + query helper"
```

---

### Task 4: Destination URL + ffmpeg argument builders (pure)

**Files:**
- Create: `stream-relay/src/destinations.js`
- Test: `stream-relay/test/destinations.test.js`

- [ ] **Step 1: Write the failing test `stream-relay/test/destinations.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildDestinationUrl, buildFfmpegArgs } = require('../src/destinations');

test('joins base url and key with a single slash', () => {
  assert.strictEqual(
    buildDestinationUrl({ rtmp_url: 'rtmp://a.rtmp.youtube.com/live2', dest_stream_key: 'abcd-1234' }),
    'rtmp://a.rtmp.youtube.com/live2/abcd-1234'
  );
});

test('does not double a trailing slash on the base url', () => {
  assert.strictEqual(
    buildDestinationUrl({ rtmp_url: 'rtmp://a.rtmp.youtube.com/live2/', dest_stream_key: 'abcd' }),
    'rtmp://a.rtmp.youtube.com/live2/abcd'
  );
});

test('returns base url unchanged when no key is provided', () => {
  assert.strictEqual(
    buildDestinationUrl({ rtmp_url: 'rtmp://host/app/key-already-in-url', dest_stream_key: '' }),
    'rtmp://host/app/key-already-in-url'
  );
});

test('builds passthrough ffmpeg args', () => {
  assert.deepStrictEqual(
    buildFfmpegArgs('rtmp://127.0.0.1:1936/live/K', 'rtmp://dest/app/key'),
    ['-i', 'rtmp://127.0.0.1:1936/live/K', '-c', 'copy', '-f', 'flv',
     '-flvflags', 'no_duration_filesize', 'rtmp://dest/app/key']
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd stream-relay && node --test test/destinations.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `stream-relay/src/destinations.js`**

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd stream-relay && node --test test/destinations.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add stream-relay/src/destinations.js stream-relay/test/destinations.test.js
git commit -m "feat(relay): destination URL + ffmpeg arg builders"
```

---

### Task 5: Stream-key validation logic

**Files:**
- Create: `stream-relay/src/keys.js`
- Test: `stream-relay/test/keys.test.js`

- [ ] **Step 1: Write the failing test `stream-relay/test/keys.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { validateStreamKey } = require('../src/keys');

function fakeDb(rows) {
  return { query: async () => rows };
}

test('rejects unknown key', async () => {
  const r = await validateStreamKey(fakeDb([]), 'nope');
  assert.deepStrictEqual(r, { ok: false, reason: 'not_found' });
});

test('rejects disabled key', async () => {
  const r = await validateStreamKey(fakeDb([{ id: 1, enabled: 0, expires_at: null }]), 'k');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'disabled');
});

test('rejects expired key', async () => {
  const past = new Date('2000-01-01T00:00:00Z');
  const r = await validateStreamKey(
    fakeDb([{ id: 1, enabled: 1, expires_at: past }]), 'k', Date.now());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'expired');
});

test('accepts enabled, non-expired key', async () => {
  const row = { id: 7, enabled: 1, expires_at: null };
  const r = await validateStreamKey(fakeDb([row]), 'k');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.key.id, 7);
});

test('accepts key whose expiry is in the future', async () => {
  const future = new Date(Date.now() + 3600_000);
  const r = await validateStreamKey(
    fakeDb([{ id: 2, enabled: 1, expires_at: future }]), 'k', Date.now());
  assert.strictEqual(r.ok, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd stream-relay && node --test test/keys.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `stream-relay/src/keys.js`**

```js
'use strict';

// db: { query(sql, params) -> rows[] }
async function validateStreamKey(db, streamKey, now = Date.now()) {
  const rows = await db.query(
    'SELECT * FROM stream_keys WHERE stream_key = ? LIMIT 1',
    [streamKey]
  );
  const key = rows[0];
  if (!key) return { ok: false, reason: 'not_found' };
  if (!key.enabled) return { ok: false, reason: 'disabled' };
  if (key.expires_at && new Date(key.expires_at).getTime() < now) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, key };
}

module.exports = { validateStreamKey };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd stream-relay && node --test test/keys.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add stream-relay/src/keys.js stream-relay/test/keys.test.js
git commit -m "feat(relay): stream-key validation (not_found/disabled/expired)"
```

---

### Task 6: Session persistence

**Files:**
- Create: `stream-relay/src/sessions.js`
- Test: `stream-relay/test/sessions.test.js`

- [ ] **Step 1: Write the failing test `stream-relay/test/sessions.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createSession, endSession } = require('../src/sessions');

function recordingDb() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/^INSERT INTO stream_sessions/i.test(sql)) return { insertId: 42 };
      if (/^SELECT started_at/i.test(sql)) return [{ started_at: new Date(Date.now() - 5000) }];
      return {};
    }
  };
}

test('createSession inserts and returns the new id', async () => {
  const db = recordingDb();
  const id = await createSession(db, 3, 2);
  assert.strictEqual(id, 42);
  assert.match(db.calls[0].sql, /INSERT INTO stream_sessions/i);
  assert.deepStrictEqual(db.calls[0].params, [3, 2]);
});

test('endSession computes duration and updates the row', async () => {
  const db = recordingDb();
  await endSession(db, 42, 'ended');
  const update = db.calls.find(c => /UPDATE stream_sessions/i.test(c.sql));
  assert.ok(update, 'should issue an UPDATE');
  // params: [duration_seconds, status, error_message, id]
  assert.ok(update.params[0] >= 4 && update.params[0] <= 10);
  assert.strictEqual(update.params[1], 'ended');
  assert.strictEqual(update.params[3], 42);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd stream-relay && node --test test/sessions.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `stream-relay/src/sessions.js`**

```js
'use strict';

async function createSession(db, streamKeyId, destinationsCount) {
  const res = await db.query(
    'INSERT INTO stream_sessions (stream_key_id, destinations_count, status) VALUES (?, ?, "active")',
    [streamKeyId, destinationsCount]
  );
  return res.insertId;
}

async function endSession(db, sessionId, status = 'ended', errorMessage = null) {
  const rows = await db.query('SELECT started_at FROM stream_sessions WHERE id = ?', [sessionId]);
  if (!rows[0]) return;
  const startedAt = new Date(rows[0].started_at).getTime();
  const duration = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  await db.query(
    'UPDATE stream_sessions SET ended_at = NOW(), duration_seconds = ?, status = ?, error_message = ? WHERE id = ?',
    [duration, status, errorMessage, sessionId]
  );
}

async function recordTarget(db, sessionId, destinationId, platform, state, lastError = null) {
  await db.query(
    'INSERT INTO stream_session_targets (session_id, destination_id, platform, state, last_error) VALUES (?, ?, ?, ?, ?)',
    [sessionId, destinationId, platform, state, lastError]
  );
}

module.exports = { createSession, endSession, recordTarget };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd stream-relay && node --test test/sessions.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add stream-relay/src/sessions.js stream-relay/test/sessions.test.js
git commit -m "feat(relay): session create/end + target recording"
```

---

### Task 7: In-memory live-status registry (pure)

**Files:**
- Create: `stream-relay/src/status.js`
- Test: `stream-relay/test/status.test.js`

- [ ] **Step 1: Write the failing test `stream-relay/test/status.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { StatusRegistry } = require('../src/status');

test('tracks a stream and its destination states', () => {
  const reg = new StatusRegistry();
  reg.startStream('streamA', { keyId: 1, startedAt: 1000 });
  reg.setDestination('streamA', 'Twitch', { state: 'connecting' });
  reg.setDestination('streamA', 'Twitch', { state: 'live' });
  reg.setDestination('streamA', 'YouTube', { state: 'failed', lastError: 'boom' });

  const snap = reg.snapshotByKeyId(1);
  assert.strictEqual(snap.live, true);
  assert.strictEqual(snap.startedAt, 1000);
  const twitch = snap.destinations.find(d => d.name === 'Twitch');
  const youtube = snap.destinations.find(d => d.name === 'YouTube');
  assert.strictEqual(twitch.state, 'live');
  assert.strictEqual(youtube.state, 'failed');
  assert.strictEqual(youtube.lastError, 'boom');
});

test('reports not-live for unknown key', () => {
  const reg = new StatusRegistry();
  assert.deepStrictEqual(reg.snapshotByKeyId(999), { live: false, destinations: [] });
});

test('removing a stream clears its status', () => {
  const reg = new StatusRegistry();
  reg.startStream('s', { keyId: 5, startedAt: 1 });
  reg.endStream('s');
  assert.strictEqual(reg.snapshotByKeyId(5).live, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd stream-relay && node --test test/status.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `stream-relay/src/status.js`**

```js
'use strict';

class StatusRegistry {
  constructor() {
    this.streams = new Map(); // streamId -> { keyId, startedAt, destinations: Map }
  }

  startStream(streamId, { keyId, startedAt }) {
    this.streams.set(streamId, { keyId, startedAt, destinations: new Map() });
  }

  setDestination(streamId, name, patch) {
    const s = this.streams.get(streamId);
    if (!s) return;
    const prev = s.destinations.get(name) || { name };
    s.destinations.set(name, { ...prev, ...patch, name });
  }

  endStream(streamId) {
    this.streams.delete(streamId);
  }

  snapshotByKeyId(keyId) {
    for (const s of this.streams.values()) {
      if (s.keyId === keyId) {
        return {
          live: true,
          startedAt: s.startedAt,
          destinations: [...s.destinations.values()]
        };
      }
    }
    return { live: false, destinations: [] };
  }

  size() {
    return this.streams.size;
  }
}

module.exports = { StatusRegistry };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd stream-relay && node --test test/status.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add stream-relay/src/status.js stream-relay/test/status.test.js
git commit -m "feat(relay): in-memory live-status registry"
```

---

### Task 8: Multistream fan-out with per-destination retry

**Files:**
- Create: `stream-relay/src/multistream.js`
- Test: `stream-relay/test/multistream.test.js`

This is the heart of the relay. `spawn` and `setTimeout` are injected so the retry logic is unit-testable without real ffmpeg.

- [ ] **Step 1: Write the failing test `stream-relay/test/multistream.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');
const { Multistreamer } = require('../src/multistream');

// Fake ffmpeg child: an EventEmitter with a .kill() and .stderr.
function makeFakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

test('spawns one process per destination and reports live', () => {
  const spawned = [];
  const states = [];
  const ms = new Multistreamer({
    retryLimit: 3,
    retryBaseMs: 10,
    spawn: (bin, args) => { const c = makeFakeChild(); spawned.push({ bin, args, child: c }); return c; },
    scheduleRetry: () => {}, // never fire in this test
    onState: (name, patch) => states.push({ name, patch })
  });

  ms.start('stream1', 'rtmp://127.0.0.1:1936/live/K', [
    { name: 'Twitch', rtmp_url: 'rtmp://t/app', dest_stream_key: 'k1' },
    { name: 'YouTube', rtmp_url: 'rtmp://y/live2', dest_stream_key: 'k2' }
  ]);

  assert.strictEqual(spawned.length, 2);
  assert.strictEqual(spawned[0].bin, 'ffmpeg');
  assert.ok(spawned[0].args.includes('rtmp://t/app/k1'));
  // both reported connecting->live
  assert.ok(states.some(s => s.name === 'Twitch' && s.patch.state === 'live'));
});

test('retries a destination that exits with failure, up to the limit', () => {
  const spawned = [];
  const states = [];
  let pendingRetry = null;
  const ms = new Multistreamer({
    retryLimit: 2,
    retryBaseMs: 10,
    spawn: (bin, args) => { const c = makeFakeChild(); spawned.push(c); return c; },
    scheduleRetry: (fn) => { pendingRetry = fn; }, // capture instead of timer
    onState: (name, patch) => states.push({ name, patch })
  });

  ms.start('s', 'rtmp://in/live/K', [
    { name: 'Kick', rtmp_url: 'rtmp://k/app', dest_stream_key: 'x' }
  ]);
  assert.strictEqual(spawned.length, 1);

  // First process dies with non-zero -> a retry is scheduled
  spawned[0].emit('close', 1);
  assert.strictEqual(typeof pendingRetry, 'function');
  pendingRetry(); // fire retry #1
  assert.strictEqual(spawned.length, 2);

  // Second dies too -> retry #2 (still within limit of 2)
  spawned[1].emit('close', 1);
  pendingRetry();
  assert.strictEqual(spawned.length, 3);

  // Third dies -> exceeds retryLimit (2) -> marked failed, no more spawns
  spawned[2].emit('close', 1);
  assert.ok(states.some(s => s.name === 'Kick' && s.patch.state === 'failed'));
});

test('stop() kills all child processes', () => {
  const children = [];
  const ms = new Multistreamer({
    retryLimit: 3, retryBaseMs: 10,
    spawn: () => { const c = makeFakeChild(); children.push(c); return c; },
    scheduleRetry: () => {}, onState: () => {}
  });
  ms.start('s', 'rtmp://in', [
    { name: 'A', rtmp_url: 'rtmp://a', dest_stream_key: '1' },
    { name: 'B', rtmp_url: 'rtmp://b', dest_stream_key: '2' }
  ]);
  ms.stop('s');
  assert.ok(children.every(c => c.killed));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd stream-relay && node --test test/multistream.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `stream-relay/src/multistream.js`**

```js
'use strict';
const { spawn: realSpawn } = require('node:child_process');
const { buildDestinationUrl, buildFfmpegArgs } = require('./destinations');

class Multistreamer {
  constructor({
    retryLimit = 5,
    retryBaseMs = 2000,
    spawn = realSpawn,
    scheduleRetry,
    onState = () => {}
  } = {}) {
    this.retryLimit = retryLimit;
    this.retryBaseMs = retryBaseMs;
    this.spawn = spawn;
    // default: real timer with exponential backoff (capped at 30s)
    this.scheduleRetry = scheduleRetry || ((fn, attempt) =>
      setTimeout(fn, Math.min(this.retryBaseMs * 2 ** attempt, 30000)));
    this.onState = onState;
    this.streams = new Map(); // streamId -> [{ name, child, stopped }]
  }

  start(streamId, inputUrl, destinations) {
    const procs = destinations.map((dest) => {
      const entry = { name: dest.name, dest, attempts: 0, child: null, stopped: false };
      this._launch(streamId, inputUrl, entry);
      return entry;
    });
    this.streams.set(streamId, procs);
  }

  _launch(streamId, inputUrl, entry) {
    const outputUrl = buildDestinationUrl(entry.dest);
    const args = buildFfmpegArgs(inputUrl, outputUrl);
    this.onState(entry.name, { state: 'connecting' });
    const child = this.spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    entry.child = child;
    // Treat a successful spawn as "live" (passthrough starts immediately).
    this.onState(entry.name, { state: 'live' });

    if (child.stderr) {
      child.stderr.on('data', (d) => {
        const msg = d.toString();
        if (/error/i.test(msg)) entry.lastError = msg.slice(0, 480);
      });
    }
    child.on('close', (code) => {
      if (entry.stopped) return; // intentional stop
      if (code === 0) { this.onState(entry.name, { state: 'ended' }); return; }
      if (entry.attempts >= this.retryLimit) {
        this.onState(entry.name, { state: 'failed', lastError: entry.lastError || `exit ${code}` });
        return;
      }
      const attempt = entry.attempts++;
      this.onState(entry.name, { state: 'connecting', lastError: entry.lastError || `exit ${code}` });
      this.scheduleRetry(() => {
        if (!entry.stopped) this._launch(streamId, inputUrl, entry);
      }, attempt);
    });
    child.on('error', (err) => { entry.lastError = err.message; });
  }

  stop(streamId) {
    const procs = this.streams.get(streamId);
    if (!procs) return;
    for (const entry of procs) {
      entry.stopped = true;
      if (entry.child && !entry.child.killed) entry.child.kill('SIGTERM');
    }
    this.streams.delete(streamId);
  }

  count() {
    return this.streams.size;
  }
}

module.exports = { Multistreamer };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd stream-relay && node --test test/multistream.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add stream-relay/src/multistream.js stream-relay/test/multistream.test.js
git commit -m "feat(relay): multistream fan-out with per-destination retry/backoff"
```

---

### Task 9: Status HTTP API (localhost only)

**Files:**
- Create: `stream-relay/src/status-api.js`
- Test: `stream-relay/test/status-api.test.js`

- [ ] **Step 1: Write the failing test `stream-relay/test/status-api.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createStatusServer } = require('../src/status-api');
const { StatusRegistry } = require('../src/status');

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
}

test('health and status endpoints respond', async () => {
  const reg = new StatusRegistry();
  reg.startStream('s', { keyId: 11, startedAt: 1000 });
  reg.setDestination('s', 'Twitch', { state: 'live' });

  const server = createStatusServer({
    registry: reg,
    resolveKeyId: async (streamKey) => (streamKey === 'good' ? 11 : null),
    activeCount: () => reg.size()
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const health = await get(port, '/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.ok, true);
    assert.strictEqual(health.body.active, 1);

    const live = await get(port, '/status?key=good');
    assert.strictEqual(live.status, 200);
    assert.strictEqual(live.body.live, true);
    assert.strictEqual(live.body.destinations[0].name, 'Twitch');

    const unknown = await get(port, '/status?key=bad');
    assert.strictEqual(unknown.body.live, false);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd stream-relay && node --test test/status-api.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `stream-relay/src/status-api.js`**

```js
'use strict';
const http = require('node:http');

// Bound to 127.0.0.1 only — never exposed publicly.
function createStatusServer({ registry, resolveKeyId, activeCount }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');

    if (url.pathname === '/health') {
      res.end(JSON.stringify({ ok: true, active: activeCount() }));
      return;
    }

    if (url.pathname === '/status') {
      const key = url.searchParams.get('key') || '';
      const keyId = await resolveKeyId(key);
      if (!keyId) { res.end(JSON.stringify({ live: false, destinations: [] })); return; }
      res.end(JSON.stringify(registry.snapshotByKeyId(keyId)));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });
}

module.exports = { createStatusServer };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd stream-relay && node --test test/status-api.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add stream-relay/src/status-api.js stream-relay/test/status-api.test.js
git commit -m "feat(relay): localhost status HTTP API (/health, /status)"
```

---

### Task 10: RTMP server wiring (relay.js)

**Files:**
- Create: `stream-relay/src/relay.js`

> No unit test — this binds `node-media-server` and orchestrates the already-tested modules. Verified by the integration test in Task 12.

- [ ] **Step 1: Implement `stream-relay/src/relay.js`**

```js
'use strict';
const NodeMediaServer = require('node-media-server');
const { config } = require('./config');
const { validateStreamKey } = require('./keys');
const { createSession, endSession } = require('./sessions');

// db: { query }, registry: StatusRegistry, multistreamer: Multistreamer
function createRelay({ db, registry, multistreamer }) {
  const nms = new NodeMediaServer({
    rtmp: { port: config.rtmpPort, chunk_size: 60000, gop_cache: true, ping: 30, ping_timeout: 60 },
    http: { port: 0, allow_origin: '*' } // disabled-ish; no public playback used
  });

  // streamId -> { sessionId }
  const sessions = new Map();

  nms.on('prePublish', async (id, StreamPath) => {
    const streamKey = StreamPath.split('/')[2];
    const reject = () => { const s = nms.getSession(id); if (s) s.reject(); };

    if (!streamKey) { console.log('[relay] no stream key'); return reject(); }

    let result;
    try {
      result = await validateStreamKey(db, streamKey);
    } catch (err) {
      console.error('[relay] DB error on validate, failing closed:', err.message);
      return reject();
    }
    if (!result.ok) { console.log(`[relay] reject key (${result.reason})`); return reject(); }

    if (registry.size() >= config.maxConcurrentStreams) {
      console.log('[relay] global concurrency cap reached, rejecting');
      return reject();
    }
    console.log(`[relay] accepted key id=${result.key.id}`);
  });

  nms.on('postPublish', async (id, StreamPath) => {
    const streamKey = StreamPath.split('/')[2];
    let result;
    try { result = await validateStreamKey(db, streamKey); } catch { return; }
    if (!result.ok) return;
    const keyId = result.key.id;

    let destinations = [];
    try {
      destinations = await db.query(
        'SELECT * FROM stream_destinations WHERE stream_key_id = ? AND enabled = 1 ORDER BY priority ASC',
        [keyId]
      );
    } catch (err) { console.error('[relay] dest load error:', err.message); return; }

    destinations = destinations.slice(0, config.maxDestinationsPerKey);
    if (destinations.length === 0) { console.log('[relay] no destinations enabled'); return; }

    await db.query('UPDATE stream_keys SET last_used_at = NOW() WHERE id = ?', [keyId]);

    let sessionId = null;
    try { sessionId = await createSession(db, keyId, destinations.length); } catch {}
    sessions.set(id, { sessionId, keyId });

    registry.startStream(id, { keyId, startedAt: Date.now() });
    const inputUrl = `rtmp://127.0.0.1:${config.rtmpPort}${StreamPath}`;

    multistreamer.onState = (name, patch) => registry.setDestination(id, name, patch);
    multistreamer.start(id, inputUrl, destinations);
    console.log(`[relay] fan-out started: ${destinations.length} destinations (key ${keyId})`);
  });

  nms.on('donePublish', async (id) => {
    multistreamer.stop(id);
    registry.endStream(id);
    const meta = sessions.get(id);
    if (meta && meta.sessionId) { try { await endSession(db, meta.sessionId, 'ended'); } catch {} }
    sessions.delete(id);
    console.log(`[relay] stream ${id} ended`);
  });

  return { nms, run: () => nms.run() };
}

module.exports = { createRelay };
```

> **Note for implementer:** `multistreamer.onState` is reassigned per stream here for simplicity. If concurrent streams are expected, instead construct one `Multistreamer` per stream inside `postPublish` (pass `onState` in its constructor) rather than sharing one instance. See Task 11 wiring — it constructs a fresh `Multistreamer` per stream to avoid cross-talk.

- [ ] **Step 2: Commit**

```bash
git add stream-relay/src/relay.js
git commit -m "feat(relay): node-media-server wiring (prePublish/postPublish/donePublish)"
```

---

### Task 11: Entry point + PM2 + env

**Files:**
- Create: `stream-relay/src/server.js`
- Create: `stream-relay/ecosystem.config.js`
- Create: `stream-relay/.env` (from `.env.example`, NOT committed)

The entry constructs a **fresh `Multistreamer` per stream** (corrects the shared-instance note in Task 10) by giving the relay a factory.

- [ ] **Step 1: Revise `relay.js` to accept a multistreamer factory**

Replace the `postPublish` body's multistreamer usage and the `createRelay` signature so each stream gets its own instance:

In `createRelay({ db, registry, makeMultistreamer })` (rename param), and inside `postPublish` replace:
```js
    multistreamer.onState = (name, patch) => registry.setDestination(id, name, patch);
    multistreamer.start(id, inputUrl, destinations);
```
with:
```js
    const ms = makeMultistreamer((name, patch) => registry.setDestination(id, name, patch));
    streamers.set(id, ms);
    ms.start(id, inputUrl, destinations);
```
Add near the top of `createRelay`: `const streamers = new Map();`
And in `donePublish` replace `multistreamer.stop(id);` with:
```js
    const ms = streamers.get(id); if (ms) ms.stop(id); streamers.delete(id);
```

- [ ] **Step 2: Implement `stream-relay/src/server.js`**

```js
'use strict';
const { config } = require('./config');
const db = require('./db');
const { StatusRegistry } = require('./status');
const { Multistreamer } = require('./multistream');
const { createStatusServer } = require('./status-api');
const { createRelay } = require('./relay');
const { validateStreamKey } = require('./keys');

const registry = new StatusRegistry();

const makeMultistreamer = (onState) => new Multistreamer({
  retryLimit: config.destRetryLimit,
  retryBaseMs: config.destRetryBaseMs,
  onState
});

const relay = createRelay({ db, registry, makeMultistreamer });

const statusServer = createStatusServer({
  registry,
  activeCount: () => registry.size(),
  resolveKeyId: async (streamKey) => {
    if (!streamKey) return null;
    const r = await validateStreamKey(db, streamKey).catch(() => ({ ok: false }));
    return r.ok ? r.key.id : null;
  }
});

relay.run();
statusServer.listen(config.statusPort, '127.0.0.1', () => {
  console.log(`[relay] RTMP on :${config.rtmpPort}  status on 127.0.0.1:${config.statusPort}`);
});

function shutdown() {
  console.log('[relay] shutting down');
  statusServer.close();
  db.pool.end().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 3: Create `stream-relay/ecosystem.config.js`**

```js
module.exports = {
  apps: [{
    name: 'certifried-stream',
    script: 'src/server.js',
    cwd: '/home/death/CertiFriedUtility/stream-relay',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: { NODE_ENV: 'production' }
  }]
};
```

- [ ] **Step 4: Create `stream-relay/.env`** (copy DB creds from the repo-root `.env`)

```bash
cd /home/death/CertiFriedUtility/stream-relay
cp .env.example .env
# then edit .env: set DB_USER=cert_CertiFriedDB, DB_NAME=cert_CertiFriedUtility, and DB_PASSWORD to the value in ../../.env (repo root)
```

- [ ] **Step 5: Run full relay test suite**

Run: `cd stream-relay && node --test`
Expected: all tests PASS (config, destinations, keys, sessions, status, multistream, status-api).

- [ ] **Step 6: Commit**

```bash
git add stream-relay/src/server.js stream-relay/src/relay.js stream-relay/ecosystem.config.js
git commit -m "feat(relay): entry point, per-stream multistreamer, PM2 config"
```

---

### Task 12: Deploy relay + integration test

**Files:** none (operational)

- [ ] **Step 1: Open the firewall for RTMP**

```bash
echo "Umemoto~0329" | sudo -S firewall-cmd --add-port=1936/tcp --permanent
echo "Umemoto~0329" | sudo -S firewall-cmd --reload
echo "Umemoto~0329" | sudo -S firewall-cmd --query-port=1936/tcp   # expect: yes
```

- [ ] **Step 2: Start the relay under PM2**

```bash
cd /home/death/CertiFriedUtility/stream-relay
pm2 start ecosystem.config.js
pm2 save
pm2 logs certifried-stream --lines 20   # expect the "RTMP on :1936  status on 127.0.0.1:4090" banner
```

- [ ] **Step 3: Verify status API is up**

```bash
curl -s http://127.0.0.1:4090/health   # expect {"ok":true,"active":0}
```

- [ ] **Step 4: Integration test — real fan-out to a local dummy RTMP sink**

Insert a test key + a destination pointing at a second local node-media-server (or any RTMP sink). Quick approach using the relay itself as both ingest and a fake "platform" is circular, so use a throwaway sink:

```bash
# a) insert a test key (id captured) and a destination that points to a local file sink via ffmpeg listener
mysql -u cert_CertiFriedDB -p cert_CertiFriedUtility <<'SQL'
INSERT INTO stream_keys (owner_type, owner_id, stream_key, label, enabled)
VALUES ('discord','TEST','cf_testkey_123','integration test',1);
SET @kid = LAST_INSERT_ID();
INSERT INTO stream_destinations (stream_key_id, platform, name, rtmp_url, dest_stream_key, enabled, priority)
VALUES (@kid, 'custom', 'LocalSink', 'rtmp://127.0.0.1:1937/live', 'sink', 1, 1);
SQL

# b) start a dummy RTMP sink on 1937 that just accepts and discards
ffmpeg -loglevel warning -listen 1 -i rtmp://127.0.0.1:1937/live/sink -f null - &
SINK_PID=$!

# c) push a 10s test pattern into the relay using our test key
ffmpeg -re -f lavfi -i testsrc=size=640x360:rate=30 -f lavfi -i sine=frequency=1000 \
  -c:v libx264 -preset veryfast -tune zerolatency -c:a aac -t 10 \
  -f flv rtmp://127.0.0.1:1936/live/cf_testkey_123

# d) while it runs, in another shell confirm live status:
curl -s "http://127.0.0.1:4090/status?key=cf_testkey_123"   # expect live:true, LocalSink state live

kill $SINK_PID 2>/dev/null
```
Expected: the push is accepted (key valid), the sink receives the relayed stream, `/status` shows `LocalSink` as `live`, and a `stream_sessions` row is created and then ended.

- [ ] **Step 5: Confirm an invalid key is rejected**

```bash
ffmpeg -re -f lavfi -i testsrc -t 3 -c:v libx264 -f flv rtmp://127.0.0.1:1936/live/not_a_real_key
```
Expected: connection rejected almost immediately (relay logs `reject key (not_found)`).

- [ ] **Step 6: Clean up test rows**

```bash
mysql -u cert_CertiFriedDB -p cert_CertiFriedUtility -e "DELETE FROM stream_keys WHERE stream_key='cf_testkey_123';"
```

- [ ] **Step 7: Commit (operational notes only, if any docs changed)**

```bash
git commit --allow-empty -m "chore(relay): relay deployed under PM2, firewall 1936 open, integration verified"
```

---

## PART B — Dashboard `/stream` UI

### Task 13: Platform presets module

**Files:**
- Create: `dashboard/services/stream-platforms.js`
- Test: `dashboard/test/stream-platforms.test.js`

- [ ] **Step 1: Write the failing test `dashboard/test/stream-platforms.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { PLATFORMS, getPreset, isKnownPlatform } from '../services/stream-platforms.js';

test('exposes the required platforms', () => {
  for (const p of ['twitch', 'youtube', 'kick', 'trovo', 'instagram', 'tiktok', 'twitter', 'facebook', 'custom']) {
    assert.ok(PLATFORMS[p], `missing preset: ${p}`);
  }
});

test('getPreset returns rtmp base for youtube', () => {
  assert.strictEqual(getPreset('youtube').rtmpUrl, 'rtmp://a.rtmp.youtube.com/live2');
});

test('custom platform is allowed but has empty base', () => {
  assert.strictEqual(getPreset('custom').rtmpUrl, '');
  assert.ok(isKnownPlatform('custom'));
});

test('unknown platform is rejected', () => {
  assert.strictEqual(isKnownPlatform('myspace'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && node --test test/stream-platforms.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `dashboard/services/stream-platforms.js`**

```js
// Platform presets for the multicast UI. rtmpUrl is the base; the user supplies
// their per-platform stream key. 'custom' lets users target any RTMP endpoint.
export const PLATFORMS = {
  twitch:    { name: 'Twitch',          rtmpUrl: 'rtmp://ingest.global-contribute.live-video.net/app', keyPlaceholder: 'live_xxxxxxxxx_xxxxxxxx', helpUrl: 'https://dashboard.twitch.tv/settings/stream' },
  youtube:   { name: 'YouTube',         rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',                    keyPlaceholder: 'xxxx-xxxx-xxxx-xxxx-xxxx', helpUrl: 'https://studio.youtube.com' },
  kick:      { name: 'Kick',            rtmpUrl: 'rtmps://fa723fc1b171.global-contribute.live-video.net/app', keyPlaceholder: 'sk_us-west-2_xxx', helpUrl: 'https://kick.com/dashboard/settings/stream' },
  trovo:     { name: 'Trovo',           rtmpUrl: 'rtmp://livepush.trovo.live/live',                    keyPlaceholder: 'live_xxxxxxxx', helpUrl: 'https://studio.trovo.live' },
  instagram: { name: 'Instagram',       rtmpUrl: 'rtmps://live-upload.instagram.com:443/rtmp',         keyPlaceholder: 'IGxxxxxxxxxx', helpUrl: 'https://www.instagram.com' },
  tiktok:    { name: 'TikTok',          rtmpUrl: 'rtmps://push.us.tiktokcdn.com/stream',               keyPlaceholder: 'stream-xxxxxxxxxx', helpUrl: 'https://www.tiktok.com/studio' },
  twitter:   { name: 'X (Twitter)',     rtmpUrl: 'rtmps://prod-video-pops-0.live.twitter.com:443/x',   keyPlaceholder: 'xxxxxxxx', helpUrl: 'https://media.x.com' },
  facebook:  { name: 'Facebook Gaming', rtmpUrl: 'rtmps://live-api-s.facebook.com:443/rtmp',           keyPlaceholder: 'FB-xxxxxxxx-x', helpUrl: 'https://www.facebook.com/live/producer' },
  custom:    { name: 'Custom RTMP',     rtmpUrl: '',                                                   keyPlaceholder: '', helpUrl: null }
};

export function getPreset(platform) {
  return PLATFORMS[platform] || null;
}

export function isKnownPlatform(platform) {
  return Object.prototype.hasOwnProperty.call(PLATFORMS, platform);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && node --test test/stream-platforms.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/services/stream-platforms.js dashboard/test/stream-platforms.test.js
git commit -m "feat(dashboard): stream platform presets"
```

---

### Task 14: Destination validation + key issuance (stream-store)

**Files:**
- Create: `dashboard/services/stream-store.js`
- Test: `dashboard/test/stream-store.test.js`

- [ ] **Step 1: Write the failing test `dashboard/test/stream-store.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { validateDestinationInput, generateStreamKey, MAX_DESTINATIONS } from '../services/stream-store.js';

test('generateStreamKey produces a cf_-prefixed unique-looking key', () => {
  const a = generateStreamKey();
  const b = generateStreamKey();
  assert.match(a, /^cf_[0-9a-f]{32}$/);
  assert.notStrictEqual(a, b);
});

test('rejects unknown platform', () => {
  const r = validateDestinationInput({ platform: 'myspace', name: 'x', rtmp_url: 'rtmp://h', dest_stream_key: 'k' }, 0);
  assert.strictEqual(r.ok, false);
});

test('rejects non-rtmp url', () => {
  const r = validateDestinationInput({ platform: 'custom', name: 'x', rtmp_url: 'http://h', dest_stream_key: 'k' }, 0);
  assert.strictEqual(r.ok, false);
});

test('accepts a valid rtmp(s) destination', () => {
  const r = validateDestinationInput({ platform: 'youtube', name: 'My YT', rtmp_url: 'rtmp://a.rtmp.youtube.com/live2', dest_stream_key: 'abcd' }, 0);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.platform, 'youtube');
});

test('enforces the destination cap', () => {
  const r = validateDestinationInput({ platform: 'custom', name: 'x', rtmp_url: 'rtmp://h', dest_stream_key: 'k' }, MAX_DESTINATIONS);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /limit/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && node --test test/stream-store.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `dashboard/services/stream-store.js`**

```js
import crypto from 'crypto';
import { isKnownPlatform } from './stream-platforms.js';

export const MAX_DESTINATIONS = 8;

export function generateStreamKey() {
  return 'cf_' + crypto.randomBytes(16).toString('hex');
}

// currentCount = how many destinations the key already has.
export function validateDestinationInput(input, currentCount) {
  if (currentCount >= MAX_DESTINATIONS) {
    return { ok: false, error: `Destination limit reached (${MAX_DESTINATIONS})` };
  }
  const platform = String(input.platform || '').toLowerCase();
  if (!isKnownPlatform(platform)) return { ok: false, error: 'Unknown platform' };

  const name = String(input.name || '').trim().slice(0, 120);
  if (!name) return { ok: false, error: 'Name is required' };

  const rtmpUrl = String(input.rtmp_url || '').trim();
  if (!/^rtmps?:\/\/.+/i.test(rtmpUrl)) return { ok: false, error: 'rtmp_url must start with rtmp:// or rtmps://' };

  const destKey = String(input.dest_stream_key || '').trim().slice(0, 500);

  return { ok: true, value: { platform, name, rtmp_url: rtmpUrl.slice(0, 500), dest_stream_key: destKey } };
}

// --- DB-backed helpers (db = utils/db.js's { query }) ---

export async function getOrCreateDiscordKey(db, discordId) {
  const rows = await db.query(
    'SELECT * FROM stream_keys WHERE owner_type = "discord" AND owner_id = ? LIMIT 1',
    [discordId]
  );
  if (rows[0]) return rows[0];
  const key = generateStreamKey();
  const res = await db.query(
    'INSERT INTO stream_keys (owner_type, owner_id, stream_key, enabled) VALUES ("discord", ?, ?, 1)',
    [discordId, key]
  );
  const created = await db.query('SELECT * FROM stream_keys WHERE id = ?', [res.insertId]);
  return created[0];
}

export async function createGuestKey(db, ttlHours = 6) {
  const key = generateStreamKey();
  const guestId = 'guest_' + crypto.randomBytes(6).toString('hex');
  const res = await db.query(
    'INSERT INTO stream_keys (owner_type, owner_id, stream_key, enabled, expires_at) VALUES ("guest", ?, ?, 1, DATE_ADD(NOW(), INTERVAL ? HOUR))',
    [guestId, key, ttlHours]
  );
  return db.query('SELECT * FROM stream_keys WHERE id = ?', [res.insertId]).then(r => r[0]);
}

export async function listDestinations(db, streamKeyId) {
  return db.query('SELECT * FROM stream_destinations WHERE stream_key_id = ? ORDER BY priority ASC, id ASC', [streamKeyId]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && node --test test/stream-store.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/services/stream-store.js dashboard/test/stream-store.test.js
git commit -m "feat(dashboard): stream key issuance + destination validation"
```

---

### Task 15: Relay client (status proxy)

**Files:**
- Create: `dashboard/services/relay-client.js`

> No unit test — a thin wrapper over `fetch` to localhost. Verified via the route test path in Task 17 manual check.

- [ ] **Step 1: Implement `dashboard/services/relay-client.js`**

```js
// Reads live status from the relay's localhost-only status API.
const RELAY_STATUS_URL = process.env.RELAY_STATUS_URL || 'http://127.0.0.1:4090';

export async function getRelayStatus(streamKey) {
  try {
    const res = await fetch(`${RELAY_STATUS_URL}/status?key=${encodeURIComponent(streamKey)}`, {
      signal: AbortSignal.timeout(2000)
    });
    if (!res.ok) return { live: false, destinations: [] };
    return await res.json();
  } catch {
    return { live: false, destinations: [], relayUnreachable: true };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/services/relay-client.js
git commit -m "feat(dashboard): relay status client"
```

---

### Task 16: `/stream` routes

**Files:**
- Create: `dashboard/routes/stream.js`
- Modify: `dashboard/server.js` (import + mount)

- [ ] **Step 1: Implement `dashboard/routes/stream.js`**

```js
// Free multicast UI + JSON API.
//   GET  /stream                      — dashboard (Discord-authed)
//   GET  /stream/quick                — guest landing (creates a temp key)
//   GET  /stream/api/destinations     — list current key's destinations
//   POST /stream/api/destinations     — add a destination
//   PATCH/DELETE /stream/api/destinations/:id
//   POST /stream/api/key/regenerate   — rotate the Discord user's key
//   GET  /stream/api/status           — live status (proxied from relay)
import express from 'express';
import rateLimit from 'express-rate-limit';
import { query } from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { PLATFORMS } from '../services/stream-platforms.js';
import {
  getOrCreateDiscordKey, createGuestKey, listDestinations,
  validateDestinationInput, generateStreamKey
} from '../services/stream-store.js';
import { getRelayStatus } from '../services/relay-client.js';

const router = express.Router();
const db = { query };
const PUBLIC_HOST = process.env.STREAM_PUBLIC_HOST || 'certifriedmultitool.com';
const RTMP_PORT = process.env.STREAM_RTMP_PORT || '1936';

function ensureDiscordAuthed(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.user?.id) return next();
  res.redirect('/auth/discord?returnTo=' + encodeURIComponent('/stream'));
}

// Resolve the active stream key for this request: Discord user, or guest via session.
async function resolveKey(req) {
  if (req.isAuthenticated && req.isAuthenticated() && req.user?.id) {
    return getOrCreateDiscordKey(db, req.user.id);
  }
  if (req.session?.guestStreamKeyId) {
    const rows = await db.query('SELECT * FROM stream_keys WHERE id = ? AND enabled = 1', [req.session.guestStreamKeyId]);
    return rows[0] || null;
  }
  return null;
}

router.get('/stream', ensureDiscordAuthed, async (req, res) => {
  const key = await getOrCreateDiscordKey(db, req.user.id);
  const destinations = await listDestinations(db, key.id);
  res.render('stream', {
    user: req.user,
    ingestUrl: `rtmp://${PUBLIC_HOST}:${RTMP_PORT}/live/${key.stream_key}`,
    streamKey: key.stream_key,
    destinations,
    platforms: PLATFORMS,
    isGuest: false
  });
});

const guestLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: 'Too many guest sessions from this IP. Try later.' });

router.get('/stream/quick', guestLimiter, async (req, res) => {
  let key;
  if (req.session?.guestStreamKeyId) {
    const rows = await db.query('SELECT * FROM stream_keys WHERE id = ? AND enabled = 1 AND (expires_at IS NULL OR expires_at > NOW())', [req.session.guestStreamKeyId]);
    key = rows[0];
  }
  if (!key) {
    key = await createGuestKey(db, 6);
    req.session.guestStreamKeyId = key.id;
  }
  const destinations = await listDestinations(db, key.id);
  res.render('stream', {
    user: null,
    ingestUrl: `rtmp://${PUBLIC_HOST}:${RTMP_PORT}/live/${key.stream_key}`,
    streamKey: key.stream_key,
    destinations,
    platforms: PLATFORMS,
    isGuest: true,
    expiresAt: key.expires_at
  });
});

router.get('/stream/api/destinations', async (req, res) => {
  const key = await resolveKey(req);
  if (!key) return res.status(401).json({ error: 'No active stream key' });
  res.json({ destinations: await listDestinations(db, key.id) });
});

router.post('/stream/api/destinations', async (req, res) => {
  const key = await resolveKey(req);
  if (!key) return res.status(401).json({ error: 'No active stream key' });
  const current = await listDestinations(db, key.id);
  const v = validateDestinationInput(req.body, current.length);
  if (!v.ok) return res.status(400).json({ error: v.error });
  await db.query(
    'INSERT INTO stream_destinations (stream_key_id, platform, name, rtmp_url, dest_stream_key, enabled, priority) VALUES (?, ?, ?, ?, ?, 1, ?)',
    [key.id, v.value.platform, v.value.name, v.value.rtmp_url, v.value.dest_stream_key, current.length + 1]
  );
  res.json({ ok: true });
});

router.patch('/stream/api/destinations/:id', async (req, res) => {
  const key = await resolveKey(req);
  if (!key) return res.status(401).json({ error: 'No active stream key' });
  const enabled = req.body.enabled ? 1 : 0;
  await db.query('UPDATE stream_destinations SET enabled = ? WHERE id = ? AND stream_key_id = ?', [enabled, req.params.id, key.id]);
  res.json({ ok: true });
});

router.delete('/stream/api/destinations/:id', async (req, res) => {
  const key = await resolveKey(req);
  if (!key) return res.status(401).json({ error: 'No active stream key' });
  await db.query('DELETE FROM stream_destinations WHERE id = ? AND stream_key_id = ?', [req.params.id, key.id]);
  res.json({ ok: true });
});

router.post('/stream/api/key/regenerate', ensureDiscordAuthed, async (req, res) => {
  const newKey = generateStreamKey();
  await db.query('UPDATE stream_keys SET stream_key = ? WHERE owner_type = "discord" AND owner_id = ?', [newKey, req.user.id]);
  res.json({ ok: true, streamKey: newKey, ingestUrl: `rtmp://${PUBLIC_HOST}:${RTMP_PORT}/live/${newKey}` });
});

router.get('/stream/api/status', async (req, res) => {
  const key = await resolveKey(req);
  if (!key) return res.status(401).json({ error: 'No active stream key' });
  res.json(await getRelayStatus(key.stream_key));
});

export default router;
```

- [ ] **Step 2: Mount the router in `dashboard/server.js`**

Near the other route imports (top, ~line 19):
```js
import streamRouter from './routes/stream.js';
```
In the route-mounting block (near the other `app.use('/', xxxRouter)` calls, ~line 9230):
```js
        app.use('/', streamRouter);
```

- [ ] **Step 3: Verify the dashboard still boots**

Run: `cd dashboard && node -e "import('./routes/stream.js').then(()=>console.log('route module OK')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: `route module OK`.

- [ ] **Step 4: Commit**

```bash
git add dashboard/routes/stream.js dashboard/server.js
git commit -m "feat(dashboard): /stream routes (pages + destinations API + status proxy)"
```

---

### Task 17: `/stream` view + client

**Files:**
- Create: `dashboard/views/stream.ejs`
- Create: `dashboard/public/js/stream.js`

> Match the existing EJS view conventions — check another view (e.g. `views/link-twitch.ejs`) for the header/partials include pattern and reuse it. The markup below is self-contained; adapt the surrounding layout include to match siblings.

- [ ] **Step 1: Implement `dashboard/views/stream.ejs`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CertiFried Multicast — Stream Everywhere, Free</title>
  <link rel="stylesheet" href="/css/output.css" />
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen">
  <main class="max-w-3xl mx-auto p-6 space-y-8">
    <header class="space-y-1">
      <h1 class="text-2xl font-bold">CertiFried Multicast</h1>
      <p class="text-gray-400">Push once. We relay your live stream to every platform — free.</p>
      <% if (isGuest) { %>
        <p class="text-amber-400 text-sm">Guest session<% if (expiresAt) { %> — expires <%= new Date(expiresAt).toLocaleString() %><% } %>. <a class="underline" href="/auth/discord">Log in with Discord</a> to keep your setup.</p>
      <% } %>
    </header>

    <section class="bg-gray-900 rounded-xl p-5 space-y-3">
      <h2 class="font-semibold">Your ingest (point OBS here)</h2>
      <label class="block text-sm text-gray-400">Server / URL</label>
      <div class="flex gap-2">
        <input id="ingestUrl" readonly value="rtmp://<%= ingestUrl.split('/live/')[0].replace('rtmp://','') %>" class="flex-1 bg-gray-800 rounded px-3 py-2 text-sm" />
        <button data-copy="#ingestUrl" class="bg-indigo-600 px-3 rounded text-sm">Copy</button>
      </div>
      <label class="block text-sm text-gray-400">Stream key</label>
      <div class="flex gap-2">
        <input id="streamKey" readonly value="<%= streamKey %>" type="password" class="flex-1 bg-gray-800 rounded px-3 py-2 text-sm" />
        <button id="revealKey" class="bg-gray-700 px-3 rounded text-sm">Show</button>
        <button data-copy="#streamKey" class="bg-indigo-600 px-3 rounded text-sm">Copy</button>
        <% if (!isGuest) { %><button id="regenKey" class="bg-red-700 px-3 rounded text-sm">Regenerate</button><% } %>
      </div>
      <p class="text-xs text-gray-500">In OBS: Settings → Stream → Custom. Note the port is <strong>1936</strong>.</p>
    </section>

    <section class="bg-gray-900 rounded-xl p-5 space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="font-semibold">Destinations</h2>
        <span id="liveBadge" class="text-xs px-2 py-1 rounded bg-gray-700">offline</span>
      </div>
      <ul id="destList" class="space-y-2"></ul>

      <form id="addDest" class="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2 border-t border-gray-800">
        <select name="platform" id="platformSel" class="bg-gray-800 rounded px-3 py-2 text-sm">
          <% Object.entries(platforms).forEach(([k, p]) => { %>
            <option value="<%= k %>"><%= p.name %></option>
          <% }) %>
        </select>
        <input name="name" placeholder="Label (e.g. My Twitch)" class="bg-gray-800 rounded px-3 py-2 text-sm" />
        <input name="rtmp_url" id="rtmpUrl" placeholder="rtmp://..." class="bg-gray-800 rounded px-3 py-2 text-sm" />
        <input name="dest_stream_key" placeholder="platform stream key" class="bg-gray-800 rounded px-3 py-2 text-sm" />
        <button class="sm:col-span-2 bg-green-600 rounded py-2 text-sm font-medium">Add destination</button>
      </form>
    </section>
  </main>

  <script>window.__PLATFORMS__ = <%- JSON.stringify(platforms) %>;</script>
  <script src="/js/stream.js"></script>
</body>
</html>
```

- [ ] **Step 2: Implement `dashboard/public/js/stream.js`**

```js
const $ = (s) => document.querySelector(s);

// Copy buttons
document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const el = document.querySelector(btn.dataset.copy);
    await navigator.clipboard.writeText(el.value);
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = 'Copy'), 1200);
  });
});

$('#revealKey')?.addEventListener('click', () => {
  const k = $('#streamKey');
  k.type = k.type === 'password' ? 'text' : 'password';
});

$('#regenKey')?.addEventListener('click', async () => {
  if (!confirm('Regenerate your stream key? Your current key stops working immediately.')) return;
  const res = await fetch('/stream/api/key/regenerate', { method: 'POST' });
  const data = await res.json();
  if (data.ok) { $('#streamKey').value = data.streamKey; alert('New key set. Update OBS.'); }
});

// Prefill rtmp_url from the selected platform preset
$('#platformSel')?.addEventListener('change', (e) => {
  const preset = window.__PLATFORMS__[e.target.value];
  if (preset) $('#rtmpUrl').value = preset.rtmpUrl;
});

async function loadDestinations() {
  const res = await fetch('/stream/api/destinations');
  if (!res.ok) return;
  const { destinations } = await res.json();
  const list = $('#destList');
  list.innerHTML = '';
  destinations.forEach((d) => {
    const li = document.createElement('li');
    li.className = 'flex items-center justify-between bg-gray-800 rounded px-3 py-2 text-sm';
    li.innerHTML = `<span><span class="dot inline-block w-2 h-2 rounded-full bg-gray-500 mr-2"></span>
      <strong>${d.name}</strong> <span class="text-gray-500">(${d.platform})</span></span>`;
    const right = document.createElement('span');
    right.className = 'flex gap-2';
    const toggle = document.createElement('button');
    toggle.textContent = d.enabled ? 'Disable' : 'Enable';
    toggle.className = 'text-xs px-2 py-1 rounded ' + (d.enabled ? 'bg-yellow-700' : 'bg-green-700');
    toggle.onclick = async () => {
      await fetch(`/stream/api/destinations/${d.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !d.enabled })
      });
      loadDestinations();
    };
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.className = 'text-xs px-2 py-1 rounded bg-red-800';
    del.onclick = async () => {
      if (!confirm(`Delete ${d.name}?`)) return;
      await fetch(`/stream/api/destinations/${d.id}`, { method: 'DELETE' });
      loadDestinations();
    };
    right.append(toggle, del);
    li.dataset.name = d.name;
    li.append(right);
    list.append(li);
  });
}

$('#addDest')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  const res = await fetch('/stream/api/destinations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Failed to add'); return; }
  e.target.reset();
  loadDestinations();
});

async function pollStatus() {
  try {
    const res = await fetch('/stream/api/status');
    if (!res.ok) return;
    const s = await res.json();
    $('#liveBadge').textContent = s.live ? 'LIVE' : 'offline';
    $('#liveBadge').className = 'text-xs px-2 py-1 rounded ' + (s.live ? 'bg-red-600' : 'bg-gray-700');
    const byName = Object.fromEntries((s.destinations || []).map((d) => [d.name, d]));
    document.querySelectorAll('#destList li').forEach((li) => {
      const st = byName[li.dataset.name];
      const dot = li.querySelector('.dot');
      const color = !st ? 'bg-gray-500'
        : st.state === 'live' ? 'bg-green-500'
        : st.state === 'failed' ? 'bg-red-500' : 'bg-yellow-500';
      dot.className = 'dot inline-block w-2 h-2 rounded-full mr-2 ' + color;
    });
  } catch {}
}

loadDestinations();
setInterval(pollStatus, 2000);
pollStatus();
```

- [ ] **Step 3: Commit**

```bash
git add dashboard/views/stream.ejs dashboard/public/js/stream.js
git commit -m "feat(dashboard): /stream page + client (destinations CRUD + live status polling)"
```

---

### Task 18: End-to-end manual verification

**Files:** none

- [ ] **Step 1: Restart the dashboard**

```bash
pm2 restart <dashboard-app-name>   # find via: pm2 list
```

- [ ] **Step 2: Verify the page loads behind Discord auth**

Visit `https://certifriedmultitool.com/stream` in a browser. Expected: redirect to Discord login, then the multicast page shows a `cf_...` ingest URL on port 1936.

- [ ] **Step 3: Add a destination and stream end-to-end**

Add a YouTube (or private test) destination with a real key. In OBS: Server `rtmp://certifriedmultitool.com:1936/live/`, Stream Key = the shown `cf_...` key. Go live.
Expected: the LIVE badge turns red within ~5s, the destination dot turns green, and the platform shows the stream. Stopping OBS returns the badge to offline.

- [ ] **Step 4: Verify guest mode**

Open `/stream/quick` in a private window (not logged in). Expected: a fresh `cf_...` guest key with a 6-hour expiry note; destinations can be added and a stream relays the same way.

- [ ] **Step 5: Commit final docs/notes**

```bash
git commit --allow-empty -m "chore: CertiFried Multicast v1 verified end-to-end"
```

---

## Self-Review

**Spec coverage:**
- Port 1936 independent ingest → Tasks 1, 10, 11, 12 ✅
- Discord login + guest keys → Task 14 (`getOrCreateDiscordKey`, `createGuestKey`), Task 16 (`/stream`, `/stream/quick`) ✅
- Passthrough fan-out (`-c copy`) → Tasks 4, 8 ✅
- Live status dashboard → Tasks 7, 9, 15, 16 (`/stream/api/status`), 17 (polling) ✅
- DB schema (4 tables) → Task 2 ✅
- Platform presets (Twitch…Facebook + custom) → Task 13 ✅
- Security: key validation every publish (Task 5/10), guest TTL + per-IP rate limit (Tasks 14, 16), concurrency + destination caps (Tasks 1, 8, 10), no public playback (Task 10 `http.port: 0`), firewall step (Task 12) ✅
- Error handling: invalid key reject, fail-closed on DB error, per-dest retry, PM2 restart → Tasks 5, 8, 10, 11 ✅
- Testing: unit (Tasks 4–9, 13, 14) + integration (Task 12) + manual (Task 18) ✅
- Deferred items (browser studio, recording, transcode) correctly excluded ✅

**Placeholder scan:** No TBD/TODO; every code step contains full code; commands have expected output. ✅

**Type/name consistency:** `validateStreamKey(db, key)`, `StatusRegistry.snapshotByKeyId`, `Multistreamer.start/stop`, `createSession/endSession`, `getRelayStatus`, `validateDestinationInput`, `getOrCreateDiscordKey/createGuestKey/listDestinations` are used consistently across tasks. Task 11 explicitly corrects the Task 10 shared-`Multistreamer` note by switching to a per-stream factory (`makeMultistreamer`). ✅
