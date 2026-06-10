# Kick Creator Dashboard — Design

**Date:** 2026-06-10
**Status:** Approved direction; phased build
**Surface:** `https://certifriedmultitool.com/kick`

## Context

`/kick` today is a thin Kick Defender panel: list your channels, toggle the
defender, and (for managers) edit a shared banlist. The user finds it "extremely
basic" and wants "more control / more access."

A parity inventory of the code copied from CannaFriend revealed the real
situation: **the backend is far richer than `/kick` exposes.** Two large,
working capability sets already run in Kick chat but have little or no web UI:

1. **The Defender** — enforcement engine supports sublist, unbanlist,
   per-action timeout-vs-ban, repeat-offender escalation, and a full
   `kbd_enforcement_log` audit trail. The web UI exposes only banlist + a stat
   summary.
2. **The Tokes bot** — a complete cannabis chat-bot (economy `!lit`/`!spark`,
   leveling, games `!sesh`/`!trivia`, leaderboards `!fireboard`, strain library,
   custom commands with `{{template}}` variables, per-channel config). All of
   its CRUD + analytics endpoints exist and work, but lived only on the now-
   hidden `/tokes-bot` site.

**This is ~80% a surfacing problem, not a greenfield build.** The expensive
parts (enforcement engine, game loops, custom-command CRUD, analytics queries)
are written and battle-tested. The work is a unified creator dashboard that
exposes them, plus a thin config layer (durations, thresholds, per-channel
toggles) the engine already accepts but nothing currently sets.

**Intended outcome:** `/kick` becomes a full creator control center — a streamer
logs in once and controls protection, channel behavior, commands, games, and
sees insights, all in one branded place; the owner gets network-wide admin.

## Goals

- Surface existing backend capability through a coherent `/kick` dashboard.
- Add the small set of genuinely-missing config (timeout durations, escalation
  threshold, custom warning text, per-channel safe-domain overrides).
- Re-home the proven `/tokes-bot` channel/command/analytics handlers under
  `/kick` (reuse, don't rewrite), keeping the `/tokes-bot` name hidden.
- One visual system: Mission Control chrome (Space Grotesk + dark gradient) for
  navigation/shell; dense control-panel patterns (tables, filters, toggles)
  inside each section.

## Non-Goals

- No new chat commands or game mechanics — we expose what exists.
- No Twitch dashboard work (the bot supports Twitch, but this is the Kick
  surface; Twitch reuse is a later, separate spec).
- No CFX/extension game UI (it has its own web surface already).
- No changes to the Discord bot.

---

## Architecture

### Routing & shell

A single Express router, `dashboard/routes/kick-dashboard.js` (grown from the
current `kick-defender.js`), mounts all sections under `/kick`. Every page
renders inside a shared shell partial:

```
dashboard/views/kick/
  _shell.ejs        ← nav chrome (Mission Control style), section tabs, footer
  panel.ejs         ← "My Channels" home (exists; restyled into shell)
  channel.ejs       ← per-channel control center (NEW; tabbed)
  defender.ejs      ← Defender management (grown from current managers.ejs)
  admin.ejs         ← owner: connected accounts + network admin (exists; extend)
  insights.ejs      ← analytics (NEW; wires to existing APIs)
```

Section tabs (visibility gated by role): **My Channels · Channel · Defender ·
Insights · Admin**. Roles already exist: streamer < manager < admin (owner).

### Data layer — reuse, don't rebuild

The proven handlers in `dashboard/routes/tokes-bot.js` (channel settings PATCH,
per-channel command toggle/override, custom-commands CRUD, analytics overview/
realtime/retention) are mounted today but gated behind the hidden-site redirect.
We **extract their logic into shared functions** and expose them under `/kick`
paths. The `/tokes-bot/api/**` routes stay allowed (the existing gate already
permits `/tokes-bot/api/**`), so we can either:
- (preferred) call the same controller functions from new `/kick/api/**` routes, or
- have the new dashboard's client JS hit the existing `/tokes-bot/api/**`
  endpoints directly.

Decision: **new `/kick/api/**` routes that import shared controller functions.**
Keeps URLs on-brand and lets us drop the `/tokes-bot` paths entirely later.

### Permission model (unchanged, reused)

`resolvePermissionContext` / `isAdminUser` / `isManagerUser` already exist in
`kick-defender.js`. Owner = `TOKES_OWNER_ID`/`TOKES_KICK_OWNER_ID` or tokes role
`owner`; manager = `kbd_managers` row; streamer = channel owner.

---

## Phases

The doc covers the whole vision; we build and ship one phase at a time, each
verified live before the next. Each phase is independently useful.

### Phase 1 — Defender depth

Surface and configure what the enforcement engine already supports.

**New UI (in `defender.ejs`):**
- **Sublist** management (add/clear) — API exists (`banlist.addBan` listType
  sublist, `clearSublist`), no UI today.
- **Unbanlist** management (add/remove) — API exists, no UI today.
- **Enforcement log viewer** — paginated, filterable by channel / action
  (ban·delete·detected_no_scope) / date, from `kbd_enforcement_log`. Today only
  summary counts are shown.

**New config (per-channel, small schema addition):**
- Timeout-vs-permanent ban + duration (engine's `kick-moderation` already takes
  a duration param; nothing sets it).
- Phishing escalation threshold (hardcoded `≥2` → per-channel setting).
- Custom warning message text (hardcoded → per-channel, with `{{username}}`).
- Per-channel safe-domain allowlist overrides.

**Schema:** new table `kbd_channel_settings (channel_id PK, ban_duration_min
NULL, phishing_threshold INT DEFAULT 2, warning_template TEXT NULL,
safe_domains TEXT NULL, updated_at)`. Engine reads it with sane fallbacks to
today's hardcoded defaults, so untouched channels behave exactly as now.

### Phase 2 — Channel settings & commands

Re-home the working `/tokes-bot` channel control under `/kick/channel/:id`.

- **Settings:** `is_enabled`, `command_prefix`, `cooldown_global`,
  `cooldown_user`, `features_enabled`, bot-account selection, `defender_enabled`
  — all via existing `PATCH /tokes-bot/api/channels/:id` logic.
- **Commands:** enable/disable built-ins, per-channel cooldown/response/mod-only
  overrides — existing endpoints.
- **Custom commands:** full CRUD with a `{{template}}` variable builder + live
  preview — existing endpoints + `template-processor.js`.

### Phase 3 — Insights & analytics

Wire the already-built analytics APIs (currently behind stub pages) into
`insights.ejs`:
- Per-channel leaderboards (`tokes_channel_stats`) with period filter.
- Activity timeline + top commands (`tokes_activity_log`, existing
  `/api/admin/analytics/overview`).
- Retention cohorts + realtime feed (existing endpoints).
- Defender stats per channel (from `kbd_enforcement_log` via `channelStats`).

### Phase 4 — Games & economy controls

- Leaderboard management (view/filter/export top N; the data exists).
- Session history (`tokes_sessions` / `tokes_session_participants`).
- Content moderation queues: strain submissions, `tokes_thoughts` approval
  (the `is_approved` workflow already exists; just needs a UI).

---

## UI / Visual system

- **Shell chrome:** Mission Control language — Space Grotesk headings, Inter
  body, dark radial-gradient background, the green(`#53FC18`)/violet accent
  pair. Cohesive with the new landing page.
- **Inside sections:** dense control-panel patterns — sortable/filterable
  tables, inline toggles, compact stat cards, a consistent `postJson()` helper
  (the self-contained CSRF-both-ways helper already written for the enroll fix,
  promoted to a shared `/js/kick-dashboard.js`).
- **Preview-first:** each phase's main screen ships first as a `/kick`-internal
  preview (or behind a flag) for approval before replacing the live section, as
  we did with the landing redesign.

## Error handling

- Every render uses `locals.`-style safe access; a missing view variable must
  never 500 the page (the homepage-500 lesson).
- All `/kick/api/**` mutations: CSRF via header **and** body, return real JSON
  errors; client surfaces the actual message, never a generic "Network error."
- Engine config reads fall back to current hardcoded defaults when a
  `kbd_channel_settings` row is absent — zero behavior change for existing
  channels until a streamer opts in.
- Per-section data loads are independently try/caught so one failing widget
  doesn't blank the dashboard.

## Testing / verification

- EJS render-tests for every new view in logged-out, streamer, manager, and
  admin states, plus a missing-variables pass (must not throw).
- Route-status checks: each new `/kick/**` path returns 200 (authed) / 302
  (gated) / 403 (wrong role), never 404/500.
- Engine config: unit-test that `kbd_channel_settings` overrides apply and that
  an absent row reproduces today's hardcoded behavior exactly.
- Live smoke: enroll a test channel, exercise sublist/unbanlist/log viewer,
  change a threshold, confirm the running enforcer picks it up.
- Each phase verified live (pm2 restart + curl/render checks) before merge.

## Migration / rollout

- Additive only. New table `kbd_channel_settings`; no destructive changes to
  existing tables.
- `/tokes-bot/**` public pages stay hidden; their `/api/**` handlers remain
  until Phase 2 re-homes them under `/kick/api/**`, then the old paths can be
  retired in a cleanup pass.
- Ship phase-by-phase; each is independently revertable.

## Open questions (resolve during build, not blocking)

- Export format for leaderboards/log (CSV vs JSON) — default CSV.
- Whether per-channel safe-domain overrides should be allow-only or also
  block-only — default allow-only (matches current "safe domains" concept).
