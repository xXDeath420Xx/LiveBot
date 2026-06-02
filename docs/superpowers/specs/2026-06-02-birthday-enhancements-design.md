# Birthday System Enhancements — Design

**Date:** 2026-06-02
**Status:** Approved (design)

## Problem

Three gaps in the birthday system:
1. Only a user can set their *own* birthday — admins can't add others.
2. No birth year is stored (`user_birthdays` has `month`, `day` only), so no age.
3. Setting a birthday requires a command with an `MM-DD` string, which confuses
   members. They want a panel with a dropdown-style date picker.

## Decisions (locked)

- **Panel input:** Month **dropdown** → **modal** for Day + optional Year. (Discord
  select menus cap at 25 options, so Day=31/Year can't be single dropdowns; modals
  hold any text but no dropdowns — the hybrid resolves both.)
- **Birth year:** optional. If provided, the announcement shows age ("turns 25");
  no year → no age. Year is opt-in to age display.
- **Admin add-others:** both an admin command (`setfor`) AND a panel admin mode
  (an admin-only "set for a member" control on the panel).

## Schema

One migration: `ALTER TABLE user_birthdays ADD COLUMN year INT NULL`. Nullable keeps
year optional and leaves existing rows valid. No other tables — the panel needs no
DB row (see Persistence).

## Components

### Pure helpers — `core/birthday-helpers.js` (new, no Discord/DB; unit-tested)
- `validateBirthday(month, day, year)` → `{ ok: boolean, error?: string }`. Month
  1–12; day valid for the month (Feb ≤ 29, Apr/Jun/Sep/Nov ≤ 30, else ≤ 31; Feb 29
  always allowed since leap-born is valid); year optional and, if present, an integer
  1900 ≤ year ≤ current year with resulting age ≤ 120.
- `computeAge(year, today)` → integer age the person reaches in `today`'s year, or
  `null` if no year. (Announcements fire on the birthday, so age = `today.year - year`.)
- `parseIntStrict(text)` → integer or `null` (for modal text inputs).

### Manager — `core/birthday-manager.js` (modify)
- `setBirthday(userId, guildId, month, day, year = null)` — validate via
  `validateBirthday`; upsert including `year` (`ON DUPLICATE KEY UPDATE … year = VALUES(year)`).
- `getBirthday` — include `year` in the returned row.
- `checkBirthdays` query (line ~91) and `announceBirthday` (line ~118) — select `year`;
  when present, compute age and substitute a new **`{age}`** placeholder in
  `message_template`. Templates without `{age}` are unaffected; if a template uses
  `{age}` but no year is set, replace it with an empty string and tidy stray spacing.

### Commands — `commands/community/engage.js` + `engage-birthday-handler.js` (modify)
- `set` — add optional integer option `year`; pass to `setBirthday`.
- `setfor` *(new subcommand, Administrator-only)* — options `user` (required),
  `date` (MM-DD, required), `year` (optional). Rejects non-admins with an ephemeral
  message; calls `setBirthday(target.id, …)`.
- `panel` *(new subcommand, Administrator-only)* — option `channel` (optional;
  defaults to current). Posts the panel message (below).
- `view` — display age when the stored row has a year.

### Panel + interaction handlers (new)
Posted by `/engage birthday panel`. Components:
- Embed (instructions) + **Month dropdown** (`bday:month`, 12 options) + button
  **"🔧 Set for a member"** (`bday:adminstart`).

Flows (state carried in the `customId` suffix; everything ephemeral except the panel):
- **Self:** select `bday:month` → open modal `bday:modal:self:<month>` (inputs: Day,
  Year optional) → submit → `setBirthday(user, month, day, year)` → ephemeral confirm.
- **Admin:** click `bday:adminstart` → Administrator check (else ephemeral "admins
  only") → ephemeral **UserSelectMenu** (`bday:adminuser`) → pick member → ephemeral
  **Month dropdown** (`bday:adminmonth:<userId>`) → open modal
  `bday:modal:admin:<userId>:<month>` → submit → `setBirthday(target, month, day, year)`
  → ephemeral confirm.

New handler files, each registered as a **prefix handler** in
`interactions/handlerRegistry.js`:
- `interactions/buttons/birthday_admin.js` — `bday:adminstart`.
- `interactions/select-menus/birthday_month.js` — handles `bday:month` (self) and
  `bday:adminmonth:` (admin); both open the day/year modal with the right customId.
- `interactions/select-menus/birthday_admin_user.js` — `bday:adminuser` → present the
  admin month dropdown for the chosen user.
- `interactions/modals/birthday_set.js` — `bday:modal:` → parse Day/Year, validate,
  `setBirthday`, confirm. Admin variant re-checks Administrator before writing.

Uses `UserSelectMenuBuilder` (first use in the codebase; standard discord.js v14).

## Persistence

The panel needs **no database row**. Interactions route by static `customId` prefix
through `handlerRegistry` (the same mechanism reaction-role buttons use), so a posted
panel message keeps working across restarts indefinitely. The only dynamic state
(target user id, chosen month) is encoded in the `customId` suffix and the modal
customId — never stored.

## Data flow

```
/engage birthday set date year            -> setBirthday(self, m, d, year)
/engage birthday setfor user date year    -> [admin] setBirthday(target, m, d, year)
/engage birthday panel [channel]          -> post panel message

panel month dropdown (self)  -> modal(day, year) -> setBirthday(self, ...)
panel admin button -> [admin] user-select -> month dropdown -> modal -> setBirthday(target, ...)

daily cron -> checkBirthdays (SELECT ... year) -> announceBirthday
              -> message_template with {age} when year present
```

## Error handling

- All validation flows through `validateBirthday`; invalid input → ephemeral error
  (panel/commands) with the specific reason.
- Admin paths (`setfor` command, `bday:adminstart` button, admin modal) re-check
  `PermissionsBitField.Flags.Administrator` server-side at the point of write — never
  trust that only admins could reach a control.
- Modal text inputs parsed with `parseIntStrict`; non-numeric → ephemeral error.
- DB writes and Discord sends wrapped in try/catch with logged context.

## Testing

- **Unit (`core/birthday-helpers.js`):** `validateBirthday` (valid dates; Feb 30 →
  fail; Apr 31 → fail; Feb 29 → ok; month 0/13 → fail; year 1899/future → fail; null
  year → ok); `computeAge` (year + today → age; null year → null); `parseIntStrict`.
- **Manual:** `set` with/without year; `setfor` as admin (and blocked as non-admin);
  panel self flow (month → modal → confirm); panel admin flow (button → user-select →
  month → modal); an announcement showing `{age}`.

## Out of scope (YAGNI)

- Per-user "store year but hide age" toggle (year present ⇒ age shown).
- Timezone-aware birthday timing (uses existing announcement scheduling).
- Editing the Feb-29-in-non-leap-year announcement behavior (unchanged).
- Bulk import of birthdays.
