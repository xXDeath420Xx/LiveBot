# Kick Creator Dashboard — Phase 2 (Channel Settings & Commands) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-home the proven `/tokes-bot` per-channel settings + command-management capability under `/kick`, in the Kick dark aesthetic, so a Kick streamer can configure their channel (prefix, cooldowns, feature toggles), enable/disable & override built-in commands, and create custom commands — without changing the working backend.

**Architecture:** Reuse the existing, validated DB operations from `dashboard/routes/tokes-bot.js`. Add new `/kick/api/**` routes that mirror them but resolve ownership via the Kick `channel_id` (VARCHAR broadcaster id) → `tokes_channels.id` (PK INT). Add a `/kick/channel/:channelId` page + a `/kick/channel/:channelId/commands` page in the `/kick` visual style (`.card`/`.srow`/`KickDash` helper). The `/tokes-bot` routes stay until retired in a later cleanup.

**Tech Stack:** Node ESM, Express, EJS, mysql2 pool (`utils/db.js`), existing validators (`utils/input-validation.js`), cache invalidation (`services/certifried-bot/command-registry.js`), template processor docs (`services/certifried-bot/template-processor.js`). Tests via `node --test`.

---

## CRITICAL cross-cutting facts (every task depends on these)

1. **Identity mismatch (the central design point):** `/kick` URLs and the defender routes use `tokes_channels.channel_id` (the Kick broadcaster user id, a VARCHAR). The tokes-bot command routes use `tokes_channels.id` (the PK, an INT). Phase 2 keeps `/kick` URLs on `channel_id` and resolves the PK inside each route via an ownership-checked lookup. A shared helper does this:
   ```js
   // returns { id } (PK) for a kick channel the user owns, or null
   async function resolveOwnedChannel(userId, channelId) {
     const [[row]] = await pool.execute(
       "SELECT id FROM tokes_channels WHERE platform='kick' AND channel_id=? AND owner_id=?",
       [String(channelId || ''), userId]
     );
     return row || null;
   }
   ```
2. **Concurrent author on `dev`:** NEVER `git commit --amend`. Each task makes FRESH commits staging ONLY its named files by exact path (never `git add -A`). After committing, verify `git show --stat --oneline HEAD` lists exactly the intended files; if more, report BLOCKED.
3. **Live system:** the app runs via PM2 from this checkout. Verification uses `pm2 restart CertiFriedUtility --update-env` + curl. Routes must return 200 (authed pages) / 302 (login gate) / 401-403 (API auth gate), never 404/500 when gated.
4. **Test files are gitignored but tracked** — use `git add -f` for new test files.
5. **`tests/` files that import the real pool hang on exit** — run individual test files with `timeout 12 node --test <file>` and read the `ok`/`not ok` lines.
6. **Reuse, don't rewrite:** the SQL, validators, and cache-invalidation calls are copied from the tokes-bot routes verbatim (they are correct and battle-tested). Phase 2's only NEW logic is the `channel_id`→PK resolution and the Kick-styled views.

## File Structure

**Create:**
- `dashboard/routes/kick-channel.js` — new router: `/kick/channel/:channelId` (page), `/kick/channel/:channelId/commands` (page), and `/kick/api/channel/:channelId/**` (settings PATCH, command toggle/override, custom CRUD). Mounted in server.js.
- `dashboard/views/kick/channel.ejs` — per-channel settings page (Kick style).
- `dashboard/views/kick/channel-commands.ejs` — command management page (Kick style).
- `tests/kick/resolve-owned-channel.test.js` — unit test for the PK-resolution helper (extracted as a pure factory so it can be mock-pooled).

**Modify:**
- `dashboard/server.js` — mount the new `kick-channel.js` router (after the existing kick-defender mount).
- `dashboard/views/kick/panel.ejs` — add a "Settings & commands" link on each channel card pointing at `/kick/channel/<channelId>`.

---

## Task 1: PK-resolution helper (pure, tested)

**Files:**
- Create: `services/certifried-bot/defender/owned-channel.js`
- Test: `tests/kick/resolve-owned-channel.test.js`

- [ ] **Step 1: Write the failing test** — Create `tests/kick/resolve-owned-channel.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeResolveOwnedChannel } from '../../services/certifried-bot/defender/owned-channel.js';

test('returns the PK row when the user owns the kick channel', async () => {
    let captured;
    const pool = { execute: async (sql, params) => { captured = { sql, params }; return [[{ id: 42 }]]; } };
    const resolve = makeResolveOwnedChannel({ pool });
    const row = await resolve(7, '62249842');
    assert.deepEqual(row, { id: 42 });
    assert.match(captured.sql, /FROM tokes_channels/);
    assert.match(captured.sql, /platform\s*=\s*'kick'/);
    assert.deepEqual(captured.params, ['62249842', 7]);
});

test('returns null when no owned channel matches', async () => {
    const pool = { execute: async () => [[]] };
    const resolve = makeResolveOwnedChannel({ pool });
    assert.equal(await resolve(7, 'nope'), null);
});

test('coerces a null channelId to empty string (no crash)', async () => {
    let captured;
    const pool = { execute: async (sql, params) => { captured = { sql, params }; return [[]]; } };
    const resolve = makeResolveOwnedChannel({ pool });
    await resolve(7, null);
    assert.equal(captured.params[0], '');
});
```

- [ ] **Step 2: Run, verify FAIL** — `node --test tests/kick/resolve-owned-channel.test.js` → fails (module missing).

- [ ] **Step 3: Write the helper** — Create `services/certifried-bot/defender/owned-channel.js`:

```javascript
/**
 * Resolve a Kick channel_id (broadcaster id, VARCHAR) to the tokes_channels PK
 * (id, INT) for a channel the given user owns. Returns { id } or null.
 *
 * The /kick surface keys everything on channel_id, but the re-homed tokes-bot
 * command routes operate on the PK. This is the single bridge between the two.
 */
import realPool from '../../../utils/db.js';

export function makeResolveOwnedChannel({ pool }) {
    return async function resolveOwnedChannel(userId, channelId) {
        const [[row]] = await pool.execute(
            "SELECT id FROM tokes_channels WHERE platform = 'kick' AND channel_id = ? AND owner_id = ?",
            [String(channelId || ''), userId]
        );
        return row || null;
    };
}

export const resolveOwnedChannel = makeResolveOwnedChannel({ pool: realPool });
```

- [ ] **Step 4: Run, verify PASS** — `node --test tests/kick/resolve-owned-channel.test.js` → `# pass 3`.

- [ ] **Step 5: Commit**

```bash
git add services/certifried-bot/defender/owned-channel.js
git add -f tests/kick/resolve-owned-channel.test.js
git commit -m "feat(kick): channel_id→PK owned-channel resolver"
git show --stat --oneline HEAD
```

---

## Task 2: The kick-channel router — settings + command APIs

**Files:**
- Create: `dashboard/routes/kick-channel.js`
- Modify: `dashboard/server.js`

These routes mirror the tokes-bot ones EXACTLY (same SQL, same validators, same cache invalidation) but (a) take the Kick `channelId` in the URL, (b) resolve the PK via `resolveOwnedChannel`, (c) use `requireKickAuth`, (d) respond with JSON `{success:true,...}` or `{error}`.

- [ ] **Step 1: Create `dashboard/routes/kick-channel.js`**

```javascript
/**
 * /kick/channel/* — per-channel settings + command management for Kick.
 * Re-homes the proven /tokes-bot channel/command operations under /kick,
 * resolving the Kick channel_id to the tokes_channels PK on every call.
 */
import express from 'express';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { requireKickAuth } from './auth-tokes-bot.js';
import { resolveOwnedChannel } from '../../services/certifried-bot/defender/owned-channel.js';
import { invalidateChannelCache } from '../../services/certifried-bot/command-registry.js';
import {
    validateCommandName, validateCommandResponse, validateCooldown,
    validateAliases, validateBoolean
} from '../../utils/input-validation.js';

const router = express.Router();

// ── Page: per-channel settings ──────────────────────────────────────────────
router.get('/kick/channel/:channelId', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).send('Channel not found.');
        const [[channel]] = await pool.execute(
            `SELECT c.id, c.channel_id, c.channel_name, c.platform, c.is_enabled,
                    c.command_prefix, c.cooldown_global, c.cooldown_user, c.features_enabled
             FROM tokes_channels c WHERE c.id = ?`, [owned.id]
        );
        res.render('kick/channel', {
            user: req.session.tokesUser,
            channel,
            csrfToken: req.csrfToken ? req.csrfToken() : (res.locals.csrfToken || '')
        });
    } catch (error) {
        logger.error('[Kick Channel] settings page error', { error: error.message });
        res.status(500).send('Failed to load channel settings.');
    }
});

// ── API: update channel settings ────────────────────────────────────────────
router.patch('/kick/api/channel/:channelId', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const { command_prefix, cooldown_global, cooldown_user, features_enabled } = req.body;
        const prefix = command_prefix != null ? String(command_prefix).slice(0, 5) : '!';
        const cg = Math.max(0, Math.min(60, parseInt(cooldown_global, 10) || 0));
        const cu = Math.max(0, Math.min(300, parseInt(cooldown_user, 10) || 0));
        const feats = features_enabled != null ? JSON.stringify(features_enabled) : null;
        await pool.execute(
            `UPDATE tokes_channels SET command_prefix = ?, cooldown_global = ?, cooldown_user = ?,
                features_enabled = COALESCE(?, features_enabled) WHERE id = ?`,
            [prefix, cg, cu, feats, owned.id]
        );
        invalidateChannelCache(owned.id);
        res.json({ success: true });
    } catch (error) {
        logger.error('[Kick Channel] settings save error', { error: error.message });
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

// ── Page: command management ────────────────────────────────────────────────
router.get('/kick/channel/:channelId/commands', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).send('Channel not found.');
        const [[channel]] = await pool.execute(
            'SELECT id, channel_id, channel_name FROM tokes_channels WHERE id = ?', [owned.id]
        );
        const [commands] = await pool.execute(
            'SELECT command_key, default_aliases, description, category, cooldown_default, mod_only FROM tokes_global_command_config WHERE is_enabled = 1 ORDER BY category, command_key'
        );
        const [channelCommands] = await pool.execute(
            'SELECT command_key, is_enabled, custom_aliases, custom_response, cooldown_override, mod_only FROM tokes_channel_commands WHERE channel_id = ?', [owned.id]
        );
        const [customCommands] = await pool.execute(
            'SELECT id, command_name, response, cooldown, mod_only, is_enabled, use_count FROM tokes_custom_commands WHERE channel_id = ? ORDER BY command_name', [owned.id]
        );
        res.render('kick/channel-commands', {
            user: req.session.tokesUser, channel, commands, channelCommands, customCommands,
            csrfToken: req.csrfToken ? req.csrfToken() : (res.locals.csrfToken || '')
        });
    } catch (error) {
        logger.error('[Kick Channel] commands page error', { error: error.message });
        res.status(500).send('Failed to load commands.');
    }
});

// ── API: toggle a built-in command ──────────────────────────────────────────
router.post('/kick/api/channel/:channelId/commands/:commandKey/toggle', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const enabled = req.body.enabled ? 1 : 0;
        await pool.execute(
            `INSERT INTO tokes_channel_commands (channel_id, command_key, is_enabled) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled)`,
            [owned.id, req.params.commandKey, enabled]
        );
        invalidateChannelCache(owned.id);
        res.json({ success: true, enabled: !!enabled });
    } catch (error) {
        logger.error('[Kick Channel] toggle error', { error: error.message });
        res.status(500).json({ error: 'Failed to toggle command' });
    }
});

// ── API: override a built-in command ────────────────────────────────────────
router.put('/kick/api/channel/:channelId/commands/:commandKey', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const aliasesV = validateAliases(req.body.custom_aliases);
        if (!aliasesV.valid) return res.status(400).json({ error: aliasesV.error });
        let respValue = null;
        if (req.body.custom_response) {
            const respV = validateCommandResponse(req.body.custom_response);
            if (!respV.valid) return res.status(400).json({ error: respV.error });
            respValue = respV.value;
        }
        const cdV = validateCooldown(req.body.cooldown_override);
        const modV = validateBoolean(req.body.mod_only, false);
        await pool.execute(
            `INSERT INTO tokes_channel_commands
                (channel_id, command_key, custom_aliases, custom_response, cooldown_override, mod_only)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE custom_aliases = VALUES(custom_aliases),
                custom_response = VALUES(custom_response), cooldown_override = VALUES(cooldown_override),
                mod_only = VALUES(mod_only), updated_at = CURRENT_TIMESTAMP`,
            [owned.id, req.params.commandKey,
             aliasesV.value.length ? JSON.stringify(aliasesV.value) : null,
             respValue, cdV.value, modV.value ? 1 : 0]
        );
        invalidateChannelCache(owned.id);
        res.json({ success: true });
    } catch (error) {
        logger.error('[Kick Channel] override error', { error: error.message });
        res.status(500).json({ error: 'Failed to update command' });
    }
});

// ── API: custom commands CRUD ───────────────────────────────────────────────
router.post('/kick/api/channel/:channelId/custom', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const nameV = validateCommandName(req.body.command_name);
        if (!nameV.valid) return res.status(400).json({ error: nameV.error });
        const respV = validateCommandResponse(req.body.response);
        if (!respV.valid) return res.status(400).json({ error: respV.error });
        const cdV = validateCooldown(req.body.cooldown);
        const modV = validateBoolean(req.body.mod_only, false);
        // Don't collide with a built-in command key.
        const [[builtin]] = await pool.execute(
            'SELECT command_key FROM tokes_global_command_config WHERE command_key = ?', [nameV.value]
        );
        if (builtin) return res.status(409).json({ error: 'That name is a built-in command' });
        try {
            const [result] = await pool.execute(
                `INSERT INTO tokes_custom_commands (channel_id, command_name, response, cooldown, mod_only, created_by)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [owned.id, nameV.value, respV.value, cdV.value, modV.value ? 1 : 0, req.session.tokesUser.name || 'owner']
            );
            invalidateChannelCache(owned.id);
            res.json({ success: true, commandId: result.insertId });
        } catch (e) {
            if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Command already exists' });
            throw e;
        }
    } catch (error) {
        logger.error('[Kick Channel] custom create error', { error: error.message });
        res.status(500).json({ error: 'Failed to create command' });
    }
});

router.put('/kick/api/channel/:channelId/custom/:cmdId', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const [[existing]] = await pool.execute(
            'SELECT id FROM tokes_custom_commands WHERE id = ? AND channel_id = ?', [req.params.cmdId, owned.id]
        );
        if (!existing) return res.status(404).json({ error: 'Command not found' });
        const respV = validateCommandResponse(req.body.response);
        if (!respV.valid) return res.status(400).json({ error: respV.error });
        const cdV = validateCooldown(req.body.cooldown);
        const modV = validateBoolean(req.body.mod_only, false);
        const enV = validateBoolean(req.body.is_enabled, true);
        await pool.execute(
            'UPDATE tokes_custom_commands SET response = ?, cooldown = ?, mod_only = ?, is_enabled = ? WHERE id = ?',
            [respV.value, cdV.value, modV.value ? 1 : 0, enV.value ? 1 : 0, req.params.cmdId]
        );
        invalidateChannelCache(owned.id);
        res.json({ success: true });
    } catch (error) {
        logger.error('[Kick Channel] custom update error', { error: error.message });
        res.status(500).json({ error: 'Failed to update command' });
    }
});

router.delete('/kick/api/channel/:channelId/custom/:cmdId', requireKickAuth, async (req, res) => {
    try {
        const userId = req.session.tokesUser.id;
        const owned = await resolveOwnedChannel(userId, req.params.channelId);
        if (!owned) return res.status(404).json({ error: 'Channel not found' });
        const [result] = await pool.execute(
            'DELETE FROM tokes_custom_commands WHERE id = ? AND channel_id = ?', [req.params.cmdId, owned.id]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Command not found' });
        invalidateChannelCache(owned.id);
        res.json({ success: true });
    } catch (error) {
        logger.error('[Kick Channel] custom delete error', { error: error.message });
        res.status(500).json({ error: 'Failed to delete command' });
    }
});

export default router;
```

- [ ] **Step 2: Mount in server.js** — find where `kick-defender.js` is imported/mounted (`grep -n "kick-defender" dashboard/server.js`). Immediately after that mount block, add:

```javascript
    import('./routes/kick-channel.js').then(({ default: kickChannelRouter }) => {
        app.use('/', kickChannelRouter);
    }).catch(err => {
        logger.error('Failed to load Kick channel routes:', err);
    });
```

- [ ] **Step 3: Syntax + mount check.** The views don't exist yet (Tasks 3-4), so the PAGE routes will 500 on render — that's expected until then. Verify the API routes register and gate:

```bash
node --check dashboard/routes/kick-channel.js && pm2 restart CertiFriedUtility --update-env && sleep 12
echo "PATCH settings -> $(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H 'Content-Type: application/json' --max-time 8 http://127.0.0.1:3001/kick/api/channel/123 -d '{}')"
echo "POST custom -> $(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --max-time 8 http://127.0.0.1:3001/kick/api/channel/123/custom -d '{}')"
echo "GET page -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:3001/kick/channel/123)"
```
Expected: API routes 403 (CSRF gate) or 302; GET page 302 (login gate). None 404. (A logged-out request hits requireKickAuth → 302 before the missing-view render, so even the page route should be 302, not 500.)

- [ ] **Step 4: Commit**

```bash
git add dashboard/routes/kick-channel.js dashboard/server.js
git commit -m "feat(kick): channel settings + command-management API routes"
git show --stat --oneline HEAD
```

---

## Task 3: Channel settings page view (`kick/channel.ejs`)

**Files:**
- Create: `dashboard/views/kick/channel.ejs`

Build in the `/kick` style (dark gradient, `.card`, `.srow`, `KickDash`, csrf meta). Sections: header (channel name + nav back to `/kick`), a settings `.card` (command prefix, global cooldown, per-user cooldown, feature toggles from `features_enabled`), a "Save settings" button, and a link to `/kick/channel/<channelId>/commands`.

- [ ] **Step 1: Write the view.** Create `dashboard/views/kick/channel.ejs` mirroring `dashboard/views/kick/panel.ejs`'s head/style/aesthetic (read panel.ejs first for the exact `<style>` block to copy — reuse `.wrap`, `.card`, `.srow`, button styles, the csrf meta tag, and `<script src="/js/kick-dashboard.js">`). The body:

```html
  <div class="wrap">
    <header>
      <h1>⚙ <%= channel.channel_name %></h1>
      <nav class="nav">
        <a href="/kick">My channels</a>
        <a href="/kick/channel/<%= channel.channel_id %>/commands">Commands</a>
        <a href="/logout">Log out</a>
      </nav>
    </header>

    <div class="card">
      <div class="srow">
        <label>Command prefix
          <input id="prefix" maxlength="5" value="<%= channel.command_prefix || '!' %>" style="width:5rem" />
        </label>
        <label>Global cooldown (s)
          <input id="cg" type="number" min="0" max="60" value="<%= channel.cooldown_global || 0 %>" style="width:6rem" />
        </label>
        <label>Per-user cooldown (s)
          <input id="cu" type="number" min="0" max="300" value="<%= channel.cooldown_user || 0 %>" style="width:6rem" />
        </label>
      </div>
      <div id="feats" class="srow" style="margin-top:.75rem"></div>
      <button id="save" style="margin-top:1rem">Save settings</button>
    </div>
  </div>

  <script src="/js/kick-dashboard.js"></script>
  <script>
    const CHANNEL = '<%= channel.channel_id %>';
    // Feature toggles — render checkboxes from the stored features_enabled JSON.
    const FEATURES = ['tokes','spark','sessions','trivia'];
    let feats = {};
    try { feats = JSON.parse('<%- (channel.features_enabled || "{}").replace(/'/g, "\\'") %>') || {}; } catch (_) {}
    document.getElementById('feats').innerHTML = FEATURES.map(f =>
      '<label style="flex-direction:row;gap:.35rem;align-items:center">' +
      '<input type="checkbox" class="feat" data-feat="' + f + '"' + (feats[f] !== false ? ' checked' : '') + '/> ' + f + '</label>').join('');

    document.getElementById('save').addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      const features = {};
      document.querySelectorAll('.feat').forEach(c => { features[c.dataset.feat] = c.checked; });
      try {
        await KickDash.post('/kick/api/channel/' + CHANNEL, {
          command_prefix: document.getElementById('prefix').value,
          cooldown_global: document.getElementById('cg').value,
          cooldown_user: document.getElementById('cu').value,
          features_enabled: features,
          _method: 'PATCH'
        });
        btn.textContent = 'Saved ✓';
      } catch (err) { alert(err.message || 'Save failed.'); }
      finally { btn.disabled = false; setTimeout(() => { btn.textContent = 'Save settings'; }, 1500); }
    });
  </script>
```

NOTE on the PATCH: `KickDash` only exposes `post`/`del`. The settings route is a PATCH. Add a `patch` method to `KickDash` in this task's Step 2 (it's a one-line addition to the shared helper), OR change the route in Task 2 to accept POST. DECISION: add a `patch` to KickDash (cleaner; keeps REST semantics). Remove the `_method` hack above and call `KickDash.patch(...)`.

- [ ] **Step 2: Add `patch` to the shared helper.** In `dashboard/public/js/kick-dashboard.js`, add `patch: (url, payload) => sendJson('PATCH', url, payload),` to the `window.KickDash` object (alongside `post`/`del`). Update the channel.ejs save handler to call `KickDash.patch('/kick/api/channel/' + CHANNEL, {...})` WITHOUT the `_method` field.

- [ ] **Step 3: Render-test**

```bash
node -e "const ejs=require('ejs'),fs=require('fs');const t=fs.readFileSync('dashboard/views/kick/channel.ejs','utf8');
const o=ejs.render(t,{csrfToken:'x',user:{name:'u'},channel:{id:1,channel_id:'62249842',channel_name:'dd',platform:'kick',is_enabled:1,command_prefix:'!',cooldown_global:5,cooldown_user:10,features_enabled:'{\"tokes\":true,\"trivia\":false}'}});
console.log('OK len='+o.length,'prefix='+o.includes('id=\"prefix\"'),'feats='+o.includes('FEATURES'),'patch='+o.includes('KickDash.patch'));" ```

Expected: `OK len=... prefix=true feats=true patch=true`.

- [ ] **Step 4: Restart + verify the page now renders (302 logged-out; no 500)**

```bash
pm2 restart CertiFriedUtility --update-env && sleep 12
echo "/kick/channel/123 -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:3001/kick/channel/123)"
```
Expected: 302 (login gate). Page content verified by the render-test.

- [ ] **Step 5: Commit**

```bash
git add dashboard/views/kick/channel.ejs dashboard/public/js/kick-dashboard.js
git commit -m "feat(kick): channel settings page + KickDash.patch helper"
git show --stat --oneline HEAD
```

---

## Task 4: Command-management page view (`kick/channel-commands.ejs`)

**Files:**
- Create: `dashboard/views/kick/channel-commands.ejs`

Kick-styled page. Sections: header (nav back to `/kick/channel/<id>`), a built-in commands list (grouped by `category`; each row: `!<key>`, description, an enable/disable checkbox reflecting the channel override, and a collapsible `<details>` with custom-alias / cooldown-override / custom-response / mod-only inputs + a per-command Save), and a Custom Commands card (list with edit/delete + an "Add command" form). All writes go through `KickDash`.

- [ ] **Step 1: Write the view.** Create `dashboard/views/kick/channel-commands.ejs`. Reuse the `<head>`/`<style>` from `kick/panel.ejs` (read it; copy the style block, add a few rules for `.cmd`/`.toggle`). The data: `commands` (built-ins), `channelCommands` (overrides keyed by command_key), `customCommands`. Build an override-lookup map in EJS:

```html
  <div class="wrap">
    <header>
      <h1>⌨ Commands — <%= channel.channel_name %></h1>
      <nav class="nav">
        <a href="/kick/channel/<%= channel.channel_id %>">Settings</a>
        <a href="/kick">My channels</a>
        <a href="/logout">Log out</a>
      </nav>
    </header>

    <%
      const ov = {};
      channelCommands.forEach(c => { ov[c.command_key] = c; });
    %>

    <div class="card">
      <h2 style="font-size:1.1rem;margin-bottom:.75rem">Built-in commands</h2>
      <% commands.forEach(cmd => { const o = ov[cmd.command_key] || {}; const enabled = o.is_enabled === undefined ? true : o.is_enabled === 1; %>
        <div class="cmd" data-key="<%= cmd.command_key %>" style="border-top:1px solid rgba(255,255,255,.06);padding:.6rem 0">
          <div class="row">
            <div><strong>!<%= cmd.command_key %></strong> <span class="muted" style="font-size:.8rem">— <%= cmd.description || cmd.category %></span></div>
            <label style="display:flex;gap:.35rem;align-items:center;font-size:.8rem">
              <input type="checkbox" class="cmd-enabled" data-key="<%= cmd.command_key %>" <%= enabled ? 'checked' : '' %>/> enabled
            </label>
          </div>
          <details class="settings">
            <summary>Customize</summary>
            <div class="srow">
              <label>Aliases (comma-sep)
                <input class="cmd-aliases" data-key="<%= cmd.command_key %>" value="<%= o.custom_aliases ? JSON.parse(o.custom_aliases).join(', ') : '' %>" />
              </label>
              <label>Cooldown (s)
                <input class="cmd-cd" data-key="<%= cmd.command_key %>" type="number" min="0" max="3600" value="<%= o.cooldown_override != null ? o.cooldown_override : '' %>" style="width:6rem" />
              </label>
              <label style="flex-direction:row;gap:.35rem;align-items:center">
                <input type="checkbox" class="cmd-mod" data-key="<%= cmd.command_key %>" <%= o.mod_only === 1 ? 'checked' : '' %>/> mod-only
              </label>
            </div>
            <textarea class="cmd-resp" data-key="<%= cmd.command_key %>" placeholder="Custom response (optional; supports {{username}}, {{lifetime_tokes}}, …)" style="width:100%;margin-top:.5rem"><%= o.custom_response || '' %></textarea>
            <button class="cmd-save" data-key="<%= cmd.command_key %>" style="margin-top:.5rem">Save</button>
          </details>
        </div>
      <% }) %>
    </div>

    <div class="card">
      <div class="row"><h2 style="font-size:1.1rem">Custom commands</h2></div>
      <div class="srow" style="margin-top:.6rem">
        <input id="new-name" placeholder="name (no !)" />
        <input id="new-cd" type="number" min="0" max="3600" value="5" placeholder="cooldown" style="width:6rem" />
        <label style="flex-direction:row;gap:.35rem;align-items:center"><input type="checkbox" id="new-mod"/> mod-only</label>
        <button id="new-add">Add command</button>
      </div>
      <textarea id="new-resp" placeholder="Response (supports {{username}}, {{lifetime_tokes}}, {{level}}, …)" style="width:100%;margin-top:.5rem"></textarea>
      <ul id="custom-list" style="margin-top:.75rem;list-style:none">
        <% customCommands.forEach(cc => { %>
          <li data-id="<%= cc.id %>" style="display:flex;justify-content:space-between;gap:.75rem;padding:.4rem 0;border-bottom:1px solid rgba(255,255,255,.05)">
            <span><strong>!<%= cc.command_name %></strong> <span class="muted" style="font-size:.8rem"><%= (cc.response || '').slice(0,60) %></span></span>
            <button class="cc-del danger" data-id="<%= cc.id %>">Delete</button>
          </li>
        <% }) %>
      </ul>
    </div>
  </div>

  <script src="/js/kick-dashboard.js"></script>
  <script>
    const CHANNEL = '<%= channel.channel_id %>';
    const esc = s => String(s == null ? '' : s);

    // Toggle a built-in command.
    document.querySelectorAll('.cmd-enabled').forEach(cb => cb.addEventListener('change', async () => {
      try { await KickDash.post('/kick/api/channel/' + CHANNEL + '/commands/' + cb.dataset.key + '/toggle', { enabled: cb.checked }); }
      catch (e) { cb.checked = !cb.checked; alert(e.message || 'Toggle failed.'); }
    }));

    // Save a built-in override.
    document.querySelectorAll('.cmd-save').forEach(btn => btn.addEventListener('click', async () => {
      const k = btn.dataset.key;
      const q = sel => document.querySelector(sel + '[data-key="' + k + '"]');
      const aliases = q('.cmd-aliases').value.split(',').map(s => s.trim()).filter(Boolean);
      btn.disabled = true;
      try {
        await KickDash.put('/kick/api/channel/' + CHANNEL + '/commands/' + k, {
          custom_aliases: aliases,
          custom_response: q('.cmd-resp').value,
          cooldown_override: q('.cmd-cd').value || null,
          mod_only: q('.cmd-mod').checked
        });
        btn.textContent = 'Saved ✓';
      } catch (e) { alert(e.message || 'Save failed.'); }
      finally { btn.disabled = false; setTimeout(() => { btn.textContent = 'Save'; }, 1500); }
    }));

    // Add a custom command.
    document.getElementById('new-add').addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      try {
        await KickDash.post('/kick/api/channel/' + CHANNEL + '/custom', {
          command_name: document.getElementById('new-name').value,
          response: document.getElementById('new-resp').value,
          cooldown: document.getElementById('new-cd').value,
          mod_only: document.getElementById('new-mod').checked
        });
        location.reload();
      } catch (err) { btn.disabled = false; alert(err.message || 'Add failed.'); }
    });

    // Delete a custom command.
    document.querySelectorAll('.cc-del').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('Delete this command?')) return;
      try { await KickDash.del('/kick/api/channel/' + CHANNEL + '/custom/' + btn.dataset.id, {}); location.reload(); }
      catch (e) { alert(e.message || 'Delete failed.'); }
    }));
  </script>
```

- [ ] **Step 2: Add `put` to the shared helper** (the override route is a PUT). In `dashboard/public/js/kick-dashboard.js` add `put: (url, payload) => sendJson('PUT', url, payload),` to `window.KickDash`. (Task 3 added `patch`; this adds `put`. Both are one-liners.)

- [ ] **Step 3: Render-test (built-ins + overrides + customs + empty-safe)**

```bash
node -e "const ejs=require('ejs'),fs=require('fs');const t=fs.readFileSync('dashboard/views/kick/channel-commands.ejs','utf8');
const d={csrfToken:'x',user:{name:'u'},channel:{id:1,channel_id:'62249842',channel_name:'dd'},
  commands:[{command_key:'lit',description:'toke',category:'economy',cooldown_default:5,mod_only:0,default_aliases:null}],
  channelCommands:[{command_key:'lit',is_enabled:0,custom_aliases:'[\"l\"]',custom_response:'hi {{username}}',cooldown_override:7,mod_only:0}],
  customCommands:[{id:9,command_name:'discord',response:'join here',cooldown:5,mod_only:0,is_enabled:1,use_count:3}]};
const o=ejs.render(t,d);
console.log('OK len='+o.length,'builtins='+o.includes('!lit'),'override-alias='+o.includes('l'),'custom='+o.includes('!discord'),'put='+o.includes('KickDash.put'));
const e=ejs.render(t,{...d,channelCommands:[],customCommands:[]});console.log('empty-safe len='+e.length);"
```
Expected: `OK len=... builtins=true override-alias=true custom=true put=true` and `empty-safe len=...` (no throw).

- [ ] **Step 4: Restart + verify both pages gate**

```bash
pm2 restart CertiFriedUtility --update-env && sleep 12
echo "/kick/channel/123/commands -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:3001/kick/channel/123/commands)"
```
Expected: 302 (login gate).

- [ ] **Step 5: Commit**

```bash
git add dashboard/views/kick/channel-commands.ejs dashboard/public/js/kick-dashboard.js
git commit -m "feat(kick): command-management page + KickDash.put helper"
git show --stat --oneline HEAD
```

---

## Task 5: Link from the panel to the channel page

**Files:**
- Modify: `dashboard/views/kick/panel.ejs`

- [ ] **Step 1: Add a Settings link to each channel card.** In `dashboard/views/kick/panel.ejs`, inside the `channels.forEach` loop, in the `.row` that holds the channel name + enroll button (or just below it), add a link to the new page. Find the enroll `<button>` and add, immediately after it (still inside the `.row`):

```html
          <a class="settings-link" href="/kick/channel/<%= ch.channelId %>" style="margin-left:.5rem;font-size:.85rem;color:#9a93b3;text-decoration:none">Settings &amp; commands →</a>
```

- [ ] **Step 2: Render-test + restart**

```bash
node -e "const ejs=require('ejs'),fs=require('fs');const t=fs.readFileSync('dashboard/views/kick/panel.ejs','utf8');
const o=ejs.render(t,{csrfToken:'x',isManager:false,isAdmin:false,reauthHref:'/x',channels:[{channelId:'62249842',channelName:'dd',enabled:true,hasBanScope:true,hasManageScope:true,stats:{banned:0,deleted:0,dormant:0}}]});
console.log('link='+o.includes('/kick/channel/62249842'));"
pm2 restart CertiFriedUtility --update-env && sleep 12
echo "/kick -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:3001/kick)"
```
Expected: `link=true`, `/kick -> 302`.

- [ ] **Step 3: Commit**

```bash
git add dashboard/views/kick/panel.ejs
git commit -m "feat(kick): link panel channel cards to settings & commands page"
git show --stat --oneline HEAD
```

---

## Task 6: Full verification pass

- [ ] **Step 1: Unit tests** — `node --test tests/kick/resolve-owned-channel.test.js` → `# pass 3`. Plus the Phase 1 defender suite still green: `for f in tests/defender/*.test.js; do timeout 12 node --test "$f" 2>&1 | grep -E "^# (pass|fail)"; done`.

- [ ] **Step 2: Live route matrix**

```bash
for p in "/kick" "/kick/channel/123" "/kick/channel/123/commands"; do
  echo "$p -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:3001$p)"
done
echo "PATCH settings -> $(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H 'Content-Type: application/json' --max-time 8 http://127.0.0.1:3001/kick/api/channel/123 -d '{}')"
echo "POST toggle -> $(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --max-time 8 http://127.0.0.1:3001/kick/api/channel/123/commands/lit/toggle -d '{}')"
echo "POST custom -> $(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --max-time 8 http://127.0.0.1:3001/kick/api/channel/123/custom -d '{}')"
```
Expected: pages 302; API routes 403/302; none 404/500.

- [ ] **Step 3: No regression** — confirm the Phase 1 surfaces still serve: `/`, `/kick/managers`, `/kick/admin`, `/docs` all respond (200 or 302 as before).

---

## Self-Review Notes

- **Spec coverage (Phase 2 of the design doc):** channel settings (prefix/cooldowns/features) → Task 2 PATCH + Task 3 page; built-in command enable/disable + override → Task 2 toggle/PUT + Task 4 page; custom-command CRUD with {{template}} vars → Task 2 custom routes + Task 4 page; reuse of proven handlers → all routes copy tokes-bot's SQL/validators/cache-invalidation; Kick visual consistency → Tasks 3-4 reuse panel.ejs style + KickDash.
- **The identity bridge** (`channel_id`→PK) is isolated in one tested helper (Task 1) and used uniformly; no route does the lookup ad hoc.
- **No new tables/migrations** — Phase 2 is pure surfacing; all tables already exist.
- **Validators reused** (`validateCommandName/Response/Cooldown/Aliases/Boolean`) — no re-implementation of input rules.
- **Cache invalidation** (`invalidateChannelCache(pkId)`) called on every write so the running bot picks up changes — note it takes the PK id, matching tokes-bot's usage.
- **Security:** all routes `requireKickAuth` + per-call ownership resolve; custom-command name collision with built-ins rejected (409); responses validated against script-injection by `validateCommandResponse`; the commands view outputs `custom_response`/aliases via EJS `<%= %>` (auto-escaped) in form values.
- **KickDash gains `patch` + `put`** (Tasks 3-4) — small additions keeping the shared helper the single CSRF-correct client path.
