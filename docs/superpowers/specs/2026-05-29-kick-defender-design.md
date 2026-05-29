# Kick Defender — Design Spec

> Status: **Draft for review** · Date: 2026-05-29 · Author: brainstorming session
> Product: a KumaBot-Defender-style shared-banlist defense network for Kick, living inside CertiFriedUtility.

## 1. Summary & Goal

Build the **Kick variant of KumaBot Defender (KBD)** — a cross-channel **shared-banlist defense network**, NOT a per-message content filter (no caps/links/emote-spam rules).

Many Kick channels enroll one network. A centrally-curated banlist (plus a sublist, an unban-protection list, and a malicious-site list) is maintained by network **Managers**. When a banlisted user appears in any enrolled channel, the bot bans them in that channel.

This is a distinct product from the existing **tokes-bot** (the cannabis/utility/games bot). It gets its own dashboard at `certifriedmultitool.com/kick`.

### Non-goals (v1)
- No content/message filtering (caps, links, emote spam, blacklist-word deletion as automod).
- No roster scanning (`!scan-channel`) — Kick's public API has no chatters-list endpoint.
- No chat-lock / sub-only / emote-only / DNL auto-lock — Kick's public API has no chatroom-settings endpoint.
- Twitch enforcement (this is Kick-only; the enforcer no-ops for Twitch in v1).

## 2. Platform Constraints (verified against Kick public API)

| Capability | Kick public API | Consequence |
|---|---|---|
| Ban / timeout | `POST /public/v1/moderation/bans` (scope `moderation:ban`; body `broadcaster_user_id`, `user_id`, optional `duration` 1–10080 min, `reason` ≤100 chars). `DELETE` to unban. | ✅ Core ban works |
| Delete message | `DELETE /public/v1/chat/{message_id}` (scope `moderation:chat_message:manage`) | ✅ Best-effort fallback |
| List chatters / viewers | **None** | ❌ `!scan-channel` dropped |
| Chatroom settings (slow/followers/sub/emote-only) | **None** (only unofficial internal endpoints) | ❌ chat-lock / DNL dropped |
| Stream offline event | `livestream.status.updated` webhook exists | Not needed without lock; deferred |
| Chat sender identity | Pusher chat events already carry `sender.id`, `sender.username`, `sender.is_moderator`, `sender.is_staff` (`kick-client.js:330-334`) | ✅ enables ban-on-event with no roster |

## 3. Key Decisions (locked)

- **Ban actor model:** per-owner OAuth token + `type:'bot'` (reuse existing per-streamer token storage). Each streamer re-authorizes with `moderation:ban` + `moderation:chat_message:manage`. **No dedicated bot account.**
  - Accepted consequence: a channel is **dormant** (undefended) until its owner re-authorizes.
- **Re-auth rollout:** lazy + dashboard banner. Un-migrated channels simply stay off; nothing breaks.
- **Enforcement model:** **ban-on-event**. Check each chat sender against the cached banlist in `command-handler.handleMessage`, **before** the prefix check. Ban only in the channel where the hit fires ("this channel only"). Network-wide banlist + lazy per-channel enforcement = eventual full coverage, no fan-out, avoids Kick rate limits.
- **Dormant-channel behavior:** best-effort. If the channel lacks `moderation:ban` but granted `moderation:chat_message:manage`, **delete** the offending message instead. Log a "would-have-banned" counter to drive the re-auth nudge.
- **Curation surface:** both a dashboard AND in-chat Manager commands.
- **Manager role:** dedicated `kbd_managers` table (independent of `tokes_users.role`).
- **Enrollment:** dashboard "Enable Defender" toggle (no bot home-channel `!join` mechanic). `!join` becomes an alias that points users to the dashboard URL.
- **Dashboard:** new `/kick` area, separate pages from `/tokes-bot`, but **reuses the existing Kick login** (`req.session.tokesUser` + `requireTokesAuth`). The added scopes go into the existing Kick OAuth flow in `auth-tokes-bot.js`.
- **Root `/`:** becomes a chooser (Discord bot vs Kick bot), always shown even when logged in.

## 4. Architecture

### 4.1 Dashboard & routing (`dashboard/`)

`dashboard/server.js` is the live ~9200-line Express monolith already running two independent auth systems:
- `req.user` → Discord (Passport, `/auth/discord`) → `/dashboard`.
- `req.session.tokesUser` → Kick/Twitch streamer (Kick OAuth, `auth-tokes-bot.js`, `requireTokesAuth`) → `/tokes-bot`.

Changes:
1. **Root `/` chooser** — replace the Discord-only `landing-tailwind` render at `server.js:577` with a new `landing-chooser` view: two cards (Discord Bot → `/dashboard`; Kick Bot → `/kick`). Always shown; each card reflects logged-in/out state for its product. Existing Discord landing content moves behind the Discord card.
2. **New `/kick` router** — `dashboard/routes/kick-defender.js`, mounted `app.use('/', kickDefenderRouter)` alongside the other tokes routers (~line 9125), internal paths under `/kick/...`. Views under `dashboard/views/kick/`. Guarded by the existing `requireTokesAuth`.
3. **OAuth scope addition** — `auth-tokes-bot.js:24` `KICK_SCOPES` gains `moderation:ban` and `moderation:chat_message:manage`. The granted `scope` string is already persisted to `tokes_platform_connections.scopes` (`auth-tokes-bot.js:494`), so scope presence is detectable with no schema change.

```
certifriedmultitool.com/                  ← chooser
        ├──► [Discord Bot] ─► /auth/discord ─► /dashboard      (req.user, unchanged)
        └──► [Kick Bot]    ─► Kick login ─┬─► /kick            (NEW defender)
                          (req.session.tokesUser)
                                          └─► /tokes-bot       (existing, untouched)
```

### 4.2 Defender engine (`services/certifried-bot/defender/`)

Five focused, independently testable units:

- **`banlist.js`** — CRUD + cached reads (60s TTL, mirrors `automod.js`) over the shared lists. Banlist is **network-global**, not per-channel.
- **`kick-moderation.js`** — thin Kick API wrapper: `banUser(broadcasterId, userId, {duration, reason}, token)`, `unbanUser(...)`, `deleteMessage(messageId, token)`. Pure I/O; token passed in; no DB coupling.
- **`enforcer.js`** — decision core. `check({ platform, channelId, userId, username, messageId, isMod, isBroadcaster }) → { acted: boolean }`:
  1. Non-Kick platform → no-op.
  2. Exempt broadcaster, mods, and unban-listed users → return early.
  3. Banlist cache lookup; miss → return `{acted:false}`.
  4. Hit → resolve channel owner token via existing `getValidAccessToken`.
     - Has `moderation:ban` → ban in this channel; log.
     - Else has `moderation:chat_message:manage` → delete the message; log "would-have-banned"; increment dormant counter.
     - Else → log "detected, no scope"; increment dormant counter.
  - Accepts an **injected ban/delete function** for unit tests (never touches Kick in tests).
- **`enforcement-log.js`** — writes `kbd_enforcement_log`; powers dashboard counts and `!get-*-count`.
- **`defender/commands/*.js`** — the in-chat command handlers, registered in the existing `command-registry`.

**Integration hook** — the only change to existing logic, in `command-handler.handleMessage` after channel-config resolution (~`command-handler.js:164`), before the prefix check:

```js
if (await enforcer.check({ platform, channelId, userId, username, messageId, isMod, isBroadcaster })) {
    return; // user was acted on; stop processing
}
```

`kick-client.handleChatMessage` must also pass `messageId` (the chat event's message UUID) into `handleMessage` so message-delete works.

## 5. Data Model (new tables)

- `kbd_banlist` — `id, platform_user_id, username, reason, list_type ENUM('ban','sublist'), added_by, created_at`. Index on `platform_user_id`.
- `kbd_unbanlist` — `id, platform_user_id, username, added_by, created_at`. (Protection list; never auto-act.)
- `kbd_malicious_sites` — `id, uri, added_by, created_at`.
- `kbd_managers` — `id, tokes_user_id, added_by, created_at`.
- `kbd_enrolled_channels` — `id, channel_id, owner_id, is_enabled, enrolled_at`. (Or a flag on `tokes_channels`; see Open Questions.)
- `kbd_enforcement_log` — `id, channel_id, target_user_id, target_username, action ENUM('ban','delete','detected_no_scope'), reason, success, created_at`.

## 6. Commands (KBD → Kick v1 mapping)

| KBD command | v1 | Permission | Note |
|---|---|---|---|
| `!add-ban`, `!add-bans`, `!remove-ban`, `!remove-bans` | keep | Manager | banlist CRUD |
| `!ban-from-all`, `!unban-from-all` | keep | Manager | loops re-authed channels |
| `!add-sublist`, `!run-sublist`, `!run-sublist-in`, `!clear-sublist` | keep | Manager | followbot cleanup |
| `!add-unban`, `!remove-unban` | keep | Manager | false-positive protection |
| `!add-known-malicious-site`, `!remove-known-malicious-site`, `!term-check` | keep | Manager | shared URL blocklist |
| `!get-*-count` (ban/channel/sublist/unban/manager/malsite) | keep | Manager | counts from lists |
| `!add-manager`, `!remove-manager` | keep | Admin | writes `kbd_managers` |
| `!mod-check` | adapt | Manager | checks owner re-authed (scope present) instead of mod badge |
| `!check-ban`, `!ping`, `!kbd-info`, `!commands` | keep | All | |
| `!join`, `!kbd-leave` | remap | Broadcaster | → dashboard Enable/Disable; `!join` aliases to dashboard URL |
| `!scan-channel(s)` | **drop** | — | no Kick chatters endpoint |
| `!lock-chat`, `!unlock-chat`, `!dnl-*` | **drop** | — | no Kick chatroom-settings endpoint |
| `!disconnect-from-channel`, `!reconnect-channel`, `!check-rate-limit`, `!update-avatars` | defer | Manager | ops/debug; nice-to-have, not v1-critical |

All commands keep the `!` prefix; the `kuma-` dual-version prefix is not needed.

## 7. Roles

Three tiers:
- **Admin** — site super-admin (`isSuperAdmin`). Manages Managers. Full access.
- **Manager** — row in `kbd_managers`. Curates the shared lists (dashboard + chat commands).
- **Streamer** — any Kick-connected user. Enrolls/disenrolls own channel, sees own "threats blocked" stats, re-auth banner.

## 8. Dashboard `/kick` pages

- **Landing / login** — product intro + Kick login (existing flow).
- **Streamer panel** — Enable/Disable Defender toggle; re-authorize banner if scopes missing; "threats blocked / detected-but-dormant" counts for own channel.
- **Manager console** — CRUD + bulk ops over banlist / sublist / unban / malicious-sites; counts.
- **Admin** — manage Managers.

## 9. Testing Strategy

- **Unit (no network):** `enforcer.check` with injected ban/delete fns — exemptions, banlist hit/miss, has-ban-scope, delete-fallback, dormant-no-scope. `banlist` cache TTL + invalidation.
- **Unit:** `kick-moderation` request shaping (mock fetch) — correct paths/bodies/headers for ban, unban, delete.
- **Integration:** `handleMessage` hook — banlisted sender stops processing; exempt users pass; Twitch no-ops.
- **Manual:** real ban in a test Kick channel after re-auth; verify dashboard counts increment.

## 10. Rollout

1. Ship tables + engine + hook (enforcement dormant for all until re-auth).
2. Add scopes to OAuth + re-auth banner.
3. As streamers re-authorize, their channels activate automatically.
4. Managers seed the banlist (dashboard or chat).

## 11. Open Questions (resolve before/within planning)

1. **Enrollment storage:** dedicated `kbd_enrolled_channels` table vs a `defender_enabled` flag on the existing `tokes_channels`? (Leaning: flag on `tokes_channels` to reuse the existing Pusher subscription/channel lifecycle.)
2. **Username vs ID for banlist entries:** Kick usernames can change; `platform_user_id` is stable but Managers usually type names. Plan: store both, match on `platform_user_id` when known, resolve name→id on add via `GET /public/v1/users` (`channel:read`/`user:read`).
3. **Rate limits:** `!ban-from-all` across many channels — needs throttling/queue. Confirm Kick's ban rate limit and add a simple queue if needed.

## 12. Out of Scope / Future

- Content-filter automod (caps/links/emote) — a separate product if ever wanted.
- Scan + chat-lock — revisit only if Kick exposes chatters/chatroom-settings endpoints.
- Twitch enforcement parity.
- tokes-bot → Discord-only migration (owner-driven, separate effort).
