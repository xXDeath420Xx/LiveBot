# Streaming Dashboard Consolidation

**Goal:** Merge 6 scattered streaming-related dashboard pages into one unified "Streaming" page with a hybrid layout (sticky defaults + tabbed sub-sections).

## Problem

Streaming configuration is currently spread across:
- **Core Settings** → Live Role
- **Announcements** → Channel, webhook persona, message template, ignored roles
- **Streamers** → Add/edit/delete stream subscriptions
- **Stream-Ended** → Delete/edit-on-end per subscription (hidden from nav)
- **Teams** → Twitch team subscriptions
- **Auto-Track** → Role-based auto-tracking rules
- **Twitch Schedules** → Twitch schedule syncs

An admin configuring streaming must visit 4+ pages. Settings that belong together (announcement channel + streamer subscriptions) are in different places.

## Design

### Layout: Hybrid — Sticky Defaults + Tabs

The new page lives at `?page=streaming`.

**Top section (always visible):** Global Defaults card
- Live Role (moved from Core Settings)
- Announcement Channel
- Use Webhook Persona toggle
- Message Template textarea with variable reference
- Ignored Roles multi-select
- Save button for defaults

**Below defaults:** Tabbed content area with 4 tabs:

| Tab | Content | Source Page |
|-----|---------|------------|
| **Streamers** | Streamer table with search, bulk actions, add/edit modals. Stream-ended toggle (edit_on_end) is an inline column per subscription row. | streamers.ejs + stream-ended.ejs |
| **Teams** | Team subscription cards with add/edit/delete. | teams.ejs |
| **Auto-Track** | Role-based auto-tracking mapping cards with add/edit/toggle/delete. | auto-track.ejs |
| **Schedules** | Twitch schedule sync table with add/delete. | twitch-schedules.ejs |

### Old Page Redirects

Old URLs redirect to the new page:
- `?page=announcements` → `?page=streaming`
- `?page=stream-ended` → `?page=streaming`
- `?page=teams` → `?page=streaming&tab=teams`
- `?page=twitch-schedules` → `?page=streaming&tab=schedules`
- `?page=auto-track` → `?page=streaming&tab=auto-track`
- `?page=streamers` → `?page=streaming`

Implemented as client-side redirects in the pageMap — when an old page key is requested, render the streaming page with the appropriate tab pre-selected.

### Core Settings Change

Live Role is removed from Core Settings (`core.ejs`). Core Settings retains only Timezone + Prefix Commands.

### Overview Hub Changes

The overview cards that currently link to the separate pages update:
- **Streamers** card → links to `?page=streaming`
- **Teams** card → links to `?page=streaming&tab=teams`
- **Announcements** card → links to `?page=streaming`
- **Twitch Schedules** card → links to `?page=streaming&tab=schedules`
- Remove **Stream-Ended** (was already hidden from nav)

## Files

### Create
| File | Purpose |
|------|---------|
| `dashboard/views/partials/manage/streaming.ejs` | Unified streaming page with defaults card + 4 tabs |

### Modify
| File | Change |
|------|--------|
| `dashboard/views/manage-tailwind.ejs` | Add `streaming` to pageMap with all required data. Map old page keys to redirect to streaming. |
| `dashboard/views/partials/manage/core.ejs` | Remove Live Role field |
| `dashboard/views/partials/manage/overview.ejs` | Update card links to point to `?page=streaming` |
| `dashboard/server.js` | Ensure all streaming data is available for the streaming page (already fetched, just needs passing) |

### Delete (after verification)
Old partials become dead code once redirects are in place:
- `dashboard/views/partials/manage/announcements.ejs`
- `dashboard/views/partials/manage/stream-ended.ejs`
- `dashboard/views/partials/manage/teams.ejs`
- `dashboard/views/partials/manage/twitch-schedules.ejs`
- `dashboard/views/partials/manage/auto-track.ejs`

These can be deleted after confirming the unified page works, or kept temporarily as reference.

## Data Flow

The manage route in `server.js` already fetches all required data:
- `consolidatedStreamers` — grouped streamer/subscription data
- `teamSubscriptions` — from `twitch_teams`
- `twitchScheduleSyncs` — from `twitch_schedule_sync_config`
- `autoTrackConfigs` — from `guild_streamer_auto_track`
- `settings` — guild config (announcement_channel_id, live_role_id, etc.)
- `channels`, `roles` — Discord cache

All of this passes into the `streaming` pageMap entry.

## Form Actions / API Endpoints

All existing POST routes and API endpoints remain unchanged:
- `POST /manage/:guildId/update-announcements` — saves global defaults
- `PATCH /api/guilds/:guildId/stream-ended/subscriptions/:id` — toggle edit_on_end
- `POST /manage/:guildId/delete-team` — delete team
- `POST /api/guilds/:guildId/auto-track/configs` — add auto-track rule
- `POST /manage/:guildId/twitch-schedules/sync` — add schedule sync

No backend changes needed — only the frontend is being reorganized.

## Tab Selection

Tabs switch via client-side JavaScript. The `tab` URL parameter pre-selects a tab:
- `?page=streaming` → Streamers tab (default)
- `?page=streaming&tab=teams` → Teams tab
- `?page=streaming&tab=auto-track` → Auto-Track tab
- `?page=streaming&tab=schedules` → Schedules tab
