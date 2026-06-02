# CertiFried Multicast — Free RTMP Multi-streaming Relay

**Date:** 2026-06-02
**Status:** Approved design
**Owner:** death (crawford.k.dylan@gmail.com)

## Summary

A free, self-hosted "restream.io, but better." Users push **one** RTMP feed to
CertiFried and the server fans it out — with **no re-encoding** (pure passthrough)
— to every platform they configure (Twitch, YouTube, Kick, Trovo, Instagram,
TikTok, X/Twitter, Facebook Gaming, or any custom RTMP endpoint). Managed from a
web page at `https://certifriedmultitool.com/stream`, behind the existing Discord
login, with a frictionless guest mode for keyless quick streams. A live status
dashboard shows per-destination health.

## Server context (as discovered 2026-06-02)

- **Host:** `server.certifriedmultitool.com`, single public IP `51.81.155.59`.
- **Existing RTMP server:** Chaos's CannaStream (`/home/chaos/cannastream/server.js`,
  user `chaos`) already binds the standard RTMP port **1935**. It is a separate
  project (`stream.canna-friend.com`) and is used here only as a reference blueprint.
- **Engine tooling present:** `ffmpeg`/`ffprobe` (`/usr/bin`), `node`, `npm`,
  `pm2`, `docker`. `node-media-server` is the proven RTMP library (CannaStream uses v2.7).
- **Web stack:** OpenLiteSpeed + CyberPanel (no nginx). The
  `certifriedmultitool.com` vhost reverse-proxies `/` → `127.0.0.1:3001` (the
  dashboard Express app at `CertiFriedUtility/dashboard/`), with sub-contexts for
  `/cfx`, `/OregonTrail`, `/techtonica-admin`.
- **Dashboard auth:** Passport + Discord OAuth (`/auth/discord`,
  `req.isAuthenticated()`, `ensureAuthenticated`). ESM Express app. Has socket.io
  (`dashboard/socket/`). Users can already link Twitch.
- **Database:** MariaDB on `localhost:3306`, database `cert_CertiFriedUtility`
  (user `cert_CertiFriedDB`) — per the repo-root `.env` that `utils/db.js` loads
  (the `dashboard/.env` DB_* values are stale/unused).
- **Firewall:** firewalld active, zone `public`. Port 1935 is **not** in the open
  list; a new ingest port must be explicitly opened.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| RTMP ingest port | **1936** (own independent node-media-server) | 1935 is taken by Chaos on the only public IP. 1936 keeps the two projects fully isolated; OBS users just type `:1936`. |
| Account model | **Discord login + guest keys** | Reuse existing Passport-Discord identity for persistent accounts; offer keyless "quick stream" guest mode (better than restream's forced signup). |
| v1 scope | **Core relay + live status dashboard** | Passthrough fan-out is near-zero marginal CPU. Status panel makes it trustworthy. |
| Architecture | **Separate relay process + dashboard UI** | A long-running media server has different failure modes than a web app; isolate it (own PM2 app) so a streaming hiccup can't take down the site. |
| Transcoding | **Passthrough only (`-c copy`)** in v1 | Keeps it free/cheap. Per-destination transcode deferred to v2. |

## Data flow

```
OBS / Streamlabs ─rtmp://certifriedmultitool.com:1936/live/<KEY>─▶ Relay (node-media-server :1936)
                                                                     │ validate <KEY> in MariaDB (prePublish)
                                                                     │ spawn 1 `ffmpeg -c copy` per enabled destination (postPublish)
                       ┌───────────────┬───────────────┬────────────┼───────────────┐
                       ▼               ▼               ▼            ▼               ▼
                    Twitch          YouTube           Kick        TikTok      …Custom RTMP
                       │
   per-destination live status ─internal WS (127.0.0.1:4090)─▶ Dashboard (:3001) ─socket.io─▶ browser at /stream
```

## Components

### A. Relay service — `certifried-stream` (new standalone PM2 app, runs as `death`)

- `node-media-server` RTMP ingest on **:1936**, stream path `/live/<streamKey>`.
- **`prePublish`**: extract `<streamKey>`, validate against MariaDB (Discord-owned
  key OR active, non-expired guest key). Reject if invalid / disabled / expired, or
  if the global concurrency cap is reached. **Fail closed** if the DB is unreachable.
- **`postPublish`**: load enabled destinations for the key and spawn one ffmpeg per
  destination:
  `ffmpeg -i rtmp://127.0.0.1:1936/live/<KEY> -c copy -f flv -flvflags no_duration_filesize <dest_url>/<dest_key>`.
  Create a `stream_sessions` row.
- **Per-destination watchdog**: on ffmpeg exit, auto-retry with capped exponential
  backoff; after N consecutive failures mark the destination `failed`. Other
  destinations are unaffected by one failing.
- **`donePublish`**: SIGTERM all ffmpeg children, finalize the session row.
- **Internal API** (HTTP + WebSocket) bound to `127.0.0.1:4090`: exposes live
  session/destination status and accepts control calls from the dashboard.
- **Playback disabled**: no public HTTP-FLV/HLS output, so the relay cannot be
  abused as an open CDN.
- Graceful shutdown on SIGINT/SIGTERM (stop all sessions, end sessions, close pool).

### B. Dashboard `/stream` UI (added to the existing Express app on :3001)

- No new LiteSpeed context needed — the existing `/` → 3001 proxy already covers
  `/stream`.
- `/stream` routes behind `ensureAuthenticated` (Discord). `/stream/quick` is public
  for guest mode.
- Panels:
  - **Ingest**: personal RTMP URL (`rtmp://certifriedmultitool.com:1936/live/<KEY>`)
    + stream key, copy button, regenerate key.
  - **Destinations**: add / edit / enable platform targets, with presets + custom RTMP.
  - **Live Status**: per-destination state (connected / failed / reconnecting),
    source bitrate, session uptime — pushed in real time via socket.io (dashboard
    subscribes to the relay's internal WS on 4090).
  - **Session history**: recent sessions with duration, destinations, status.

### C. Database — new tables in `cert_CertiFriedUtility` (MariaDB)

- `stream_keys` — `id`, `owner_type ENUM('discord','guest')`, `owner_id`,
  `stream_key` (UNIQUE), `label`, `enabled`, `created_at`, `expires_at` (NULL for
  Discord users), `last_used_at`.
- `stream_destinations` — `id`, `stream_key_id` (FK), `platform`, `name`,
  `rtmp_url`, `dest_stream_key`, `enabled`, `priority`, `created_at`.
- `stream_sessions` — `id`, `stream_key_id` (FK), `started_at`, `ended_at`,
  `duration_seconds`, `destinations_count`, `status`, `error_message`.
- `stream_session_targets` — `id`, `session_id` (FK), `destination_id`, `platform`,
  `state`, `last_error`, `bytes_transferred` — per-destination history.

## Platform presets

Twitch (with live ingest-server auto-discovery via `https://ingest.twitch.tv/ingests`,
as CannaStream does), YouTube, Kick, Trovo, Instagram, TikTok, X/Twitter, Facebook
Gaming, **+ Custom RTMP**. Each preset carries the base RTMP URL, a stream-key
placeholder, and a help URL.

## Security / abuse protection

- Stream keys are 32-byte random hex, validated on every publish. Destination keys
  are never logged in full.
- **Guest keys**: one active session each, TTL **6 hours**, per-IP mint rate-limit.
- **Global concurrent-stream ceiling** (default 10) and **per-key destination cap**
  (default 8), both configurable, to protect the single box.
- Required deploy step: `firewall-cmd --add-port=1936/tcp --permanent && firewall-cmd --reload`,
  then verify external reachability of `:1936`.
- Relay accepts publish from valid keys only; no public playback endpoint.

## Error handling

- Invalid/expired/disabled key → reject the publish session immediately.
- A destination's ffmpeg dies → retry with capped backoff; mark `failed` after N
  tries; surface in UI; other destinations continue.
- Relay process crash → PM2 autorestart; active OBS clients auto-reconnect.
- DB unreachable → deny new publishes (fail closed), log the error.

## Testing

- **Unit**: stream-key validation, destination RTMP URL building (trailing-slash
  handling), ffmpeg argument construction, guest-key TTL/expiry logic.
- **Integration**: start the relay on a test port, publish a short ffmpeg test
  pattern, assert per-destination fan-out processes spawn and `stream_sessions` /
  `stream_session_targets` rows are written; assert invalid keys are rejected.
- **Manual**: OBS → `:1936` → a private/unlisted YouTube test stream; confirm
  live status panel reflects connected/failed states.

## Defaults (configurable)

- Code/service name: `certifried-stream`.
- Guest key TTL: 6 hours.
- Per-key destination cap: 8.
- Global concurrent-stream ceiling: 10.

## Deferred to v2

Browser studio (webcam/screen, no OBS), cloud recording, per-destination transcode,
viewer-count analytics, team/multi-user roles.
