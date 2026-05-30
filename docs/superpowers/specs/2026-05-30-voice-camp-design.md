# Voice Camp ("always stay") Channel — Design

**Date:** 2026-05-30
**Status:** Approved (design)

## Problem

Operators want a bot to permanently occupy a specific voice channel ("camp"), e.g.
guild `844406178799943730` should always have the bot sitting in VC
`869428255223074886`.

The existing 24/7 mode only *prevents the bot from leaving* once playback has
started (it sets `leaveOnEmpty`/`leaveOnEnd` to `false`). It does **not**:

- make the bot *join* a channel on its own,
- survive a process restart,
- return the bot to a home channel after a music session, or
- reconnect after an involuntary disconnect.

So "always stay in VC X" is a distinct, slightly larger feature built *on top of*
24/7 mode.

## Storage

Reuse the existing but currently-unused `music_config.default_voice_channel_id`
column as the **camp channel id**. No migration required.

- `default_voice_channel_id IS NULL` → no camp; existing behavior unchanged.
- `default_voice_channel_id = <id>` → camp behavior enabled for that guild.

Camp behavior assumes 24/7 is meaningful but does **not** require the
`twenty_four_seven` flag: the camp logic itself keeps the bot present. (Guild
`844406178799943730` already has `twenty_four_seven = 1`.)

## Behaviors

### 1. Join on startup
When a bot client becomes `ready`, iterate the guilds **that client** is in
(never the shared `guilds` table — each client only sees its own subset), look up
each guild's camp channel, and connect idle (self-deafened, nothing playing) via
`player.voiceUtils.connect(channel, { deaf: true })`.

### 2. Follow, then return
`/play` is unchanged — the bot follows the requester to their voice channel. When
the queue empties (`emptyQueue` event), after existing autoplay handling, if a
camp channel is configured and the bot is not already in it, move the connection
back to camp via `queue.connect(campChannel)`. When 24/7 is on (this guild),
`leaveOnEnd = false` keeps the queue alive long enough to relocate. If 24/7 were
off and the queue disconnected first, the `disconnect` → `rejoinCamp` path
(behavior 3) is the backstop that still returns the bot to camp — so camp is
self-healing regardless of the 24/7 flag.

### 3. Reconnect if knocked out
In the `disconnect` event handler, if the guild has a camp channel configured,
rejoin it after a short delay (~3s). This is a **narrow, correct** replacement for
the previously-removed broken rejoin: it targets only the fixed camp channel for
camp-configured guilds, so it cannot hit the empty-search / wrong-metadata-key
bugs. It will also rejoin after an admin manually drags the bot out — this is the
intended meaning of "always stay"; an admin disables it by clearing the camp
channel.

## Components

New module `core/voice-camp-manager.js`, one clear purpose (camp lifecycle):

- `getCampChannelId(guildId): Promise<string|null>` — read camp id from
  `music_config` (reuse `getMusicConfig`).
- `joinCampChannels(client, player): Promise<void>` — startup join across the
  client's own guilds; fetch each channel, skip if missing/not a voice channel or
  the bot lacks Connect permission; log skips (no silent failures).
- `returnToCamp(queue): Promise<boolean>` — move an idle queue's connection back
  to its guild's camp channel if configured and not already there.
- `rejoinCamp(client, player, guildId): Promise<void>` — reconnect idle to the
  camp channel for a single guild (used by the disconnect handler).

`index.js` wires these into existing hooks only:
- after the player/`ready` setup → `joinCampChannels`
- inside `emptyQueue` handler → `returnToCamp`
- inside `disconnect` handler → `rejoinCamp` (guarded by camp configured)

### Configuration command
Add a `/music camp` admin subcommand (Administrator-only, matching `handle247`):
- `/music camp channel:<voice channel>` → set `default_voice_channel_id`, then
  immediately join it.
- `/music camp off` → clear `default_voice_channel_id`; the bot may leave on the
  normal path (does not force-disconnect an active session).

Handler `handleCamp(interaction)` lives in `handlers/music/controls.js` alongside
`handle247`; wired through `commands/music/music.js` (builder + dispatch switch).

## Data flow

```
ready ──> joinCampChannels(client, player) ──> voiceUtils.connect(campCh) [idle]
/play ──> player.play(requesterCh) ──> normal playback (24/7 flags via getLeaveOptions)
queue empties ──> emptyQueue ──> returnToCamp(queue) ──> queue.connect(campCh) [idle]
disconnected ──> disconnect ──> rejoinCamp(client, player, guildId) ──> reconnect
/music camp <ch> ──> updateMusicConfig(default_voice_channel_id) + connect
/music camp off  ──> updateMusicConfig(default_voice_channel_id = NULL)
```

## Error handling

- All voice connects wrapped in try/catch; failures logged with guild/channel
  context, never thrown into the ready/event path.
- Permission/missing-channel cases are skipped with a logged reason.
- `returnToCamp` / `rejoinCamp` no-op (return false) when no camp configured or
  the channel can't be resolved.

## Testing

- Unit: `returnToCamp` decision logic with a mocked queue (camp set vs null;
  already-in-camp vs elsewhere) — pure branch checks, no Discord/DB.
- Manual (on next PM2 restart, never via a competing one-off session):
  1. Bot joins `869428255223074886` on startup.
  2. `/play` from another VC follows; on queue end the bot returns to camp.
  3. Manually disconnect the bot → it rejoins camp.
  4. `/music camp off` → camp behavior stops.

## Out of scope (YAGNI)

- Playing idle ambience/audio while camped (it sits silently connected).
- Multiple camp channels per guild.
- Stage-channel speaker logic beyond a basic connect.

## Configuration applied now

Set `music_config.default_voice_channel_id = '869428255223074886'` for guild
`844406178799943730` (via the new `/music camp` path or a direct update).
