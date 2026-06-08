# CertiFried Cinema — Jellyfin Movie Streaming via Discord Go Live

**Date:** 2026-06-08
**Status:** Approved design, pending implementation plan
**Author:** brainstormed with Claude

## Summary

Add a `/movie` command that streams films from the user's Jellyfin server
(`https://jellyfin.certifriedmultitool.net`) into a Discord voice channel as a
native **Go Live** stream, so a group watches together off **one** server-side
transcode instead of each viewer hammering Jellyfin / their own network.

## Critical constraints (why the design is shaped this way)

- **Discord bots cannot send video.** Video is blocked on the bot gateway. The
  only working path is a **selfbot** (user account) driving Discord's
  undocumented voice UDP protocol via `@dank074/discord-video-stream` (v6, the
  maintained library as of 2026-03) with peer dep `discord.js-selfbot-v13`.
- **This is a ToS violation** (Automated User Accounts policy). The risk is
  **isolated to a throwaway user account** — never the bot fleet — but is
  **not eliminable**. The account can be banned; the library will eventually
  break on a Discord update. Both are accepted, mitigated by isolation and a
  swappable separate service.
- **Selfbot needs discord.js v13 internals**; the main fleet is v14. Separate
  process avoids the version clash.
- **Go Live caps ~50 viewers**, is **click-to-watch**, and the throwaway
  account is **free tier → 720p** ceiling.

## Architecture

A new standalone PM2 process, **`CertiFried-Cinema`**, in a new `cinema/`
directory — the only place the selfbot and ffmpeg run. It is firewalled from
the bot fleet: it loads **no bot token**, only its own env.

```
┌──────────────────────────┐         ┌──────────────────────────────┐
│ Main bot (discord.js 14)  │  HTTP   │ CertiFried-Cinema (PM2)       │
│  /movie command           │ ──────▶ │  • discord.js-selfbot-v13     │
│  autocomplete + pickers   │127.0.0.1│  • @dank074/discord-video-    │
│  control-panel buttons    │loopback │    stream v6 (Go Live)        │
│                           │ +secret │  • ffmpeg (single encode)     │
└───────────┬───────────────┘         │  • Jellyfin client            │
            │                          └───────────────┬──────────────┘
            │   shared MySQL (cinema_* tables only)     │
            └────────────────────────────────────────────┘
```

- **Main → Cinema:** loopback-only HTTP API (`127.0.0.1:CINEMA_PORT`,
  `X-Cinema-Secret` shared-secret header): `play / pause / resume / stop /
  seek / status`.
- **Cinema → Main:** no callback channel. Cinema writes live state to the
  shared `cinema_state` table; the main bot reads it for busy-checks, panel
  updates, and crash recovery. (Both already share `utils/db.js` `pool`.)
- **Isolation:** a Cinema crash, ban, or ffmpeg CPU spike never touches the
  20-bot fleet.

## Components

| Component | Path | Responsibility |
|---|---|---|
| Cinema service entry | `cinema/index.js` | selfbot login, loopback HTTP API, watchdog |
| Stream engine | `cinema/streamer.js` | join VC, build ffmpeg cmd (map audio, burn sub, scale 720p30), `playStream` Go Live |
| Jellyfin client (shared) | `utils/jellyfin.js` | `search()`, `getItem()` (MediaStreams), `streamUrl()` (static, no JF transcode) |
| Slash command | `commands/media/movie.js` | `/movie play\|stop\|status`, autocomplete, picker flow |
| Control panel + buttons | `handlers/cinema/panel.js` | embed + Pause/Resume/Stop/Seek, permission gate |
| Migration | `migrations/123_cinema.js` | `cinema_config`, `cinema_state` (idempotent) |

## Data flow — starting a movie

1. `/movie play <title>` → autocomplete hits `utils/jellyfin.search()` live as
   you type (Jellyfin `/Items?searchTerm=&IncludeItemTypes=Movie,Episode&Recursive=true`).
2. User must be in a voice channel (else ephemeral error).
3. Bot fetches the item's `MediaStreams` → posts **ephemeral** audio-track and
   subtitle-track select menus.
4. On confirm: check the global lock (`cinema_state` singleton row exists?).
   - Busy → "🎬 Cinema is in use in **<guild>**, started by <user>."
   - Free → insert the lock row.
5. Bot `POST 127.0.0.1/play` with `{guildId, voiceChannelId, itemId,
   streamUrl, audioIndex, subIndex, width:1280, height:720, fps:30, bitrate}`.
6. Cinema: selfbot joins the VC → ffmpeg (`-map` chosen audio, burn chosen sub
   via `subtitles=` filter, `scale=1280:720`, encode H.264 + Opus) →
   `playStream(output, streamer, {type:'go-live'})`.
7. Bot posts the **control panel** embed in the text channel; members click
   **Watch Stream** in the VC.

### One-transcode offload

Jellyfin serves the **original file** via a static stream URL
(`/Videos/{id}/stream?static=true&api_key=…`) — **no Jellyfin-side transcode**.
The Cinema service's ffmpeg does the **single** encode to the H.264/Opus that
Discord requires. One encode, in the isolated service. N viewers share it.

## Data model — migration 123 (idempotent, whitelist table-existence checks)

```
cinema_config              -- per-guild enablement + control perms
  guild_id        VARCHAR(20) PRIMARY KEY
  enabled         TINYINT(1) DEFAULT 0
  control_role_id VARCHAR(20) NULL   -- role that counts as "mod" for controls
  default_vc_id   VARCHAR(20) NULL
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP

cinema_state               -- SINGLETON: the one active session globally
  id              INT PRIMARY KEY          -- always 1; enforces single row
  guild_id        VARCHAR(20) NOT NULL
  channel_id      VARCHAR(20) NOT NULL     -- text channel hosting the panel
  voice_channel_id VARCHAR(20) NOT NULL
  item_id         VARCHAR(64) NOT NULL
  item_name       VARCHAR(255) NOT NULL
  started_by      VARCHAR(20) NOT NULL
  audio_index     INT NULL
  sub_index       INT NULL
  status          ENUM('playing','paused') DEFAULT 'playing'
  position_secs   INT DEFAULT 0            -- Cinema updates periodically
  panel_message_id VARCHAR(20) NULL
  started_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
```

- **Global lock** = the singleton row's existence. `/movie stop`, stream-end,
  and idle-timeout delete it. Multi-guild scope shares this one account → a
  second guild gets a "busy" message (request queue is a deliberate
  post-v1 enhancement, not v1 scope).

## Controls & permissions

Button panel: `cinema_pause` / `cinema_resume` / `cinema_stop` / `cinema_seek`.
**Allowed:** the starter (`cinema_state.started_by`) **or** a member with
`cinema_config.control_role_id` (or Manage Guild). Others → ephemeral
"Only the host or a mod can control playback." Seek opens a modal for
`HH:MM:SS`. Mirrors the existing `core/music-panel.js` pattern.

## Lifecycle & error handling

- **Stream end:** ffmpeg exits → Cinema deletes `cinema_state`, edits the panel
  to "⏹ Ended."
- **Idle timeout:** VC empty for **10 minutes** → auto-stop (saves CPU, shrinks
  the exposure window). Configurable.
- **Selfbot logged out / flagged:** Cinema logs, clears state, sets a health
  flag; the main bot surfaces "Cinema temporarily unavailable."
- **Crash recovery:** on restart, either process reconciles against
  `cinema_state`; stale rows (no live stream) are swept by the watchdog.

## Secrets & external setup (operator to-dos, NOT in git)

- **Throwaway Cinema account:** provided out-of-band (email/password for browser
  login only). Discord blocks scripted email+password login, so the operator
  signs in via browser and **extracts the user token**; that token is the only
  credential the service uses. Credentials are **never** committed.
- **Env (Cinema process only, in gitignored `.env`):**
  - `CINEMA_USER_TOKEN` — extracted selfbot token
  - `CINEMA_API_SECRET` — shared secret for the loopback API
  - `CINEMA_PORT` — loopback API port
  - `JELLYFIN_URL=https://jellyfin.certifriedmultitool.net`
  - `JELLYFIN_API_KEY` — Jellyfin server API key
  - Optional `CINEMA_IDLE_TIMEOUT_MIN` (default 10)
- An entry will be added to `.env.example` documenting these keys (no values).

## Dependencies

- New (Cinema service only): `@dank074/discord-video-stream@^6`, its peer
  `discord.js-selfbot-v13`. ⚠️ The original peer was **archived 2025-10**;
  the maintained fork `discord.js-selfbot-youtsuho-v13` is the documented
  fallback if it breaks.
- System **ffmpeg** — already present (used by music / yt-dlp extractor).

## Build phases (input to the implementation plan)

1. **Cinema skeleton** — selfbot login, loopback HTTP API, `utils/jellyfin.js`
   client, raw play/stop with hardcoded args; PM2 entry.
2. **Command + UX** — `/movie` with autocomplete, audio/sub picker, control
   panel + buttons, `cinema_state` lock/state, migration 123.
3. **Lifecycle** — idle timeout, stream-end detection, crash rehydration,
   per-guild `cinema_config` + permissions, health surfacing.

## Explicitly out of scope (v1 / YAGNI)

- Request queue across guilds (busy message only in v1).
- Multiple simultaneous streams / multiple accounts.
- 1080p60 (requires Nitro on the throwaway account; encode settings are
  config-driven so this is a later flip, not a rewrite).
- TV "next episode" auto-advance.

## Accepted risks

- The Cinema account **can be banned** (isolated to that account, not the fleet).
- The selfbot library **will eventually break** on a Discord update — mitigated
  by being a separate, swappable service with a known maintained fork fallback.
