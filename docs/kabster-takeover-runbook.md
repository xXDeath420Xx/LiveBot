# Kabster's Shit Cunts — Guild Takeover Runbook

**Guild:** `814321716872347648` · **Our bot:** Kabbot `1522493725526327386`
**Evidence:** scan id 6 — 6,728 messages, all 34 text channels read to their first message,
20 bots, 1,462 distinct response templates, 115 members. REST-GET only; zero writes.
**Status:** NOT EXECUTED. Nothing in this document runs until you say go.

---

## 1. The hierarchy blocker — now CLEARED ✅

The earlier plan opened on a hard blocker: Kabbot and sixteen bots all sat on the same role,
`Clanker 🤖`, and Discord only lets you remove a member whose highest role is *strictly below* yours,
so Kabbot could not remove anything. **That has since been fixed** — Kabbot's managed role was raised
above `Clanker 🤖`.

Verified live on 2026-07-12:

```
106  Karabi
105  Bot Developer
104  Kabbot            <-- Kabbot's managed role, now ABOVE Clanker
103  Clanker 🤖        <-- every bot to retire tops out here (or lower)
102  Twitch Mod
101  Discord Mod
```

**All 19 target bots are removable by Kabbot today.** 16 top out at `Clanker 🤖` (103); Nightbot (88),
DISBOARD (82) and Sx Bot (81) are lower still. Nothing is blocked on hierarchy. The retirement gate
(`core/bot-retirement.js`, strict `comparePositionTo(...) > 0`) now passes for each of them, so Step 0
in §5 is already satisfied — leave it as a pre-flight check, not a task.

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

<a id="analyzer"></a>
**The analyzer was blind to Components V2** *(fixed, `602dc6d`)*. A CV2 message carries its entire
text inside `components[]`, with an **empty `content` and empty `embeds`**. `templateOf()` read only
`content`, `embeds`, and one flat level of button labels — so a CV2 message reduced to the empty
string and was silently dropped. **99 messages in this guild were invisible**: all **95 FreeStuff**
posts (which is exactly why it scanned with *zero* templates), **OwO's guild boss**, and 3 OwO
level-ups. A bot cannot be cleared for retirement on evidence the scanner cannot see. `templateOf`
now walks the component tree recursively; re-verified against the live guild — **99 CV2 messages, 0
still blank.** FreeStuff's real output turned out to be Steam/Epic giveaways *and free weekends* plus
a Prime-Gaming opt-in panel; our `free-games-manager` covers Epic, Steam, GOG **and** Prime including
free weekends, so its retirement still stands — but now on actual evidence rather than on silence.

---

## 3. Progress — what survives

Discord exposes no API for another bot's stored data, so I first assumed all of this was lost. Most
of it isn't: the bots *said* enough in the channels to rebuild from.

| Bot | Lost |
|---|---|
| **OwO** | *fully recoverable — see below. Cowoncy included, once someone runs `owo balance`.* |
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
**Recovered 2026-07-13:** cowoncy. It was only ever "lost" because a balance appears in a channel
*only if somebody runs `owo balance`* — and nobody had. Once karabi and death420 did, OwO printed
them and `scripts/owo-import-cowoncy.mjs` read them straight out of its own reply:
karabi **1,671,101**, death420 **15,000**. New players now start at **15,000** (migration 160), so
nobody opens on nothing next to a carried-over millionaire.

**Still lost:** her pre-channel zoo (OwO's economy is global, so the imported zoo
is a floor), and each weapon's rolled qualities (type and count exact, stats re-roll).

### Guild bosses DO exist, and we don't have them (gap)

I previously wrote that OwO has no guild bosses. **That was wrong**, and the reason it was wrong is
worth keeping: the boss post is a **Components V2** message — empty `content`, empty `embeds`, all of
its text nested inside `components` — and the analyzer only read `content` + `embeds`. It reduced to
an empty string and got dropped. Fixed in `602dc6d`; see §Analyzer below.

One boss has spawned here, message `1509192313501520044` in `#owo-game`:

```
# 🐉 A Guild Boss Appeared!
### Top 10 Damage Dealt
**__`Rank`__ __`Damage`__ __`Username`__**
**`1   `** ` 7,174` @karabi420
### Rewards
-# ⏳ runs away <t:1779893486:R>   ⚔️ 1 fighters   💀 0 defeated
[Inspect] [Leaderboard] [Fight!]
```

**It ran away undefeated** — one fighter, zero kills. So there is no boss progress to carry over and
nothing was lost. But the *feature* is a real parity gap: if we retire OwO, bosses stop spawning.

The boss command source is **not** in the vendored repo (it postdates it — the message is CV2 and
links `owobot.com/battle-log`). The **schema is**, in `secret/CREATE-OWO-TABLES.sql`, and it pins the
mechanics exactly:

| table | tells us |
|---|---|
| `guild_boss(gid, active, created, boss_animal, boss_lvl, boss_hp, boss_wp)` | one boss per guild — an **animal** at a level, with HP and weapon points |
| `boss_weapon(gid, wid, stat, avg)` | it wields a **real weapon** from the weapon table |
| `boss_weapon_passive(gid, pcount, wpid, stat)` | …with passives |
| `user_boss(gid, uid, total_dmg)` | cumulative damage per user — exactly the "Top 10 Damage Dealt" board |

So a boss is an ordinary battle enemy built from the systems we already have (animals, weapons,
passives, teams), fought with your battle team, accumulating `total_dmg` per user, and despawning on
a timer if the guild doesn't finish it.

**✅ Built (migration 154).** A guild boss now spawns off hunts (low chance, one at a time), or via
`owo boss spawn` (manager only). Anyone fights it with their active team — `owo boss fight` or the
**Fight!** button on the announcement — dealing damage drawn from their real roster (rank + stats +
weapon), banked per user in `owo_boss_damage`. The announcement carries a live HP bar and Top-10
board and a runs-away timer. Kill it before the timer and everyone who fought is paid cowoncy
weighted by damage (top dealer gets +15%); miss the timer and it flees (a 2-minute reaper job edits
the message to its fled state). `core/owo/guildboss-service.js` + `guildboss-text.js` +
`interactions/buttons/owo_guildboss.js` + `jobs/owo-boss-reaper.js`. So OwO parity is now complete
except progress (cowoncy).

**So the only thing left that truly resets is Cat Bot.**

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

## 4½. Server health — the full-audit picture (2026-07-12)

Run `node scripts/guild-full-audit.mjs 814321716872347648 --json out.json` for the complete dump
(REST-GET only, safe while live). What it surfaced beyond the bots, and what to raise with the owner:

**Snapshot.** Created 2021-02-25 (1,963 days). 115 members, 20 bot members. 34 text channels,
6,743 messages. 113 emoji, 15 stickers, 13 soundboard sounds. 22 integrations, 11 invites, 2 webhooks.

**Security — two things to fix, owner's call:**
- **2FA for moderation is OFF.** Any compromised mod account can ban/kick. Owner can turn on
  "Require 2FA for moderation" in Server Settings → Safety Setup.
- **Verification is Low.** A fresh account can post immediately. Medium gates accounts younger than
  5 minutes. Explicit-content filter is already at "All members" (good). One AutoMod rule
  (Block Mention Spam) — light, but present.
- Dangerous roles worth an eyeball: `ALT` and `Fake` both carry admin-equivalent perms with 1 and 3
  holders. `Clanker 🤖` (the bot role) holds ManageGuild/ManageRoles — expected for bots, but it is
  what every incumbent tops out at.

**Role hygiene — Carl-bot leftovers, safe to prune AFTER the panels are rebuilt (Step 8):**
- Pronoun roles exist ~5× over and region roles ~2× (old reaction-role panels stacked them up).
- Several 0-holder roles and unnamed "new role" placeholders.
- The readiness card on `?page=takeover` lists the exact duplicate names and counts live.

**Nothing here blocks the takeover** — it is cleanup and hardening to do alongside it.

---

## 5. The steps, in order

Everything below is idempotent and safe to re-run. Steps 1–7 are **config only** — they never post,
edit or delete a message. Steps 8 and 9 are the two that touch the server, and each is its own
deliberate action.

### Step 0 — Hierarchy *(already done — pre-flight check only)*
Kabbot's role is at **104**, above `Clanker 🤖` (103). All 19 target bots are removable.
**Verify before starting:** `?page=takeover` → open any bot → the `hierarchy` gate is green. If
someone has since re-ordered roles and it is red, drag Kabbot's role back above `Clanker 🤖`.

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
**Ko-fi is no longer blocked** — Karabi supplied her webhook token (`5e39361f-981b-4b28-945a-f90ff37843a4`,
answered `kofi=token`); `/kofi setup` + `/kofi tier` can run.

### Step 8 — Post the role panels *(posts messages — deliberate, separate action)*
Rebuilds the self-assign panels in `#self-assign-roles･ﾟ❀` as **buttons**. Six panels:
region (7, incl. restored 🕌 Middle East), pronouns (4), platform (5), zodiac (12), **timezone (12)**
and **pings (5)**.

**No colour panel.** Karabi approved the clean-up with *"everything but colours!"* (answered
`roles_ok=go`), so *Pick a name colour* is **not** posted — her seven existing colour roles stay as
they are, pickerless, and no duplicates are renamed into colours. Enforced in code
(`GUILD_PROFILES.skipPanels`), so it cannot be posted by accident.

The 🦒 **Africa** role was previously deleted and is now **restored** in the region panel (role
`1466950520668422421`).

**Also posted here (her answers):**
- **Spare-role panel** — the 7 roles she named, verbatim: `Fortnite, Streamer, Minecraft, Party
  Games, Among Us, 18-20, 21+` (answered `spare_roles=names`).
- **Twitch link panel** — a "Link your Twitch" button in the self-assign channel (`twitch_member_link=panel`,
  note *"self roles!"*). Her own Twitch links via the dashboard so her VIPs/mods map to **existing**
  Discord roles (`twitch_roles=yes`, *"Existing ones please"*). Subscriber roles stay Discord-native.

**The tree — a forest fire, not a carry-over.** Karabi changed her mind: she answered `tree=fresh`
with the note *"We would like a forest fire natural disaster story"*. So the tree **does** reset now.
The sequence (run at removal of Grow a Tree, so there aren't two trees visible):
1. `/tree plant name:Kababi height:193 last-watered-by:@karabi` — carry the incumbent's live height
   in so the fire has a real 193ft tree to consume.
2. Trigger the **Forest fire** action (`POST /forest-fire`, owner-only, typed `BURN`). It burns the
   193ft Kababi, posts the fire → green-shoot → sapling story, and pins the sapling. Levels, XP,
   coins and sticker books all survive; the tree and gardener board do not.

The tree minigames (bug net → sticker book, falling fruit → baskets → coins → community composter)
ship with ours and are live.

*(`/cat setup` is run at Cat Bot's removal, not here — both would spawn cats otherwise.)*

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
- [ ] The tree resets too, on purpose — the **forest fire** story (§ step 8). Not a silent loss.
- [x] ~~Get the Ko-fi webhook token~~ — supplied (`kofi=token`).
- [x] ~~Hierarchy (step 0)~~ — verified live 2026-07-13: Kabbot @104, all 19 bots strictly below.
- [ ] Do **step 0**. Nothing retires without it.
- [ ] Leave **TANGIA**'s webhook in `#𝙩𝙩𝙨` alone.
- [ ] Raise verification to **Medium** (`sec_verify=raise`, *"nothing too crazy"*). Leave **2FA off**
      (`sec_2fa=off`, she finds it annoying). Leave the **ALT** role alone (`sec_alt=intended`).
- [ ] She does **NOT** want, so do not switch on: automod/word-filters, welcome messages, reminders,
      tags, D&D, CAH, TTS, social feeds, game-patch watcher, grow journal.

## 7. The soak gate — why this is TWO sessions, not one *(added 2026-07-13)*

The retirements cannot happen the same day as the config. The `soak` gate requires the replacement to
have run **24h uninterrupted** with every other gate green, and the clock **has not started** —
`guild_retire_state` is empty. This is correct: most of our replacements (OwO, counting, Nightbot,
Cat Bot) are still OFF, because turning them on while the incumbent is present makes both bots reply.

**Session 1 (today).** Apply the non-conflicting config, post the panels (step 8), run the tree fire,
then open `?page=takeover` and evaluate each bot so the soak clocks **start**. Nothing is removed.

**Session 2 (≥24h later).** Retire the bots one at a time (§ step 9), each re-gated live. Flip the
**sequenced** replacements on as their incumbent leaves — OwO the moment OwO goes, counting as
Counting Bot goes, Nightbot commands/autoresponses as Nightbot goes, `/cat setup` as Cat Bot goes.
**Pingcord last.** Its `@everyone` go-live ping is the loudest thing to break, and our Karabi420
subscription must be confirmed live before it leaves — this was the original gap.

Compressing the soak (removing today) is a call only the owner can make, and it means skipping the
one thing the soak proves: that our replacement ran correctly in *this* server before the original
was burned. Given the conflicting features were never live here, that proof has real value.
