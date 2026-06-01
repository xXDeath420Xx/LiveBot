# Voice XP Counts Toward Levels — Design

**Date:** 2026-06-01
**Status:** Approved (design)

## Problem

The leveling system tracks voice activity but it doesn't count toward levels. In
`core/leveling-manager.js`, `addVoiceXP` (credited on channel *leave*) only bumps
the separate `voice_xp` and `total_voice_minutes` columns — it never touches the
`xp`/`level` columns and never triggers a level-up. The leaderboard ranks by
`level DESC, xp DESC` (message XP only). So voice time is a dead-end stat.

Goal: make time spent in voice award real XP that advances level and leaderboard
rank, exactly like message XP.

## Decisions (locked)

- **Crediting model:** a per-minute ticker (not on-leave). Resilient to restarts,
  enables real-time level-ups, lets anti-AFK checks run each minute.
- **Anti-AFK guards:** no XP if the member is in the guild's AFK channel, is
  self-deafened, or is alone (fewer than 2 non-bot humans in the channel).
- **Existing data:** going-forward only. No retroactive conversion of accumulated
  `voice_xp` into levels. `total_voice_minutes` remains as a historical stat.
- **Level-up announce fallback:** voice-triggered level-ups announce to
  `level_up_channel_id` if set, else the **voice channel's own text chat**.

## Architecture

Replace the parallel voice-XP currency with real XP routed through the *existing*
`addXP` path, credited by a periodic ticker. No schema change (writes existing
`xp`/`level`/`total_voice_minutes` columns).

### Component 1 — Voice XP ticker (`jobs/voice-xp-ticker.js`, new)

`node-cron` `* * * * *` (every minute), registered/stopped in `index.js` like
`jobs/tiktok-video-checker.js`. **Single instance** (module-level singleton guard):
it iterates `global.botManager.clients` (a `Map<botId, client>` that includes the
default bot under key `'default'` plus every custom bot — the same accessor the
TikTok checker uses) and each client's `guilds.cache`, so each guild is handled
exactly once by its owning client (a guild belongs to one client).

Per tick, for each guild:
1. Load config via `levelingManager.getConfig(guildId)`. If `!voice_xp_enabled`, skip.
2. For each voice-based channel in the guild:
   - Skip if `channel.id === guild.afkChannelId` (AFK guard).
   - Let `humans = members.filter(m => !m.user.bot)`. Skip channel if `humans.size < 2` (alone guard).
   - For each human member: skip if `member.voice.deaf || member.voice.selfDeaf` (deafened guard).
     Otherwise call `levelingManager.creditVoiceMinute(guild, member)`.

Eligibility decisions live in a **pure helper** (`core/voice-xp-helpers.js`) so they
are unit-testable without Discord:
- `voiceXpAmount(xpPerMinute, multiplier) -> Math.floor(xpPerMinute * multiplier)`
- `isChannelEligible(channelId, afkChannelId, humanCount) -> boolean`
- `isMemberEligible(isBot, isDeaf, isSelfDeaf) -> boolean`

### Component 2 — `creditVoiceMinute(guild, member)` (`core/leveling-manager.js`, new)

1. `multiplier = await getActiveMultiplier(guildId)`; `amount = voiceXpAmount(config.xp_per_voice_minute, multiplier)`.
2. `+1` to `total_voice_minutes` (and, informationally, `voice_xp += amount`) via an
   upsert.
3. `oldLevel = await addXP(guildId, userId, amount)` — the existing curve; advances
   `xp`/`level`.
4. `await announceLevelUp(guild, member, oldLevel, member.voice.channel)` — fallback
   channel is the member's voice channel.

### Component 3 — Extract `announceLevelUp` (`core/leveling-manager.js`, refactor)

`checkLevelUp(message, oldLevel)` is hard-coupled to a `message`. Extract the
message-agnostic core:

`announceLevelUp(guild, member, oldLevel, fallbackChannel)`:
- Re-read the member's `level`; return if `level <= oldLevel`.
- Build the level-up embed (same format/text as today, `{user}/{level}/{username}`
  placeholders).
- Grant `level_role_rewards` for the new level via `member.roles.add` (catch+log).
- Run the existing "auto-resume paused subs at level >= 3" side-effect.
- Send to `config.level_up_channel_id` channel if set & text-based, else
  `fallbackChannel` if set & text-based (Discord voice channels are text-based and
  accept messages).

`checkLevelUp(message, oldLevel)` becomes a thin wrapper:
`announceLevelUp(message.guild, message.member, oldLevel, message.channel)`. The
message XP path is unchanged in behavior.

### Component 4 — Remove on-leave crediting (`core/leveling-manager.js`, change)

In `handleVoiceStateUpdate`, remove the `voiceSessions` start/stop tracking and the
`addVoiceXP`-on-leave call (the ticker is now the sole crediter — keeping both would
double-count). `addVoiceXP` is removed or left unused; the `voiceSessions` map and
its memory-monitor registration are removed. If `handleVoiceStateUpdate` has no
remaining work, drop its wiring in `events/voiceStateUpdate.js`.

## Data flow

```
every minute ─> voice-xp-ticker
  for each client -> each guild (voice_xp_enabled?)
    each voice channel (not AFK, >=2 humans)
      each human (not deafened)
        levelingManager.creditVoiceMinute(guild, member)
          -> +1 total_voice_minutes
          -> addXP(guild,user, xpPerMinute*multiplier)   // advances level
          -> announceLevelUp(guild, member, oldLevel, voiceChannel)
               -> embed + role rewards -> level_up_channel_id || voiceChannel text
message ─> handleMessageXP -> addXP -> checkLevelUp -> announceLevelUp(..., message.channel)
```

## Error handling

- Each guild / channel / member iteration is independently try/caught; one failure
  never aborts the tick.
- DB writes and `roles.add` / `channel.send` are catch+logged (non-fatal).
- Ticker registration mirrors the TikTok checker (singleton guard; `stop` on shutdown).

## Testing

- **Unit (pure, `core/voice-xp-helpers.js`):** `voiceXpAmount` (floor + multiplier);
  `isChannelEligible` (AFK channel false; <2 humans false; normal true);
  `isMemberEligible` (bot false; deaf/selfDeaf false; normal true).
- **Manual:** sit in a voice channel with a second (non-bot) account, confirm XP and
  `total_voice_minutes` rise ~once/minute; cross a level boundary and confirm the
  level-up embed posts (to level-up channel, or the voice channel's text chat) and a
  role reward is granted; verify AFK channel / deafened / alone earn nothing; verify
  no double-credit on leave.

## Out of scope (YAGNI)

- Retroactive conversion of historical `voice_xp` to levels.
- Separate voice-only leaderboard or voice levels.
- Per-channel XP rates, streaming/camera bonuses, anti-alt detection.
- Schema migrations (none needed).
