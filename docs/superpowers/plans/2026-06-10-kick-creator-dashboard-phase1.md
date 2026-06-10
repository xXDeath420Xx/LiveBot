# Kick Creator Dashboard — Phase 1 (Defender Depth) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the Kick Defender's existing-but-hidden capabilities (sublist, unbanlist, full enforcement-log viewer) in the `/kick` web UI, add per-channel enforcement config (ban duration, escalation threshold, custom warning, safe-domain overrides) the engine already accepts, and document the Kick dashboard with a link back from the homepage.

**Architecture:** The enforcer (`services/certifried-bot/defender/enforcer.js`) is dependency-injected and unit-tested. We add a `kbd_channel_settings` table (additive migration), a settings loader the enforcer consults with fallbacks to today's hardcoded defaults (zero behavior change until a streamer opts in), new `/kick/api/**` routes that reuse existing `banlist.js`/`enforcement-log.js` functions, and new sections in the existing kick views. Docs + homepage link are explicit tasks.

**Tech Stack:** Node ESM, Express, EJS, mysql2 (`utils/db.js` pool), `node --test` (built-in test runner), node-cron (already used).

---

## File Structure

**Create:**
- `migrations/125_kbd_channel_settings.js` — additive table for per-channel enforcement config.
- `scripts/run-migration-125.js` — one-off runner (matches `run-migration-114.js`).
- `services/certifried-bot/defender/channel-settings.js` — loader: `getChannelSettings(channelId)` with cached fallbacks to current hardcoded defaults.
- `tests/defender/channel-settings.test.js` — unit tests for the loader + fallbacks.
- `dashboard/public/js/kick-dashboard.js` — shared client helper `postJson()` (CSRF header+body, real error surfacing), extracted from the panel inline script.

**Modify:**
- `services/certifried-bot/defender/enforcer.js` — read threshold/warning/duration from injected `getSettings(channelId)` with the exact current values as defaults.
- `services/certifried-bot/defender/index.js` — wire `getChannelSettings` into the enforcer deps.
- `services/certifried-bot/defender/enforcement-log.js` — add `listEvents()` (paginated, filterable) alongside `channelStats()`.
- `tests/defender/enforcer.test.js` — add tests for configurable threshold/duration/warning.
- `dashboard/routes/kick-defender.js` — add `/kick/api/sublist`, `/kick/api/unban`, `/kick/api/enforcement-log`, `/kick/api/channel-settings` routes; pass new data to views.
- `dashboard/views/kick/managers.ejs` — add Sublist + Unbanlist management cards.
- `dashboard/views/kick/panel.ejs` — add per-channel "Protection settings" + "Recent actions" (enforcement log), switch inline script to shared `kick-dashboard.js`.
- `dashboard/views/docs-tailwind.ejs` — add a "Kick Defender" documentation section.
- `dashboard/views/landing-chooser.ejs` — footer link to the Kick docs/dashboard.

---

## Task 1: Migration — `kbd_channel_settings` table

**Files:**
- Create: `migrations/125_kbd_channel_settings.js`
- Create: `scripts/run-migration-125.js`

- [ ] **Step 1: Write the migration**

Create `migrations/125_kbd_channel_settings.js`:

```javascript
/**
 * Migration 125 — per-channel Kick Defender settings.
 * Additive. One row per enrolled channel that has customized its enforcement.
 * Absent row == use the engine's hardcoded defaults (no behavior change).
 * Runner (scripts/run-migration-125.js) calls up(pool), so `db` IS the pool.
 */
export async function up(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS kbd_channel_settings (
            channel_id VARCHAR(64) PRIMARY KEY,
            ban_duration_min INT NULL,
            phishing_threshold INT NOT NULL DEFAULT 2,
            warning_template TEXT NULL,
            safe_domains TEXT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS kbd_channel_settings');
}
```

- [ ] **Step 2: Write the runner**

Create `scripts/run-migration-125.js`:

```javascript
import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/125_kbd_channel_settings.js';

(async () => {
    try {
        await up(pool);
        const [t] = await pool.execute("SHOW TABLES LIKE 'kbd_channel_settings'");
        console.log('Migration 125 — kbd_channel_settings present:', t.length === 1);
    } catch (e) {
        console.error('Migration 125 FAILED:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
```

- [ ] **Step 3: Run the migration**

Run: `node scripts/run-migration-125.js`
Expected: `Migration 125 — kbd_channel_settings present: true`

- [ ] **Step 4: Commit**

```bash
git add migrations/125_kbd_channel_settings.js scripts/run-migration-125.js
git commit -m "feat(kbd): migration 125 — per-channel defender settings table"
```

---

## Task 2: Channel-settings loader with defaults

**Files:**
- Create: `services/certifried-bot/defender/channel-settings.js`
- Test: `tests/defender/channel-settings.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/defender/channel-settings.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGetChannelSettings, DEFAULTS } from '../../services/certifried-bot/defender/channel-settings.js';

test('returns defaults when no row exists', async () => {
    const get = makeGetChannelSettings({ pool: { execute: async () => [[]] } });
    const s = await get('chanX');
    assert.equal(s.phishingThreshold, DEFAULTS.phishingThreshold); // 2
    assert.equal(s.banDurationMin, DEFAULTS.banDurationMin);       // null = permanent
    assert.equal(s.warningTemplate, DEFAULTS.warningTemplate);
    assert.deepEqual(s.safeDomains, DEFAULTS.safeDomains);          // []
});

test('row overrides defaults; blanks fall back', async () => {
    const row = { ban_duration_min: 600, phishing_threshold: 3, warning_template: 'gtfo {{username}}', safe_domains: 'a.com,b.com' };
    const get = makeGetChannelSettings({ pool: { execute: async () => [[row]] } });
    const s = await get('chanY');
    assert.equal(s.banDurationMin, 600);
    assert.equal(s.phishingThreshold, 3);
    assert.equal(s.warningTemplate, 'gtfo {{username}}');
    assert.deepEqual(s.safeDomains, ['a.com', 'b.com']);
});

test('a DB error returns defaults, never throws', async () => {
    const get = makeGetChannelSettings({ pool: { execute: async () => { throw new Error('db down'); } } });
    const s = await get('chanZ');
    assert.equal(s.phishingThreshold, DEFAULTS.phishingThreshold);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/defender/channel-settings.test.js`
Expected: FAIL — `Cannot find module '.../channel-settings.js'`

- [ ] **Step 3: Write the loader**

Create `services/certifried-bot/defender/channel-settings.js`:

```javascript
/**
 * Per-channel defender settings with fallback to the engine's historical
 * hardcoded defaults. An absent kbd_channel_settings row (or any DB error)
 * yields DEFAULTS, so unconfigured channels behave exactly as before.
 */
import realPool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

export const DEFAULTS = Object.freeze({
    banDurationMin: null, // null = permanent ban (current behavior)
    phishingThreshold: 2, // enforcer.js used `count >= 2`
    warningTemplate: '@{{username}} posted a known scam link and it was removed. Repeat offenses = ban.',
    safeDomains: []       // per-channel ADDITIONS to the global safe list
});

export function makeGetChannelSettings({ pool }) {
    return async function getChannelSettings(channelId) {
        try {
            const [[row]] = await pool.execute(
                'SELECT ban_duration_min, phishing_threshold, warning_template, safe_domains FROM kbd_channel_settings WHERE channel_id = ?',
                [String(channelId)]
            );
            if (!row) return { ...DEFAULTS };
            return {
                banDurationMin: row.ban_duration_min ?? DEFAULTS.banDurationMin,
                phishingThreshold: Number.isInteger(row.phishing_threshold) ? row.phishing_threshold : DEFAULTS.phishingThreshold,
                warningTemplate: row.warning_template || DEFAULTS.warningTemplate,
                safeDomains: row.safe_domains ? String(row.safe_domains).split(',').map(s => s.trim()).filter(Boolean) : []
            };
        } catch (error) {
            logger.warn('[KBD] getChannelSettings failed; using defaults', { channelId, error: error.message });
            return { ...DEFAULTS };
        }
    };
}

export const getChannelSettings = makeGetChannelSettings({ pool: realPool });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/defender/channel-settings.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add services/certifried-bot/defender/channel-settings.js tests/defender/channel-settings.test.js
git commit -m "feat(kbd): per-channel settings loader with safe defaults"
```

---

## Task 3: Make the enforcer consume settings

**Files:**
- Modify: `services/certifried-bot/defender/enforcer.js`
- Modify: `tests/defender/enforcer.test.js`

- [ ] **Step 1: Add failing tests for configurable behavior**

Append to `tests/defender/enforcer.test.js` (the `build()` helper already exists; extend it to accept a `getSettings` override by adding this inside the `deps` object in `build`, right after the `log:` line — locate `log: async (entry) => { calls.logs.push(entry); }` and add on the next line):

```javascript
        getSettings: async () => overrides.settings ?? {
            banDurationMin: null, phishingThreshold: 2,
            warningTemplate: '@{{username}} posted a known scam link and it was removed. Repeat offenses = ban.',
            safeDomains: []
        },
```

Then append these tests at the end of the file:

```javascript
test('phishing threshold is configurable (threshold 1 bans on first offense)', async () => {
    const { enforcer, calls } = build({
        withPhishing: true, phishingDomain: 'evil.com', offenseCount: 1,
        scopes: ['moderation:ban', 'moderation:chat_message:manage'],
        settings: { banDurationMin: null, phishingThreshold: 1, warningTemplate: 'x', safeDomains: [] }
    });
    await enforcer.check({ ...baseEvent });
    assert.equal(calls.bans.length, 1, 'should ban on first offense when threshold=1');
});

test('ban duration from settings is passed to banUser', async () => {
    const { enforcer, calls } = build({
        banlisted: true, scopes: ['moderation:ban'],
        settings: { banDurationMin: 600, phishingThreshold: 2, warningTemplate: 'x', safeDomains: [] }
    });
    await enforcer.check({ ...baseEvent });
    assert.equal(calls.bans.length, 1);
    assert.equal(calls.bans[0].o.durationMin, 600, 'ban opts should carry durationMin');
});

test('custom warning template is used on first phishing offense', async () => {
    const replies = [];
    const { enforcer } = build({
        withPhishing: true, phishingDomain: 'evil.com', offenseCount: 1,
        scopes: ['moderation:chat_message:manage'],
        settings: { banDurationMin: null, phishingThreshold: 2, warningTemplate: 'begone {{username}}', safeDomains: [] }
    });
    await enforcer.check({ ...baseEvent, reply: (m) => replies.push(m) });
    assert.equal(replies[0], 'begone baddie', 'warning should render template with username');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/defender/enforcer.test.js`
Expected: FAIL — new tests fail (durationMin undefined, threshold 1 doesn't ban, warning is the hardcoded string).

- [ ] **Step 3: Update the enforcer to read settings**

In `services/certifried-bot/defender/enforcer.js`:

(a) Add a settings fetch at the top of `check`. Replace the body start of `handleBanlisted` and `handlePhishingLink` to load settings. Concretely, change `handleBanlisted` so the ban call carries duration. Replace this block:

```javascript
        if (scopes.includes(BAN_SCOPE)) {
            return act(() => deps.banUser(channel.broadcasterId, userId, { reason }, channel.token),
                { channelId, targetUserId: userId, targetUsername: username, action: 'ban', reason });
        }
```

with:

```javascript
        if (scopes.includes(BAN_SCOPE)) {
            const settings = deps.getSettings ? await deps.getSettings(channelId) : {};
            const opts = { reason };
            if (settings.banDurationMin != null) opts.durationMin = settings.banDurationMin;
            return act(() => deps.banUser(channel.broadcasterId, userId, opts, channel.token),
                { channelId, targetUserId: userId, targetUsername: username, action: 'ban', reason });
        }
```

(b) In `handlePhishingLink`, replace:

```javascript
        const count = deps.recordOffense ? await deps.recordOffense(event.platform, userId, username, domain) : 1;
        const repeat = count >= 2;
```

with:

```javascript
        const settings = deps.getSettings ? await deps.getSettings(channelId) : {};
        const threshold = Number.isInteger(settings.phishingThreshold) ? settings.phishingThreshold : 2;
        const count = deps.recordOffense ? await deps.recordOffense(event.platform, userId, username, domain) : 1;
        const repeat = count >= threshold;
```

(c) In `handlePhishingLink`, replace the ban call (the `repeat && scopes.includes(BAN_SCOPE)` branch's `act(...)`):

```javascript
            return act(() => deps.banUser(channel.broadcasterId, userId, { reason }, channel.token),
                { channelId, targetUserId: userId, targetUsername: username, action: 'ban', reason });
```

with:

```javascript
            const banOpts = { reason };
            if (settings.banDurationMin != null) banOpts.durationMin = settings.banDurationMin;
            return act(() => deps.banUser(channel.broadcasterId, userId, banOpts, channel.token),
                { channelId, targetUserId: userId, targetUsername: username, action: 'ban', reason });
```

(d) In `handlePhishingLink`, replace the warning line:

```javascript
                try { reply(`@${username} posted a known scam link and it was removed. Repeat offenses = ban.`); } catch { /* ignore */ }
```

with:

```javascript
                const tpl = settings.warningTemplate || '@{{username}} posted a known scam link and it was removed. Repeat offenses = ban.';
                try { reply(tpl.replace(/\{\{username\}\}/g, username)); } catch { /* ignore */ }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/defender/enforcer.test.js`
Expected: PASS (all existing + 3 new tests). Existing tests still pass because `getSettings` defaults to threshold 2 / null duration / the original warning string.

- [ ] **Step 5: Commit**

```bash
git add services/certifried-bot/defender/enforcer.js tests/defender/enforcer.test.js
git commit -m "feat(kbd): enforcer reads per-channel threshold, ban duration, warning"
```

---

## Task 4: Wire settings + ban duration through the real deps

**Files:**
- Modify: `services/certifried-bot/defender/index.js`
- Modify: `services/certifried-bot/defender/kick-moderation.js`

- [ ] **Step 1: Confirm kick-moderation ban signature supports duration**

Run: `grep -n "export async function banUser\|duration\|expires" services/certifried-bot/defender/kick-moderation.js`
Expected: shows `banUser(broadcasterId, userId, opts, token)` — note whether `opts.durationMin` / `opts.duration` is already sent to the Kick API.

- [ ] **Step 2: Ensure banUser forwards durationMin to the Kick API**

In `services/certifried-bot/defender/kick-moderation.js`, inside `banUser`, locate where the request body is built (the object POSTed to the Kick bans endpoint). Ensure it conditionally includes the duration. Add this immediately before the fetch/body is finalized (adapt the body variable name to the file — it is the object holding `broadcaster_user_id`/`user_id`/`reason`):

```javascript
    // Optional timed ban: Kick expects `duration` in minutes; omit for permanent.
    if (opts && opts.durationMin != null) body.duration = Number(opts.durationMin);
```

- [ ] **Step 3: Wire getChannelSettings into the enforcer**

In `services/certifried-bot/defender/index.js`, add the import after the other defender imports:

```javascript
import { getChannelSettings } from './channel-settings.js';
```

Then add `getSettings` to the `createEnforcer({...})` deps object (after the `recordOffense` line):

```javascript
    getSettings: getChannelSettings,
```

- [ ] **Step 4: Run the full defender test suite**

Run: `node --test tests/defender/`
Expected: PASS (all files, including kick-moderation + enforcer).

- [ ] **Step 5: Commit**

```bash
git add services/certifried-bot/defender/index.js services/certifried-bot/defender/kick-moderation.js
git commit -m "feat(kbd): forward ban duration to Kick API and wire channel settings"
```

---

## Task 5: Enforcement-log query for the viewer

**Files:**
- Modify: `services/certifried-bot/defender/enforcement-log.js`
- Test: `tests/defender/enforcement-log.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/defender/enforcement-log.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeListEvents } from '../../services/certifried-bot/defender/enforcement-log.js';

test('builds a filtered, paginated query', async () => {
    let captured = null;
    const pool = { execute: async (sql, params) => { captured = { sql, params }; return [[{ id: 1 }]]; } };
    const listEvents = makeListEvents({ pool });
    const rows = await listEvents({ channelId: 'c1', action: 'ban', limit: 25, offset: 50 });
    assert.equal(rows.length, 1);
    assert.match(captured.sql, /FROM kbd_enforcement_log/);
    assert.match(captured.sql, /channel_id = \?/);
    assert.match(captured.sql, /action = \?/);
    assert.deepEqual(captured.params, ['c1', 'ban', 25, 50]);
});

test('omits action filter when not given', async () => {
    let captured = null;
    const pool = { execute: async (sql, params) => { captured = { sql, params }; return [[]]; } };
    const listEvents = makeListEvents({ pool });
    await listEvents({ channelId: 'c1', limit: 10, offset: 0 });
    assert.doesNotMatch(captured.sql, /action = \?/);
    assert.deepEqual(captured.params, ['c1', 10, 0]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/defender/enforcement-log.test.js`
Expected: FAIL — `makeListEvents` is not exported.

- [ ] **Step 3: Add `makeListEvents` + `listEvents` to enforcement-log.js**

In `services/certifried-bot/defender/enforcement-log.js`, add after `channelStats`:

```javascript
export function makeListEvents({ pool }) {
    return async function listEvents({ channelId, action = null, limit = 50, offset = 0 }) {
        const where = ['channel_id = ?'];
        const params = [String(channelId)];
        if (action) { where.push('action = ?'); params.push(action); }
        const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const off = Math.max(parseInt(offset, 10) || 0, 0);
        params.push(lim, off);
        const [rows] = await pool.execute(
            `SELECT id, channel_id, target_user_id, target_username, action, reason, success, created_at
             FROM kbd_enforcement_log
             WHERE ${where.join(' AND ')}
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?`,
            params
        );
        return rows;
    };
}

export const listEvents = makeListEvents({ pool });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/defender/enforcement-log.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add services/certifried-bot/defender/enforcement-log.js tests/defender/enforcement-log.test.js
git commit -m "feat(kbd): listEvents — filtered, paginated enforcement log query"
```

---

## Task 6: Shared client helper `kick-dashboard.js`

**Files:**
- Create: `dashboard/public/js/kick-dashboard.js`

- [ ] **Step 1: Write the helper**

Create `dashboard/public/js/kick-dashboard.js` (extracted from the panel's inline `postJson`, made reusable for all verbs):

```javascript
/**
 * Shared client helper for the /kick dashboard. Sends the CSRF token BOTH as
 * the X-CSRF-Token header AND in the JSON body (_csrf) because some reverse
 * proxies strip non-standard X- headers. Surfaces the real server error.
 */
(function () {
  const meta = document.querySelector('meta[name="csrf-token"]');
  const CSRF = meta ? meta.getAttribute('content') : '';

  async function sendJson(method, url, payload) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
      body: JSON.stringify({ ...(payload || {}), _csrf: CSRF })
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-JSON */ }
    if (!res.ok) {
      const msg = (data && data.error) ? data.error : `Request failed (HTTP ${res.status}).`;
      const err = new Error(msg); err.status = res.status; throw err;
    }
    return data;
  }

  window.KickDash = {
    post: (url, payload) => sendJson('POST', url, payload),
    del: (url, payload) => sendJson('DELETE', url, payload),
    csrf: CSRF
  };
})();
```

- [ ] **Step 2: Verify it parses**

Run: `node --check dashboard/public/js/kick-dashboard.js`
Expected: no output (valid).

- [ ] **Step 3: Commit**

```bash
git add dashboard/public/js/kick-dashboard.js
git commit -m "feat(kick): shared client helper (CSRF header+body, real errors)"
```

---

## Task 7: API routes — sublist, unbanlist, enforcement-log, channel-settings

**Files:**
- Modify: `dashboard/routes/kick-defender.js`

- [ ] **Step 1: Add the route imports**

In `dashboard/routes/kick-defender.js`, extend the banlist import to include the unban/sublist functions and add the log + settings imports. Replace:

```javascript
import * as banlist from '../../services/certifried-bot/defender/banlist.js';
```

with:

```javascript
import * as banlist from '../../services/certifried-bot/defender/banlist.js';
import { listEvents } from '../../services/certifried-bot/defender/enforcement-log.js';
import pool from '../../utils/db.js';
```

(Note: `pool` may already be imported at the top of the file — if `grep -n "import pool" dashboard/routes/kick-defender.js` shows an existing import, do NOT add a duplicate.)

- [ ] **Step 2: Add the four route groups**

In `dashboard/routes/kick-defender.js`, immediately before the final `export default router;`, insert:

```javascript
// ── Sublist (manager) ──────────────────────────────────────────────────────
router.post('/kick/api/sublist', requireTokesAuth, async (req, res) => {
    if (!await isManagerUser(req)) return res.status(403).json({ error: 'Managers only' });
    const { username, reason } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    await banlist.addBan({ platform: 'kick', username, reason: reason || 'Bot', listType: 'sublist', addedBy: req.session.tokesUser.id });
    res.json({ success: true });
});

router.post('/kick/api/sublist/clear', requireTokesAuth, async (req, res) => {
    if (!await isManagerUser(req)) return res.status(403).json({ error: 'Managers only' });
    await banlist.clearSublist();
    res.json({ success: true });
});

// ── Unbanlist / whitelist (manager) ────────────────────────────────────────
router.post('/kick/api/unban', requireTokesAuth, async (req, res) => {
    if (!await isManagerUser(req)) return res.status(403).json({ error: 'Managers only' });
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    await banlist.addUnban({ platform: 'kick', username, addedBy: req.session.tokesUser.id });
    res.json({ success: true });
});

router.delete('/kick/api/unban', requireTokesAuth, async (req, res) => {
    if (!await isManagerUser(req)) return res.status(403).json({ error: 'Managers only' });
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    await banlist.removeUnban('kick', null, username);
    res.json({ success: true });
});

// ── Enforcement log viewer (channel owner or manager) ──────────────────────
router.get('/kick/api/enforcement-log', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const channelId = String(req.query.channelId || '');
        if (!channelId) return res.status(400).json({ error: 'channelId required' });
        // Owner of the channel OR a manager may view.
        const [[owned]] = await pool.execute(
            "SELECT 1 AS ok FROM tokes_channels WHERE platform = 'kick' AND channel_id = ? AND owner_id = ?",
            [channelId, userId]
        );
        if (!owned && !await isManagerUser(req)) return res.status(403).json({ error: 'Not your channel' });
        const rows = await listEvents({
            channelId,
            action: req.query.action || null,
            limit: req.query.limit || 50,
            offset: req.query.offset || 0
        });
        res.json({ events: rows });
    } catch (error) {
        logger.error('[KBD Dashboard] enforcement-log error', { error: error.message });
        res.status(500).json({ error: 'Failed to load enforcement log' });
    }
});

// ── Per-channel protection settings (channel owner) ────────────────────────
router.get('/kick/api/channel-settings', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const channelId = String(req.query.channelId || '');
        const [[owned]] = await pool.execute(
            "SELECT 1 AS ok FROM tokes_channels WHERE platform = 'kick' AND channel_id = ? AND owner_id = ?",
            [channelId, userId]
        );
        if (!owned) return res.status(403).json({ error: 'Not your channel' });
        const [[row]] = await pool.execute(
            'SELECT ban_duration_min, phishing_threshold, warning_template, safe_domains FROM kbd_channel_settings WHERE channel_id = ?',
            [channelId]
        );
        res.json({ settings: row || null });
    } catch (error) {
        logger.error('[KBD Dashboard] get channel-settings error', { error: error.message });
        res.status(500).json({ error: 'Failed to load settings' });
    }
});

router.post('/kick/api/channel-settings', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const { channelId, banDurationMin, phishingThreshold, warningTemplate, safeDomains } = req.body;
        const [[owned]] = await pool.execute(
            "SELECT 1 AS ok FROM tokes_channels WHERE platform = 'kick' AND channel_id = ? AND owner_id = ?",
            [String(channelId || ''), userId]
        );
        if (!owned) return res.status(403).json({ error: 'Not your channel' });
        const dur = (banDurationMin === '' || banDurationMin == null) ? null : Math.max(0, parseInt(banDurationMin, 10) || 0) || null;
        const thr = Math.min(Math.max(parseInt(phishingThreshold, 10) || 2, 1), 10);
        const warn = (warningTemplate && String(warningTemplate).trim()) ? String(warningTemplate).slice(0, 400) : null;
        const safe = Array.isArray(safeDomains) ? safeDomains.join(',') : (safeDomains ? String(safeDomains) : null);
        await pool.execute(
            `INSERT INTO kbd_channel_settings (channel_id, ban_duration_min, phishing_threshold, warning_template, safe_domains)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE ban_duration_min = VALUES(ban_duration_min),
                phishing_threshold = VALUES(phishing_threshold),
                warning_template = VALUES(warning_template), safe_domains = VALUES(safe_domains)`,
            [String(channelId), dur, thr, warn, safe]
        );
        res.json({ success: true });
    } catch (error) {
        logger.error('[KBD Dashboard] save channel-settings error', { error: error.message });
        res.status(500).json({ error: 'Failed to save settings' });
    }
});
```

- [ ] **Step 3: Syntax check + restart + verify routes are gated (not 404/500)**

Run:
```bash
node --check dashboard/routes/kick-defender.js && pm2 restart CertiFriedUtility --update-env && sleep 11
for p in "/kick/api/sublist" "/kick/api/unban" "/kick/api/enforcement-log" "/kick/api/channel-settings"; do
  echo "$p -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:3001$p)"
done
```
Expected: each returns 401/403 (auth/CSRF gate) — NOT 404 (missing route) or 500. GET `/kick/api/enforcement-log` without auth → 302 or 401.

- [ ] **Step 4: Commit**

```bash
git add dashboard/routes/kick-defender.js
git commit -m "feat(kick): sublist, unbanlist, enforcement-log, channel-settings APIs"
```

---

## Task 8: Manager view — Sublist + Unbanlist cards

**Files:**
- Modify: `dashboard/views/kick/managers.ejs`
- Modify: `dashboard/routes/kick-defender.js` (pass `unbans` already loaded; confirm)

- [ ] **Step 1: Confirm the managers route already loads unbans**

Run: `grep -n "unbans\|listUnbans\|render('kick/managers'" dashboard/routes/kick-defender.js`
Expected: the `/kick/managers` render already passes `unbans` (it does today). If not present, add `unbans: await banlist.listUnbans('kick', 100, 0),` to the render object.

- [ ] **Step 2: Add Sublist + Unbanlist management cards**

In `dashboard/views/kick/managers.ejs`, find the existing "Manual sites" card block (`<h2>Manual sites ...`) and insert BEFORE it:

```html
    <h2>Sublist <span class="muted">(<%= counts.sublist %>)</span> — raid / bot defense</h2>
    <div class="card">
      <p class="muted" style="margin-bottom:.6rem">Mass-add names during a raid; cleared in one click.</p>
      <div class="formrow">
        <input id="sub-username" placeholder="username" />
        <input id="sub-reason" placeholder="reason (optional)" />
        <button id="sub-add">Add to sublist</button>
        <button id="sub-clear" class="danger">Clear sublist</button>
      </div>
    </div>

    <h2>Unban / protection list <span class="muted">(<%= counts.unbanlist %>)</span></h2>
    <div class="card">
      <p class="muted" style="margin-bottom:.6rem">Whitelisted users are never actioned (false-positive protection).</p>
      <div class="formrow">
        <input id="unban-username" placeholder="username" />
        <button id="unban-add">Add to whitelist</button>
      </div>
      <% if (unbans && unbans.length) { %>
        <ul>
          <% unbans.forEach(u => { %>
            <li><span><strong><%= u.username || u.platform_user_id %></strong></span>
              <button class="danger unban-remove" data-username="<%= u.username || u.platform_user_id %>">Remove</button></li>
          <% }) %>
        </ul>
      <% } %>
    </div>
```

- [ ] **Step 3: Wire the buttons using the existing `send()` helper**

In `dashboard/views/kick/managers.ejs`, inside the existing `<script>` block (which already defines `send(method, url, body)` and `v(id)`), append before the closing `</script>`:

```javascript
    const subAdd = document.getElementById('sub-add');
    if (subAdd) {
      subAdd.onclick = () => v('sub-username') && send('POST', '/kick/api/sublist', { username: v('sub-username'), reason: v('sub-reason') });
      document.getElementById('sub-clear').onclick = () => { if (confirm('Clear the entire sublist?')) send('POST', '/kick/api/sublist/clear', {}); };
    }
    const unbanAdd = document.getElementById('unban-add');
    if (unbanAdd) {
      unbanAdd.onclick = () => v('unban-username') && send('POST', '/kick/api/unban', { username: v('unban-username') });
      document.querySelectorAll('.unban-remove').forEach(b =>
        b.onclick = () => send('DELETE', '/kick/api/unban', { username: b.dataset.username }));
    }
```

- [ ] **Step 4: Render-test the view (all role states + missing-vars safety)**

Run:
```bash
node -e "const ejs=require('ejs'),fs=require('fs');const t=fs.readFileSync('dashboard/views/kick/managers.ejs','utf8');
const d={csrfToken:'x',user:{name:'m'},counts:{banlist:1,sublist:2,unbanlist:3,sites:0},sites:[],bans:[],sublist:[],unbans:[{username:'safe'}],phishingCount:391000,isAdmin:true};
const o=ejs.render(t,d);console.log('OK len='+o.length,'sublist='+o.includes('Sublist'),'unban='+o.includes('whitelist'));"
```
Expected: `OK len=... sublist=true unban=true`

- [ ] **Step 5: Commit**

```bash
git add dashboard/views/kick/managers.ejs dashboard/routes/kick-defender.js
git commit -m "feat(kick): sublist + unbanlist management UI in manager console"
```

---

## Task 9: Panel — per-channel Protection Settings + Recent Actions

**Files:**
- Modify: `dashboard/views/kick/panel.ejs`

- [ ] **Step 1: Add the settings + log UI per channel**

In `dashboard/views/kick/panel.ejs`, inside the `channels.forEach(ch => {` loop, after the existing `<% if (ch.enabled && !ch.hasBanScope) { %>` banner block and before the closing `</div>` of `.card`, insert:

```html
        <details class="settings">
          <summary>Protection settings &amp; recent actions</summary>
          <div class="srow">
            <label>Ban type
              <select class="set-bantype" data-channel="<%= ch.channelId %>">
                <option value="">Permanent</option>
                <option value="timed">Timed (minutes)</option>
              </select>
            </label>
            <input class="set-duration" data-channel="<%= ch.channelId %>" type="number" min="1" placeholder="minutes" style="width:8rem" />
            <label>Scam-link strikes before ban
              <input class="set-threshold" data-channel="<%= ch.channelId %>" type="number" min="1" max="10" value="2" style="width:5rem" />
            </label>
            <button class="set-save" data-channel="<%= ch.channelId %>">Save settings</button>
          </div>
          <textarea class="set-warning" data-channel="<%= ch.channelId %>" placeholder="Custom scam-link warning (use {{username}})" style="width:100%;margin-top:.5rem"></textarea>
          <div class="log" data-channel="<%= ch.channelId %>" style="margin-top:.75rem">
            <button class="log-load" data-channel="<%= ch.channelId %>">Load recent actions</button>
            <div class="log-out"></div>
          </div>
        </details>
```

Add to the `<style>` block:

```css
    .settings{margin-top:.85rem;border-top:1px solid rgba(255,255,255,.07);padding-top:.75rem}
    .settings summary{cursor:pointer;color:#9a93b3;font-size:.85rem}
    .srow{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;margin-top:.6rem}
    .srow label{font-size:.78rem;color:#9a93b3;display:flex;flex-direction:column;gap:.2rem}
    .log-out{margin-top:.5rem;font-size:.8rem;color:#b9b4cf}
    .log-out table{width:100%;border-collapse:collapse}.log-out td{padding:.2rem .4rem;border-bottom:1px solid rgba(255,255,255,.05)}
```

- [ ] **Step 2: Switch the panel to the shared helper + wire settings/log**

In `dashboard/views/kick/panel.ejs`, replace the entire existing `<script>...</script>` block (the self-contained `postJson` + enroll handlers) with a version that loads the shared helper and adds the new handlers:

```html
  <script src="/js/kick-dashboard.js"></script>
  <script>
    // Enroll toggle (reuses shared helper).
    document.querySelectorAll('.enroll').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await KickDash.post('/kick/api/enroll', { channelId: btn.dataset.channel, enabled: Number(btn.dataset.enabled) });
          location.reload();
        } catch (e) { btn.disabled = false; alert(e.message || 'Could not update enrollment.'); }
      });
    });

    // Save per-channel protection settings.
    document.querySelectorAll('.set-save').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ch = btn.dataset.channel;
        const q = s => document.querySelector(s + '[data-channel="' + ch + '"]');
        const banType = q('.set-bantype').value;
        const duration = q('.set-duration').value;
        const payload = {
          channelId: ch,
          banDurationMin: banType === 'timed' ? (duration || 1) : '',
          phishingThreshold: q('.set-threshold').value,
          warningTemplate: q('.set-warning').value
        };
        btn.disabled = true;
        try { await KickDash.post('/kick/api/channel-settings', payload); btn.textContent = 'Saved ✓'; }
        catch (e) { alert(e.message || 'Save failed.'); }
        finally { btn.disabled = false; setTimeout(() => { btn.textContent = 'Save settings'; }, 1500); }
      });
    });

    // Load enforcement log on demand.
    document.querySelectorAll('.log-load').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ch = btn.dataset.channel;
        const out = btn.parentElement.querySelector('.log-out');
        out.textContent = 'Loading…';
        try {
          const res = await fetch('/kick/api/enforcement-log?channelId=' + encodeURIComponent(ch) + '&limit=25');
          const j = await res.json();
          if (!res.ok) throw new Error(j.error || 'Failed');
          if (!j.events.length) { out.textContent = 'No actions recorded yet.'; return; }
          out.innerHTML = '<table>' + j.events.map(e =>
            '<tr><td>' + new Date(e.created_at).toISOString().slice(0,16).replace('T',' ') +
            '</td><td>' + e.action + (e.success ? '' : ' (failed)') +
            '</td><td>' + (e.target_username || '') + '</td><td>' + (e.reason || '') + '</td></tr>').join('') + '</table>';
        } catch (e) { out.textContent = e.message || 'Failed to load.'; }
      });
    });

    // Prefill settings forms from the server for each channel.
    document.querySelectorAll('.set-save').forEach(async btn => {
      const ch = btn.dataset.channel;
      try {
        const res = await fetch('/kick/api/channel-settings?channelId=' + encodeURIComponent(ch));
        const j = await res.json();
        if (res.ok && j.settings) {
          const q = s => document.querySelector(s + '[data-channel="' + ch + '"]');
          if (j.settings.ban_duration_min != null) { q('.set-bantype').value = 'timed'; q('.set-duration').value = j.settings.ban_duration_min; }
          if (j.settings.phishing_threshold != null) q('.set-threshold').value = j.settings.phishing_threshold;
          if (j.settings.warning_template) q('.set-warning').value = j.settings.warning_template;
        }
      } catch (_) { /* defaults are fine */ }
    });
  </script>
```

- [ ] **Step 3: Render-test the panel (with a channel + missing-vars safety)**

Run:
```bash
node -e "const ejs=require('ejs'),fs=require('fs');const t=fs.readFileSync('dashboard/views/kick/panel.ejs','utf8');
const d={csrfToken:'x',isManager:false,isAdmin:false,reauthHref:'/tokes-bot/auth/kick',channels:[{channelId:'62249842',channelName:'doldrumdan',enabled:true,hasBanScope:true,hasManageScope:true,stats:{banned:0,deleted:0,dormant:0}}]};
const o=ejs.render(t,d);console.log('OK len='+o.length,'settings='+o.includes('Protection settings'),'helper='+o.includes('kick-dashboard.js'));
const o2=ejs.render(t,{csrfToken:'x',reauthHref:'/x',channels:[]});console.log('empty-safe len='+o2.length);"
```
Expected: `OK len=... settings=true helper=true` and `empty-safe len=...` (no throw).

- [ ] **Step 4: Restart + manual smoke**

Run: `pm2 restart CertiFriedUtility --update-env && sleep 11 && curl -s -o /dev/null -w '/kick -> %{http_code}\n' http://127.0.0.1:3001/kick`
Expected: `/kick -> 302` (login gate; the page itself is verified via render-test above and live login).

- [ ] **Step 5: Commit**

```bash
git add dashboard/views/kick/panel.ejs
git commit -m "feat(kick): per-channel protection settings + enforcement-log viewer in panel"
```

---

## Task 10: Documentation — Kick Defender docs section

**Files:**
- Modify: `dashboard/views/docs-tailwind.ejs`

- [ ] **Step 1: Find the docs section structure**

Run: `grep -n "section\|<h2\|id=\"\|nav-link\|sidebar" dashboard/views/docs-tailwind.ejs | head -40`
Expected: reveals how doc sections + their sidebar/nav anchors are structured (note the pattern: a nav link + a `<section id="...">`).

- [ ] **Step 2: Add a Kick Defender doc section**

In `dashboard/views/docs-tailwind.ejs`, following the existing section pattern observed in Step 1, add a new section (adapt the wrapper classes/markup to match a neighbouring section exactly). Insert this content where other feature sections live:

```html
<section id="kick-defender" class="docs-section">
  <h2>Kick Defender</h2>
  <p>The Kick Defender is a shared-banlist defense network for Kick channels.
     Log in at <a href="/kick">certifriedmultitool.com/kick</a> with your Kick
     account and the defender is enabled automatically — bad actors and known
     scam links are removed across every connected channel.</p>

  <h3>Getting started</h3>
  <ol>
    <li>Go to <a href="/kick">/kick</a> and log in with Kick.</li>
    <li>Your channel is registered and the defender is turned on automatically.</li>
    <li>If prompted, re-authorize to grant ban + message-management permissions.</li>
  </ol>

  <h3>Per-channel protection settings</h3>
  <ul>
    <li><strong>Ban type</strong> — permanent (default) or a timed ban in minutes.</li>
    <li><strong>Scam-link strikes</strong> — how many known-scam links a user may
        post before being banned (default 2; first strike deletes + warns).</li>
    <li><strong>Custom warning</strong> — the message shown when a scam link is
        removed; use <code>{{username}}</code> for a mention.</li>
  </ul>

  <h3>Manager console</h3>
  <p>Managers (assigned by the owner) manage the shared lists at
     <a href="/kick/managers">/kick/managers</a>: the <strong>banlist</strong>,
     the <strong>sublist</strong> (fast raid/bot defense), the
     <strong>unban / protection list</strong> (whitelist that is never actioned),
     and manual scam-domain entries. A live lookup checks any domain against the
     blocklist.</p>

  <h3>Owner admin</h3>
  <p>The owner sees every connected account, its channels, defender status and
     granted permissions at <a href="/kick/admin">/kick/admin</a>, and assigns
     managers from the manager console.</p>

  <h3>Chat commands</h3>
  <p>In Kick chat: <code>!kbd-info</code> (help), <code>!check-ban &lt;user&gt;</code>,
     <code>!ping</code>. Managers also have <code>!add-ban</code>,
     <code>!remove-ban</code>, <code>!add-sublist</code>, <code>!add-unban</code>,
     <code>!mod-check</code>.</p>
</section>
```

If the docs page has a sidebar/nav, also add a link to it (matching the existing nav-link pattern from Step 1):

```html
<a href="#kick-defender" class="docs-nav-link">Kick Defender</a>
```

- [ ] **Step 3: Render-test the docs page**

Run:
```bash
node -e "const ejs=require('ejs'),fs=require('fs');const t=fs.readFileSync('dashboard/views/docs-tailwind.ejs','utf8');
try{const o=ejs.render(t,{user:null});console.log('docs render OK len='+o.length,'kick='+o.includes('Kick Defender'));}catch(e){console.log('NEEDS-VARS:',e.message);}"
```
Expected: `docs render OK len=... kick=true`. If it reports missing variables, supply them by mirroring how `server.js` renders `docs-tailwind` (check `grep -n \"render('docs-tailwind'\" dashboard/server.js`) and re-run.

- [ ] **Step 4: Commit**

```bash
git add dashboard/views/docs-tailwind.ejs
git commit -m "docs(kick): add Kick Defender documentation section"
```

---

## Task 11: Homepage link back to the Kick dashboard/docs

**Files:**
- Modify: `dashboard/views/landing-chooser.ejs`

- [ ] **Step 1: Add Kick links to the homepage footer**

In `dashboard/views/landing-chooser.ejs`, replace the footer line:

```html
  <footer><a href="/discord">About the Discord bot</a> · <a href="/donate">Donate</a></footer>
```

with:

```html
  <footer>
    <a href="/discord">About the Discord bot</a> ·
    <a href="/kick">Kick dashboard</a> ·
    <a href="/docs#kick-defender">Kick docs</a> ·
    <a href="/donate">Donate</a>
  </footer>
```

- [ ] **Step 2: Confirm /docs resolves to the docs page**

Run: `grep -n "get('/docs'\|render('docs-tailwind'" dashboard/server.js`
Expected: a route maps `/docs` → `docs-tailwind`. If the route is different (e.g. `/docs` renders a different view), point the homepage link at the correct path that renders the section from Task 10.

- [ ] **Step 3: Render-test + live check**

Run:
```bash
node -e "const ejs=require('ejs'),fs=require('fs');const t=fs.readFileSync('dashboard/views/landing-chooser.ejs','utf8');
const o=ejs.render(t,{discordHref:'/auth/discord',kickHref:'/tokes-bot/auth/kick'});console.log('home OK','kicklink='+o.includes('/kick'),'docslink='+o.includes('kick-defender'));"
pm2 restart CertiFriedUtility --update-env && sleep 11
curl -s --max-time 8 http://127.0.0.1:3001/ | grep -oE 'href=\"/(kick|docs#kick-defender)\"' | sort -u
```
Expected: `home OK kicklink=true docslink=true`, and the curl lists both `/kick` and `/docs#kick-defender`.

- [ ] **Step 4: Commit**

```bash
git add dashboard/views/landing-chooser.ejs
git commit -m "feat(home): link homepage footer to Kick dashboard + docs"
```

---

## Task 12: Full verification pass

- [ ] **Step 1: Run the whole defender test suite**

Run: `node --test tests/defender/`
Expected: all PASS (existing + new channel-settings, enforcement-log, enforcer config tests).

- [ ] **Step 2: Live route matrix**

Run:
```bash
sleep 2
for p in "/" "/kick" "/kick/managers" "/kick/admin" "/docs" \
         "/kick/api/sublist" "/kick/api/unban" "/kick/api/enforcement-log" "/kick/api/channel-settings"; do
  echo "$p -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:3001$p)"
done
```
Expected: `/` 200; `/docs` 200; `/kick*` pages 302 (login gate); `/kick/api/*` 401/403 (auth gate) — none 404 or 500.

- [ ] **Step 3: Confirm engine still safe for unconfigured channels**

Run:
```bash
node -e "import('./services/certifried-bot/defender/channel-settings.js').then(async m => {
  const s = await m.getChannelSettings('definitely-not-a-real-channel');
  console.log('defaults:', s.phishingThreshold === 2 && s.banDurationMin === null ? 'OK (unchanged behavior)' : 'WRONG');
});"
```
Expected: `defaults: OK (unchanged behavior)`

- [ ] **Step 4: Final commit (if any uncommitted verification tweaks)**

```bash
git add -A -- ':!scripts/setup-*' ':!setup-*.js'
git status --short | head
git commit -m "test(kick): phase 1 verification" || echo "nothing to commit"
```

---

## Self-Review Notes

- **Spec coverage:** Phase 1 items (sublist UI, unbanlist UI, enforcement-log viewer, timeout/threshold/warning/safe-domain config, additive `kbd_channel_settings`, engine fallback) → Tasks 1–9. Documentation requirement → Task 10. Homepage link-back requirement → Task 11. Verification → Task 12.
- **Safe-domains note:** the `safe_domains` column + API are stored in Phase 1 (Tasks 1, 7) and exposed in settings; wiring them into `findPhishingDomain`'s per-channel allow-check is a small follow-up noted for Phase 1.1 if not reached — the column and persistence exist so no schema change is needed later.
- **No behavior change guarantee:** Tasks 2–4 make every new knob default to the exact current hardcoded value; Task 12 Step 3 asserts it.
- **Backwards-compatible deps:** the enforcer's `getSettings` dep is optional (`deps.getSettings ? ... : {}`), so existing tests that build enforcers without it keep passing.
