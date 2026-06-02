# Self-Service Event Schedules — Design

**Date:** 2026-06-02
**Status:** Approved (design)

## Problem

Servers want any interested member (not just admins) to publish an event schedule
rendered as a weekly **Gantt-style timeline** (per the reference
`docs/Screenshot_20260602_140808_High_Seas_Hero.jpg`: a 7-day week strip with
"today" highlighted, custom category sections, and events as horizontal bars
spanning their days with an icon + label). Members can enter events manually OR
import their **Twitch** schedule. This is distinct from the existing admin-only
`twitch-schedule-manager` (which syncs one streamer's stream slots in a different
visual style).

## Decisions (locked)

- **One comprehensive spec** (events + Gantt render + Twitch import in one).
- **Per-guild mode, configurable:** `combined` (everyone's events on one board,
  grouped by category) OR `per_user` (each contributor gets their own post).
- **Open self-serve:** any member adds/manages their own events; admins configure.
- **Output:** Discord auto-posted, auto-updated canvas image (reuses the existing
  hash + cooldown + edit-message machinery). Per-guild enable.
- **Recurrence:** members can add a `weekly` recurring slot OR a one-off dated event.
- **Categories:** per-server custom (admin-defined name + emoji + color + order).
- **Twitch import:** OAuth (verified ownership) AND no-OAuth-by-username. **Both
  read via the Helix schedule API** — no Puppeteer page-scraping (Helix reads public
  schedules reliably; OAuth's role is ownership verification + token storage, not
  reading). True HTML scraping is explicitly out of scope.

## Architecture

Mirror the proven `core/twitch-schedule-manager.js` patterns (Helix fetch, schedule
hash, change-detect + 10-minute cooldown, edit-in-place via `last_message_id`,
cron `processAll`) and the node-canvas rendering used across the codebase
(`utils/welcomeCard.js`, `utils/rank-card-generator.js`, the manager's
`_buildWeeklyImage`). Recurrence is stored as a rule and **materialized** into
concrete weekly segments at render time, so manual-recurring, manual-one-off, and
Twitch-imported events all flow through one render + change-detect path.

## Data model (new tables; migrations start at 117)

- `event_schedule_config` — per guild: `guild_id` PK, `is_enabled` TINYINT,
  `mode` ENUM('combined','per_user') DEFAULT 'combined', `channel_id` VARCHAR(20),
  `timezone` VARCHAR(64) DEFAULT 'UTC', `title` VARCHAR(100) DEFAULT 'Event Calendar',
  `custom_message` VARCHAR(500) NULL, `force_refresh` TINYINT DEFAULT 0.
- `event_schedule_categories` — `id` PK, `guild_id`, `name` VARCHAR(60),
  `emoji` VARCHAR(64) NULL, `color` VARCHAR(9) DEFAULT '#3498DB', `sort_order` INT
  DEFAULT 0. (A guild with none gets a seeded default set on first enable.)
- `event_schedule_events` — `id` PK, `guild_id`, `user_id` VARCHAR(20) (owner),
  `category_id` INT NULL (FK-ish), `title` VARCHAR(120), `emoji` VARCHAR(64) NULL,
  `start_time` DATETIME, `end_time` DATETIME NULL, `recurrence` ENUM('none','weekly')
  DEFAULT 'none', `recur_dow` TINYINT NULL (0=Sun..6=Sat), `recur_start_min` SMALLINT
  NULL (minutes past midnight, for weekly), `recur_end_min` SMALLINT NULL,
  `source` ENUM('manual','twitch') DEFAULT 'manual', `source_ref` VARCHAR(64) NULL
  (twitch segment id, for dedupe/update), `created_at`, `updated_at`.
  Times are stored in **UTC**; the materializer/renderer convert to the guild
  `timezone` for display (one canonical clock; matches the reference's UTC header).
- `event_schedule_posts` — tracks each rendered post for edit-in-place:
  `id` PK, `guild_id`, `user_id` VARCHAR(20) NULL (NULL = the combined board),
  `channel_id` VARCHAR(20), `last_message_id` VARCHAR(20) NULL, `schedule_hash`
  VARCHAR(64) NULL, `change_detected_at` DATETIME NULL, `last_synced` DATETIME NULL.
  UNIQUE(`guild_id`, `user_id`).
- `twitch_oauth_accounts` — global per Discord user (OAuth-verified ownership):
  `discord_user_id` VARCHAR(20) PK, `twitch_user_id` VARCHAR(32), `twitch_username`
  VARCHAR(64), `access_token` TEXT (AES-256-GCM via `utils/encryption.js`),
  `refresh_token` TEXT, `expires_at` DATETIME, `verified_at` DATETIME. Does NOT
  disturb the existing self-asserted `community_twitch_links` table.

## Components

### Pure helpers — `core/event-schedule-helpers.js` (no DB/Discord; unit-tested)
- `materializeWeek(events, weekStart, tz)` → expand `weekly` events into concrete
  `{start, end, ...}` segments falling within the 7-day window `[weekStart, +7d)`;
  pass through `none` events whose `start_time` is in-window. Returns a flat segment
  list with `categoryId`, `title`, `emoji`, `source`, `userId`.
- `groupByCategory(segments, categories)` → ordered sections for the renderer.
- `scheduleHash(segments)` → stable hash of the rendered content (drives
  change-detection; same idea as the Twitch manager's `schedule_hash`).
- `weekStartFor(date, tz)` → the Sunday (or configured first day) 00:00 local.

### Renderer — `utils/event-schedule-renderer.js` (node-canvas)
`renderEventSchedule({ title, timestamp, tz, weekDays, sections })` → PNG Buffer.
Layout per the reference: header band (title + timestamp), 7-column day strip with
the current day highlighted, one block per category (label bar + event bars
positioned/spanned by day with emoji + title), footer "Actual event times are
subject to change." Reuses font registration + gradient/box patterns already in the
codebase. Returns a Buffer for `AttachmentBuilder`.

### Manager — `core/event-schedule-manager.js`
Mirrors `twitch-schedule-manager`:
- `syncGuild(guildId, { skipCooldown })` — load config; if disabled, no-op. Build the
  segment set (manual + twitch, materialized) for the week. For `combined`: one
  board (post row `user_id IS NULL`). For `per_user`: iterate distinct owners, render
  each. Hash → if unchanged, skip; if changed, set `change_detected_at` and wait the
  cooldown; once elapsed, render + post/edit and store `last_message_id` + hash.
- `importTwitch(guildId, userId, { twitchUserId })` — fetch the user's Helix schedule
  (reuse the Twitch manager's fetch helper), upsert `source='twitch'` events keyed by
  `source_ref` (segment id); remove stale twitch events no longer in the schedule.
- `processAll()` — cron entry: re-materialize, re-import twitch (on the sync cadence),
  re-render changed boards. Started/stopped in `index.js` like the other checkers.
- `client` resolution per guild via `global.botManager.getClientForGuild` (multi-bot).

### Twitch OAuth — `dashboard/routes/auth-twitch.js` + helper
- `/auth/twitch` (requires Discord-logged-in session) → redirect to Twitch authorize
  (minimal scope; schedule is public, so scope is for identity/ownership only).
- `/auth/twitch/callback` → exchange code → fetch the Twitch user → upsert
  `twitch_oauth_accounts` for `req.user` (the Discord user), tokens encrypted.
- `utils/twitch-helix.js` (new or reuse from the manager) centralizes app-token +
  Helix schedule fetch by `twitch_user_id`/login, with token caching.

### Entry points
- **Commands** (`commands/community/` or a new `commands/community/schedule.js`):
  self-serve `/schedule add | remove | list | twitch-sync`; admin (Administrator)
  `/schedule setup | mode | category | disable`. Routed through the standard command
  loader; modal/select handlers (category pick, recurrence) via `handlerRegistry` if
  needed.
- **Dashboard:** `?page=event-schedule` manage partial (enable, mode, channel,
  categories CRUD) wired into `manage-tailwind` like other features; a member-facing
  add/manage-events view with a **Connect Twitch** button (OAuth). API routes under
  `dashboard/routes/api/features/event-schedule.js`, all guild-scoped.

### Cron — `jobs/event-schedule-checker.js`
`node-cron` (e.g. every 5 min), singleton, iterates `global.botManager.clients` →
their guilds with `is_enabled=1` → `manager.processAll`-style sync. A daily/weekly
tick re-materializes the new week and refreshes Twitch imports. Registered + stopped
in `index.js` alongside the existing checkers.

## Data flow

```
member /schedule add (or dashboard)            -> insert event_schedule_events
member Connect Twitch (OAuth) / twitch-sync    -> twitch_oauth_accounts + Helix pull -> upsert source='twitch' events
member /schedule twitch-sync <username> (no OAuth) -> Helix-by-username -> upsert source='twitch' events
cron (5 min) -> manager.processAll
  per enabled guild: materializeWeek(events) -> groupByCategory -> renderEventSchedule -> hash
    changed? -> cooldown -> post/edit channel message (combined: 1; per_user: N) -> store last_message_id+hash
```

## Error handling

- Helix/OAuth failures are caught per-user and logged; a failed Twitch import never
  blocks manual events or other users' boards.
- Renderer returns null on empty schedule; manager skips posting an empty board.
- All admin/config writes Administrator-gated server-side; members may only edit their
  OWN events (ownership checked by `user_id` on every mutation).
- Tokens encrypted at rest; refresh on expiry, drop the link on refresh failure.
- Multi-bot: never reconcile a shared guild list against one client's cache; resolve
  each guild's owning client.

## Testing

- **Unit (`core/event-schedule-helpers.js`):** `materializeWeek` (weekly event lands
  on the right day/time within the window; out-of-window one-off excluded; DST/tz
  boundary), `groupByCategory` (ordering, uncategorized bucket), `scheduleHash`
  (stable for equal content, differs on change), `weekStartFor`.
- **Manual:** enable in a test guild; add a one-off + a weekly event; confirm the
  rendered image matches the reference layout; confirm edit-in-place on change;
  Connect Twitch via OAuth and via `/schedule twitch-sync <username>` and confirm
  imported segments appear; per_user vs combined mode.

## Build order (single plan, internally phased)

1. Migrations 117–121 (the five tables) + default-category seed.
2. Pure helpers + tests.
3. Renderer (canvas) — verify against the reference image with sample data.
4. Manager (gather → materialize → render → change-detect → post/edit) + cron.
5. Self-serve + admin commands.
6. Dashboard manage + member pages + API.
7. Twitch: `utils/twitch-helix.js` fetch, no-OAuth `/schedule twitch-sync`, then the
   OAuth flow (`auth-twitch.js` + `twitch_oauth_accounts`) + dashboard Connect button.
8. Deploy (migrations + restart + command redeploy) — paused for the user.

## Out of scope (YAGNI)

- True HTML/Puppeteer scraping of Twitch schedule pages (Helix-by-username replaces it).
- Cross-guild/global event boards (per-guild only).
- Per-event RSVP/attendance, reminders/notifications (separate feature).
- ICS export / Google Calendar sync.
- Editing another member's events (owners only; admins can disable the feature/remove via DB if needed).
