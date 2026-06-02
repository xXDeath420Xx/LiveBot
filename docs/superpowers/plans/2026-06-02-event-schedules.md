# Self-Service Event Schedules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any interested member of an enabled server publish a weekly Gantt-style event schedule (manual events + Twitch-imported segments), auto-rendered as a canvas image and auto-updated in a Discord channel.

**Architecture:** Mirror `core/twitch-schedule-manager.js` (Helix fetch via `utils/platforms/twitch-api.js`, schedule hash + change-detect + edit-in-place, cron `processAll`) and the node-canvas rendering used by the existing schedule/cards. Recurrence is stored as a rule and materialized into concrete weekly segments so manual-recurring, manual-one-off, and Twitch events share one render + change-detect path. Twitch import reuses `getTwitchUser`/`getStreamSchedule` (app-token; no user OAuth needed to read); OAuth only verifies ownership + stores the linked username.

**Tech Stack:** Node.js (ESM), discord.js v14, node-canvas (`canvas`), MySQL (`utils/db.js`), `node-cron`, Twitch Helix (`utils/platforms/twitch-api.js`), AES-256-GCM (`utils/encryption.js`), Node built-in test runner.

**Reference image:** `docs/Screenshot_20260602_140808_High_Seas_Hero.jpg`. **Spec:** `docs/superpowers/specs/2026-06-02-event-schedules-design.md`.

---

### Task 1: Migration 117 — schema (5 tables + default-category seed)

**Files:** Create `migrations/117_event_schedules.js`

- [ ] **Step 1: Write the migration**

```javascript
/**
 * Migration 117 — Self-service event schedules.
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
export async function up(db) {
  await db.execute(`CREATE TABLE IF NOT EXISTS event_schedule_config (
    guild_id VARCHAR(20) PRIMARY KEY,
    is_enabled TINYINT(1) NOT NULL DEFAULT 0,
    mode ENUM('combined','per_user') NOT NULL DEFAULT 'combined',
    channel_id VARCHAR(20) NULL,
    timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
    title VARCHAR(100) NOT NULL DEFAULT 'Event Calendar',
    custom_message VARCHAR(500) NULL,
    force_refresh TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS event_schedule_categories (
    id INT PRIMARY KEY AUTO_INCREMENT,
    guild_id VARCHAR(20) NOT NULL,
    name VARCHAR(60) NOT NULL,
    emoji VARCHAR(64) NULL,
    color VARCHAR(9) NOT NULL DEFAULT '#3498DB',
    sort_order INT NOT NULL DEFAULT 0,
    KEY idx_guild (guild_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS event_schedule_events (
    id INT PRIMARY KEY AUTO_INCREMENT,
    guild_id VARCHAR(20) NOT NULL,
    user_id VARCHAR(20) NOT NULL,
    category_id INT NULL,
    title VARCHAR(120) NOT NULL,
    emoji VARCHAR(64) NULL,
    start_time DATETIME NULL,
    end_time DATETIME NULL,
    recurrence ENUM('none','weekly') NOT NULL DEFAULT 'none',
    recur_dow TINYINT NULL,
    recur_start_min SMALLINT NULL,
    recur_end_min SMALLINT NULL,
    source ENUM('manual','twitch') NOT NULL DEFAULT 'manual',
    source_ref VARCHAR(64) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_guild (guild_id),
    KEY idx_guild_user (guild_id, user_id),
    KEY idx_source_ref (guild_id, user_id, source_ref)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS event_schedule_posts (
    id INT PRIMARY KEY AUTO_INCREMENT,
    guild_id VARCHAR(20) NOT NULL,
    user_id VARCHAR(20) NULL,
    channel_id VARCHAR(20) NULL,
    last_message_id VARCHAR(20) NULL,
    schedule_hash VARCHAR(64) NULL,
    change_detected_at DATETIME NULL,
    last_synced DATETIME NULL,
    UNIQUE KEY uniq_post (guild_id, user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS twitch_oauth_accounts (
    discord_user_id VARCHAR(20) PRIMARY KEY,
    twitch_user_id VARCHAR(32) NOT NULL,
    twitch_username VARCHAR(64) NOT NULL,
    access_token TEXT NULL,
    refresh_token TEXT NULL,
    expires_at DATETIME NULL,
    verified_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export async function down(db) {
  for (const t of ['event_schedule_posts','event_schedule_events','event_schedule_categories','event_schedule_config','twitch_oauth_accounts']) {
    await db.execute(`DROP TABLE IF EXISTS ${t}`).catch(() => {});
  }
}

/** Default category set seeded when a guild first enables the feature. */
export const DEFAULT_CATEGORIES = [
  { name: 'Streams',     emoji: '🔴', color: '#9146FF', sort_order: 0 },
  { name: 'Tournaments', emoji: '🏆', color: '#F1C40F', sort_order: 1 },
  { name: 'Community',   emoji: '🎉', color: '#2ECC71', sort_order: 2 },
  { name: 'Other',       emoji: '📌', color: '#3498DB', sort_order: 3 },
];
```

- [ ] **Step 2: Apply + verify**

```bash
node --input-type=module -e "import pool from './utils/db.js'; const { up } = await import('./migrations/117_event_schedules.js'); await up(pool); for (const t of ['event_schedule_config','event_schedule_categories','event_schedule_events','event_schedule_posts','twitch_oauth_accounts']) { const [r]=await pool.query('SHOW TABLES LIKE ?',[t]); console.log(t, r.length?'OK':'MISSING'); } process.exit(0);"
```
Expected: all five print `OK`.

- [ ] **Step 3: Commit**

```bash
git add migrations/117_event_schedules.js
git commit -m "feat(event-schedules): migration 117 — schema + default categories"
```

---

### Task 2: Pure helpers (TDD)

Materialization/grouping/hash with NO DB/Discord imports.

**Files:** Create `core/event-schedule-helpers.js`, Test `tests/event-schedule-helpers.test.js`

- [ ] **Step 1: Write the failing test** — `tests/event-schedule-helpers.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { weekStartFor, materializeWeek, groupByCategory, scheduleHash } from '../core/event-schedule-helpers.js';

const WEEK = new Date('2026-06-01T00:00:00Z'); // a Monday; weekStart (Sunday) = 2026-05-31

test('weekStartFor: returns the Sunday 00:00 UTC of the week', () => {
    const ws = weekStartFor(new Date('2026-06-02T13:00:00Z'));
    assert.equal(ws.toISOString(), '2026-05-31T00:00:00.000Z');
});

test('materializeWeek: one-off in window included, out-of-window excluded', () => {
    const ws = weekStartFor(new Date('2026-06-02T13:00:00Z')); // 05-31..06-07
    const events = [
        { id: 1, recurrence: 'none', start_time: '2026-06-02T18:00:00Z', end_time: '2026-06-02T20:00:00Z', title: 'A', category_id: 1, user_id: 'u1' },
        { id: 2, recurrence: 'none', start_time: '2026-06-20T18:00:00Z', end_time: null, title: 'B', category_id: 1, user_id: 'u1' },
    ];
    const segs = materializeWeek(events, ws);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].title, 'A');
});

test('materializeWeek: weekly event lands on its day-of-week within the window', () => {
    const ws = weekStartFor(new Date('2026-06-02T13:00:00Z')); // Sunday 05-31
    const events = [
        { id: 3, recurrence: 'weekly', recur_dow: 2, recur_start_min: 19 * 60, recur_end_min: 21 * 60, title: 'Tue Stream', category_id: 2, user_id: 'u2' },
    ];
    const segs = materializeWeek(events, ws);
    assert.equal(segs.length, 1);
    // Tuesday of that week = 2026-06-02, 19:00 UTC
    assert.equal(new Date(segs[0].start).toISOString(), '2026-06-02T19:00:00.000Z');
    assert.equal(new Date(segs[0].end).toISOString(), '2026-06-02T21:00:00.000Z');
});

test('groupByCategory: orders by category sort_order, unknown category -> Other bucket', () => {
    const cats = [{ id: 1, name: 'Streams', sort_order: 0 }, { id: 2, name: 'Tournaments', sort_order: 1 }];
    const segs = [{ categoryId: 2, title: 'T' }, { categoryId: 1, title: 'S' }, { categoryId: 999, title: 'U' }];
    const sections = groupByCategory(segs, cats);
    assert.deepEqual(sections.map(s => s.name), ['Streams', 'Tournaments', 'Uncategorized']);
});

test('scheduleHash: stable for equal content, differs on change', () => {
    const a = [{ start: 1, end: 2, title: 'X', categoryId: 1 }];
    const b = [{ start: 1, end: 2, title: 'X', categoryId: 1 }];
    const c = [{ start: 1, end: 2, title: 'Y', categoryId: 1 }];
    assert.equal(scheduleHash(a), scheduleHash(b));
    assert.notEqual(scheduleHash(a), scheduleHash(c));
});
```

- [ ] **Step 2: Run, confirm fail** — `node --test tests/event-schedule-helpers.test.js` → FAIL (module not found).

- [ ] **Step 3: Implement** — `core/event-schedule-helpers.js`:

```javascript
import crypto from 'crypto';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The Sunday 00:00 UTC of the week containing `date`. */
export function weekStartFor(date) {
    const d = new Date(date);
    const dow = d.getUTCDay(); // 0=Sun
    const sunday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
    return sunday;
}

/**
 * Expand events into concrete segments inside [weekStart, weekStart+7d).
 * - recurrence 'none': included iff start_time is in-window.
 * - recurrence 'weekly': materialized on recur_dow at recur_start_min..recur_end_min (UTC).
 * Returns flat segments: { start:number(ms), end:number(ms), title, emoji, categoryId, userId, source }.
 */
export function materializeWeek(events, weekStart) {
    const ws = weekStart.getTime();
    const we = ws + WEEK_MS;
    const out = [];
    for (const e of events) {
        if (e.recurrence === 'weekly' && e.recur_dow != null && e.recur_start_min != null) {
            const dayStart = ws + e.recur_dow * DAY_MS;
            const start = dayStart + e.recur_start_min * 60 * 1000;
            const end = e.recur_end_min != null ? dayStart + e.recur_end_min * 60 * 1000 : start + 60 * 60 * 1000;
            if (start >= ws && start < we) {
                out.push({ start, end, title: e.title, emoji: e.emoji ?? null, categoryId: e.category_id ?? null, userId: e.user_id, source: e.source ?? 'manual' });
            }
        } else if (e.start_time) {
            const start = new Date(e.start_time).getTime();
            if (start >= ws && start < we) {
                const end = e.end_time ? new Date(e.end_time).getTime() : start + 60 * 60 * 1000;
                out.push({ start, end, title: e.title, emoji: e.emoji ?? null, categoryId: e.category_id ?? null, userId: e.user_id, source: e.source ?? 'manual' });
            }
        }
    }
    out.sort((a, b) => a.start - b.start);
    return out;
}

/** Group segments into ordered category sections; unknown category_id -> "Uncategorized". */
export function groupByCategory(segments, categories) {
    const byId = new Map(categories.map(c => [c.id, c]));
    const buckets = new Map(); // categoryId -> { name, sort, items }
    for (const s of segments) {
        const cat = byId.get(s.categoryId);
        const key = cat ? cat.id : '__uncat__';
        if (!buckets.has(key)) {
            buckets.set(key, { id: cat?.id ?? null, name: cat?.name ?? 'Uncategorized', emoji: cat?.emoji ?? null, color: cat?.color ?? '#7F8C8D', sort: cat?.sort_order ?? 9999, items: [] });
        }
        buckets.get(key).items.push(s);
    }
    return [...buckets.values()].sort((a, b) => a.sort - b.sort);
}

/** Stable content hash for change-detection. */
export function scheduleHash(segments) {
    const norm = segments.map(s => `${s.start}|${s.end}|${s.categoryId}|${s.title}|${s.userId ?? ''}`).sort();
    return crypto.createHash('sha256').update(norm.join('\n')).digest('hex');
}
```

- [ ] **Step 4: Run, confirm pass** — `node --test tests/event-schedule-helpers.test.js` → PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add core/event-schedule-helpers.js
git add -f tests/event-schedule-helpers.test.js
git commit -m "feat(event-schedules): pure materialize/group/hash helpers with tests"
```

---

### Task 3: Twitch import module

Reuses `utils/platforms/twitch-api.js` (`getTwitchUser`, `getStreamSchedule` — app-token, no user OAuth needed). Upserts `source='twitch'` events keyed by `source_ref` (segment id), prunes stale.

**Files:** Create `core/event-schedule-twitch.js`

- [ ] **Step 1: Implement**

```javascript
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import twitchApi from '../utils/platforms/twitch-api.js';

const { getTwitchUser, getStreamSchedule } = twitchApi;

/**
 * Import a member's Twitch schedule into event_schedule_events as source='twitch'.
 * Reads the PUBLIC schedule via Helix (app token) — works without user OAuth.
 * @returns {Promise<{ imported:number, twitchUsername:string }>}
 */
export async function importTwitchSchedule(guildId, userId, username, { categoryId = null } = {}) {
    const cleanName = String(username).trim().replace(/^@/, '');
    const user = await getTwitchUser(cleanName);
    if (!user?.id) throw new Error(`Twitch user "${cleanName}" not found.`);

    const schedule = await getStreamSchedule(user.id).catch(() => null);
    const segments = schedule?.segments || schedule?.data?.segments || [];

    // Upsert each segment by its Twitch id (source_ref); collect ids to prune stale rows.
    const keptRefs = [];
    let imported = 0;
    for (const seg of segments) {
        const ref = seg.id;
        if (!ref || !seg.start_time) continue;
        keptRefs.push(ref);
        const title = (seg.title || user.display_name || cleanName).substring(0, 120);
        const [existing] = await pool.execute(
            'SELECT id FROM event_schedule_events WHERE guild_id=? AND user_id=? AND source=\'twitch\' AND source_ref=?',
            [guildId, userId, ref]
        );
        if (existing.length) {
            await pool.execute(
                'UPDATE event_schedule_events SET title=?, start_time=?, end_time=?, category_id=COALESCE(category_id,?), updated_at=NOW() WHERE id=?',
                [title, toMysql(seg.start_time), toMysql(seg.end_time), categoryId, existing[0].id]
            );
        } else {
            await pool.execute(
                `INSERT INTO event_schedule_events (guild_id,user_id,category_id,title,start_time,end_time,recurrence,source,source_ref)
                 VALUES (?,?,?,?,?,?, 'none','twitch', ?)`,
                [guildId, userId, categoryId, title, toMysql(seg.start_time), toMysql(seg.end_time), ref]
            );
            imported++;
        }
    }

    // Prune twitch events for this user that are no longer in the schedule.
    if (keptRefs.length) {
        const placeholders = keptRefs.map(() => '?').join(',');
        await pool.execute(
            `DELETE FROM event_schedule_events WHERE guild_id=? AND user_id=? AND source='twitch' AND source_ref NOT IN (${placeholders})`,
            [guildId, userId, ...keptRefs]
        );
    } else {
        await pool.execute("DELETE FROM event_schedule_events WHERE guild_id=? AND user_id=? AND source='twitch'", [guildId, userId]);
    }

    logger.info(`[EventSchedule] Imported ${segments.length} Twitch segments for ${cleanName} (guild ${guildId}, user ${userId})`);
    return { imported: segments.length, twitchUsername: user.display_name || cleanName };
}

function toMysql(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return isNaN(d) ? null : d.toISOString().slice(0, 19).replace('T', ' ');
}
```

- [ ] **Step 2: Verify it parses + helpers test still passes**

Run: `node --check core/event-schedule-twitch.js && node --test tests/event-schedule-helpers.test.js`
Expected: no syntax errors; 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add core/event-schedule-twitch.js
git commit -m "feat(event-schedules): Twitch schedule import via Helix (no OAuth needed to read)"
```

---

### Task 4: Gantt canvas renderer (implementer-iterated against the reference)

**This task is the visual one.** The implementer writes the canvas drawing code, iterating against the reference image (`docs/Screenshot_20260602_140808_High_Seas_Hero.jpg`) and reusing the canvas setup patterns in `core/twitch-schedule-manager.js` `_buildWeeklyImage` (font registration, `Canvas.createCanvas`, gradient header, day strip).

**Files:** Create `utils/event-schedule-renderer.js`

**Contract (exact signature + output — must match for the manager to consume it):**
```javascript
// utils/event-schedule-renderer.js
// export default async function renderEventSchedule(model) -> Promise<Buffer|null>
//
// model = {
//   title: string,                 // header title (config.title)
//   timestampLabel: string,        // e.g. "2026-06-02 13:08:07 UTC" (already formatted)
//   weekDays: [{ label:'Sun', date:'05/31', isToday:boolean }, ... 7],
//   sections: [{ name, emoji, color, items: [{ startCol:0..6, span:1..7, title, emoji, source }] }],
//   footer: string                 // "Actual event times are subject to change."
// }
// Returns a PNG Buffer, or null if `canvas` is unavailable (graceful, like the existing manager).
```

Layout requirements (match the reference):
- Width ~1080; gradient header band with `title` + `timestampLabel` + a calendar glyph.
- A 7-column day strip below the header; highlight the `isToday` column (both in the strip and as a faint vertical band through the body).
- One block per section: a left-aligned label bar (`emoji name`), then the section's events as **horizontal rounded bars** positioned at `startCol` and spanning `span` day-columns, each with its `emoji` + truncated `title`. Color the bar by section `color`.
- Footer text centered at the bottom.
- Register a font if the existing manager does; otherwise use system `Arial` like `_buildWeeklyImage`.

- [ ] **Step 1:** Read `core/twitch-schedule-manager.js` `_buildWeeklyImage` (~line 386+) and the reference image. Reuse the `Canvas` optional-import guard (`let Canvas=null; try{Canvas=await import('canvas')}catch{}`) and `return null` when unavailable.
- [ ] **Step 2:** Implement `renderEventSchedule(model)` per the contract + layout. Compute column X positions from width; map `startCol`/`span` to bar geometry; clip/truncate long titles.
- [ ] **Step 3:** Render a sample and eyeball it. Run:
```bash
node --input-type=module -e "
import render from './utils/event-schedule-renderer.js';
import fs from 'fs';
const model = { title:'Event Calendar', timestampLabel:'2026-06-02 13:08 UTC',
 weekDays:[['Sun','05/31'],['Mon','06/01'],['Tue','06/02'],['Wed','06/03'],['Thu','06/04'],['Fri','06/05'],['Sat','06/06']].map((d,i)=>({label:d[0],date:d[1],isToday:i===2})),
 sections:[{name:'Streams',emoji:'🔴',color:'#9146FF',items:[{startCol:2,span:3,title:'State Warfare',emoji:'🟡',source:'manual'}]},
           {name:'Community',emoji:'🎉',color:'#2ECC71',items:[{startCol:1,span:1,title:'Purr-fect',emoji:'🐱',source:'manual'}]}],
 footer:'Actual event times are subject to change.' };
const buf = await render(model); fs.writeFileSync('/tmp/sched-sample.png', buf); console.log('wrote', buf.length, 'bytes'); process.exit(0);"
```
Expected: writes a PNG; open `/tmp/sched-sample.png` and confirm it resembles the reference (header, highlighted Tue column, two category rows with spanning bars, footer). Iterate until it looks right. If `buf` is null, ensure `canvas` is installed (`node -e "require('canvas')"`).
- [ ] **Step 4: Commit**
```bash
git add utils/event-schedule-renderer.js
git commit -m "feat(event-schedules): Gantt-style weekly canvas renderer"
```

---

### Task 5: Manager — gather → materialize → render → change-detect → post/edit

**Files:** Create `core/event-schedule-manager.js`

- [ ] **Step 1: Implement** (mirrors `twitch-schedule-manager` post/edit + hash flow):

```javascript
import { AttachmentBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { weekStartFor, materializeWeek, groupByCategory, scheduleHash } from './event-schedule-helpers.js';
import renderEventSchedule from '../utils/event-schedule-renderer.js';

const COOLDOWN_MS = 10 * 60 * 1000; // mirror the twitch manager's 10-min settle window

class EventScheduleManager {
  constructor(client) { this.client = client; logger.info('[EventSchedule] Manager initialized'); }

  async getConfig(guildId) {
    const [rows] = await pool.execute('SELECT * FROM event_schedule_config WHERE guild_id = ?', [guildId]);
    return rows[0] || null;
  }

  /** Build the renderer model for a set of events + the guild's categories. */
  async buildModel(config, events, categories) {
    const now = new Date();
    const ws = weekStartFor(now);
    const segs = materializeWeek(events, ws);
    if (!segs.length) return { model: null, hash: scheduleHash([]) };
    const sections = groupByCategory(segs, categories).map(sec => ({
      name: sec.name, emoji: sec.emoji, color: sec.color,
      items: sec.items.map(it => {
        const startCol = Math.max(0, Math.min(6, Math.floor((it.start - ws.getTime()) / (24 * 60 * 60 * 1000))));
        const endCol = Math.max(startCol, Math.min(6, Math.floor((it.end - 1 - ws.getTime()) / (24 * 60 * 60 * 1000))));
        return { startCol, span: endCol - startCol + 1, title: it.title, emoji: it.emoji, source: it.source };
      }),
    }));
    const weekDays = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(ws.getTime() + i * 24 * 60 * 60 * 1000);
      const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const isToday = d.toDateString() === now.toDateString();
      return { label: labels[i], date: `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`, isToday };
    });
    const model = {
      title: config.title || 'Event Calendar',
      timestampLabel: `${now.toISOString().slice(0, 19).replace('T', ' ')} UTC`,
      weekDays, sections, footer: 'Actual event times are subject to change.',
    };
    return { model, hash: scheduleHash(segs) };
  }

  /** Render + post/edit a single board (combined: userId=null; per_user: a specific user). */
  async syncBoard(config, userId) {
    const guildId = config.guild_id;
    const [cats] = await pool.execute('SELECT * FROM event_schedule_categories WHERE guild_id = ? ORDER BY sort_order', [guildId]);
    const eventsSql = userId
      ? 'SELECT * FROM event_schedule_events WHERE guild_id=? AND user_id=?'
      : 'SELECT * FROM event_schedule_events WHERE guild_id=?';
    const [events] = await pool.execute(eventsSql, userId ? [guildId, userId] : [guildId]);

    const { model, hash } = await this.buildModel(config, events, cats);

    const [postRows] = await pool.execute(
      'SELECT * FROM event_schedule_posts WHERE guild_id=? AND user_id <=> ?', [guildId, userId]
    );
    const post = postRows[0];

    if (post && post.schedule_hash === hash) return; // unchanged

    // Cooldown settle window (so rapid edits batch into one post).
    if (post && post.schedule_hash && post.change_detected_at) {
      const elapsed = Date.now() - new Date(post.change_detected_at).getTime();
      if (elapsed < COOLDOWN_MS && !config.force_refresh) return;
    } else if (post && post.schedule_hash) {
      await pool.execute('UPDATE event_schedule_posts SET change_detected_at=NOW() WHERE id=?', [post.id]);
      if (!config.force_refresh) return;
    }

    const client = global.botManager?.getClientForGuild?.(guildId) || this.client;
    const channel = await client.channels.fetch(config.channel_id).catch(() => null);
    if (!channel?.isTextBased?.()) { logger.warn(`[EventSchedule] No channel for guild ${guildId}`); return; }

    let messageId = post?.last_message_id || null;
    const buffer = model ? await renderEventSchedule(model) : null;
    const content = config.custom_message || (userId ? `<@${userId}>'s event schedule` : null);
    const payload = buffer
      ? { content: content || undefined, files: [new AttachmentBuilder(buffer, { name: 'schedule.png' })] }
      : { content: content || 'No upcoming events.' };

    try {
      if (messageId) {
        const msg = await channel.messages.fetch(messageId).catch(() => null);
        if (msg) await msg.edit(payload); else messageId = (await channel.send(payload)).id;
      } else {
        messageId = (await channel.send(payload)).id;
      }
    } catch (e) { logger.error(`[EventSchedule] post/edit failed for guild ${guildId}: ${e.message}`); return; }

    await pool.execute(
      `INSERT INTO event_schedule_posts (guild_id,user_id,channel_id,last_message_id,schedule_hash,change_detected_at,last_synced)
       VALUES (?,?,?,?,?,NULL,NOW())
       ON DUPLICATE KEY UPDATE channel_id=VALUES(channel_id), last_message_id=VALUES(last_message_id), schedule_hash=VALUES(schedule_hash), change_detected_at=NULL, last_synced=NOW()`,
      [guildId, userId, config.channel_id, messageId, hash]
    );
  }

  async syncGuild(guildId) {
    const config = await this.getConfig(guildId);
    if (!config || !config.is_enabled || !config.channel_id) return;
    if (config.mode === 'per_user') {
      const [owners] = await pool.execute('SELECT DISTINCT user_id FROM event_schedule_events WHERE guild_id=?', [guildId]);
      for (const { user_id } of owners) await this.syncBoard(config, user_id).catch(e => logger.error(`[EventSchedule] user board ${user_id}: ${e.message}`));
    } else {
      await this.syncBoard(config, null);
    }
    if (config.force_refresh) await pool.execute('UPDATE event_schedule_config SET force_refresh=0 WHERE guild_id=?', [guildId]);
  }

  async processAll() {
    const [guilds] = await pool.execute('SELECT guild_id FROM event_schedule_config WHERE is_enabled=1 AND channel_id IS NOT NULL');
    for (const { guild_id } of guilds) await this.syncGuild(guild_id).catch(e => logger.error(`[EventSchedule] guild ${guild_id}: ${e.message}`));
  }
}

export default EventScheduleManager;
```

- [ ] **Step 2: Verify parse** — `node --check core/event-schedule-manager.js` (exit 0).
- [ ] **Step 3: Commit**
```bash
git add core/event-schedule-manager.js
git commit -m "feat(event-schedules): manager (materialize/render/change-detect/post-edit, combined+per_user)"
```

---

### Task 6: Cron job + manager wiring in index.js

**Files:** Create `jobs/event-schedule-checker.js`; Modify `index.js`

- [ ] **Step 1: Create the job** — `jobs/event-schedule-checker.js`:

```javascript
import cron from 'node-cron';
import logger from '../utils/logger.js';
import EventScheduleManager from '../core/event-schedule-manager.js';

let task = null;
let manager = null;

export function startEventScheduleChecker(client) {
  if (task) return; // singleton
  manager = new EventScheduleManager(client);
  task = cron.schedule('*/5 * * * *', async () => {
    try { await manager.processAll(); } catch (e) { logger.error(`[EventSchedule] cycle error: ${e.message}`); }
  });
  logger.info('[EventSchedule] Checker started (every 5 min)');
}

export function getEventScheduleManager() { return manager; }
export function stopEventScheduleChecker() { if (task) { task.stop(); task = null; } }
export default { startEventScheduleChecker, stopEventScheduleChecker, getEventScheduleManager };
```

- [ ] **Step 2: Register in index.js** — add the import near the other job imports:
```javascript
import { startEventScheduleChecker, stopEventScheduleChecker } from './jobs/event-schedule-checker.js';
```
Find the line `startTikTokVideoChecker(client);` (in the default-bot scheduler block) and add AFTER it:
```javascript
  startEventScheduleChecker(client);
```
Find the shutdown line `stopTikTokVideoChecker();` and add AFTER it:
```javascript
    stopEventScheduleChecker();
```

- [ ] **Step 3: Verify parse** — `node --check jobs/event-schedule-checker.js && node --check index.js` (exit 0).
- [ ] **Step 4: Commit**
```bash
git add jobs/event-schedule-checker.js index.js
git commit -m "feat(event-schedules): 5-min cron checker + index.js wiring"
```

---

### Task 7: Commands — `/schedule` (self-serve + admin)

**Files:** Create `commands/community/schedule.js`

Self-serve: `add` (title, day/time or date, category, recurrence), `remove` (own events, picks by id), `list` (own events), `twitch-sync` (username → import). Admin (Administrator): `setup` (channel, mode), `category` (add a category), `disable`, `refresh` (force re-post).

- [ ] **Step 1: Implement** the command (standard discord.js `SlashCommandBuilder` + `execute(interaction)` dispatch). Use `EventScheduleManager` via `getEventScheduleManager()` for `refresh`, and `importTwitchSchedule` for `twitch-sync`. Gate admin subcommands on `interaction.member.permissions.has(PermissionFlagsBits.Administrator)`. On first `setup`, if the guild has no categories, seed `DEFAULT_CATEGORIES` from `migrations/117_event_schedules.js`. Validate times with the helpers. Members may only `remove` their own events (`WHERE guild_id=? AND user_id=? AND id=?`).

Provide the full builder + handlers (the implementer writes this against the existing command pattern in `commands/community/engage.js`; keep each subcommand handler small and ephemeral-reply). Reference the engage command's structure for the loader contract (`export default { data, execute }`).

- [ ] **Step 2: Verify parse + builder** — `node --check commands/community/schedule.js`; then:
```bash
node --input-type=module -e "const m=await import('./commands/community/schedule.js'); const subs=m.default.data.toJSON().options.map(o=>o.name); console.log('subcommands:', subs.join(',')); process.exit(0);"
```
Expected: prints `add,remove,list,twitch-sync,setup,category,disable,refresh` (order may vary).

- [ ] **Step 3: Commit**
```bash
git add commands/community/schedule.js
git commit -m "feat(event-schedules): /schedule command (self-serve add/remove/list/twitch-sync + admin)"
```

---

### Task 8: Dashboard — manage page + member events page + API

**Files:** Create `dashboard/routes/api/features/event-schedule.js`, `dashboard/views/partials/manage/event-schedule.ejs`; Modify `dashboard/views/manage-tailwind.ejs` (pageMap), `dashboard/routes/api/index.js` (mount), and the manage render in `dashboard/server.js` if a sidebar entry is needed.

Guild-scoped API (all `WHERE guild_id=?`): GET config+categories+events; POST config (enable/mode/channel/title — Administrator); POST category (add/delete — Administrator); POST event (member adds own); DELETE event (own only). The member page lists the member's own events + a "Connect Twitch" button (Task 9) + a "Sync by username" form (calls `importTwitchSchedule`).

- [ ] **Step 1:** Build the API route mirroring `dashboard/routes/api/features/leveling.js` (guild-scoped, `checkAuth`/`checkGuildAdmin` where admin). Mount it in `dashboard/routes/api/index.js` next to the others.
- [ ] **Step 2:** Build the partial mirroring `dashboard/views/partials/manage/achievements.ejs` (client-side fetch of the API). Add `'event-schedule': { partial: 'event-schedule', data: { guild, channels } }` to the `pageMap` in `manage-tailwind.ejs` (the `include('partials/manage/${partial}')` path).
- [ ] **Step 3:** Verify the API route + EJS compile: `node --check dashboard/routes/api/features/event-schedule.js` and `node -e "require('ejs').compile(require('fs').readFileSync('dashboard/views/partials/manage/event-schedule.ejs','utf8'),{filename:'x'})"`.
- [ ] **Step 4: Commit**
```bash
git add dashboard/routes/api/features/event-schedule.js dashboard/views/partials/manage/event-schedule.ejs dashboard/views/manage-tailwind.ejs dashboard/routes/api/index.js
git commit -m "feat(event-schedules): dashboard manage + member events page + API"
```

---

### Task 9: Twitch OAuth (ownership verification)

**Files:** Create `dashboard/routes/auth-twitch.js`; Modify `dashboard/app.js` or `dashboard/server.js` (mount the routes), add a "Connect Twitch" button to the member page (Task 8 partial).

- [ ] **Step 1:** Implement the OAuth2 flow (no passport needed — manual code exchange, like other integrations):
  - `GET /auth/twitch` — requires a logged-in Discord session (`req.user`); redirect to `https://id.twitch.tv/oauth2/authorize?client_id=…&redirect_uri=…&response_type=code&scope=user:read:email` with a signed `state`.
  - `GET /auth/twitch/callback` — verify `state`; exchange `code` at `https://id.twitch.tv/oauth2/token`; call Helix `GET /users` with the user token to get the verified `twitch_user_id`/login; upsert `twitch_oauth_accounts` for the Discord `req.user.id` with tokens encrypted via `utils/encryption.js` (`encryption.encrypt(JSON.stringify({...}))`); redirect back to the member page with `?twitch=connected`.
- [ ] **Step 2:** Mount the router where the Discord auth routes are mounted (grep `dashboard/` for `/auth/discord` to find the mount point). Add `TWITCH_REDIRECT_URI` to `.env` usage (document it; falls back to `${DASHBOARD_URL}/auth/twitch/callback`).
- [ ] **Step 3:** Add the "Connect Twitch" link/button to the member event-schedule partial pointing at `/auth/twitch`. After connecting, the member's `twitch-sync` defaults to their verified username.
- [ ] **Step 4:** Verify parse: `node --check dashboard/routes/auth-twitch.js`.
- [ ] **Step 5: Commit**
```bash
git add dashboard/routes/auth-twitch.js dashboard/views/partials/manage/event-schedule.ejs dashboard/app.js
git commit -m "feat(event-schedules): Twitch OAuth account-link for ownership verification"
```

---

### Task 10: Deploy + verify (PAUSE for user)

Migrations applied in Task 1. Commands changed → redeploy on restart. Restarts the fleet — get user go-ahead.

- [ ] **Step 1:** `pm2 restart CertiFriedUtility`; confirm online + no startup errors (`grep -iE "EventSchedule|event-schedule|ERR_MODULE" pm2 logs`).
- [ ] **Step 2: Manual (Discord + dashboard):** enable via `/schedule setup` (or dashboard); add a one-off + a weekly event; confirm the Gantt image posts to the channel and matches the reference; edit an event and confirm edit-in-place after the cooldown; `/schedule twitch-sync <username>` imports segments; Connect Twitch via dashboard OAuth; toggle `per_user` mode and confirm per-user posts.

---

## Notes for the implementer

- **Reuse, don't rebuild:** Twitch reads go through `utils/platforms/twitch-api.js` (`getTwitchUser`/`getStreamSchedule`, app-token); the manager mirrors `twitch-schedule-manager`'s hash+cooldown+edit pattern; the renderer mirrors `_buildWeeklyImage`'s canvas setup.
- **One render path:** manual-recurring, manual-one-off, and Twitch events all become segments via `materializeWeek`, so the renderer/hash never special-case source.
- **Multi-bot:** resolve each guild's client via `global.botManager.getClientForGuild` (never iterate a shared guild list against one client).
- **Security:** admin subcommands/config re-check `Administrator` server-side; members mutate only their own events (`user_id` guard on every write/delete); Twitch tokens encrypted at rest.
- **Times are UTC** in the DB; the renderer/materializer use UTC day-columns (the reference header is UTC). A future enhancement can convert to `config.timezone` for display.
- **`<=>` null-safe equality** is used for `user_id` post lookups (combined board = NULL user_id).
- **gitignored tests:** `tests/` needs `git add -f`.
