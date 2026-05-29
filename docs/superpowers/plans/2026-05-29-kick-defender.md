# Kick Defender Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Kick variant of KumaBot Defender — a cross-channel shared-banlist defense network — inside CertiFriedUtility, with ban-on-event enforcement and a dedicated `/kick` dashboard.

**Architecture:** A new `services/certifried-bot/defender/` engine (banlist store, Kick moderation API wrapper, enforcer decision core, enforcement log) hooked into the existing Kick chat pipeline at the top of `command-handler.handleMessage`. Enforcement uses each channel owner's OAuth token (with added `moderation:ban` + `moderation:chat_message:manage` scopes); a banlisted user is banned in the channel where they appear, or their message deleted if only the delete scope was granted. A new `/kick` dashboard area reuses the existing Kick login (`req.session.tokesUser`); root `/` becomes a Discord-vs-Kick chooser.

**Tech Stack:** Node.js (ESM, `type: module`), MySQL via `mysql2` pool (`utils/db.js`), Express monolith (`dashboard/server.js`), EJS views, Node built-in test runner (`node --test`). WebSocket chat via Pusher (`services/certifried-bot/kick-client.js`).

**Spec:** `docs/superpowers/specs/2026-05-29-kick-defender-design.md`

**Conventions discovered (verified against the codebase):**
- Tests: `tests/**/*.test.js`, run with `npm test` (= `node --test tests/`). Existing tests already use `node:test` + `node:assert/strict` (e.g. `tests/fourthwall-api.test.js`) — match that style. Run a single file with `node --test tests/defender/foo.test.js`.
- Migrations: `migrations/NNN_name.js` exporting `export async function up(db)` / `export async function down(db)`. The runner is `scripts/run-migrations.js` (NOT `migrations/run.js` — that doesn't exist; the `npm run migrate` script in package.json points at a nonexistent path and is broken). The runner passes the shared `pool` as `db`, tracks applied files in `schema_migrations`, and runs all pending in numeric order at most once each. **Do not import the pool inside a migration — use the `db` arg.** Run with `node scripts/run-migrations.js`. Next free number is **111**. (Note: `run-migration.js` in the repo root is an unrelated one-off SQL script — ignore it.)
- Command resolution: the existing `getCommand(channelId, name)` reads enabled rows from the `tokes_global_command_config` table (columns: `command_key`, `default_aliases` JSON, `cooldown_default`, `mod_only`, `broadcaster_only`, `category`, `description`) and maps `row.command_key` → the static `commandHandlers[command_key]` map in `command-registry.js`. A built-in command only resolves if it has BOTH a config row AND a `commandHandlers` entry. **The defender does NOT use this path** — defender commands are a self-contained in-memory map dispatched directly in `command-handler.js` (Task 9), so no DB config rows are needed and `command-registry.js` is left unchanged. The defender's manager/admin tiers are enforced in `command-handler.js`.
- DB access (engine/runtime code, NOT migrations): `import pool from '../../utils/db.js'` then `await pool.execute(sql, params)`.
- Logging: `import logger from '../../utils/logger.js'`.
- Token crypto: `import { encryptToken, decryptToken } from '../../utils/token-encryption.js'`.

---

## File Structure

**New — defender engine (`services/certifried-bot/defender/`):**
- `banlist.js` — cached CRUD over `kbd_banlist`, `kbd_unbanlist`, `kbd_malicious_sites`. One responsibility: shared-list data access + cache.
- `managers.js` — CRUD + `isManager()` over `kbd_managers`.
- `kick-moderation.js` — thin Kick API wrapper: `banUser`, `unbanUser`, `deleteMessage`. Pure I/O, token passed in.
- `enforcer.js` — decision core: `createEnforcer(deps)` returning `check(event)`. Dependency-injected for testing.
- `enforcement-log.js` — writes/reads `kbd_enforcement_log`; count helpers.
- `channel-tokens.js` — resolves a channel's owner token **and** granted scopes (extends the pattern in `kick-client.getValidAccessToken`).
- `commands/index.js` — registers defender chat commands into the command registry.
- `commands/*.js` — individual command handlers.

**New — migrations:**
- `migrations/111_kbd_tables.js` — all `kbd_*` tables + `defender_enabled` flag on `tokes_channels`.

**New — dashboard (`dashboard/`):**
- `routes/kick-defender.js` — `/kick` router (streamer panel, manager console, admin, enroll toggle, JSON APIs).
- `views/kick/index.ejs`, `views/kick/panel.ejs`, `views/kick/managers.ejs` — defender pages.
- `views/landing-chooser.ejs` — Discord-vs-Kick chooser.

**Modified:**
- `services/certifried-bot/command-handler.js` — insert enforcer hook at top of `handleMessage`; thread `messageId`; add defender permission tier resolution.
- `services/certifried-bot/kick-client.js` — pass `messageId` into `handleMessage`; expose a shared token+scope resolver.
- `services/certifried-bot/command-registry.js` — register defender commands; support `minRole` tiers `manager`/`admin`/`broadcaster`.
- `dashboard/routes/auth-tokes-bot.js:24` — add the two moderation scopes to `KICK_SCOPES`.
- `dashboard/server.js:577` — root `/` renders `landing-chooser`; mount `kickDefenderRouter`.

---

## Phase 1 — Database

### Task 1: Migration for all `kbd_*` tables + enrollment flag

**Files:**
- Create: `migrations/111_kbd_tables.js`

- [ ] **Step 1: Write the migration**

```js
/**
 * Migration: Kick Defender (KBD) tables + defender enrollment flag.
 * Shared-banlist defense network for Kick. See docs/superpowers/specs/2026-05-29-kick-defender-design.md
 */

// NOTE: scripts/run-migrations.js calls up(pool)/down(pool), so `db` IS the
// shared mysql2 pool. Do NOT import the pool here — use the `db` arg. Matches
// migration 110's style (CREATE TABLE IF NOT EXISTS, no explicit transaction).

export async function up(db) {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS kbd_banlist (
                id INT PRIMARY KEY AUTO_INCREMENT,
                platform VARCHAR(16) NOT NULL DEFAULT 'kick',
                platform_user_id VARCHAR(64) NULL,
                username VARCHAR(255) NOT NULL,
                reason VARCHAR(255) NULL,
                list_type ENUM('ban','sublist') NOT NULL DEFAULT 'ban',
                added_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_user (platform, platform_user_id, list_type),
                KEY idx_username (platform, username),
                KEY idx_list_type (list_type)
            )
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS kbd_unbanlist (
                id INT PRIMARY KEY AUTO_INCREMENT,
                platform VARCHAR(16) NOT NULL DEFAULT 'kick',
                platform_user_id VARCHAR(64) NULL,
                username VARCHAR(255) NOT NULL,
                added_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_user (platform, platform_user_id),
                KEY idx_username (platform, username)
            )
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS kbd_malicious_sites (
                id INT PRIMARY KEY AUTO_INCREMENT,
                uri VARCHAR(512) NOT NULL,
                added_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_uri (uri)
            )
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS kbd_managers (
                id INT PRIMARY KEY AUTO_INCREMENT,
                tokes_user_id INT NOT NULL,
                added_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_manager (tokes_user_id)
            )
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS kbd_enforcement_log (
                id INT PRIMARY KEY AUTO_INCREMENT,
                channel_id VARCHAR(64) NOT NULL,
                target_user_id VARCHAR(64) NULL,
                target_username VARCHAR(255) NOT NULL,
                action ENUM('ban','delete','detected_no_scope') NOT NULL,
                reason VARCHAR(255) NULL,
                success TINYINT(1) NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                KEY idx_channel (channel_id),
                KEY idx_created (created_at)
            )
        `);

        // Enrollment flag on existing tokes_channels (column may already exist on re-run)
        const [cols] = await db.execute(`
            SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tokes_channels'
              AND COLUMN_NAME = 'defender_enabled'
        `);
        if (cols.length === 0) {
            await db.execute(
                `ALTER TABLE tokes_channels ADD COLUMN defender_enabled TINYINT(1) NOT NULL DEFAULT 0`
            );
        }
        // MySQL DDL auto-commits per statement; no explicit transaction needed
        // (matches migration 110's style). `db` is the pool passed by run.js.
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS kbd_enforcement_log');
    await db.execute('DROP TABLE IF EXISTS kbd_managers');
    await db.execute('DROP TABLE IF EXISTS kbd_malicious_sites');
    await db.execute('DROP TABLE IF EXISTS kbd_unbanlist');
    await db.execute('DROP TABLE IF EXISTS kbd_banlist');
    // Intentionally leave defender_enabled column in place (dropping risks data loss on re-up).
}
```

- [ ] **Step 2: Run pending migrations**

Run: `node scripts/run-migrations.js`
Expected: log line `[Migrate] Applying 111_kbd_tables.js...` then `[Migrate] Applied 111_kbd_tables.js` and `[Migrate] All migrations applied`, process exits 0. (Already-applied earlier migrations are silently skipped.)

- [ ] **Step 3: Verify tables exist**

Run: `node -e "import('./utils/db.js').then(async m=>{const[r]=await m.default.execute(\"SHOW TABLES LIKE 'kbd_%'\");console.log(r);process.exit(0);})"`
Expected: 5 rows (`kbd_banlist`, `kbd_unbanlist`, `kbd_malicious_sites`, `kbd_managers`, `kbd_enforcement_log`).

- [ ] **Step 4: Commit**

```bash
git add migrations/111_kbd_tables.js
git commit -m "feat(kbd): add Kick Defender database tables + enrollment flag"
```

---

## Phase 2 — Pure logic units (no DB in tests)

### Task 2: `kick-moderation.js` — Kick API wrapper

**Files:**
- Create: `services/certifried-bot/defender/kick-moderation.js`
- Test: `tests/defender/kick-moderation.test.js`

- [ ] **Step 1: Write the failing test** (injects a fake `fetch`)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { banUser, unbanUser, deleteMessage } from '../../services/certifried-bot/defender/kick-moderation.js';

function fakeFetch(captured) {
    return async (url, opts) => {
        captured.url = url;
        captured.opts = opts;
        captured.body = opts.body ? JSON.parse(opts.body) : null;
        return { ok: true, status: 200, text: async () => '' };
    };
}

test('banUser posts to moderation/bans with broadcaster + user id', async () => {
    const cap = {};
    const res = await banUser('123', '456', { reason: 'spam' }, 'tok', fakeFetch(cap));
    assert.equal(res.ok, true);
    assert.equal(cap.url, 'https://api.kick.com/public/v1/moderation/bans');
    assert.equal(cap.opts.method, 'POST');
    assert.equal(cap.opts.headers.Authorization, 'Bearer tok');
    assert.equal(cap.body.broadcaster_user_id, 123);
    assert.equal(cap.body.user_id, 456);
    assert.equal(cap.body.reason, 'spam');
    assert.equal('duration' in cap.body, false); // permanent ban omits duration
});

test('banUser includes duration when given', async () => {
    const cap = {};
    await banUser('1', '2', { duration: 60 }, 'tok', fakeFetch(cap));
    assert.equal(cap.body.duration, 60);
});

test('unbanUser DELETEs moderation/bans', async () => {
    const cap = {};
    await unbanUser('123', '456', 'tok', fakeFetch(cap));
    assert.equal(cap.url, 'https://api.kick.com/public/v1/moderation/bans');
    assert.equal(cap.opts.method, 'DELETE');
    assert.equal(cap.body.broadcaster_user_id, 123);
    assert.equal(cap.body.user_id, 456);
});

test('deleteMessage DELETEs chat/{id}', async () => {
    const cap = {};
    await deleteMessage('msg-uuid', 'tok', fakeFetch(cap));
    assert.equal(cap.url, 'https://api.kick.com/public/v1/chat/msg-uuid');
    assert.equal(cap.opts.method, 'DELETE');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/defender/kick-moderation.test.js`
Expected: FAIL — `Cannot find module .../kick-moderation.js`.

- [ ] **Step 3: Write the implementation**

```js
/**
 * Thin wrapper over Kick's official moderation + chat-delete endpoints.
 * Pure I/O: the caller supplies a valid user access token. No DB coupling.
 * `fetchImpl` is injectable for testing; defaults to global fetch.
 */

const KICK_API_BASE = 'https://api.kick.com/public/v1';

export async function banUser(broadcasterId, userId, { duration, reason } = {}, token, fetchImpl = fetch) {
    const body = {
        broadcaster_user_id: parseInt(broadcasterId, 10),
        user_id: parseInt(userId, 10)
    };
    if (typeof duration === 'number') body.duration = duration; // minutes; omit => permanent
    if (reason) body.reason = String(reason).slice(0, 100);

    const response = await fetchImpl(`${KICK_API_BASE}/moderation/bans`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return { ok: response.ok, status: response.status, error: response.ok ? null : await response.text() };
}

export async function unbanUser(broadcasterId, userId, token, fetchImpl = fetch) {
    const response = await fetchImpl(`${KICK_API_BASE}/moderation/bans`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            broadcaster_user_id: parseInt(broadcasterId, 10),
            user_id: parseInt(userId, 10)
        })
    });
    return { ok: response.ok, status: response.status, error: response.ok ? null : await response.text() };
}

export async function deleteMessage(messageId, token, fetchImpl = fetch) {
    const response = await fetchImpl(`${KICK_API_BASE}/chat/${messageId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    return { ok: response.ok, status: response.status, error: response.ok ? null : await response.text() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/defender/kick-moderation.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add services/certifried-bot/defender/kick-moderation.js tests/defender/kick-moderation.test.js
git commit -m "feat(kbd): add Kick moderation API wrapper (ban/unban/delete)"
```

### Task 3: `enforcer.js` — decision core (dependency-injected)

**Files:**
- Create: `services/certifried-bot/defender/enforcer.js`
- Test: `tests/defender/enforcer.test.js`

The enforcer is the heart of the system. It takes all collaborators as injected dependencies so unit tests never touch the network or DB. `scopes` is a Set-like check.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnforcer } from '../../services/certifried-bot/defender/enforcer.js';

// Build an enforcer with controllable fakes.
function build(overrides = {}) {
    const calls = { bans: [], deletes: [], logs: [] };
    const deps = {
        isOnBanlist: async () => overrides.banlisted ?? false,
        isOnUnbanlist: async () => overrides.unbanlisted ?? false,
        resolveChannel: async () => overrides.channel ?? {
            broadcasterId: '999', token: 'tok', scopes: overrides.scopes ?? ['moderation:ban']
        },
        banUser: async (b, u, o, t) => { calls.bans.push({ b, u, o, t }); return { ok: true }; },
        deleteMessage: async (m, t) => { calls.deletes.push({ m, t }); return { ok: true }; },
        log: async (entry) => { calls.logs.push(entry); }
    };
    return { enforcer: createEnforcer(deps), calls };
}

const baseEvent = {
    platform: 'kick', channelId: 'chan1', userId: '456', username: 'baddie',
    messageId: 'msg1', isMod: false, isBroadcaster: false
};

test('no-ops for non-kick platforms', async () => {
    const { enforcer, calls } = build({ banlisted: true });
    const r = await enforcer.check({ ...baseEvent, platform: 'twitch' });
    assert.equal(r.acted, false);
    assert.equal(calls.bans.length, 0);
});

test('exempts broadcaster and mods', async () => {
    const { enforcer, calls } = build({ banlisted: true });
    assert.equal((await enforcer.check({ ...baseEvent, isBroadcaster: true })).acted, false);
    assert.equal((await enforcer.check({ ...baseEvent, isMod: true })).acted, false);
    assert.equal(calls.bans.length, 0);
});

test('exempts users on the unbanlist even if banlisted', async () => {
    const { enforcer, calls } = build({ banlisted: true, unbanlisted: true });
    assert.equal((await enforcer.check(baseEvent)).acted, false);
    assert.equal(calls.bans.length, 0);
});

test('passes through non-banlisted users', async () => {
    const { enforcer, calls } = build({ banlisted: false });
    assert.equal((await enforcer.check(baseEvent)).acted, false);
    assert.equal(calls.bans.length, 0);
    assert.equal(calls.logs.length, 0);
});

test('bans banlisted user when channel has moderation:ban', async () => {
    const { enforcer, calls } = build({ banlisted: true, scopes: ['moderation:ban'] });
    const r = await enforcer.check(baseEvent);
    assert.equal(r.acted, true);
    assert.equal(calls.bans.length, 1);
    assert.equal(calls.bans[0].b, '999');
    assert.equal(calls.bans[0].u, '456');
    assert.equal(calls.logs[0].action, 'ban');
    assert.equal(calls.logs[0].success, true);
});

test('falls back to delete when only manage scope present', async () => {
    const { enforcer, calls } = build({ banlisted: true, scopes: ['moderation:chat_message:manage'] });
    const r = await enforcer.check(baseEvent);
    assert.equal(r.acted, true);
    assert.equal(calls.bans.length, 0);
    assert.equal(calls.deletes.length, 1);
    assert.equal(calls.deletes[0].m, 'msg1');
    assert.equal(calls.logs[0].action, 'delete');
});

test('logs detected_no_scope when dormant (no usable scope)', async () => {
    const { enforcer, calls } = build({ banlisted: true, scopes: [] });
    const r = await enforcer.check(baseEvent);
    assert.equal(r.acted, false);
    assert.equal(calls.bans.length, 0);
    assert.equal(calls.deletes.length, 0);
    assert.equal(calls.logs[0].action, 'detected_no_scope');
});

test('no-ops when channel not enrolled / token missing', async () => {
    const { enforcer, calls } = build({ banlisted: true, channel: null });
    const r = await enforcer.check(baseEvent);
    assert.equal(r.acted, false);
    assert.equal(calls.logs.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/defender/enforcer.test.js`
Expected: FAIL — `Cannot find module .../enforcer.js`.

- [ ] **Step 3: Write the implementation**

```js
/**
 * Defender decision core. Pure logic + injected collaborators so it is
 * unit-testable without network or DB.
 *
 * deps:
 *   isOnBanlist(platform, userId, username) -> bool
 *   isOnUnbanlist(platform, userId, username) -> bool
 *   resolveChannel(channelId) -> { broadcasterId, token, scopes:string[] } | null
 *   banUser(broadcasterId, userId, {reason}, token) -> { ok }
 *   deleteMessage(messageId, token) -> { ok }
 *   log(entry) -> void
 */

const BAN_SCOPE = 'moderation:ban';
const MANAGE_SCOPE = 'moderation:chat_message:manage';

export function createEnforcer(deps) {
    async function check(event) {
        const { platform, channelId, userId, username, messageId, isMod, isBroadcaster } = event;

        if (platform !== 'kick') return { acted: false };
        if (isBroadcaster || isMod) return { acted: false };

        const banlisted = await deps.isOnBanlist(platform, userId, username);
        if (!banlisted) return { acted: false };

        if (await deps.isOnUnbanlist(platform, userId, username)) return { acted: false };

        const channel = await deps.resolveChannel(channelId);
        if (!channel || !channel.token) return { acted: false };

        const scopes = channel.scopes || [];
        const reason = 'KBD banlist';

        if (scopes.includes(BAN_SCOPE)) {
            const res = await deps.banUser(channel.broadcasterId, userId, { reason }, channel.token);
            await deps.log({ channelId, targetUserId: userId, targetUsername: username, action: 'ban', reason, success: !!res.ok });
            return { acted: !!res.ok };
        }

        if (scopes.includes(MANAGE_SCOPE) && messageId) {
            const res = await deps.deleteMessage(messageId, channel.token);
            await deps.log({ channelId, targetUserId: userId, targetUsername: username, action: 'delete', reason, success: !!res.ok });
            return { acted: !!res.ok };
        }

        // Dormant: detected a threat but lack any usable scope.
        await deps.log({ channelId, targetUserId: userId, targetUsername: username, action: 'detected_no_scope', reason, success: false });
        return { acted: false };
    }

    return { check };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/defender/enforcer.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add services/certifried-bot/defender/enforcer.js tests/defender/enforcer.test.js
git commit -m "feat(kbd): add enforcer decision core with injected deps"
```

---

## Phase 3 — Data-access units (integration tests; need DB)

> These tests require a working DB connection (same one the app uses). They are integration tests. If `CI` lacks a DB, mark them skipped via `test('...', { skip: !process.env.DB_AVAILABLE }, ...)`. Locally, the dev DB is available.

### Task 4: `banlist.js` — cached shared-list store

**Files:**
- Create: `services/certifried-bot/defender/banlist.js`
- Test: `tests/defender/banlist.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../../utils/db.js';
import {
    addBan, removeBan, isOnBanlist, addUnban, isOnUnbanlist,
    getCounts, invalidateCache, addSite, listSites
} from '../../services/certifried-bot/defender/banlist.js';

const TEST_UID = 'test-uid-0001';

after(async () => {
    await pool.execute('DELETE FROM kbd_banlist WHERE platform_user_id = ?', [TEST_UID]);
    await pool.execute('DELETE FROM kbd_unbanlist WHERE platform_user_id = ?', [TEST_UID]);
    await pool.execute("DELETE FROM kbd_malicious_sites WHERE uri = ?", ['http://evil.test/x']);
    await pool.end();
});

test('addBan then isOnBanlist by id', async () => {
    await addBan({ platform: 'kick', userId: TEST_UID, username: 'evil', reason: 'spam', listType: 'ban', addedBy: null });
    invalidateCache();
    assert.equal(await isOnBanlist('kick', TEST_UID, 'evil'), true);
});

test('isOnBanlist matches by username when id unknown', async () => {
    invalidateCache();
    assert.equal(await isOnBanlist('kick', null, 'evil'), true);
});

test('removeBan clears membership', async () => {
    await removeBan('kick', TEST_UID);
    invalidateCache();
    assert.equal(await isOnBanlist('kick', TEST_UID, 'evil'), false);
});

test('unbanlist add + check', async () => {
    await addUnban({ platform: 'kick', userId: TEST_UID, username: 'evil', addedBy: null });
    invalidateCache();
    assert.equal(await isOnUnbanlist('kick', TEST_UID, 'evil'), true);
});

test('getCounts returns numeric fields', async () => {
    const counts = await getCounts();
    assert.equal(typeof counts.banlist, 'number');
    assert.equal(typeof counts.sublist, 'number');
    assert.equal(typeof counts.unbanlist, 'number');
    assert.equal(typeof counts.sites, 'number');
});

test('site add + list', async () => {
    await addSite('http://evil.test/x', null);
    const sites = await listSites();
    assert.ok(sites.some(s => s.uri === 'http://evil.test/x'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/defender/banlist.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
/**
 * Shared-list store for the Kick Defender: banlist (+ sublist), unbanlist,
 * malicious sites. Network-global (not per-channel). Cached with a short TTL
 * because isOnBanlist runs on every chat message.
 */

import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

const CACHE_TTL_MS = 60_000;
let cache = null;        // { ban:Set, sub:Set, unban:Set, banNames:Set, unbanNames:Set, expiresAt }
let cachePromise = null;

function key(platform, id) { return `${platform}:${id}`; }
function nameKey(platform, name) { return `${platform}:${String(name).toLowerCase()}`; }

async function loadCache() {
    const [bans] = await pool.execute('SELECT platform, platform_user_id, username, list_type FROM kbd_banlist');
    const [unbans] = await pool.execute('SELECT platform, platform_user_id, username FROM kbd_unbanlist');

    const ban = new Set(), sub = new Set(), unban = new Set(), banNames = new Set(), unbanNames = new Set();
    for (const r of bans) {
        if (r.platform_user_id) (r.list_type === 'sublist' ? sub : ban).add(key(r.platform, r.platform_user_id));
        if (r.username) banNames.add(nameKey(r.platform, r.username));
    }
    for (const r of unbans) {
        if (r.platform_user_id) unban.add(key(r.platform, r.platform_user_id));
        if (r.username) unbanNames.add(nameKey(r.platform, r.username));
    }
    cache = { ban, sub, unban, banNames, unbanNames, expiresAt: Date.now() + CACHE_TTL_MS };
    return cache;
}

async function getCache() {
    if (cache && cache.expiresAt > Date.now()) return cache;
    if (!cachePromise) {
        cachePromise = loadCache().finally(() => { cachePromise = null; });
    }
    return cachePromise;
}

export function invalidateCache() { cache = null; }

export async function isOnBanlist(platform, userId, username) {
    const c = await getCache();
    if (userId && (c.ban.has(key(platform, userId)) || c.sub.has(key(platform, userId)))) return true;
    if (username && c.banNames.has(nameKey(platform, username))) return true;
    return false;
}

export async function isOnUnbanlist(platform, userId, username) {
    const c = await getCache();
    if (userId && c.unban.has(key(platform, userId))) return true;
    if (username && c.unbanNames.has(nameKey(platform, username))) return true;
    return false;
}

export async function addBan({ platform = 'kick', userId = null, username, reason = null, listType = 'ban', addedBy = null }) {
    await pool.execute(
        `INSERT INTO kbd_banlist (platform, platform_user_id, username, reason, list_type, added_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE username = VALUES(username), reason = VALUES(reason)`,
        [platform, userId, username, reason, listType, addedBy]
    );
    invalidateCache();
    logger.info('[KBD] Added ban', { platform, userId, username, listType });
}

export async function removeBan(platform, userId, username = null) {
    if (userId) {
        await pool.execute('DELETE FROM kbd_banlist WHERE platform = ? AND platform_user_id = ?', [platform, userId]);
    } else if (username) {
        await pool.execute('DELETE FROM kbd_banlist WHERE platform = ? AND username = ?', [platform, username]);
    }
    invalidateCache();
}

export async function clearSublist() {
    await pool.execute("DELETE FROM kbd_banlist WHERE list_type = 'sublist'");
    invalidateCache();
}

export async function addUnban({ platform = 'kick', userId = null, username, addedBy = null }) {
    await pool.execute(
        `INSERT INTO kbd_unbanlist (platform, platform_user_id, username, added_by)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE username = VALUES(username)`,
        [platform, userId, username, addedBy]
    );
    invalidateCache();
}

export async function removeUnban(platform, userId, username = null) {
    if (userId) {
        await pool.execute('DELETE FROM kbd_unbanlist WHERE platform = ? AND platform_user_id = ?', [platform, userId]);
    } else if (username) {
        await pool.execute('DELETE FROM kbd_unbanlist WHERE platform = ? AND username = ?', [platform, username]);
    }
    invalidateCache();
}

export async function addSite(uri, addedBy = null) {
    await pool.execute(
        'INSERT IGNORE INTO kbd_malicious_sites (uri, added_by) VALUES (?, ?)', [uri, addedBy]
    );
}

export async function removeSite(uri) {
    await pool.execute('DELETE FROM kbd_malicious_sites WHERE uri = ?', [uri]);
}

export async function listSites() {
    const [rows] = await pool.execute('SELECT id, uri FROM kbd_malicious_sites ORDER BY id');
    return rows;
}

export async function getCounts() {
    const [[ban]] = await pool.execute("SELECT COUNT(*) n FROM kbd_banlist WHERE list_type = 'ban'");
    const [[sub]] = await pool.execute("SELECT COUNT(*) n FROM kbd_banlist WHERE list_type = 'sublist'");
    const [[unban]] = await pool.execute('SELECT COUNT(*) n FROM kbd_unbanlist');
    const [[sites]] = await pool.execute('SELECT COUNT(*) n FROM kbd_malicious_sites');
    return { banlist: ban.n, sublist: sub.n, unbanlist: unban.n, sites: sites.n };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/defender/banlist.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add services/certifried-bot/defender/banlist.js tests/defender/banlist.test.js
git commit -m "feat(kbd): add cached shared-list store (banlist/sublist/unban/sites)"
```

### Task 5: `enforcement-log.js` + `managers.js`

**Files:**
- Create: `services/certifried-bot/defender/enforcement-log.js`
- Create: `services/certifried-bot/defender/managers.js`
- Test: `tests/defender/managers.test.js`

- [ ] **Step 1: Write `enforcement-log.js`** (no separate test; exercised via enforcer integration in Task 7)

```js
/**
 * Append-only audit log of defender actions; powers dashboard counts.
 */
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

export async function log({ channelId, targetUserId = null, targetUsername, action, reason = null, success = false }) {
    try {
        await pool.execute(
            `INSERT INTO kbd_enforcement_log (channel_id, target_user_id, target_username, action, reason, success)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [channelId, targetUserId, targetUsername, action, reason, success ? 1 : 0]
        );
    } catch (error) {
        logger.error('[KBD] Failed to write enforcement log', { error: error.message });
    }
}

export async function channelStats(channelId) {
    const [[banned]] = await pool.execute(
        "SELECT COUNT(*) n FROM kbd_enforcement_log WHERE channel_id = ? AND action = 'ban' AND success = 1", [channelId]
    );
    const [[deleted]] = await pool.execute(
        "SELECT COUNT(*) n FROM kbd_enforcement_log WHERE channel_id = ? AND action = 'delete' AND success = 1", [channelId]
    );
    const [[dormant]] = await pool.execute(
        "SELECT COUNT(*) n FROM kbd_enforcement_log WHERE channel_id = ? AND action = 'detected_no_scope'", [channelId]
    );
    return { banned: banned.n, deleted: deleted.n, dormant: dormant.n };
}
```

- [ ] **Step 2: Write the failing test for managers**

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../../utils/db.js';
import { addManager, removeManager, isManager, managerCount } from '../../services/certifried-bot/defender/managers.js';

const TEST_USER = 990001;

after(async () => {
    await pool.execute('DELETE FROM kbd_managers WHERE tokes_user_id = ?', [TEST_USER]);
    await pool.end();
});

test('addManager then isManager true', async () => {
    await addManager(TEST_USER, null);
    assert.equal(await isManager(TEST_USER), true);
});

test('managerCount is a number', async () => {
    assert.equal(typeof (await managerCount()), 'number');
});

test('removeManager then isManager false', async () => {
    await removeManager(TEST_USER);
    assert.equal(await isManager(TEST_USER), false);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/defender/managers.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `managers.js`**

```js
/**
 * Network-Manager roster for the Kick Defender (dedicated, independent of
 * tokes_users.role). Cached: isManager runs on each manager-gated command.
 */
import pool from '../../utils/db.js';

const CACHE_TTL_MS = 30_000;
let cache = null;

async function getSet() {
    if (cache && cache.expiresAt > Date.now()) return cache.set;
    const [rows] = await pool.execute('SELECT tokes_user_id FROM kbd_managers');
    const set = new Set(rows.map(r => Number(r.tokes_user_id)));
    cache = { set, expiresAt: Date.now() + CACHE_TTL_MS };
    return set;
}

export function invalidate() { cache = null; }

export async function isManager(tokesUserId) {
    if (tokesUserId == null) return false;
    return (await getSet()).has(Number(tokesUserId));
}

export async function addManager(tokesUserId, addedBy = null) {
    await pool.execute(
        'INSERT IGNORE INTO kbd_managers (tokes_user_id, added_by) VALUES (?, ?)',
        [tokesUserId, addedBy]
    );
    invalidate();
}

export async function removeManager(tokesUserId) {
    await pool.execute('DELETE FROM kbd_managers WHERE tokes_user_id = ?', [tokesUserId]);
    invalidate();
}

export async function managerCount() {
    const [[row]] = await pool.execute('SELECT COUNT(*) n FROM kbd_managers');
    return row.n;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/defender/managers.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add services/certifried-bot/defender/enforcement-log.js services/certifried-bot/defender/managers.js tests/defender/managers.test.js
git commit -m "feat(kbd): add enforcement log + manager roster"
```

### Task 6: `channel-tokens.js` — owner token + scope resolver

**Files:**
- Create: `services/certifried-bot/defender/channel-tokens.js`
- Test: `tests/defender/channel-tokens.test.js`

This mirrors `kick-client.getValidAccessToken` but also returns the channel's `broadcasterId` and parsed granted `scopes`, and only for defender-enrolled channels.

- [ ] **Step 1: Write the failing test** (inject a fake `pool` + fake decrypt + fake refresher)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeResolveChannel } from '../../services/certifried-bot/defender/channel-tokens.js';

function fakePool(row) {
    return { execute: async () => [row ? [row] : []] };
}

test('returns null when channel not enrolled', async () => {
    const resolve = makeResolveChannel({
        pool: fakePool(null), decryptToken: () => 'x', refresh: async () => null
    });
    assert.equal(await resolve('chanX'), null);
});

test('returns broadcasterId, token, parsed scopes for enrolled channel', async () => {
    const row = {
        broadcaster_id: '999', connection_id: 1,
        access_token: 'enc', refresh_token: 'encr',
        expires_at: new Date(Date.now() + 3600_000).toISOString().slice(0,19).replace('T',' '),
        scopes: 'user:read chat:write moderation:ban'
    };
    const resolve = makeResolveChannel({
        pool: fakePool(row), decryptToken: () => 'plain-token', refresh: async () => null
    });
    const r = await resolve('chan1');
    assert.equal(r.broadcasterId, '999');
    assert.equal(r.token, 'plain-token');
    assert.deepEqual(r.scopes, ['user:read', 'chat:write', 'moderation:ban']);
});

test('refreshes when expired', async () => {
    const row = {
        broadcaster_id: '999', connection_id: 1,
        access_token: 'enc', refresh_token: 'encr',
        expires_at: '2000-01-01 00:00:00', scopes: 'moderation:ban'
    };
    let refreshed = false;
    const resolve = makeResolveChannel({
        pool: fakePool(row), decryptToken: () => 'old',
        refresh: async () => { refreshed = true; return 'new-token'; }
    });
    const r = await resolve('chan1');
    assert.equal(refreshed, true);
    assert.equal(r.token, 'new-token');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/defender/channel-tokens.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
/**
 * Resolve a defender-enrolled channel's broadcaster id, a valid owner access
 * token (refreshing if expired), and the granted OAuth scopes.
 *
 * makeResolveChannel injects collaborators for testing; the default export
 * wires the real pool / token crypto / refresher.
 */
import realPool from '../../utils/db.js';
import { decryptToken as realDecrypt } from '../../utils/token-encryption.js';

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export function makeResolveChannel({ pool, decryptToken, refresh }) {
    return async function resolveChannel(channelId) {
        const [rows] = await pool.execute(`
            SELECT c.channel_id AS broadcaster_id,
                   pc.id AS connection_id, pc.access_token, pc.refresh_token,
                   pc.expires_at, pc.scopes
            FROM tokes_channels c
            JOIN tokes_platform_connections pc ON c.connection_id = pc.id
            WHERE c.channel_id = ? AND c.platform = 'kick' AND c.defender_enabled = 1
        `, [channelId]);

        const row = rows[0];
        if (!row || !row.access_token) return null;

        const scopes = (row.scopes ? String(row.scopes).split(/\s+/) : []).filter(Boolean);
        const isExpired = row.expires_at && new Date(row.expires_at) < new Date(Date.now() + EXPIRY_BUFFER_MS);

        let token = null;
        if (isExpired && row.refresh_token) {
            token = await refresh(row.connection_id, row.refresh_token);
        }
        if (!token) token = decryptToken(row.access_token);
        if (!token) return null;

        return { broadcasterId: String(row.broadcaster_id), token, scopes };
    };
}

// Default wiring. `refresh` is bound lazily to the running KickBot instance to
// reuse its refreshAccessToken; falls back to no-refresh if unavailable.
export const resolveChannel = makeResolveChannel({
    pool: realPool,
    decryptToken: realDecrypt,
    refresh: async (connectionId, encryptedRefreshToken) => {
        const bot = global.kickBot; // set in kick-client/start
        if (bot && typeof bot.refreshAccessToken === 'function') {
            return bot.refreshAccessToken(connectionId, encryptedRefreshToken);
        }
        return null;
    }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/defender/channel-tokens.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify `global.kickBot` is set** — inspect `services/certifried-bot/start.js` / `kick-client.js` for where the KickBot instance is created. If it is not assigned to `global.kickBot`, add `global.kickBot = this;` in the `KickBot` constructor (`kick-client.js`, after `this.channels = new Map();`).

- [ ] **Step 6: Commit**

```bash
git add services/certifried-bot/defender/channel-tokens.js tests/defender/channel-tokens.test.js services/certifried-bot/kick-client.js
git commit -m "feat(kbd): add channel owner-token + scope resolver"
```

---

## Phase 4 — Wire the enforcer into the chat pipeline

### Task 7: Compose the live enforcer + integration hook

**Files:**
- Create: `services/certifried-bot/defender/index.js` (composition root)
- Modify: `services/certifried-bot/kick-client.js` (~line 330, pass `messageId`)
- Modify: `services/certifried-bot/command-handler.js` (top of `handleMessage`, ~line 150-167)
- Test: `tests/defender/integration-hook.test.js`

- [ ] **Step 1: Write the composition root**

```js
// services/certifried-bot/defender/index.js
/**
 * Wires the real collaborators into the enforcer. Import { enforcer } and call
 * enforcer.check(event) from the chat pipeline.
 */
import { createEnforcer } from './enforcer.js';
import { isOnBanlist, isOnUnbanlist } from './banlist.js';
import { resolveChannel } from './channel-tokens.js';
import { banUser, deleteMessage } from './kick-moderation.js';
import { log } from './enforcement-log.js';

export const enforcer = createEnforcer({
    isOnBanlist,
    isOnUnbanlist,
    resolveChannel,
    banUser: (broadcasterId, userId, opts, token) => banUser(broadcasterId, userId, opts, token),
    deleteMessage: (messageId, token) => deleteMessage(messageId, token),
    log
});
```

- [ ] **Step 2: Write the failing integration test** (verifies the hook stops processing for a banlisted user; uses a seeded banlist + non-enrolled channel so no network call happens — enforcer no-ops on `resolveChannel === null` but still must be CALLED).

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../../utils/db.js';
import { addBan, removeBan, invalidateCache } from '../../services/certifried-bot/defender/banlist.js';
import { enforcer } from '../../services/certifried-bot/defender/index.js';

const UID = 'hook-test-uid';

after(async () => {
    await pool.execute('DELETE FROM kbd_banlist WHERE platform_user_id = ?', [UID]);
    await pool.end();
});

test('enforcer.check returns acted=false for non-enrolled channel even if banlisted', async () => {
    await addBan({ platform: 'kick', userId: UID, username: 'hooktest' });
    invalidateCache();
    const r = await enforcer.check({
        platform: 'kick', channelId: 'definitely-not-enrolled-xyz',
        userId: UID, username: 'hooktest', messageId: 'm', isMod: false, isBroadcaster: false
    });
    assert.equal(r.acted, false); // no token/enrollment -> safe no-op
});

test('enforcer.check returns acted=false for clean user', async () => {
    invalidateCache();
    const r = await enforcer.check({
        platform: 'kick', channelId: 'whatever',
        userId: 'clean-user', username: 'cleanguy', messageId: 'm', isMod: false, isBroadcaster: false
    });
    assert.equal(r.acted, false);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/defender/integration-hook.test.js`
Expected: FAIL — `index.js` not found (until Step 1 saved) then PASS once saved; if it already passes after Step 1, that is acceptable for this composition-only task.

- [ ] **Step 4: Thread `messageId` through the chat event** — in `services/certifried-bot/kick-client.js`, the `handleMessage({...})` call (~line 326-336) currently omits the message id. Add it:

```js
            await handleMessage({
                platform: 'kick',
                channelId: channelInfo.channelId,
                channelName: channelInfo.name,
                userId: data.sender?.id?.toString(),
                username: data.sender?.username || data.sender?.slug,
                message: data.content,
                messageId: data.id,                       // <-- ADD: chat message UUID for delete fallback
                isBroadcaster: data.sender?.id === channelInfo.broadcasterId,
                isMod: data.sender?.is_moderator || data.sender?.is_staff,
                reply: (text) => this.sendMessage(chatroomId, text)
            });
```

(Confirm the exact field name `data.id` against a logged ChatMessageEvent payload; if the id lives at `data.message_id`, use that. The existing `automod`/Kick code reads `data.content` and `data.sender`, so `data.id` is the message id.)

- [ ] **Step 5: Insert the enforcer hook** — in `services/certifried-bot/command-handler.js`, add the import at the top and call the enforcer at the very start of `handleMessage`, BEFORE `getChannelConfig` (so defender-only channels are covered even if they have no games config). The function destructures `context` at ~line 150-161; add `messageId` to the destructure and insert the hook right after it:

```js
// near other imports at top of command-handler.js:
import { enforcer } from './defender/index.js';
```

```js
export async function handleMessage(context) {
    const {
        platform,
        channelId,
        channelName,
        userId,
        username,
        message,
        messageId,          // <-- ADD
        isBroadcaster,
        isMod,
        reply
    } = context;

    // Kick Defender: ban-on-event. Runs before everything else so banlisted
    // users are handled even in channels with no games config. Safe no-op for
    // non-kick platforms and non-enrolled channels.
    try {
        const result = await enforcer.check({ platform, channelId, userId, username, messageId, isMod, isBroadcaster });
        if (result.acted) return; // user was banned/message deleted; stop processing
    } catch (err) {
        // Never let defender errors break normal chat handling.
        // (logger is already imported in this file)
        logger.error('[KBD] enforcer.check failed', { error: err.message });
    }

    // Get channel config
    const channel = await getChannelConfig(platform, channelId);
    if (!channel) {
        return; // Channel not registered or disabled
    }
    // ... rest unchanged
```

- [ ] **Step 6: Run the full defender test suite**

Run: `node --test tests/defender/*.test.js`
Expected: all PASS.

- [ ] **Step 7: Smoke-check the bot still boots** (syntax/import wiring)

Run: `node --check services/certifried-bot/command-handler.js && node --check services/certifried-bot/kick-client.js && node --check services/certifried-bot/defender/index.js`
Expected: no output, exit 0.

- [ ] **Step 8: Commit**

```bash
git add services/certifried-bot/defender/index.js services/certifried-bot/kick-client.js services/certifried-bot/command-handler.js tests/defender/integration-hook.test.js
git commit -m "feat(kbd): wire enforcer into Kick chat pipeline (ban-on-event)"
```

---

## Phase 5 — OAuth scopes

### Task 8: Add moderation scopes to the Kick OAuth flow

**Files:**
- Modify: `dashboard/routes/auth-tokes-bot.js:24`

- [ ] **Step 1: Update `KICK_SCOPES`**

```js
// dashboard/routes/auth-tokes-bot.js, line 24
const KICK_SCOPES = ['user:read', 'chat:write', 'events:subscribe', 'channel:read', 'moderation:ban', 'moderation:chat_message:manage'].join(' ');
```

- [ ] **Step 2: Add a scope-check helper used by the dashboard banner** — at the bottom of `auth-tokes-bot.js`, export:

```js
export function hasModerationScopes(scopesStr) {
    const s = scopesStr ? String(scopesStr).split(/\s+/) : [];
    return s.includes('moderation:ban') || s.includes('moderation:chat_message:manage');
}
```

- [ ] **Step 3: Syntax check**

Run: `node --check dashboard/routes/auth-tokes-bot.js`
Expected: exit 0.

- [ ] **Step 4: Manual verification note** — after deploy, a streamer who re-runs the Kick connect flow should see Kick's consent screen list the two new moderation permissions, and `tokes_platform_connections.scopes` should contain them. (Verify in Phase 8.)

- [ ] **Step 5: Commit**

```bash
git add dashboard/routes/auth-tokes-bot.js
git commit -m "feat(kbd): request moderation scopes in Kick OAuth flow"
```

---

## Phase 6 — Chat commands

### Task 9: Defender command permission tiers + in-memory dispatch

**Files:**
- Modify: `services/certifried-bot/command-handler.js` (dispatch defender commands + `manager`/`admin`/`broadcaster` tier checks)
- Create: `services/certifried-bot/defender/commands/index.js`
- Create: `services/certifried-bot/defender/commands/banlist-commands.js`
- Create: `services/certifried-bot/defender/commands/info-commands.js`
- Test: `tests/defender/commands.test.js`

> Permission model: defender commands carry a `minRole` of `everyone` | `broadcaster` | `manager` | `admin`. Resolution: `admin` = `isSuperAdmin(resolveTokesUserId(platform,userId))`; `manager` = `isManager(tokesUserId)` OR admin; `broadcaster` = `isBroadcaster` OR manager OR admin. The tokes user id is resolved from `tokes_platform_connections` by `(platform, platform_id=userId)`.

- [ ] **Step 1: Write the failing test for permission resolution**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetsMinRole } from '../../services/certifried-bot/defender/commands/index.js';

test('everyone passes for any user', () => {
    assert.equal(meetsMinRole('everyone', { isBroadcaster: false, isManager: false, isAdmin: false }), true);
});
test('broadcaster requires broadcaster/manager/admin', () => {
    assert.equal(meetsMinRole('broadcaster', { isBroadcaster: true, isManager: false, isAdmin: false }), true);
    assert.equal(meetsMinRole('broadcaster', { isBroadcaster: false, isManager: true, isAdmin: false }), true);
    assert.equal(meetsMinRole('broadcaster', { isBroadcaster: false, isManager: false, isAdmin: false }), false);
});
test('manager requires manager/admin', () => {
    assert.equal(meetsMinRole('manager', { isBroadcaster: true, isManager: false, isAdmin: false }), false);
    assert.equal(meetsMinRole('manager', { isBroadcaster: false, isManager: true, isAdmin: false }), true);
    assert.equal(meetsMinRole('manager', { isBroadcaster: false, isManager: false, isAdmin: true }), true);
});
test('admin requires admin', () => {
    assert.equal(meetsMinRole('admin', { isBroadcaster: false, isManager: true, isAdmin: false }), false);
    assert.equal(meetsMinRole('admin', { isBroadcaster: false, isManager: false, isAdmin: true }), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/defender/commands.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `commands/index.js`** (permission helper + registration map + tokes-user resolver)

```js
/**
 * Defender chat-command registration + permission tiers.
 */
import pool from '../../../utils/db.js';
import { isSuperAdmin } from '../../../utils/constants.js';
import { isManager } from '../managers.js';
import * as banlistCmds from './banlist-commands.js';
import * as infoCmds from './info-commands.js';

export function meetsMinRole(minRole, { isBroadcaster, isManager: mgr, isAdmin }) {
    switch (minRole) {
        case 'admin': return !!isAdmin;
        case 'manager': return !!isAdmin || !!mgr;
        case 'broadcaster': return !!isAdmin || !!mgr || !!isBroadcaster;
        case 'everyone':
        default: return true;
    }
}

export async function resolveTokesUserId(platform, platformUserId) {
    if (!platformUserId) return null;
    const [rows] = await pool.execute(
        'SELECT user_id FROM tokes_platform_connections WHERE platform = ? AND platform_id = ?',
        [platform, platformUserId]
    );
    return rows[0]?.user_id ?? null;
}

export async function resolvePermissionContext(ctx) {
    const tokesUserId = await resolveTokesUserId(ctx.platform, ctx.userId);
    const isAdmin = tokesUserId != null && isSuperAdmin(tokesUserId);
    const mgr = await isManager(tokesUserId);
    return { isBroadcaster: !!ctx.isBroadcaster, isManager: mgr, isAdmin, tokesUserId };
}

// command key -> { handler, minRole, aliases }
export const defenderCommands = {
    'add-ban':   { handler: banlistCmds.addBanCmd,    minRole: 'manager', aliases: ['add-bans'] },
    'remove-ban':{ handler: banlistCmds.removeBanCmd, minRole: 'manager', aliases: ['remove-bans'] },
    'add-sublist':{ handler: banlistCmds.addSublistCmd, minRole: 'manager', aliases: ['add-sublists'] },
    'clear-sublist':{ handler: banlistCmds.clearSublistCmd, minRole: 'manager', aliases: [] },
    'add-unban': { handler: banlistCmds.addUnbanCmd,  minRole: 'manager', aliases: ['add-unbans'] },
    'remove-unban':{ handler: banlistCmds.removeUnbanCmd, minRole: 'manager', aliases: ['remove-unbans'] },
    'check-ban': { handler: banlistCmds.checkBanCmd,  minRole: 'everyone', aliases: [] },
    'get-ban-count': { handler: banlistCmds.countsCmd, minRole: 'manager', aliases: ['get-sublist-count','get-unban-count','get-unbans-count'] },
    'ping':      { handler: infoCmds.pingCmd,         minRole: 'everyone', aliases: ['kumabot','kbd'] },
    'kbd-info':  { handler: infoCmds.infoCmd,         minRole: 'everyone', aliases: ['kbd-help'] },
    'join':      { handler: infoCmds.joinCmd,         minRole: 'everyone', aliases: [] },
    'mod-check': { handler: infoCmds.modCheckCmd,     minRole: 'manager', aliases: ['mod-checks'] }
};
```

- [ ] **Step 4: Write `commands/banlist-commands.js`**

```js
/**
 * Manager-facing banlist commands. Each handler receives the standard ctx
 * { platform, channelId, username, userId, args, reply, permCtx }.
 */
import * as banlist from '../banlist.js';
import { getCounts } from '../banlist.js';

export async function addBanCmd(ctx) {
    const [target, ...reasonParts] = ctx.args;
    if (!target) return ctx.reply('Usage: !add-ban <username> [reason]');
    await banlist.addBan({ platform: ctx.platform, username: target, reason: reasonParts.join(' ') || null, addedBy: ctx.permCtx?.tokesUserId ?? null });
    ctx.reply(`Added ${target} to the banlist.`);
}

export async function removeBanCmd(ctx) {
    const [target] = ctx.args;
    if (!target) return ctx.reply('Usage: !remove-ban <username>');
    await banlist.removeBan(ctx.platform, null, target);
    ctx.reply(`Removed ${target} from the banlist.`);
}

export async function addSublistCmd(ctx) {
    const [target, ...reasonParts] = ctx.args;
    if (!target) return ctx.reply('Usage: !add-sublist <username> [reason]');
    await banlist.addBan({ platform: ctx.platform, username: target, reason: reasonParts.join(' ') || 'Bot', listType: 'sublist', addedBy: ctx.permCtx?.tokesUserId ?? null });
    ctx.reply(`Added ${target} to the sublist.`);
}

export async function clearSublistCmd(ctx) {
    await banlist.clearSublist();
    ctx.reply('Sublist cleared.');
}

export async function addUnbanCmd(ctx) {
    const [target] = ctx.args;
    if (!target) return ctx.reply('Usage: !add-unban <username>');
    await banlist.addUnban({ platform: ctx.platform, username: target, addedBy: ctx.permCtx?.tokesUserId ?? null });
    ctx.reply(`Added ${target} to the unban (protection) list.`);
}

export async function removeUnbanCmd(ctx) {
    const [target] = ctx.args;
    if (!target) return ctx.reply('Usage: !remove-unban <username>');
    await banlist.removeUnban(ctx.platform, null, target);
    ctx.reply(`Removed ${target} from the unban list.`);
}

export async function checkBanCmd(ctx) {
    const [target] = ctx.args;
    if (!target) return ctx.reply('Usage: !check-ban <username>');
    const onList = await banlist.isOnBanlist(ctx.platform, null, target);
    ctx.reply(onList ? `${target} IS on the KBD banlist.` : `${target} is not on the KBD banlist.`);
}

export async function countsCmd(ctx) {
    const c = await getCounts();
    ctx.reply(`Banlist: ${c.banlist} · Sublist: ${c.sublist} · Unban: ${c.unbanlist} · Sites: ${c.sites}`);
}
```

- [ ] **Step 5: Write `commands/info-commands.js`**

```js
import { managerCount } from '../managers.js';
import { resolveChannel } from '../channel-tokens.js';

export async function pingCmd(ctx) { ctx.reply('KBD is responding! 🐻'); }

export async function infoCmd(ctx) {
    ctx.reply('KumaBot Defender (Kick) — a shared-banlist defense network. Manage at https://certifriedmultitool.com/kick');
}

export async function joinCmd(ctx) {
    ctx.reply('Enroll your channel in the defender at https://certifriedmultitool.com/kick (log in with Kick and enable the defender).');
}

export async function modCheckCmd(ctx) {
    // "mod-check" on Kick == has the channel owner re-authorized with moderation scopes?
    const ch = await resolveChannel(ctx.channelId);
    if (!ch) return ctx.reply('This channel is not enrolled / no valid token.');
    const ok = (ch.scopes || []).includes('moderation:ban');
    ctx.reply(ok ? 'This channel is re-authorized for bans. ✅' : 'This channel is enrolled but NOT re-authorized for bans — re-authorize at /kick.');
}
```

- [ ] **Step 6: Dispatch defender commands via their own in-memory path in `command-handler.js`**

> IMPORTANT: the existing `getCommand()` only returns commands that have a ROW in `tokes_global_command_config` (it maps `row.command_key` → `commandHandlers[key]`). We deliberately do NOT route defender commands through that DB-backed path — that would require seeding config rows and a per-channel enable. Instead, defender commands are a self-contained in-memory map (`defenderCommands` from Task 9 Step 3) dispatched directly in `handleMessage`, right after the channel/prefix parse and BEFORE the `getCommand()` lookup. No changes to `command-registry.js` are needed.

Add a resolver for defender command keys + aliases to `commands/index.js` (append):

```js
// Resolve a typed command name (or alias) to a defender command def, or null.
const aliasToKey = (() => {
    const map = {};
    for (const [key, def] of Object.entries(defenderCommands)) {
        map[key] = key;
        for (const alias of def.aliases) map[alias] = key;
    }
    return map;
})();

export function resolveDefenderCommand(name) {
    const key = aliasToKey[name?.toLowerCase()];
    return key ? { key, ...defenderCommands[key] } : null;
}
```

In `services/certifried-bot/command-handler.js`, add the import at the top:

```js
import { resolveDefenderCommand, meetsMinRole, resolvePermissionContext } from './defender/commands/index.js';
```

Then, inside `handleMessage`, AFTER `commandName`/`args` are parsed (current `command-handler.js:179-180`) and BEFORE the `getCommand(channel.id, ...)` lookup (current line 183), insert the defender dispatch:

```js
    // Defender commands: self-contained, dispatched before the DB-backed registry.
    const defCmd = resolveDefenderCommand(commandName);
    if (defCmd) {
        const permCtx = await resolvePermissionContext({ platform, userId, isBroadcaster });
        if (!meetsMinRole(defCmd.minRole, permCtx)) {
            return; // silently ignore unauthorized defender command
        }
        const defCtx = { platform, channelId, channelName, userId, username, args, message, reply, isBroadcaster, isMod, permCtx };
        try {
            await defCmd.handler(defCtx);
        } catch (err) {
            logger.error('[KBD] defender command failed', { command: commandName, error: err.message });
        }
        return; // handled; do not fall through to games/custom commands
    }
```

(Note: the defender `ctx` uses `reply` directly — the banlist/info command handlers in Steps 4-5 only use `ctx.reply`, `ctx.args`, `ctx.platform`, `ctx.channelId`, and `ctx.permCtx`. No `profile`/`channelStats` needed.)

- [ ] **Step 7: Run command tests**

Run: `node --test tests/defender/commands.test.js`
Expected: PASS (4 tests).

- [ ] **Step 8: Syntax check the modified files**

Run: `node --check services/certifried-bot/command-registry.js && node --check services/certifried-bot/command-handler.js && node --check services/certifried-bot/defender/commands/index.js`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add services/certifried-bot/defender/commands tests/defender/commands.test.js services/certifried-bot/command-registry.js services/certifried-bot/command-handler.js
git commit -m "feat(kbd): add defender chat commands with permission tiers"
```

---

## Phase 7 — Dashboard

### Task 10: Root `/` Discord-vs-Kick chooser

**Files:**
- Create: `dashboard/views/landing-chooser.ejs`
- Modify: `dashboard/server.js:577` (the `app.get('/')` handler)

- [ ] **Step 1: Create the chooser view** — `dashboard/views/landing-chooser.ejs`. Follow the existing view conventions (the project uses an EJS `include` helper and Tailwind; mirror the structure of `views/landing-tailwind.ejs` for header/footer includes). Minimal body:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CertiFried Utility — Choose your bot</title>
  <link rel="stylesheet" href="/css/tailwind.css" />
</head>
<body class="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center p-6">
  <div class="grid md:grid-cols-2 gap-6 max-w-4xl w-full">
    <a href="<%= discordHref %>" class="rounded-2xl border border-indigo-500/40 bg-indigo-500/5 p-8 hover:bg-indigo-500/10 transition">
      <h2 class="text-2xl font-bold mb-2">Discord Bot</h2>
      <p class="text-gray-400 mb-4">Server management, games, utilities, and more.</p>
      <span class="inline-block rounded-lg bg-indigo-600 px-4 py-2 font-semibold">
        <%= discordLoggedIn ? 'Continue to dashboard' : 'Log in with Discord' %>
      </span>
    </a>
    <a href="<%= kickHref %>" class="rounded-2xl border border-green-500/40 bg-green-500/5 p-8 hover:bg-green-500/10 transition">
      <h2 class="text-2xl font-bold mb-2">Kick Bot</h2>
      <p class="text-gray-400 mb-4">KumaBot-Defender-style shared-banlist protection for your Kick channel.</p>
      <span class="inline-block rounded-lg bg-green-600 px-4 py-2 font-semibold">
        <%= kickLoggedIn ? 'Continue to /kick' : 'Log in with Kick' %>
      </span>
    </a>
  </div>
</body>
</html>
```

(If `/css/tailwind.css` is not the project's compiled CSS path, match whatever `landing-tailwind.ejs` links.)

- [ ] **Step 2: Update the `/` handler** in `dashboard/server.js` (~line 577) to render the chooser:

```js
    app.get('/', async (req, res) => {
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        const discordLoggedIn = req.isAuthenticated && req.isAuthenticated();
        const kickLoggedIn = !!req.session?.tokesUser;
        res.render('landing-chooser', {
            discordLoggedIn,
            kickLoggedIn,
            discordHref: discordLoggedIn ? '/dashboard' : '/auth/discord',
            kickHref: kickLoggedIn ? '/kick' : '/tokes-bot/auth/kick'
        });
    });
```

(The old `landing-tailwind` render is preserved behind the Discord card / can remain reachable at `/dashboard`. Confirm `/tokes-bot/auth/kick` is the existing Kick login start route — it is, per `auth-tokes-bot.js`.)

- [ ] **Step 3: Smoke test the route** — start the dashboard (or syntax check) and curl `/`:

Run: `node --check dashboard/server.js`
Expected: exit 0. (Full render verified in Phase 8 manual checks.)

- [ ] **Step 4: Commit**

```bash
git add dashboard/views/landing-chooser.ejs dashboard/server.js
git commit -m "feat(kbd): root chooser between Discord bot and Kick bot"
```

### Task 11: `/kick` router — streamer panel, manager console, admin, enroll API

**Files:**
- Create: `dashboard/routes/kick-defender.js`
- Create: `dashboard/views/kick/panel.ejs`, `dashboard/views/kick/managers.ejs`
- Modify: `dashboard/server.js` (import + mount the router near the other tokes routers, ~line 9125)

- [ ] **Step 1: Write the router**

```js
// dashboard/routes/kick-defender.js
import express from 'express';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { requireTokesAuth } from './auth-tokes-bot.js';
import { isSuperAdmin } from '../../utils/constants.js';
import * as banlist from '../../services/certifried-bot/defender/banlist.js';
import * as managers from '../../services/certifried-bot/defender/managers.js';
import { channelStats } from '../../services/certifried-bot/defender/enforcement-log.js';

const router = express.Router();

async function isManagerUser(req) {
    const id = req.session?.tokesUser?.id;
    if (!id) return false;
    return isSuperAdmin(id) || await managers.isManager(id);
}

// Streamer panel: enrollment + re-auth banner + own stats
router.get('/kick', requireTokesAuth, async (req, res) => {
    const userId = req.session.tokesUser.id;
    const [channels] = await pool.execute(
        `SELECT c.channel_id, c.channel_name, c.defender_enabled, pc.scopes
         FROM tokes_channels c
         JOIN tokes_platform_connections pc ON c.connection_id = pc.id
         WHERE c.platform = 'kick' AND c.owner_id = ?`,
        [userId]
    );
    const enriched = [];
    for (const ch of channels) {
        const scopes = ch.scopes ? String(ch.scopes).split(/\s+/) : [];
        enriched.push({
            ...ch,
            hasBanScope: scopes.includes('moderation:ban'),
            hasManageScope: scopes.includes('moderation:chat_message:manage'),
            stats: await channelStats(ch.channel_id)
        });
    }
    res.render('kick/panel', {
        user: req.session.tokesUser,
        channels: enriched,
        isManager: await isManagerUser(req),
        reauthHref: '/tokes-bot/auth/kick'
    });
});

// Toggle enrollment for a channel the user owns
router.post('/kick/api/enroll', requireTokesAuth, async (req, res) => {
    const userId = req.session.tokesUser.id;
    const { channelId, enabled } = req.body;
    const [[owned]] = await pool.execute(
        "SELECT 1 AS ok FROM tokes_channels WHERE platform='kick' AND channel_id=? AND owner_id=?",
        [channelId, userId]
    );
    if (!owned) return res.status(403).json({ error: 'Not your channel' });
    await pool.execute(
        "UPDATE tokes_channels SET defender_enabled=? WHERE platform='kick' AND channel_id=?",
        [enabled ? 1 : 0, channelId]
    );
    res.json({ success: true });
});

// Manager console
router.get('/kick/managers', requireTokesAuth, async (req, res) => {
    if (!await isManagerUser(req)) return res.status(403).render('error-tailwind', { user: req.session.tokesUser, error: 'Managers only.' });
    res.render('kick/managers', {
        user: req.session.tokesUser,
        counts: await banlist.getCounts(),
        sites: await banlist.listSites(),
        isAdmin: isSuperAdmin(req.session.tokesUser.id)
    });
});

// Manager banlist API (add/remove)
router.post('/kick/api/ban', requireTokesAuth, async (req, res) => {
    if (!await isManagerUser(req)) return res.status(403).json({ error: 'Managers only' });
    const { username, reason, listType } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    await banlist.addBan({ platform: 'kick', username, reason: reason || null, listType: listType === 'sublist' ? 'sublist' : 'ban', addedBy: req.session.tokesUser.id });
    res.json({ success: true });
});

router.delete('/kick/api/ban', requireTokesAuth, async (req, res) => {
    if (!await isManagerUser(req)) return res.status(403).json({ error: 'Managers only' });
    const { username } = req.body;
    await banlist.removeBan('kick', null, username);
    res.json({ success: true });
});

// Admin: manage managers
router.post('/kick/api/managers', requireTokesAuth, async (req, res) => {
    if (!isSuperAdmin(req.session.tokesUser.id)) return res.status(403).json({ error: 'Admins only' });
    const { tokesUserId, action } = req.body;
    if (action === 'add') await managers.addManager(tokesUserId, req.session.tokesUser.id);
    else if (action === 'remove') await managers.removeManager(tokesUserId);
    res.json({ success: true });
});

export default router;
```

- [ ] **Step 2: Create the views** — `dashboard/views/kick/panel.ejs` (lists owned channels, enroll toggle, re-auth banner when `!hasBanScope`, shows `stats.banned/deleted/dormant`) and `dashboard/views/kick/managers.ejs` (counts, add/remove ban form, sites list, and — when `isAdmin` — manager management). Mirror the markup/style of an existing tokes view (e.g. `views/tokes-bot/commands.ejs`) for header/footer includes and Tailwind classes. Each form posts to the JSON APIs above with the CSRF token (the app injects `res.locals` csrf — match how `tokes-bot/*.ejs` includes it).

panel.ejs key fragment:

```html
<% channels.forEach(ch => { %>
  <div class="rounded-xl border border-gray-700 p-4 mb-3">
    <div class="flex justify-between items-center">
      <span class="font-semibold"><%= ch.channel_name %></span>
      <button data-channel="<%= ch.channel_id %>" data-enabled="<%= ch.defender_enabled ? 0 : 1 %>"
              class="enroll-toggle rounded bg-green-600 px-3 py-1">
        <%= ch.defender_enabled ? 'Disable defender' : 'Enable defender' %>
      </button>
    </div>
    <% if (ch.defender_enabled && !ch.hasBanScope) { %>
      <p class="mt-2 text-amber-400">⚠ Re-authorize to enable bans —
        <a class="underline" href="<%= reauthHref %>">re-connect Kick</a>.
        Detected-but-couldn't-act: <%= ch.stats.dormant %></p>
    <% } %>
    <p class="mt-2 text-sm text-gray-400">Banned: <%= ch.stats.banned %> · Deleted: <%= ch.stats.deleted %></p>
  </div>
<% }) %>
<script>
document.querySelectorAll('.enroll-toggle').forEach(b => b.addEventListener('click', async () => {
  await fetch('/kick/api/enroll', { method:'POST', headers:{'Content-Type':'application/json','CSRF-Token':window.csrfToken}, body: JSON.stringify({ channelId: b.dataset.channel, enabled: Number(b.dataset.enabled) }) });
  location.reload();
}));
</script>
```

(Confirm the CSRF header name the app expects — check an existing `tokes-bot` AJAX form; the project uses `csrfToken` middleware at `server.js:258`.)

- [ ] **Step 3: Mount the router** in `dashboard/server.js` — add the import near the other route imports (top of file with the others) and mount it next to `authTokesBotRouter`/`tokesBotRouter` (~line 9125):

```js
// with imports:
import kickDefenderRouter from './routes/kick-defender.js';
// with the other app.use('/', ...Router) mounts (~9125):
app.use('/', kickDefenderRouter);
```

- [ ] **Step 4: Syntax check**

Run: `node --check dashboard/routes/kick-defender.js && node --check dashboard/server.js`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add dashboard/routes/kick-defender.js dashboard/views/kick dashboard/server.js
git commit -m "feat(kbd): add /kick dashboard (panel, manager console, enroll API)"
```

---

## Phase 8 — End-to-end verification

### Task 12: Manual E2E + full suite

- [ ] **Step 1: Run the full defender test suite**

Run: `node --test tests/defender/*.test.js`
Expected: all PASS.

- [ ] **Step 2: Boot the dashboard locally** and verify:
  - `GET /` shows the two-card chooser (logged out: both say "Log in"; logged into Kick: Kick card says "Continue to /kick").
  - `GET /kick` after Kick login shows owned channels + enroll toggle.
  - Toggling enroll flips `tokes_channels.defender_enabled` (verify in DB).

- [ ] **Step 3: Re-authorize a test Kick channel** through `/tokes-bot/auth/kick`; confirm Kick's consent screen lists the two moderation permissions and `tokes_platform_connections.scopes` now contains `moderation:ban`.

- [ ] **Step 4: Live ban test** — with a test channel enrolled + re-authorized: add a throwaway account to the banlist (`!add-ban <user>` as a Manager, or via the dashboard), have that account post in the enrolled channel, and confirm it gets banned and a `kbd_enforcement_log` row with `action='ban', success=1` is written.

- [ ] **Step 5: Dormant fallback test** — enroll a channel that granted ONLY `moderation:chat_message:manage` (or temporarily simulate by removing `moderation:ban` from its stored scopes), post as a banlisted user, confirm the message is deleted and logged `action='delete'`.

- [ ] **Step 6: Final commit / branch wrap-up**

```bash
git add -A
git commit -m "test(kbd): end-to-end verification notes" || echo "nothing to commit"
```

Then use the `superpowers:finishing-a-development-branch` skill to decide merge/PR.

---

## Self-Review notes (coverage vs spec)

- Spec §2 constraints → Task 2 (ban/unban/delete only; no scan/lock anywhere). ✓
- Spec §3 ban-on-event, this-channel-only, dormant best-effort delete → Tasks 3, 7. ✓
- Spec §3 per-owner token + scopes → Tasks 6, 8. ✓
- Spec §4.1 chooser + `/kick` reusing tokes login → Tasks 10, 11. ✓
- Spec §5 data model → Task 1 (note: `kbd_enrolled_channels` resolved to a `defender_enabled` flag on `tokes_channels`, per §11 Q1 lean — documented in Task 1). ✓
- Spec §6 commands → Task 9 (scan/lock/dnl intentionally absent; ops/debug deferred). ✓
- Spec §7 roles → Task 9 tiers + Task 11 dashboard gates. ✓
- Spec §8 dashboard pages → Tasks 10, 11. ✓
- Spec §9 testing → unit (Tasks 2,3,9) + integration (Tasks 4,5,6,7) + manual (Task 12). ✓
- Spec §11 open questions: Q1 resolved (flag on tokes_channels); Q2 (username vs id) — banlist stores both, matches by id then name (Task 4); Q3 (rate limits) — `!ban-from-all` bulk loop is deferred (not in v1 command set), so no queue needed yet; documented as future. ✓
```
