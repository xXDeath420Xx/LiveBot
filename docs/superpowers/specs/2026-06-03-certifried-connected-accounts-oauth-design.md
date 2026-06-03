# CertiFried Connected Accounts — OAuth "Add Platform" for Multicast

**Date:** 2026-06-03
**Status:** Approved design
**Owner:** death (crawford.k.dylan@gmail.com)
**Builds on:** [CertiFried Multicast](2026-06-02-certifried-multicast-rtmp-design.md)

## Summary

Let a logged-in Discord user click **Add Platform → Connect [Twitch / YouTube /
Facebook / Kick]**, complete OAuth, and have CertiFried obtain their RTMP
destination automatically — fetching a stream key now where the platform's API
allows, or minting one at go-live where it doesn't. The existing manual
"Custom RTMP / paste key" flow remains for any other platform and for guests
(OAuth requires a persistent account, so guests keep manual paste).

## Server context (discovered 2026-06-02/03)

- Dashboard is an in-process Express app inside the main `CertiFriedUtility` PM2
  process (started by `index.js:843`), served at `127.0.0.1:3001`.
- **Twitch OAuth already exists**: `TWITCH_CLIENT_ID/SECRET` in repo-root `.env`,
  OAuth routes (`dashboard/routes/auth-twitch.js`), and an encrypted-token table
  `twitch_oauth_accounts`.
- **Token encryption already exists**: `utils/encryption.js` (AES-256-GCM);
  Twitch tokens are stored encrypted (JSON of the encrypted object) in TEXT.
- **OAuth apps already registered** for more platforms: `KICK_CLIENT_ID/SECRET`
  and a Meta app (`META_APP_ID/SECRET`, page + IG tokens). YouTube has only
  `YOUTUBE_API_KEY` — no OAuth client yet (must create a Google OAuth client +
  consent-screen verification).
- Multicast relay is a separate PM2 app `certified-stream` (CommonJS) on RTMP
  :1936, status API 127.0.0.1:4090; it reads `stream_destinations` and fans out
  with `ffmpeg -c copy`. DB is MariaDB `cert_CertiFriedUtility`.

## Platform reality (static vs dynamic)

| Platform | Mode | Key acquisition |
|---|---|---|
| **Twitch** | static | OAuth (existing app) + scope `channel:read:stream_key` → Helix `GET https://api.twitch.tv/helix/streams/key`. Persistent key fetched at connect. Ingest = Twitch global contribute URL. |
| **Kick** | static (manual key) | OAuth (existing app) for identity/label only — Kick exposes no stream-key API → user pastes key once; we prefill the RTMP URL. |
| **YouTube** | dynamic | Google OAuth (new client + verification) + YouTube Data API v3. At go-live: `liveStreams.insert` + `liveBroadcasts.insert` with `contentDetails.enableAutoStart=true` and `enableAutoStop=true`, bind them → return ingestion address + stream name (key). Auto-start makes YouTube go live on first ingest and end on disconnect — no manual transition. |
| **Facebook** | dynamic | Meta OAuth (existing app) + `publish_video` (requires Meta App Review). At go-live: create a Live Video → `stream_url` (server + key); goes live on ingest. |

## Architecture (Approach A — dashboard-hosted resolver)

Three independently testable layers:

### (a) Connections (dashboard)
OAuth flows + encrypted token storage. New table `stream_platform_accounts`:
- `id`, `owner_discord_id`, `platform`, `platform_user_id`, `platform_username`,
  `access_token` (TEXT, encrypted), `refresh_token` (TEXT, encrypted),
  `expires_at`, `scopes`, `status ENUM('active','needs_reconnect')`,
  `created_at`, UNIQUE(`owner_discord_id`, `platform`).
Reuses `utils/encryption.js` exactly as `twitch_oauth_accounts` does.

### (b) Destinations (extend existing `stream_destinations`)
Add columns:
- `account_id BIGINT UNSIGNED NULL` (FK → `stream_platform_accounts.id`, NULL for manual),
- `resolution ENUM('static','dynamic') NOT NULL DEFAULT 'static'`,
- `config_json JSON NULL` (e.g., YouTube `{title, privacy}` defaults).
Static rows carry `rtmp_url` + `dest_stream_key` as today. Dynamic rows carry no
key until go-live. Server-fetched keys (Twitch) stored encrypted; manual
user-entered keys unchanged.

### (c) Resolver (dashboard internal endpoint)
`POST /internal/resolve-destinations` — called by the relay at `postPublish`.
- Auth: shared-secret header (`RELAY_INTERNAL_SECRET`, in both `.env`s),
  CSRF-exempt, bound to 127.0.0.1.
- Input: the publishing stream key (identifies the user's `stream_keys` row).
- For each enabled destination of that user: `static` → return stored
  `{rtmp_url, key}` (decrypting if needed); `dynamic` → run
  `adapter.resolveAtGoLive(account, config)` (refresh token, create
  broadcast/stream, return fresh `{rtmp_url, key}`).
- Output: `[{ name, platform, rtmp_url, key, state }]`. The relay fans out.

## Adapter interface (one module per platform — `dashboard/services/platforms/<name>.js`)

```
getAuthUrl(state)         -> OAuth authorize URL (correct scopes, PKCE where supported)
handleCallback(code)      -> { platformUserId, username, tokens }
refresh(account)          -> new access token (+ persists)
connectDestination(acct)  -> static : fetch key, return ready destination row data
                             kick   : return {rtmp_url, key:null} (prompt manual)
                             dynamic: return a 'dynamic' destination stub
resolveAtGoLive(acct,cfg) -> dynamic: create broadcast+stream -> {rtmp_url, key}
                             static : return stored {rtmp_url, key}
```
A shared `registry.js` maps platform → adapter and declares each platform's mode,
scopes, and whether it is review-gated.

## Relay ↔ resolver contract

- At `postPublish` (after key validation) the relay POSTs
  `{ streamKey }` to `http://127.0.0.1:3001/internal/resolve-destinations`
  with header `X-Relay-Secret: <RELAY_INTERNAL_SECRET>`.
- Resolver returns the resolved destination list; relay spawns one
  `ffmpeg -c copy` per entry (unchanged fan-out).
- **Resilience / fallback:** if the resolver call fails (timeout/non-200), the
  relay falls back to reading **static** `stream_destinations` rows directly
  (manual + Twitch keep working during a dashboard restart); dynamic
  destinations simply don't activate that session and the failure is logged.
- `donePublish` is unchanged (YouTube `enableAutoStop` / Facebook end-on-ingest
  handle broadcast teardown, so no finalize call or broadcast-tracking table in
  v1).

## UX (`/stream` page)

- **"+ Add Platform"** button opens a chooser: Connect Twitch / YouTube /
  Facebook / Kick + **Custom RTMP (manual)**.
- OAuth return behavior:
  - **Twitch** → destination auto-created and shown ready.
  - **Kick** → connection saved; manual key field prefilled with the Kick RTMP URL.
  - **YouTube / Facebook** → a `dynamic` destination with an
    **"auto — key minted at go-live"** badge + small config (title/privacy).
- Destination rows show a badge: *Connected as @name* vs *Manual*.
- **Disconnect** removes the connection and its dynamic destinations.
- Guests see only **Custom RTMP (manual)**.
- Review-gated platforms (YouTube, Facebook) render as **"Coming soon"** until
  their app reviews clear (framework ships; buttons light up via a feature flag).

## Security

- All OAuth tokens encrypted at rest (`encryption.js`, AES-256-GCM).
- OAuth `state` parameter for CSRF on the OAuth round-trip; PKCE where supported;
  minimal scopes per platform.
- Server-fetched stream keys stored encrypted; the resolver decrypts and returns
  plaintext to the relay over localhost — the relay never holds the encryption
  key or long-lived secrets.
- Internal resolver endpoint: shared-secret header + CSRF-exempt + 127.0.0.1 only.
- Token-refresh failure → connection marked `needs_reconnect`; its destination is
  skipped at go-live and flagged in the UI.

## Error handling

- Per-destination isolation (already in the relay): a failed dynamic resolve
  marks only that destination `failed`; others continue.
- OAuth callback failure → no partial connection persisted; friendly error.
- Resolver unreachable → relay static-fallback (above).
- Review-gated platforms feature-flagged until approved.

## Testing

- **Unit**: adapter auth-URL/scope building; token-refresh logic (mocked HTTP);
  resolver static-vs-dynamic decision; encryption round-trip; registry mode flags.
- **Integration**: mock platform API servers; connect → resolve flow; relay→
  resolver contract incl. the static-fallback path.
- **Manual**: real Twitch connect end-to-end (app exists today); YouTube/Facebook
  via their app test users until reviews clear.

## Phasing (one spec; naturally ordered implementation)

1. **Framework** — `stream_platform_accounts` table, `stream_destinations`
   columns, adapter interface + registry, resolver endpoint, relay integration
   + fallback, `/stream` Add-Platform chooser UI.
2. **Twitch adapter** — works immediately (no external review).
3. **Kick adapter** — OAuth connect + manual key prefill.
4. **YouTube adapter** — after creating a Google OAuth client + consent
   verification.
5. **Facebook adapter** — after Meta `publish_video` App Review.

## Out of scope (v1)

Per-broadcast finalize/transition tracking table (handled by auto-start/stop),
Instagram/TikTok/X auto-key (no API), analytics of OAuth usage, multi-account
per platform per user (one connection per platform per user in v1).
