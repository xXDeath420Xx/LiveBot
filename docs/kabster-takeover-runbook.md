# Kabster's Shit Cunts — Guild Takeover Runbook

**Guild:** `814321716872347648` · **Our bot:** Kabbot `1522493725526327386`
**Evidence:** scan id 6 — 6,728 messages, all 34 text channels read to their first message,
20 bots, 1,462 distinct response templates, 115 members. REST-GET only; zero writes.
**Status:** NOT EXECUTED. Nothing in this document runs until you say go.

---

## 1. The one thing that blocks everything

**Kabbot cannot remove any of the bots today.**

Sixteen bots — including Kabbot — all hold the same role, **`Clanker 🤖` (position 103)**. Discord
only lets you remove a member whose highest role is *strictly below* yours. Equal rank is a refusal,
and **Administrator does not bypass it**. So Kabbot's highest role ties with every bot it is meant
to replace.

```
105  Karabi
104  Bot Developer
103  Clanker 🤖        <-- Kabbot AND 15 bots to retire all sit here
102  Kabbot            (managed/integration role)
101  Twitch Mod
100  Discord Mod
```

The retirement gate already catches this and refuses (`core/bot-retirement.js:146`), so nothing was
ever going to slip through — but it means **step 0 below is mandatory**.

Three bots are already below Kabbot and could be removed today: **Nightbot (87), DISBOARD (81),
Sx Bot (80)**.

---

## 2. What we found that changed the plan

**Dyno is already gone.** It was the second-most active bot in the server (308 messages, 252
templates) and it is *not* a guild member — it left, and its webhook has since been deleted. It did
pure logging into `#mod-bot-logs`: message edits/deletes, bulk deletes, voice join/leave, nickname
changes, role grants/removals, role setting changes, member joins (with account age), leaves, and
timeouts.

**We already replace it.** `logging_config` for this guild already points at `#mod-bot-logs`
(`1466957583133708520`) with every one of those event types enabled. **No action needed** — but be
aware the server has had **no moderation logging at all** since Dyno left.

**A stale counting row.** `counting_channels` has a row pointing at `#mod-bot-logs`, not at
`#𝗰𝗼𝘂𝗻𝘁𝗶𝗻𝗴`. It is inert (`is_active = 0`) and the unique key is `(guild_id, channel_id)`, so
applying the real counting channel inserts a **new** row rather than hijacking the log channel. It
is not dangerous, but it gets cleaned up (step 5).

**The platform emoji are not ours.** The five emoji on Carl-bot's platform panel (steam, xbox,
playstation, switch, android) live on **Carl-bot's own emoji server**. A bot may only use a custom
emoji from a guild *it* is in, so once Carl-bot leaves we can neither react with them nor put them
on a button. They must be re-hosted here first (step 6). The guild has 68 free static emoji slots
and no name collisions; all five source images are still on the CDN.

---

## 3. Progress — what survives

Discord exposes no API for another bot's stored data, so I first assumed all of this was lost. Most
of it isn't: the bots *said* enough in the channels to rebuild from.

| Bot | Lost |
|---|---|
| **OwO** | *mostly recoverable — see below. Only cowoncy is truly lost.* |
| **Cat Bot** | cats caught, achievements |
| **Grow a Tree** | *nothing — carried over at 190ft, see below* |
| **TacoShack** | *(not being retired — no equivalent exists)* |

You accepted a reset on condition of **exact behaviour**, so the clones were audited against what
the real bots actually posted in *this* guild and corrected (commit `d9915a8`). Since then, OwO and
the tree turned out to be recoverable too — so only Cat Bot still resets.

- **Cat Bot** — rarity slot 6 renamed `Gremlin` → **`Baby`**; spawn wording and `/cat setup` reply
  matched; achievements now render as an **"Achievement get!"** embed; added **"First cat!"** and
  **"Who Ping"** (which needed a mention handler we never had); spawning now *reports* missing
  permissions instead of silently stopping.
- **Grow a Tree** — buttons are **`grow`** / **`refresh`**; description reads
  **"Your tree is 188ft tall."** with the waterer and readiness in the same block; whole feet.
- **OwO** — **levels removed.** Hunts were feeding XP into the *server* leveling system, so a member
  could out-rank everyone by spamming `owoh` without ever talking. The real OwO grants no server XP
  either. Sacrifice still yields *essence*; that was never server XP.

### OwO — the four missing features are now built (commit `488c421`)

Upstream is vendored at `docs/Discord-OwO-Bot-master`, so these use its real constants, not guesses:

| Real OwO here | Ours, now |
|---|---|
| `owoh` returns **several** animals on one line, "empowered by" gem counters | same: `N = (1 + Hunting.amount) × 2` if Empowering — a Legendary Hunting gem gives the **16** we observed |
| `owob` embed with **`<name>'s Team` / `Enemy Team`** fields | same |
| **Lootboxes** and **Empowering Gems** | 35-gem catalog, one active per type, `[left/length]` uses |
| **Timed weapon-crate drops**, `RESETS IN 6H 7M` | same: first drop after midnight guaranteed, then 5%, cap 3/day |

Verified by replay: hunt XP is the sum of each animal's rank XP, and our table reproduces five
captured hunts (126 / 489 / 62 / 443 / 108 xp) **exactly**.

Two aliases changed to match upstream: **`owo lb` now opens a lootbox** (was leaderboard) and
**`owo use` activates a gem** (was equip). `owo top` still reaches the leaderboard and `owo equip`
still equips, so nothing became unreachable.

`/owo` was already at Discord's 25-subcommand cap, so the six `team-*` subcommands were folded into
a `team` group. Chat accepts both `owo team add` and `owo team-add`.

### Grow a Tree — carried over, not reset (commit `51e19c4`)

The real tree is **190ft** with **45m52s** of growing behind it. `/tree plant` now takes a `height`
and a `last-watered-by`, so it continues instead of restarting:

```
/tree plant name:Kababi height:190 last-watered-by:@you
```

It generates a real 190-segment trunk (writing `size` alone would have collapsed the tree back to
4ft on the first water), arrives **ready**, and keeps whose turn it is. Our `getTreeAge(190)` gives
45m50s against their 45m52s — a 2-second rounding delta, confirming the growth curve is already
theirs.

### OwO progress is recoverable — `#owo-game` is a full transcript (commit `94cfb18`)

OwO joined 2026-05-27 and `#owo-game` goes back that far, so the channel holds **its entire history
in this guild**. And OwO is chatty: `owo inv` printed an exact inventory, every hunt/opening/battle
after it is a replayable delta, and the hunt line carries each gem's remaining uses.

**Only karabi actually plays.** Her state, rebuilt and cross-checked by hand:

| | |
|---|---|
| gems | **502** across 20 kinds (494 in the dump + 8 from openings) |
| active | Legendary Hunting + Empowering + Lucky — the exact loadout that gives 16-animal hunts |
| lootboxes | **1** (3 + 6 found − 8 opened) |
| weapon crates | **232** (227 + 5 found) |
| weapons | **282** across 19 types |
| team | `karabi's Team` — 🐊 🐅 🐘, all **L. 26** |

```
node scripts/owo-import-from-channel.mjs 814321716872347648 1509191647320346725 --apply
```

REST-GET only, dry-run by default. **Not lost:** gems, lootboxes, crates, weapons, team, pet levels.
**Lost:** cowoncy (never printed), her pre-channel zoo (OwO's economy is global, so the imported zoo
is a floor), and each weapon's rolled qualities (type and count exact, stats re-roll).

**There are no guild bosses.** OwO has no such feature and none appear anywhere in the channel.

**So only Cat Bot still truly resets.**

---

## 4. The 20 bots

**Retire (15)** — we replace the feature:
Carl-bot · Pingcord · Counting Bot · Nightbot · Sx Bot · CannaFriend · Friend Time · Birthday Bot ·
Cat Bot · Grow a Tree · **OwO** · Ko-fi Bot · FreeStuff · FlaviBot · Throne Integration Bot

OwO's four missing features are built (§3), so the only thing it still costs is its **progress**
(cowoncy, animals, weapons, zoo) — which no API can move. Say that before retiring it.

**Keep (4 + 1 webhook)** — no equivalent exists:
**TacoShack** (idle game) · **DISBOARD** (bump service) · **BetterTTV** (Twitch emotes) ·
**Blerp** (voice soundboard with a *hosted* clip library — it posts zero messages, so a text scan
never sees it; our `/soundboard` only plays clips you upload) · **TANGIA** (webhook-only Twitch TTS,
no bot user — leave the webhook in `#𝙩𝙩𝙨` alone).

---

## 5. The steps, in order

Everything below is idempotent and safe to re-run. Steps 1–7 are **config only** — they never post,
edit or delete a message. Steps 8 and 9 are the two that touch the server, and each is its own
deliberate action.

### Step 0 — Fix the hierarchy *(manual, you)*
Drag Kabbot's role above **`Clanker 🤖`**, or move `Clanker 🤖` below it. Nothing can be retired
until this is done. Karabi and Bot Developer stay above Kabbot either way.
**Verify:** `/takeover` shows the `hierarchy` gate green.

### Step 1 — Scan *(already done — re-run to refresh)*
Dashboard → `?page=takeover` → **Scan**. Full history, resumable, REST-GET only.

### Step 2 — Counting → `#𝗰𝗼𝘂𝗻𝘁𝗶𝗻𝗴` (`1466965996224118807`)
Seeds at the number read live from the channel at apply time (**314** at audit; re-read, never
stale). **Infinite attempts**, exactly as configured today:
`fail_mode='delete'` · `allow_same_user=1` · `delete_chatter=1` · `announce_milestones=0`.
Any message that is not the exact next number is deleted, whoever posts it. The count never resets.
`allow_same_user=1` is load-bearing — without it the correct next number gets deleted purely because
the same person posted the previous one.

### Step 3 — Disable the stray counting row on `#mod-bot-logs`

### Step 4 — Stream announcements → **Karabi420** (twitch, id `585693894`) → `#kabs-live★`, ping `@everyone`
**This was the gap.** Pingcord announces her with `@everyone` and she was **never** in our
`subscriptions`. Retiring Pingcord without this silently kills the server's most important
announcement.

### Step 5 — Nightbot
- **Commands** → `custom_commands`: `!pp` (`{user.name} has a {random:1-10}% inch pp :0` — a random
  roll, `:0` is literal) and `!karabi`.
- **Autoresponses** → `autoresponders` (the live table; `auto_responses` is dead): `bruh`, `W`, `L`.
  These fire on the **first word of plain chat**, not on a prefix — registering them as commands
  would not reproduce the behaviour. Verified by replaying all 4,773 real human messages: 14 fires
  across five years, with every known negative ("Well", "lol", "Love ya too bruh") silent.

### Step 6 — Platform emoji
Re-uploads steam / xbox / playstation / switch / android from the CDN into this guild. Additive and
idempotent. **Step 8 refuses to run until this is done.**

### Step 7 — The rest of the config
Timezone (Friend Time) · Cat Bot channel · Ko-fi · FreeStuff · birthdays · CannaFriend · Throne.
Ko-fi still needs its **webhook token** from Karabi's Ko-fi settings — that step stays blocked
until it is supplied.

### Step 8 — Post the role panels *(posts messages — deliberate, separate action)*
Rebuilds Carl-bot's four self-assign panels in `#self-assign-roles･ﾟ❀` as **buttons**: region (5),
pronouns (4), platform (5), zodiac (12) — **26 roles**. Carl-bot's originals are left where they
are; they simply stop responding when it leaves, and can be deleted afterwards.

The 🦒 **Africa** role is **already deleted** — Carl-bot's live panel still offers it and it silently
does nothing. We drop it rather than carry the bug across. Recreate the role and re-add the option
if it is still wanted.

*(`/cat setup` and the tree carry-over are run here:
`/tree plant name:Kababi height:190 last-watered-by:@you`)*

### Step 9 — Retire the bots *(one at a time, owner only, typed confirmation)*
Each bot is re-gated **live** at the moment of removal — a plan that passed an hour ago proves
nothing. All eight gates must be green:

`known` · `present` · `parity` (every template attributed) · `evidence` · `data` (extraction
acknowledged) · `hierarchy` (step 0) · `permission` · `soak` (parity held **uninterrupted** for 24h
— the clock resets on any regression)

Removal prefers `DELETE /guilds/{id}/integrations/{id}` over a kick.

**Order:** start with the two that are already below us and need no hierarchy change — **Nightbot**,
then **Sx Bot**. (DISBOARD is also below us, but it is on the keep list.) Then, once step 0 is done,
the rest. Retire **Pingcord last** — it is the one whose failure is loudest and most visible.

---

## 6. Before you start

- [ ] **Say out loud** that OwO and Cat Bot progress resets (§3). Do it *before*, not after.
      Grow a Tree does NOT reset — it carries over at 190ft.
- [ ] Get the **Ko-fi webhook token**.
- [ ] Do **step 0**. Nothing retires without it.
- [ ] Leave **TANGIA**'s webhook in `#𝙩𝙩𝙨` alone.
