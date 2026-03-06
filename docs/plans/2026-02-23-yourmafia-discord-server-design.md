# YourMafia Discord Server Setup Design

**Date:** 2026-02-23
**Server ID:** 1475352754682597468
**Bot:** Your Mafia (custom CertiFriedUtility instance)
**Approach:** Script-based setup via Discord REST API + DB configuration

## Overview

Set up a complete Discord server for the YourMafia browser-based mafia MMORPG. The server serves as both a public community hub for players and a private staff/dev area. Expected scale: 50-500 members.

## Role Hierarchy

| Role | Color | Hoisted | Key Permissions |
|------|-------|---------|----------------|
| Owner | #FF0000 | Yes | Administrator |
| Developer | #E91E63 | Yes | Manage Server, Channels, Roles |
| Head Admin | #FF4500 | Yes | Ban, Kick, Manage Messages, Roles |
| Admin | #FF8C00 | Yes | Ban, Kick, Manage Messages |
| Moderator | #2ECC71 | Yes | Kick, Timeout, Manage Messages |
| Trial Mod | #27AE60 | Yes | Timeout, Manage Messages |
| YourMafia Bot | #5865F2 | No | Bot-required permissions |
| VIP | #F1C40F | Yes | Access to VIP channels |
| OG Player | #9B59B6 | Yes | Cosmetic/early adopter |
| Verified | #3498DB | No | Access to main server channels |
| Muted | #95A5A6 | No | Deny Send Messages globally |
| Quarantine | #E74C3C | No | Deny all except quarantine |
| @everyone | default | No | See only welcome/rules/verify |

## Channel Structure

### INFORMATION (read-only)
- `#rules` — Server rules embed
- `#announcements` — Game updates and news
- `#patch-notes` — Game changelog
- `#roles` — Reaction role panel
- `#faq` — Frequently asked questions

### VERIFICATION (limited access)
- `#welcome` — Greeting messages (read-only for members)
- `#verify` — Verification button panel

### COMMUNITY
- `#general` — Main chat
- `#off-topic` — Non-game discussion
- `#media` — Screenshots, videos, memes
- `#introductions` — New member introductions

### YOURMAFIA GAME
- `#game-chat` — Strategy, gangs, crime discussion
- `#gang-recruitment` — Gang recruitment posts
- `#trading` — In-game item/credit trading
- `#game-events` — Bot-posted event feeds (future)
- `#leaderboards` — Bot-posted leaderboards (future)

### FEEDBACK
- `#suggestions` — Suggestion system via bot
- `#bug-reports` — Game bug reports
- `#changelog` — Staff responses to feedback

### SUPPORT
- `#open-ticket` — Ticket panel (click to open)
- Dynamic ticket channels created by bot

### VOICE
- General Voice (voice channel)
- AFK (5-minute timeout)

### STAFF AREA (staff-only)
- `#staff-chat` — Staff discussion
- `#mod-actions` — Moderation action log
- `#staff-todos` — Task tracking
- `#dev-chat` — Developer discussion
- `#bot-testing` — Bot command testing

### LOGS (staff-only)
- `#audit-log` — General server logs
- `#mod-logs` — Moderation actions
- `#automod-logs` — AutoMod triggers
- `#join-leave-log` — Member join/leave tracking

## Verification Gate

1. New member joins → sees only #welcome and #verify
2. Bot posts greeting in #welcome
3. #verify has embed with rules summary + "Verify" button
4. Click "Verify" → @Verified role → full server access
5. Verification logged in #join-leave-log

## Security Configuration

### AutoMod Rules
- Anti-spam: 5 messages/5 seconds = 5min mute
- Discord invite filter: block external invites (staff exempt)
- Mass mention filter: 5+ mentions = 10min mute
- All caps filter: 70%+ caps in 10+ char messages = warn
- Banned words: Evasion-resistant slur filter

### Progressive Punishment (Heat System)
- Heat values: spam=20, mention=15, caps=5, invite=25, banned_word=30
- Decay: 15 minutes
- Thresholds: 25=warn, 50=5min mute, 75=30min mute, 100=kick, 150=ban

### Escalation Rules
- 3 infractions in 24h = 30min mute
- 5 infractions in 48h = 2h mute
- 7 infractions in 7 days = kick
- 10 infractions in 30 days = ban

### Anti-Nuke
- 3 channel/role deletes = kick + alert
- 5 bans/kicks = kick + alert
- Alerts → #mod-logs

### Raid Detection
- 8 joins in 60 seconds = alert
- Accounts < 7 days old flagged
- Alerts → #staff-chat

### Adaptive Spam + Selfbot Detection
- Cross-channel spam: 3 channels in 5 min
- Selfbot: 20 msgs/sec burst, <50ms response time
- New account sensitivity multipliers

## Bot Feature Configuration

| Feature | Channel | Status |
|---------|---------|--------|
| Logging (all events) | #audit-log | Enabled |
| Mod logging | #mod-logs | Enabled |
| AutoMod logging | #automod-logs | Enabled |
| Welcome/Greeting | #welcome | Enabled |
| Suggestions | #suggestions | Enabled |
| Tickets | #open-ticket | Enabled |
| Reaction Roles | #roles | Enabled |
| Leveling/XP | In-channel | Enabled |
| Starboard | Future | Deferred |
| Anti-Nuke | #mod-logs | Enabled |
| Raid Detection | #staff-chat | Enabled |

## Rules Content

```
YourMafia Community Rules

1. Respect All Members — No harassment, hate speech, discrimination, or personal attacks.
2. No Spam — No flooding, excessive caps, repeated messages, or meaningless content.
3. No Cheating Discussion — Do not share exploits, hacks, or methods to cheat in YourMafia.
4. Keep It Legal — No illegal content, doxxing, threats, or NSFW.
5. English Only — Main channels are English. Use #off-topic for other languages.
6. No Advertising — No unsolicited promotion of other games, servers, or services.
7. Use Channels Properly — Keep discussions in their relevant channels.
8. Follow Discord ToS — All Discord Terms of Service and Community Guidelines apply.
9. Listen to Staff — Moderator decisions are final. Use #open-ticket to appeal.
10. Have Fun — This is a community. Enjoy the game and each other.

Violations result in progressive punishment: Warning → Mute → Kick → Ban
```

## Implementation

Single script: `setup-yourmafia-server.js`
- Uses Discord REST API (same pattern as existing setup scripts)
- Configures all DB tables for the guild
- Bot token from environment or parameter
- Outputs summary of all created resources

## Future Work (Not in Script)
- Game event feeds (requires PHP-side webhooks)
- Leaderboard polling (requires game API)
- Gang war notifications (requires game triggers)
- Starboard configuration
