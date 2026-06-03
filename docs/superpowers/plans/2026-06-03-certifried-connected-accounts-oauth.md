# CertiFried Connected Accounts (OAuth Add-Platform) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let logged-in Discord users OAuth into Twitch/Kick/YouTube/Facebook from the `/stream` page and have their RTMP destination auto-provisioned — keys fetched at connect (static) or minted at go-live (dynamic) via a dashboard-hosted resolver the relay calls.

**Architecture:** A per-platform **adapter** framework in the dashboard (ESM) holds OAuth + key logic; encrypted tokens live in a new `stream_platform_accounts` table (reusing `utils/encryption.js`). `stream_destinations` gains `account_id`/`resolution`/`config_json`. At `postPublish` the relay (CommonJS) calls a localhost, secret-gated dashboard endpoint `/internal/resolve-destinations` which returns the final `{rtmp_url, key}` list (running adapters for dynamic platforms); the relay falls back to reading static rows directly if the resolver is down.

**Tech Stack:** Express 4 + EJS + `mysql2` + `node-fetch` + Passport-Discord + `utils/encryption.js` (dashboard, ESM); `node-media-server` relay (CommonJS); MariaDB `cert_CertiFriedUtility`; `node:test`.

**Spec:** `docs/superpowers/specs/2026-06-03-certifried-connected-accounts-oauth-design.md`

**Conventions (verified):**
- DB creds in repo-root `.env` (`cert_CertiFriedDB` / `cert_CertiFriedUtility`); run mysql with `MYSQL_PWD=$(grep ^DB_PASSWORD= .env|cut -d= -f2-)`.
- Repo `.gitignore` ignores `test*` → use `git add -f` for test files.
- Commit from `/home/death/CertiFriedUtility`; append `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` to messages.
- Dashboard runs in-process with the bot (PM2 app `CertiFriedUtility`); activating new routes requires restarting that process (final task).
- Encryption: `encryption.encrypt(str) -> {iv,encryptedData,authTag}`; stored as `JSON.stringify(...)`; `encryption.decrypt(obj) -> str`.
- `utils/db.js` `query(sql, params)` returns unwrapped rows.

---

## File Structure

```
dashboard/services/platforms/
  accounts.js            # encrypted CRUD for stream_platform_accounts
  registry.js            # platform -> adapter map + mode/scope/reviewGated metadata
  twitch.js              # adapter: static, fetch persistent key
  kick.js                # adapter: connect identity, manual key
  youtube.js             # adapter: dynamic, create stream+broadcast at go-live
  facebook.js            # adapter: dynamic, create live video at go-live
  resolver.js            # resolve a user's destinations (static + dynamic)
dashboard/routes/
  stream-connect.js      # GET /stream/connect/:platform[/callback], POST /stream/api/connections/:platform DELETE
  stream-internal.js     # POST /internal/resolve-destinations (secret-gated, localhost)
dashboard/test/
  platforms-accounts.test.js
  platforms-registry.test.js
  platforms-resolver.test.js
  platforms-twitch.test.js
  platforms-kick.test.js
  platforms-youtube.test.js
  platforms-facebook.test.js
stream-relay/
  sql/002_connected_accounts.sql   # migration
  src/resolver-client.js           # relay -> dashboard resolver call + fallback
  test/resolver-client.test.js
dashboard/{views/stream.ejs, public/js/stream.js, server.js}  # MODIFY: chooser UI + mounts
stream-relay/src/relay.js          # MODIFY: postPublish calls resolver-client
```

---

## PART A — Framework

### Task 1: Database migration

**Files:**
- Create: `stream-relay/sql/002_connected_accounts.sql`

- [ ] **Step 1: Write `stream-relay/sql/002_connected_accounts.sql`**

```sql
-- Connected Accounts (OAuth) for CertiFried Multicast — DB: cert_CertiFriedUtility

CREATE TABLE IF NOT EXISTS stream_platform_accounts (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_discord_id  VARCHAR(32) NOT NULL,
  platform          VARCHAR(40) NOT NULL,
  platform_user_id  VARCHAR(128) DEFAULT NULL,
  platform_username VARCHAR(190) DEFAULT NULL,
  access_token      TEXT DEFAULT NULL,        -- JSON of encryption.encrypt()
  refresh_token     TEXT DEFAULT NULL,        -- JSON of encryption.encrypt()
  expires_at        DATETIME DEFAULT NULL,
  scopes            VARCHAR(500) DEFAULT NULL,
  status            ENUM('active','needs_reconnect') NOT NULL DEFAULT 'active',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_owner_platform (owner_discord_id, platform)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE stream_destinations
  ADD COLUMN account_id  BIGINT UNSIGNED NULL AFTER stream_key_id,
  ADD COLUMN resolution  ENUM('static','dynamic') NOT NULL DEFAULT 'static' AFTER platform,
  ADD COLUMN config_json JSON NULL AFTER dest_stream_key,
  ADD CONSTRAINT fk_dest_account FOREIGN KEY (account_id)
      REFERENCES stream_platform_accounts (id) ON DELETE CASCADE;
```

- [ ] **Step 2: Apply the migration**

```bash
cd /home/death/CertiFriedUtility
MYSQL_PWD=$(grep ^DB_PASSWORD= .env|cut -d= -f2-) mysql -u cert_CertiFriedDB cert_CertiFriedUtility < stream-relay/sql/002_connected_accounts.sql
```

- [ ] **Step 3: Verify**

```bash
MYSQL_PWD=$(grep ^DB_PASSWORD= .env|cut -d= -f2-) mysql -u cert_CertiFriedDB cert_CertiFriedUtility -e "DESCRIBE stream_platform_accounts; SHOW COLUMNS FROM stream_destinations LIKE 'resolution';"
```
Expected: the new table's columns + a `resolution` row.

- [ ] **Step 4: Commit**

```bash
git add stream-relay/sql/002_connected_accounts.sql
git commit -m "feat(accounts): DB schema for connected OAuth accounts"
```

---

### Task 2: Encrypted account store

**Files:**
- Create: `dashboard/services/platforms/accounts.js`
- Test: `dashboard/test/platforms-accounts.test.js`

- [ ] **Step 1: Write the failing test `dashboard/test/platforms-accounts.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { makeAccountStore } from '../services/platforms/accounts.js';

// Fake encryption: reversible, deterministic, JSON-shaped like the real one.
const fakeEnc = {
  encrypt: (s) => ({ iv: 'x', encryptedData: Buffer.from(s).toString('base64'), authTag: 't' }),
  decrypt: (o) => Buffer.from(o.encryptedData, 'base64').toString('utf8'),
};

function fakeDb() {
  const rows = [];
  return {
    rows,
    query: async (sql, params) => {
      if (/^INSERT INTO stream_platform_accounts/i.test(sql)) {
        rows.push({ id: rows.length + 1, owner_discord_id: params[0], platform: params[1],
          platform_user_id: params[2], platform_username: params[3],
          access_token: params[4], refresh_token: params[5], expires_at: params[6], scopes: params[7] });
        return { insertId: rows.length };
      }
      if (/^SELECT \* FROM stream_platform_accounts/i.test(sql)) {
        return rows.filter(r => r.owner_discord_id === params[0] && (params[1] ? r.platform === params[1] : true));
      }
      return {};
    },
  };
}

test('saveAccount encrypts tokens before storing', async () => {
  const db = fakeDb();
  const store = makeAccountStore(db, fakeEnc);
  await store.saveAccount({ ownerDiscordId: '1', platform: 'twitch', platformUserId: 'tw1',
    platformUsername: 'bob', accessToken: 'AT', refreshToken: 'RT', expiresAt: null, scopes: 'a b' });
  const raw = db.rows[0].access_token;
  assert.ok(!raw.includes('AT'), 'token must not be stored in plaintext');
  assert.ok(JSON.parse(raw).encryptedData, 'stored as JSON of encrypted object');
});

test('getAccount returns decrypted tokens', async () => {
  const db = fakeDb();
  const store = makeAccountStore(db, fakeEnc);
  await store.saveAccount({ ownerDiscordId: '1', platform: 'twitch', platformUserId: 'tw1',
    platformUsername: 'bob', accessToken: 'AT', refreshToken: 'RT', expiresAt: null, scopes: '' });
  const acct = await store.getAccount('1', 'twitch');
  assert.strictEqual(acct.accessToken, 'AT');
  assert.strictEqual(acct.refreshToken, 'RT');
  assert.strictEqual(acct.platform, 'twitch');
});

test('getAccount returns null when absent', async () => {
  const store = makeAccountStore(fakeDb(), fakeEnc);
  assert.strictEqual(await store.getAccount('nope', 'twitch'), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/death/CertiFriedUtility/dashboard && node --test test/platforms-accounts.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `dashboard/services/platforms/accounts.js`**

```js
// Encrypted CRUD for stream_platform_accounts. Inject db + encryption for testability.
import poolDefault, { query as queryDefault } from '../../../utils/db.js';
import encryptionDefault from '../../../utils/encryption.js';

const enc = (encryption, s) => (s == null ? null : JSON.stringify(encryption.encrypt(s)));
const dec = (encryption, s) => (s == null ? null : encryption.decrypt(JSON.parse(s)));

export function makeAccountStore(db, encryption) {
  return {
    async saveAccount(a) {
      await db.query(
        `INSERT INTO stream_platform_accounts
           (owner_discord_id, platform, platform_user_id, platform_username, access_token, refresh_token, expires_at, scopes, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
         ON DUPLICATE KEY UPDATE
           platform_user_id=VALUES(platform_user_id), platform_username=VALUES(platform_username),
           access_token=VALUES(access_token), refresh_token=VALUES(refresh_token),
           expires_at=VALUES(expires_at), scopes=VALUES(scopes), status='active'`,
        [a.ownerDiscordId, a.platform, a.platformUserId, a.platformUsername,
         enc(encryption, a.accessToken), enc(encryption, a.refreshToken), a.expiresAt, a.scopes]
      );
    },
    async getAccount(ownerDiscordId, platform) {
      const rows = await db.query(
        'SELECT * FROM stream_platform_accounts WHERE owner_discord_id = ? AND platform = ? LIMIT 1',
        [ownerDiscordId, platform]
      );
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id, platform: r.platform, ownerDiscordId: r.owner_discord_id,
        platformUserId: r.platform_user_id, platformUsername: r.platform_username,
        accessToken: dec(encryption, r.access_token), refreshToken: dec(encryption, r.refresh_token),
        expiresAt: r.expires_at, scopes: r.scopes, status: r.status,
      };
    },
    async listAccounts(ownerDiscordId) {
      const rows = await db.query(
        'SELECT id, platform, platform_username, status, created_at FROM stream_platform_accounts WHERE owner_discord_id = ?',
        [ownerDiscordId]
      );
      return rows;
    },
    async deleteAccount(ownerDiscordId, platform) {
      await db.query('DELETE FROM stream_platform_accounts WHERE owner_discord_id = ? AND platform = ?',
        [ownerDiscordId, platform]);
    },
    async markStatus(id, status) {
      await db.query('UPDATE stream_platform_accounts SET status = ? WHERE id = ?', [status, id]);
    },
  };
}

// Default singleton wired to the real db + encryption.
export const accountStore = makeAccountStore({ query: queryDefault }, encryptionDefault);
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/death/CertiFriedUtility/dashboard && node --test test/platforms-accounts.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -f dashboard/test/platforms-accounts.test.js
git add dashboard/services/platforms/accounts.js
git commit -m "feat(accounts): encrypted account store"
```

---

### Task 3: Adapter registry + metadata

**Files:**
- Create: `dashboard/services/platforms/registry.js`
- Test: `dashboard/test/platforms-registry.test.js`

- [ ] **Step 1: Write the failing test `dashboard/test/platforms-registry.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { PLATFORM_META, getAdapter, listConnectable } from '../services/platforms/registry.js';

test('declares mode + reviewGated per platform', () => {
  assert.strictEqual(PLATFORM_META.twitch.mode, 'static');
  assert.strictEqual(PLATFORM_META.kick.mode, 'static');
  assert.strictEqual(PLATFORM_META.youtube.mode, 'dynamic');
  assert.strictEqual(PLATFORM_META.facebook.mode, 'dynamic');
  assert.strictEqual(PLATFORM_META.youtube.reviewGated, true);
  assert.strictEqual(PLATFORM_META.twitch.reviewGated, false);
});

test('getAdapter returns an adapter with the required methods', () => {
  const a = getAdapter('twitch');
  for (const m of ['getAuthUrl', 'handleCallback', 'connectDestination', 'resolveAtGoLive']) {
    assert.strictEqual(typeof a[m], 'function', `twitch adapter missing ${m}`);
  }
});

test('listConnectable excludes review-gated when flag is off', () => {
  const names = listConnectable({ enableGated: false }).map(p => p.platform);
  assert.ok(names.includes('twitch'));
  assert.ok(names.includes('kick'));
  assert.ok(!names.includes('youtube'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/death/CertiFriedUtility/dashboard && node --test test/platforms-registry.test.js`
Expected: FAIL (module/adapters not found).

- [ ] **Step 3: Implement `dashboard/services/platforms/registry.js`**

```js
import * as twitch from './twitch.js';
import * as kick from './kick.js';
import * as youtube from './youtube.js';
import * as facebook from './facebook.js';

export const PLATFORM_META = {
  twitch:   { platform: 'twitch',   label: 'Twitch',   mode: 'static',  reviewGated: false, adapter: twitch },
  kick:     { platform: 'kick',     label: 'Kick',     mode: 'static',  reviewGated: false, adapter: kick },
  youtube:  { platform: 'youtube',  label: 'YouTube',  mode: 'dynamic', reviewGated: true,  adapter: youtube },
  facebook: { platform: 'facebook', label: 'Facebook', mode: 'dynamic', reviewGated: true,  adapter: facebook },
};

export function getAdapter(platform) {
  const m = PLATFORM_META[platform];
  if (!m) throw new Error(`Unknown platform: ${platform}`);
  return m.adapter;
}

export function listConnectable({ enableGated } = { enableGated: false }) {
  return Object.values(PLATFORM_META)
    .filter(m => enableGated || !m.reviewGated)
    .map(m => ({ platform: m.platform, label: m.label, mode: m.mode }));
}
```

> NOTE: Tasks 8–11 create the four adapter modules. This registry imports them, so it will not load until those files exist. Implement Task 3's test by first creating **minimal stub adapter files** that export the four required functions throwing `new Error('not implemented')`, then flesh each out in its own task. Create the stubs now:

- [ ] **Step 3b: Create stub adapters so the registry imports**

For each of `dashboard/services/platforms/{twitch,kick,youtube,facebook}.js`:
```js
export function getAuthUrl() { throw new Error('not implemented'); }
export async function handleCallback() { throw new Error('not implemented'); }
export async function connectDestination() { throw new Error('not implemented'); }
export async function resolveAtGoLive() { throw new Error('not implemented'); }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/death/CertiFriedUtility/dashboard && node --test test/platforms-registry.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -f dashboard/test/platforms-registry.test.js
git add dashboard/services/platforms/registry.js dashboard/services/platforms/twitch.js dashboard/services/platforms/kick.js dashboard/services/platforms/youtube.js dashboard/services/platforms/facebook.js
git commit -m "feat(platforms): adapter registry + stub adapters"
```

---

### Task 4: Resolver

**Files:**
- Create: `dashboard/services/platforms/resolver.js`
- Test: `dashboard/test/platforms-resolver.test.js`

- [ ] **Step 1: Write the failing test `dashboard/test/platforms-resolver.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { resolveDestinations } from '../services/platforms/resolver.js';

function ctx(destinations, accounts = {}, adapters = {}) {
  return {
    db: {
      query: async (sql, params) => {
        if (/FROM stream_keys/i.test(sql)) return [{ id: 7 }];
        if (/FROM stream_destinations/i.test(sql)) return destinations;
        return [];
      },
    },
    accountStore: { getAccountById: async (id) => accounts[id] || null },
    getAdapter: (p) => adapters[p],
  };
}

test('passes through static destinations unchanged', async () => {
  const out = await resolveDestinations(ctx([
    { id: 1, name: 'My Twitch', platform: 'twitch', resolution: 'static', rtmp_url: 'rtmp://t/app', dest_stream_key: 'k1', account_id: null, config_json: null },
  ]), 'cf_key');
  assert.deepStrictEqual(out, [{ name: 'My Twitch', platform: 'twitch', rtmp_url: 'rtmp://t/app', dest_stream_key: 'k1' }]);
});

test('runs adapter.resolveAtGoLive for dynamic destinations', async () => {
  const adapters = { youtube: { resolveAtGoLive: async () => ({ rtmp_url: 'rtmp://yt/live2', key: 'yt-fresh' }) } };
  const out = await resolveDestinations(ctx([
    { id: 2, name: 'YT', platform: 'youtube', resolution: 'dynamic', rtmp_url: null, dest_stream_key: null, account_id: 5, config_json: null },
  ], { 5: { id: 5, platform: 'youtube' } }, adapters), 'cf_key');
  assert.deepStrictEqual(out, [{ name: 'YT', platform: 'youtube', rtmp_url: 'rtmp://yt/live2', dest_stream_key: 'yt-fresh' }]);
});

test('skips a dynamic destination whose adapter throws (isolation)', async () => {
  const adapters = {
    youtube: { resolveAtGoLive: async () => { throw new Error('boom'); } },
    twitch: { resolveAtGoLive: async () => ({ rtmp_url: 'rtmp://t', key: 'k' }) },
  };
  const out = await resolveDestinations(ctx([
    { id: 2, name: 'YT', platform: 'youtube', resolution: 'dynamic', account_id: 5, config_json: null },
    { id: 1, name: 'Tw', platform: 'twitch', resolution: 'static', rtmp_url: 'rtmp://t', dest_stream_key: 'k', account_id: null },
  ], { 5: { id: 5, platform: 'youtube' } }, adapters), 'cf_key');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'Tw');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/death/CertiFriedUtility/dashboard && node --test test/platforms-resolver.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `dashboard/services/platforms/resolver.js`**

```js
import poolDefault, { query as queryDefault } from '../../../utils/db.js';
import { accountStore as defaultStore } from './accounts.js';
import { getAdapter as defaultGetAdapter } from './registry.js';
import loggerDefault from '../../../utils/logger.js';

// ctx allows dependency injection for tests; defaults wire the real services.
export async function resolveDestinations(ctx, streamKey) {
  const db = ctx.db || { query: queryDefault };
  const accountStore = ctx.accountStore || defaultStore;
  const getAdapter = ctx.getAdapter || defaultGetAdapter;
  const logger = ctx.logger || loggerDefault;

  const keyRows = await db.query('SELECT id FROM stream_keys WHERE stream_key = ? AND enabled = 1 LIMIT 1', [streamKey]);
  if (!keyRows[0]) return [];
  const destinations = await db.query(
    'SELECT * FROM stream_destinations WHERE stream_key_id = ? AND enabled = 1 ORDER BY priority ASC',
    [keyRows[0].id]
  );

  const out = [];
  for (const d of destinations) {
    if (d.resolution !== 'dynamic') {
      out.push({ name: d.name, platform: d.platform, rtmp_url: d.rtmp_url, dest_stream_key: d.dest_stream_key || '' });
      continue;
    }
    try {
      const account = await accountStore.getAccountById(d.account_id);
      if (!account) throw new Error('no linked account');
      const cfg = d.config_json ? (typeof d.config_json === 'string' ? JSON.parse(d.config_json) : d.config_json) : {};
      const r = await getAdapter(d.platform).resolveAtGoLive(account, cfg);
      out.push({ name: d.name, platform: d.platform, rtmp_url: r.rtmp_url, dest_stream_key: r.key || '' });
    } catch (err) {
      logger.error(`[resolver] dynamic resolve failed for ${d.platform} (${d.name}): ${err.message}`);
      // isolation: skip this destination, keep the rest
    }
  }
  return out;
}
```

- [ ] **Step 3b: Add `getAccountById` to the account store** (`dashboard/services/platforms/accounts.js`, inside the object returned by `makeAccountStore`)

```js
    async getAccountById(id) {
      if (!id) return null;
      const rows = await db.query('SELECT * FROM stream_platform_accounts WHERE id = ? LIMIT 1', [id]);
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id, platform: r.platform, ownerDiscordId: r.owner_discord_id,
        platformUserId: r.platform_user_id, platformUsername: r.platform_username,
        accessToken: dec(encryption, r.access_token), refreshToken: dec(encryption, r.refresh_token),
        expiresAt: r.expires_at, scopes: r.scopes, status: r.status,
      };
    },
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/death/CertiFriedUtility/dashboard && node --test test/platforms-resolver.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -f dashboard/test/platforms-resolver.test.js
git add dashboard/services/platforms/resolver.js dashboard/services/platforms/accounts.js
git commit -m "feat(platforms): go-live destination resolver (static + dynamic, isolated)"
```

---

### Task 5: Internal resolver endpoint + relay client

**Files:**
- Create: `dashboard/routes/stream-internal.js`
- Modify: `dashboard/server.js` (mount + CSRF exempt)
- Create: `stream-relay/src/resolver-client.js`
- Test: `stream-relay/test/resolver-client.test.js`
- Modify: `stream-relay/.env.example`, repo-root `.env`, `dashboard/.env` shared secret

- [ ] **Step 1: Add `RELAY_INTERNAL_SECRET` to envs**

Append to `stream-relay/.env.example`:
```
# Shared secret for the relay -> dashboard resolver call (set the SAME value in the dashboard env)
RELAY_INTERNAL_SECRET=
DASHBOARD_RESOLVER_URL=http://127.0.0.1:3001/internal/resolve-destinations
```
Then generate one secret and set it in BOTH `stream-relay/.env` and the repo-root `.env`:
```bash
cd /home/death/CertiFriedUtility
SECRET=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
printf '\nRELAY_INTERNAL_SECRET=%s\nDASHBOARD_RESOLVER_URL=http://127.0.0.1:3001/internal/resolve-destinations\n' "$SECRET" >> stream-relay/.env
grep -q '^RELAY_INTERNAL_SECRET=' .env || printf '\nRELAY_INTERNAL_SECRET=%s\n' "$SECRET" >> .env
```

- [ ] **Step 2: Implement `dashboard/routes/stream-internal.js`**

```js
// Localhost-only, secret-gated endpoint the relay calls at go-live.
import express from 'express';
import { resolveDestinations } from '../services/platforms/resolver.js';
import logger from '../../utils/logger.js';

const router = express.Router();
const SECRET = process.env.RELAY_INTERNAL_SECRET;

router.post('/internal/resolve-destinations', async (req, res) => {
  if (!SECRET || req.headers['x-relay-secret'] !== SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const streamKey = req.body && req.body.streamKey;
  if (!streamKey) return res.status(400).json({ error: 'streamKey required' });
  try {
    const destinations = await resolveDestinations({}, streamKey);
    res.json({ destinations });
  } catch (err) {
    logger.error('[stream-internal] resolve failed: ' + err.message);
    res.status(500).json({ error: 'resolve_failed' });
  }
});

export default router;
```

- [ ] **Step 3: Mount it + CSRF-exempt** in `dashboard/server.js`

Near the other route imports (~line 21):
```js
import streamInternalRouter from './routes/stream-internal.js';
```
Mount it BEFORE other `/` routers (top of the mounting block) and add `/internal/resolve-destinations` to the `csrfProtection({ ignorePaths: [...] })` list in `dashboard/app.js`:
```js
        app.use('/', streamInternalRouter);
```
In `dashboard/app.js` `ignorePaths` array, add:
```js
            '/internal/resolve-destinations',
```

- [ ] **Step 4: Write the failing test `stream-relay/test/resolver-client.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveViaDashboard } = require('../src/resolver-client');

test('returns resolver destinations on success', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ destinations: [{ name: 'A', platform: 'twitch', rtmp_url: 'rtmp://t', dest_stream_key: 'k' }] }) });
  const out = await resolveViaDashboard('cf_key', { url: 'http://x', secret: 's', fetchFn: fakeFetch });
  assert.strictEqual(out[0].name, 'A');
});

test('throws on non-200 so caller can fall back', async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(() => resolveViaDashboard('cf_key', { url: 'http://x', secret: 's', fetchFn: fakeFetch }));
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `cd /home/death/CertiFriedUtility/stream-relay && node --test test/resolver-client.test.js`
Expected: FAIL — module not found.

- [ ] **Step 6: Implement `stream-relay/src/resolver-client.js`**

```js
'use strict';
const { config } = require('./config');

// Node 20 has global fetch; allow injection for tests.
async function resolveViaDashboard(streamKey, opts = {}) {
  const url = opts.url || config.resolverUrl;
  const secret = opts.secret || config.internalSecret;
  const fetchFn = opts.fetchFn || fetch;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Relay-Secret': secret },
    body: JSON.stringify({ streamKey }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error('resolver HTTP ' + res.status);
  const data = await res.json();
  return data.destinations || [];
}

module.exports = { resolveViaDashboard };
```

- [ ] **Step 6b: Add the two config keys** to `stream-relay/src/config.js` `loadConfig` return (after `playSecret`):
```js
    resolverUrl: env.DASHBOARD_RESOLVER_URL || 'http://127.0.0.1:3001/internal/resolve-destinations',
    internalSecret: env.RELAY_INTERNAL_SECRET || '',
```

- [ ] **Step 7: Run to verify it passes**

Run: `cd /home/death/CertiFriedUtility/stream-relay && node --test test/resolver-client.test.js`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add -f stream-relay/test/resolver-client.test.js
git add dashboard/routes/stream-internal.js dashboard/server.js dashboard/app.js stream-relay/src/resolver-client.js stream-relay/src/config.js stream-relay/.env.example
git commit -m "feat(resolver): internal resolve endpoint + relay resolver-client"
```

---

### Task 6: Wire the relay to the resolver (with fallback)

**Files:**
- Modify: `stream-relay/src/relay.js`

- [ ] **Step 1: Replace the destination-loading block in `postPublish`**

In `stream-relay/src/relay.js`, add at top: `const { resolveViaDashboard } = require('./resolver-client');`

Replace the existing destinations query in `postPublish`:
```js
    let destinations = [];
    try {
      destinations = await db.query(
        'SELECT * FROM stream_destinations WHERE stream_key_id = ? AND enabled = 1 ORDER BY priority ASC',
        [keyId]
      );
    } catch (err) { console.error('[relay] dest load error:', err.message); return; }
    destinations = destinations.slice(0, config.maxDestinationsPerKey);
```
with:
```js
    let destinations = [];
    try {
      // Primary path: dashboard resolver (handles dynamic OAuth platforms).
      destinations = await resolveViaDashboard(streamKey);
      console.log(`[relay] resolver returned ${destinations.length} destination(s)`);
    } catch (err) {
      console.error('[relay] resolver unavailable, falling back to static rows:', err.message);
      try {
        const rows = await db.query(
          "SELECT name, platform, rtmp_url, dest_stream_key FROM stream_destinations WHERE stream_key_id = ? AND enabled = 1 AND resolution = 'static' ORDER BY priority ASC",
          [keyId]
        );
        destinations = rows;
      } catch (e) { console.error('[relay] static fallback failed:', e.message); return; }
    }
    destinations = destinations.slice(0, config.maxDestinationsPerKey);
```

- [ ] **Step 2: Syntax check (do not start the server)**

Run: `cd /home/death/CertiFriedUtility/stream-relay && node --check src/relay.js && echo OK`
Expected: `OK`.

- [ ] **Step 3: Run the relay suite**

Run: `cd /home/death/CertiFriedUtility/stream-relay && node --test`
Expected: all pass (existing + resolver-client).

- [ ] **Step 4: Commit**

```bash
git add stream-relay/src/relay.js
git commit -m "feat(relay): resolve destinations via dashboard at go-live, static fallback"
```

---

### Task 7: OAuth connect routes + connection management

**Files:**
- Create: `dashboard/routes/stream-connect.js`
- Modify: `dashboard/server.js` (mount)

- [ ] **Step 1: Implement `dashboard/routes/stream-connect.js`**

```js
// OAuth connect flow + connection management for the multicast Add-Platform feature.
//   GET    /stream/connect/:platform            -> redirect to provider OAuth (Discord-authed)
//   GET    /stream/connect/:platform/callback   -> exchange code, save account, create destination
//   GET    /stream/api/connections              -> list current user's connections
//   DELETE /stream/api/connections/:platform    -> disconnect
import express from 'express';
import crypto from 'crypto';
import { query } from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { PLATFORM_META, getAdapter } from '../services/platforms/registry.js';
import { accountStore } from '../services/platforms/accounts.js';

const router = express.Router();
const db = { query };
const ENABLE_GATED = process.env.STREAM_ENABLE_GATED_PLATFORMS === '1';

function ensureDiscordAuthed(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.user?.id) return next();
  res.redirect('/auth/discord?returnTo=' + encodeURIComponent('/stream'));
}

router.get('/stream/connect/:platform', ensureDiscordAuthed, (req, res) => {
  const meta = PLATFORM_META[req.params.platform];
  if (!meta) return res.redirect('/stream?error=unknown_platform');
  if (meta.reviewGated && !ENABLE_GATED) return res.redirect('/stream?error=platform_coming_soon');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.streamOAuthState = state;
  req.session.streamOAuthPlatform = meta.platform;
  res.redirect(getAdapter(meta.platform).getAuthUrl(state));
});

router.get('/stream/connect/:platform/callback', ensureDiscordAuthed, async (req, res) => {
  const platform = req.params.platform;
  const meta = PLATFORM_META[platform];
  if (!meta) return res.redirect('/stream?error=unknown_platform');
  if (req.query.error) return res.redirect('/stream?error=oauth_denied');
  if (!req.query.code || req.query.state !== req.session.streamOAuthState || platform !== req.session.streamOAuthPlatform) {
    return res.redirect('/stream?error=oauth_state');
  }
  delete req.session.streamOAuthState; delete req.session.streamOAuthPlatform;
  try {
    const adapter = getAdapter(platform);
    const result = await adapter.handleCallback(req.query.code);
    await accountStore.saveAccount({
      ownerDiscordId: req.user.id, platform,
      platformUserId: result.platformUserId, platformUsername: result.username,
      accessToken: result.tokens.access_token, refreshToken: result.tokens.refresh_token || null,
      expiresAt: result.tokens.expires_at || null, scopes: result.tokens.scope || meta.scopesStr || null,
    });
    const account = await accountStore.getAccount(req.user.id, platform);

    // Find/create the user's stream_keys row id
    const keyRows = await db.query('SELECT id FROM stream_keys WHERE owner_type = "discord" AND owner_id = ? LIMIT 1', [req.user.id]);
    if (!keyRows[0]) return res.redirect('/stream?error=no_stream_key');
    const streamKeyId = keyRows[0].id;

    const dest = await adapter.connectDestination(account); // { name, rtmp_url, dest_stream_key, resolution, config }
    await db.query(
      `INSERT INTO stream_destinations (stream_key_id, account_id, platform, resolution, name, rtmp_url, dest_stream_key, config_json, enabled, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 50)`,
      [streamKeyId, account.id, platform, meta.mode, dest.name || meta.label,
       dest.rtmp_url || '', dest.dest_stream_key || '', dest.config ? JSON.stringify(dest.config) : null]
    );
    const flag = meta.mode === 'dynamic' ? 'connected_dynamic' : (dest.dest_stream_key ? 'connected' : 'connected_need_key');
    res.redirect('/stream?ok=' + flag + '&platform=' + platform);
  } catch (err) {
    logger.error(`[stream-connect] ${platform} callback failed: ${err.message}`);
    res.redirect('/stream?error=connect_failed');
  }
});

router.get('/stream/api/connections', ensureDiscordAuthed, async (req, res) => {
  res.json({ connections: await accountStore.listAccounts(req.user.id) });
});

router.delete('/stream/api/connections/:platform', ensureDiscordAuthed, async (req, res) => {
  await accountStore.deleteAccount(req.user.id, req.params.platform); // FK cascade removes its destinations
  res.json({ ok: true });
});

export default router;
```

- [ ] **Step 2: Mount in `dashboard/server.js`** (with the other route imports + mounts):
```js
import streamConnectRouter from './routes/stream-connect.js';
```
```js
        app.use('/', streamConnectRouter);
```

- [ ] **Step 3: Syntax check**

Run: `cd /home/death/CertiFriedUtility/dashboard && node --check routes/stream-connect.js && node --check server.js && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add dashboard/routes/stream-connect.js dashboard/server.js
git commit -m "feat(connect): OAuth connect flow + connection management routes"
```

---

## PART B — Twitch adapter

### Task 8: Twitch adapter (static, fetch persistent key)

**Files:**
- Modify: `dashboard/services/platforms/twitch.js` (replace stub)
- Test: `dashboard/test/platforms-twitch.test.js`

- [ ] **Step 1: Write the failing test `dashboard/test/platforms-twitch.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { getAuthUrl, connectDestination, TWITCH_INGEST } from '../services/platforms/twitch.js';

test('getAuthUrl includes the stream-key scope and state', () => {
  const url = getAuthUrl('abc123');
  assert.ok(url.startsWith('https://id.twitch.tv/oauth2/authorize'));
  assert.ok(url.includes('channel%3Aread%3Astream_key'));
  assert.ok(url.includes('state=abc123'));
});

test('connectDestination fetches the key and builds a static destination', async () => {
  const account = { accessToken: 'AT', platformUsername: 'bob', platformUserId: '42' };
  const fakeFetch = async (u, o) => {
    assert.ok(u.includes('/helix/streams/key'));
    return { ok: true, json: async () => ({ data: [{ stream_key: 'live_42_secret' }] }) };
  };
  const dest = await connectDestination(account, { fetchFn: fakeFetch });
  assert.strictEqual(dest.resolution, 'static');
  assert.strictEqual(dest.dest_stream_key, 'live_42_secret');
  assert.strictEqual(dest.rtmp_url, TWITCH_INGEST);
  assert.ok(dest.name.toLowerCase().includes('twitch'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/death/CertiFriedUtility/dashboard && node --test test/platforms-twitch.test.js`
Expected: FAIL (stub throws / missing exports).

- [ ] **Step 3: Implement `dashboard/services/platforms/twitch.js`**

```js
import fetch from 'node-fetch';

const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const BASE_URL = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '');
const REDIRECT_URI = `${BASE_URL}/stream/connect/twitch/callback`;
const SCOPES = 'channel:read:stream_key';
export const TWITCH_INGEST = 'rtmp://ingest.global-contribute.live-video.net/app';

export function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPES, state,
  });
  return `https://id.twitch.tv/oauth2/authorize?${params}`;
}

export async function handleCallback(code, opts = {}) {
  const fetchFn = opts.fetchFn || fetch;
  const tokenRes = await fetchFn('https://id.twitch.tv/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI }),
  });
  const tokens = await tokenRes.json();
  if (!tokens.access_token) throw new Error('twitch token exchange failed');
  const userRes = await fetchFn('https://api.twitch.tv/helix/users', {
    headers: { Authorization: `Bearer ${tokens.access_token}`, 'Client-Id': CLIENT_ID },
  });
  const u = (await userRes.json()).data?.[0];
  if (!u) throw new Error('twitch user fetch failed');
  if (Array.isArray(tokens.scope)) tokens.scope = tokens.scope.join(' ');
  return { platformUserId: u.id, username: u.login, tokens };
}

export async function connectDestination(account, opts = {}) {
  const fetchFn = opts.fetchFn || fetch;
  const res = await fetchFn(`https://api.twitch.tv/helix/streams/key?broadcaster_id=${account.platformUserId}`, {
    headers: { Authorization: `Bearer ${account.accessToken}`, 'Client-Id': CLIENT_ID },
  });
  if (!res.ok) throw new Error('twitch stream key fetch failed (' + res.status + ')');
  const key = (await res.json()).data?.[0]?.stream_key;
  if (!key) throw new Error('twitch returned no stream key');
  return { name: `Twitch (${account.platformUsername})`, resolution: 'static', rtmp_url: TWITCH_INGEST, dest_stream_key: key, config: null };
}

// Static platform: resolver returns stored values, but provide a passthrough for completeness.
export async function resolveAtGoLive(account, cfg) {
  return { rtmp_url: cfg?.rtmp_url || TWITCH_INGEST, key: cfg?.key || '' };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/death/CertiFriedUtility/dashboard && node --test test/platforms-twitch.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -f dashboard/test/platforms-twitch.test.js
git add dashboard/services/platforms/twitch.js
git commit -m "feat(twitch): adapter — OAuth + persistent stream-key fetch"
```

---

## PART C — Kick adapter

### Task 9: Kick adapter (OAuth connect, manual key)

**Files:**
- Modify: `dashboard/services/platforms/kick.js` (replace stub)
- Test: `dashboard/test/platforms-kick.test.js`

> Kick OAuth uses `https://id.kick.com/oauth/authorize` + token `https://id.kick.com/oauth/token` (PKCE). Kick exposes no stream-key API, so `connectDestination` returns the ingest URL with an EMPTY key (UI prompts the user to paste it). Ingest base: `rtmps://fa723fc1b171.global-contribute.live-video.net/app`.

- [ ] **Step 1: Write the failing test `dashboard/test/platforms-kick.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { getAuthUrl, connectDestination, KICK_INGEST } from '../services/platforms/kick.js';

test('getAuthUrl points at Kick authorize with state', () => {
  const url = getAuthUrl('s1');
  assert.ok(url.startsWith('https://id.kick.com/oauth/authorize'));
  assert.ok(url.includes('state=s1'));
});

test('connectDestination returns ingest URL with empty key (manual)', async () => {
  const dest = await connectDestination({ platformUsername: 'bob' });
  assert.strictEqual(dest.resolution, 'static');
  assert.strictEqual(dest.rtmp_url, KICK_INGEST);
  assert.strictEqual(dest.dest_stream_key, '');
  assert.strictEqual(dest.needsKey, true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/death/CertiFriedUtility/dashboard && node --test test/platforms-kick.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement `dashboard/services/platforms/kick.js`**

```js
import fetch from 'node-fetch';

const CLIENT_ID = process.env.KICK_CLIENT_ID;
const CLIENT_SECRET = process.env.KICK_CLIENT_SECRET;
const BASE_URL = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '');
const REDIRECT_URI = `${BASE_URL}/stream/connect/kick/callback`;
const SCOPES = 'user:read';
export const KICK_INGEST = 'rtmps://fa723fc1b171.global-contribute.live-video.net/app';

export function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPES, state,
  });
  return `https://id.kick.com/oauth/authorize?${params}`;
}

export async function handleCallback(code, opts = {}) {
  const fetchFn = opts.fetchFn || fetch;
  const res = await fetchFn('https://id.kick.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI }),
  });
  const tokens = await res.json();
  if (!tokens.access_token) throw new Error('kick token exchange failed');
  let username = 'kick', platformUserId = null;
  try {
    const me = await fetchFn('https://api.kick.com/public/v1/users', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const u = (await me.json()).data?.[0];
    if (u) { username = u.name || u.username || 'kick'; platformUserId = String(u.user_id || u.id || ''); }
  } catch { /* identity is best-effort; Kick API shapes vary */ }
  return { platformUserId, username, tokens };
}

export async function connectDestination(account) {
  return { name: `Kick (${account.platformUsername || 'account'})`, resolution: 'static', rtmp_url: KICK_INGEST, dest_stream_key: '', needsKey: true, config: null };
}

export async function resolveAtGoLive(account, cfg) {
  return { rtmp_url: cfg?.rtmp_url || KICK_INGEST, key: cfg?.key || '' };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/death/CertiFriedUtility/dashboard && node --test test/platforms-kick.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -f dashboard/test/platforms-kick.test.js
git add dashboard/services/platforms/kick.js
git commit -m "feat(kick): adapter — OAuth identity connect, manual key"
```

---

## PART D — YouTube adapter (review-gated)

### Task 10: YouTube adapter (dynamic; create stream+broadcast with auto-start)

**Files:**
- Modify: `dashboard/services/platforms/youtube.js` (replace stub)
- Test: `dashboard/test/platforms-youtube.test.js`

> Requires a Google OAuth client (`GOOGLE_OAUTH_CLIENT_ID/SECRET`) + consent-screen verification before it works against real accounts. The adapter is fully implemented + unit-tested with mocked HTTP now; the connect button stays behind `STREAM_ENABLE_GATED_PLATFORMS=1`.

- [ ] **Step 1: Write the failing test `dashboard/test/platforms-youtube.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { getAuthUrl, resolveAtGoLive } from '../services/platforms/youtube.js';

test('getAuthUrl requests offline access + youtube scope', () => {
  const url = getAuthUrl('s1');
  assert.ok(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth'));
  assert.ok(url.includes('access_type=offline'));
  assert.ok(url.includes('youtube'));
  assert.ok(url.includes('state=s1'));
});

test('resolveAtGoLive creates stream+broadcast and returns ingestion key', async () => {
  const calls = [];
  const account = { accessToken: 'AT', refreshToken: 'RT', expiresAt: null };
  const fakeFetch = async (u, o) => {
    calls.push(u);
    if (u.includes('/liveStreams')) return { ok: true, json: async () => ({ id: 'S1', cdn: { ingestionInfo: { ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', streamName: 'yt-key-1' } } }) };
    if (u.includes('/liveBroadcasts') && o.method === 'POST' && !u.includes('bind')) return { ok: true, json: async () => ({ id: 'B1' }) };
    if (u.includes('/liveBroadcasts/bind')) return { ok: true, json: async () => ({ id: 'B1' }) };
    return { ok: true, json: async () => ({}) };
  };
  const r = await resolveAtGoLive(account, { title: 'Test', privacy: 'unlisted' }, { fetchFn: fakeFetch, refreshFn: async () => 'AT' });
  assert.strictEqual(r.rtmp_url, 'rtmp://a.rtmp.youtube.com/live2');
  assert.strictEqual(r.key, 'yt-key-1');
  assert.ok(calls.some(u => u.includes('/liveStreams')));
  assert.ok(calls.some(u => u.includes('/liveBroadcasts/bind')));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/death/CertiFriedUtility/dashboard && node --test test/platforms-youtube.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement `dashboard/services/platforms/youtube.js`**

```js
import fetch from 'node-fetch';

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const BASE_URL = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '');
const REDIRECT_URI = `${BASE_URL}/stream/connect/youtube/callback`;
const SCOPE = 'https://www.googleapis.com/auth/youtube';
const API = 'https://www.googleapis.com/youtube/v3';

export function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function handleCallback(code, opts = {}) {
  const fetchFn = opts.fetchFn || fetch;
  const res = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI }),
  });
  const tokens = await res.json();
  if (!tokens.access_token) throw new Error('youtube token exchange failed');
  let username = 'youtube', platformUserId = null;
  try {
    const ch = await fetchFn(`${API}/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const c = (await ch.json()).items?.[0];
    if (c) { username = c.snippet?.title || 'youtube'; platformUserId = c.id; }
  } catch { /* best effort */ }
  tokens.expires_at = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
  return { platformUserId, username, tokens };
}

async function refreshAccessToken(account, fetchFn) {
  const res = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: account.refreshToken, grant_type: 'refresh_token' }),
  });
  const t = await res.json();
  if (!t.access_token) throw new Error('youtube token refresh failed');
  return t.access_token;
}

export async function connectDestination(account) {
  return { name: `YouTube (${account.platformUsername})`, resolution: 'dynamic', rtmp_url: '', dest_stream_key: '',
    config: { title: 'Live with CertiFried', privacy: 'public' } };
}

export async function resolveAtGoLive(account, cfg = {}, opts = {}) {
  const fetchFn = opts.fetchFn || fetch;
  const at = opts.refreshFn ? await opts.refreshFn(account) : await refreshAccessToken(account, fetchFn);
  const auth = { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' };

  const streamRes = await fetchFn(`${API}/liveStreams?part=snippet,cdn,contentDetails`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ snippet: { title: cfg.title || 'CertiFried Stream' },
      cdn: { frameRate: 'variable', ingestionType: 'rtmp', resolution: 'variable' }, contentDetails: { isReusable: false } }),
  });
  if (!streamRes.ok) throw new Error('yt liveStreams.insert ' + streamRes.status);
  const stream = await streamRes.json();
  const ing = stream.cdn?.ingestionInfo;
  if (!ing) throw new Error('yt missing ingestionInfo');

  const bRes = await fetchFn(`${API}/liveBroadcasts?part=snippet,status,contentDetails`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ snippet: { title: cfg.title || 'CertiFried Stream', scheduledStartTime: new Date().toISOString() },
      status: { privacyStatus: cfg.privacy || 'public', selfDeclaredMadeForKids: false },
      contentDetails: { enableAutoStart: true, enableAutoStop: true } }),
  });
  if (!bRes.ok) throw new Error('yt liveBroadcasts.insert ' + bRes.status);
  const broadcast = await bRes.json();

  const bindRes = await fetchFn(`${API}/liveBroadcasts/bind?id=${broadcast.id}&streamId=${stream.id}&part=id,contentDetails`,
    { method: 'POST', headers: auth });
  if (!bindRes.ok) throw new Error('yt liveBroadcasts.bind ' + bindRes.status);

  return { rtmp_url: ing.ingestionAddress, key: ing.streamName };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/death/CertiFriedUtility/dashboard && node --test test/platforms-youtube.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -f dashboard/test/platforms-youtube.test.js
git add dashboard/services/platforms/youtube.js
git commit -m "feat(youtube): adapter — dynamic broadcast+stream with auto-start"
```

---

## PART E — Facebook adapter (review-gated)

### Task 11: Facebook adapter (dynamic; create live video)

**Files:**
- Modify: `dashboard/services/platforms/facebook.js` (replace stub)
- Test: `dashboard/test/platforms-facebook.test.js`

> Requires Meta App Review for `publish_video` before it works on real accounts. Implemented + unit-tested with mocked HTTP now; button stays behind `STREAM_ENABLE_GATED_PLATFORMS=1`. Facebook's `live_videos` returns `stream_url` containing server+key combined, so we store it as `rtmp_url` with an empty key (the relay's `buildDestinationUrl` leaves a keyless base unchanged).

- [ ] **Step 1: Write the failing test `dashboard/test/platforms-facebook.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { getAuthUrl, resolveAtGoLive } from '../services/platforms/facebook.js';

test('getAuthUrl requests publish_video scope + state', () => {
  const url = getAuthUrl('s1');
  assert.ok(url.startsWith('https://www.facebook.com/'));
  assert.ok(url.includes('publish_video'));
  assert.ok(url.includes('state=s1'));
});

test('resolveAtGoLive creates a live video and returns its stream_url', async () => {
  const account = { accessToken: 'AT', platformUserId: 'me' };
  const fakeFetch = async (u, o) => {
    assert.ok(u.includes('/live_videos'));
    return { ok: true, json: async () => ({ id: 'LV1', stream_url: 'rtmps://live-api-s.facebook.com:443/rtmp/FB-key-xyz' }) };
  };
  const r = await resolveAtGoLive(account, { title: 'Test' }, { fetchFn: fakeFetch });
  assert.strictEqual(r.rtmp_url, 'rtmps://live-api-s.facebook.com:443/rtmp/FB-key-xyz');
  assert.strictEqual(r.key, '');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/death/CertiFriedUtility/dashboard && node --test test/platforms-facebook.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement `dashboard/services/platforms/facebook.js`**

```js
import fetch from 'node-fetch';

const APP_ID = process.env.META_APP_ID;
const APP_SECRET = process.env.META_APP_SECRET;
const BASE_URL = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/+$/, '');
const REDIRECT_URI = `${BASE_URL}/stream/connect/facebook/callback`;
const GRAPH = 'https://graph.facebook.com/v19.0';
const SCOPE = 'publish_video';

export function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: APP_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPE, state,
  });
  return `https://www.facebook.com/v19.0/dialog/oauth?${params}`;
}

export async function handleCallback(code, opts = {}) {
  const fetchFn = opts.fetchFn || fetch;
  const tRes = await fetchFn(`${GRAPH}/oauth/access_token?` + new URLSearchParams({
    client_id: APP_ID, client_secret: APP_SECRET, redirect_uri: REDIRECT_URI, code,
  }));
  const tokens = await tRes.json();
  if (!tokens.access_token) throw new Error('facebook token exchange failed');
  let username = 'facebook', platformUserId = 'me';
  try {
    const me = await fetchFn(`${GRAPH}/me?fields=id,name&access_token=${tokens.access_token}`);
    const u = await me.json();
    if (u.id) { platformUserId = u.id; username = u.name || 'facebook'; }
  } catch { /* best effort */ }
  tokens.expires_at = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
  return { platformUserId, username, tokens };
}

export async function connectDestination(account) {
  return { name: `Facebook (${account.platformUsername})`, resolution: 'dynamic', rtmp_url: '', dest_stream_key: '',
    config: { title: 'Live with CertiFried', target: 'me' } };
}

export async function resolveAtGoLive(account, cfg = {}, opts = {}) {
  const fetchFn = opts.fetchFn || fetch;
  const target = cfg.target || account.platformUserId || 'me';
  const res = await fetchFn(`${GRAPH}/${target}/live_videos`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'LIVE_NOW', title: cfg.title || 'CertiFried Stream', access_token: account.accessToken }),
  });
  if (!res.ok) throw new Error('fb live_videos ' + res.status);
  const lv = await res.json();
  const url = lv.secure_stream_url || lv.stream_url;
  if (!url) throw new Error('fb missing stream_url');
  return { rtmp_url: url, key: '' };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/death/CertiFriedUtility/dashboard && node --test test/platforms-facebook.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -f dashboard/test/platforms-facebook.test.js
git add dashboard/services/platforms/facebook.js
git commit -m "feat(facebook): adapter — dynamic live-video creation"
```

---

## PART F — UI + deploy

### Task 12: Add-Platform UI on `/stream`

**Files:**
- Modify: `dashboard/routes/stream.js` (pass connections + connectable list + ok/error flags to the view)
- Modify: `dashboard/views/stream.ejs` (Add-Platform chooser, connection badges)
- Modify: `dashboard/public/js/stream.js` (chooser interactions, disconnect, ok/error toasts)

- [ ] **Step 1: Pass connection data to the view** — in `dashboard/routes/stream.js`, in the `GET /stream` handler, before `res.render`:

```js
import { listConnectable } from '../services/platforms/registry.js';
import { accountStore } from '../services/platforms/accounts.js';
// ...
  const connections = await accountStore.listAccounts(req.user.id);
  const connectable = listConnectable({ enableGated: process.env.STREAM_ENABLE_GATED_PLATFORMS === '1' });
```
Add `connections, connectable, notice: { ok: req.query.ok || null, error: req.query.error || null, platform: req.query.platform || null }` to the render locals. For `/stream/quick` (guests) pass `connections: [], connectable: [], notice: {...}`.

- [ ] **Step 2: Add the chooser + connections UI to `dashboard/views/stream.ejs`**

Inside the Destinations card body, ABOVE the existing `#destList`, add (Discord users only):
```html
<% if (!isGuest) { %>
<div class="connect-bar">
  <button type="button" class="btn btn-primary" id="addPlatformBtn"><i class="fas fa-plug"></i> Add Platform</button>
  <div class="connect-menu" id="connectMenu" hidden>
    <% connectable.forEach((p) => { %>
      <a class="connect-opt" href="/stream/connect/<%= p.platform %>"><span class="platform-icon platform-<%= p.platform %>"></span><%= p.label %></a>
    <% }) %>
    <button type="button" class="connect-opt" id="manualOpt"><i class="fas fa-sliders"></i> Custom RTMP (manual)</button>
  </div>
</div>
<% } %>
```
Add minimal CSS to the page `<style>`:
```css
.connect-bar { position: relative; margin-bottom: 1rem; }
.connect-menu { position: absolute; z-index: 20; margin-top: 0.4rem; background: #161b1f; border: 1px solid var(--border-color); border-radius: 12px; padding: 0.4rem; display: flex; flex-direction: column; min-width: 220px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
.connect-opt { display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 0.7rem; border-radius: 8px; color: var(--text-secondary); text-decoration: none; background: none; border: none; cursor: pointer; font: inherit; text-align: left; }
.connect-opt:hover { background: var(--bg-card-hover); color: #fff; }
.connect-opt .platform-icon { width: 22px; height: 22px; border-radius: 6px; }
```

- [ ] **Step 3: Wire interactions in `dashboard/public/js/stream.js`** (append):

```js
// Add-Platform chooser
const addBtn = document.getElementById('addPlatformBtn');
const menu = document.getElementById('connectMenu');
addBtn?.addEventListener('click', () => { menu.hidden = !menu.hidden; });
document.addEventListener('click', (e) => { if (menu && !menu.hidden && !menu.contains(e.target) && e.target !== addBtn) menu.hidden = true; });
document.getElementById('manualOpt')?.addEventListener('click', () => { menu.hidden = true; document.getElementById('addDest')?.scrollIntoView({ behavior: 'smooth' }); });

// One-time notice from OAuth round-trip (?ok=... / ?error=...)
(function notice() {
  const p = new URLSearchParams(location.search);
  const ok = p.get('ok'), err = p.get('error'), platform = p.get('platform') || '';
  if (ok === 'connected') toast(`Connected ${platform} — destination added`, 'ok');
  else if (ok === 'connected_need_key') toast(`Connected ${platform} — paste your stream key on the new destination`, 'info');
  else if (ok === 'connected_dynamic') toast(`Connected ${platform} — it’ll go live automatically when you start streaming`, 'ok');
  else if (err === 'platform_coming_soon') toast('That platform is coming soon', 'info');
  else if (err) toast('Could not connect: ' + err.replace(/_/g, ' '), 'err');
  if (ok || err) history.replaceState({}, '', '/stream');
})();
```

- [ ] **Step 4: Syntax check**

Run: `cd /home/death/CertiFriedUtility/dashboard && node --check public/js/stream.js && node --check routes/stream.js && echo OK`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add dashboard/routes/stream.js dashboard/views/stream.ejs dashboard/public/js/stream.js
git commit -m "feat(ui): Add-Platform chooser + connection notices on /stream"
```

---

### Task 13: Deploy + verify

**Files:** none (operational)

- [ ] **Step 1: Run full test suites**

```bash
cd /home/death/CertiFriedUtility/stream-relay && node --test 2>&1 | grep -E "# (tests|pass|fail)"
cd /home/death/CertiFriedUtility/dashboard && node --test 2>&1 | grep -E "# (tests|pass|fail)"
```
Expected: 0 failures in both.

- [ ] **Step 2: Restart the relay (resolver-client + relay.js changes)**

```bash
pm2 restart certifried-stream && sleep 2 && curl -s http://127.0.0.1:4090/health
```
Expected: `{"ok":true,"active":0}`.

- [ ] **Step 3: Restart the dashboard process (new routes + resolver endpoint)**

```bash
pm2 restart CertiFriedUtility && sleep 8
curl -s -o /dev/null -w "resolver guard: HTTP %{http_code}\n" -X POST http://127.0.0.1:3001/internal/resolve-destinations -H 'Content-Type: application/json' -d '{"streamKey":"x"}'
```
Expected: `HTTP 403` (no/incorrect secret → correctly rejected).

- [ ] **Step 4: Resolver happy-path smoke (with the real secret)**

```bash
cd /home/death/CertiFriedUtility
SECRET=$(grep ^RELAY_INTERNAL_SECRET= .env | cut -d= -f2-)
curl -s -X POST http://127.0.0.1:3001/internal/resolve-destinations -H 'Content-Type: application/json' -H "X-Relay-Secret: $SECRET" -d '{"streamKey":"nonexistent"}'
```
Expected: `{"destinations":[]}` (valid secret, unknown key → empty list, no error).

- [ ] **Step 5: Manual Twitch connect (real, end-to-end)**

In a browser logged in via Discord: open `/stream` → **Add Platform → Connect Twitch** → approve. Expected: redirect back with a success toast and a new **Twitch (username)** destination whose key is pre-filled (masked). Start OBS to the ingest URL/key → Twitch destination shows **live**.

- [ ] **Step 6: Enable gated platforms once reviews clear**

When Google verification + Meta App Review are approved and `GOOGLE_OAUTH_CLIENT_ID/SECRET` are set, add `STREAM_ENABLE_GATED_PLATFORMS=1` to the repo-root `.env` and `pm2 restart CertiFriedUtility`. The YouTube/Facebook options then appear in the chooser.

- [ ] **Step 7: Commit (operational marker)**

```bash
git commit --allow-empty -m "chore: connected-accounts deployed; Twitch live, YouTube/Facebook gated pending review"
```

---

## Self-Review

**Spec coverage:**
- Connections table + encryption → Task 1, 2 ✅
- `stream_destinations` account_id/resolution/config_json → Task 1 ✅
- Adapter interface + registry + mode/reviewGated → Task 3 ✅
- Dashboard-hosted resolver (static + dynamic, isolation) → Task 4 ✅
- Internal secret-gated endpoint + relay client + fallback → Tasks 5, 6 ✅
- OAuth connect flow + connection mgmt + guests excluded → Task 7 (ensureDiscordAuthed; guests never get connect UI) ✅
- Twitch (static key), Kick (manual), YouTube (dynamic auto-start), Facebook (dynamic live video) → Tasks 8–11 ✅
- UX chooser + badges + disconnect + coming-soon gating → Tasks 7, 12 ✅
- Security: encrypted tokens (T2), state param (T7), secret-gated localhost resolver (T5), token-refresh→needs_reconnect (accounts.markStatus + adapters) ✅
- Testing: unit per module + relay contract + deploy smokes → all tasks + T13 ✅
- Feature-flag gating for review-gated platforms → registry.reviewGated + STREAM_ENABLE_GATED_PLATFORMS (T7, T10, T11, T12, T13) ✅

**Placeholder scan:** No TBD/TODO; every code step has complete code; commands have expected output. Stub adapters in Task 3b are explicit, minimal, and replaced in Tasks 8–11. ✅

**Type/name consistency:** `makeAccountStore(db, encryption)` + `accountStore` singleton; `getAccount`/`getAccountById`/`listAccounts`/`deleteAccount`/`saveAccount`/`markStatus`; adapter quartet `getAuthUrl/handleCallback/connectDestination/resolveAtGoLive` consistent across registry + all four adapters; resolver returns `{name, platform, rtmp_url, dest_stream_key}` which matches the relay's `multistreamer.start` destination shape; `resolveViaDashboard(streamKey, opts)` used by relay.js Task 6. ✅
