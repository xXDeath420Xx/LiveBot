# OwO-Style Module Attribution & License Notice

## Scope

This notice applies **only** to the following CertiFried Utility files, which
together form the "OwO-style" module:

- `core/owo/**` — includes the full translated battle engine under
  `core/owo/battle/**` (22 weapon classes, 21 passives, 12 buffs, interfaces,
  utilities), catalog loader, cowoncy bridge, weapon/team/battle/quest/
  autohunt/luck/ranch/profile services.
- `commands/fun/owo.js`, `commands/fun/owo2.js`, `commands/fun/owoify.js`,
  `commands/fun/autohunt.js`, `commands/fun/luck.js`,
  `commands/fun/owo-profile.js` — slash-command surfaces.
- `handlers/owo-prefix.js` — prefix-command surface.
- `migrations/087_owo_integration.js` through `migrations/092_owo_*.js` — the
  full schema port (60+ `owo_*` tables) and seed data.
- `utils/mysql.js`, `utils/global.js`, `botHandlers/mysqlHandler.js` —
  compatibility shims used *only* by the translated battle module.

All other files in CertiFried Utility are unaffected by this notice and remain
under their original project license.

## Attribution & derivation

The OwO-style module is a direct **derivative work** of **OwO Bot** by
Christopher Thai:

- Source: https://github.com/ChristopherBThai/Discord-OwO-Bot
- Original License: **CC-BY-NC-SA-4.0**
  (Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International)
- License text: https://creativecommons.org/licenses/by-nc-sa/4.0/

**What was ported directly** from the upstream source tree
(`docs/Discord-OwO-Bot-master/`):

- **Database schema** — `CREATE-OWO-TABLES.sql` (87 tables); CertiFried keeps
  the 57 tables relevant to gameplay (patreon, surveys, duplicates of
  systems we already own were excluded). Table names prefixed `owo_`, Discord
  snowflake columns normalized to `VARCHAR(20)`, and `guild_id` added to
  user-scoped tables so Lair's zoo ≠ Pac's zoo. Generated via
  `scripts/build-owo-migration.mjs`.
- **Seed catalogs** — `OWO-TABLE-DATA.sql`: 14 ranks, 20 animals (with full
  HP / ATT / PR / WP / MAG / MR combat stats), 22 weapon registrations, 21
  weapon-passive registrations, 35 gems. Loaded verbatim into `owo_animals`,
  `owo_animals_rank`, `owo_weapon`, `owo_weapon_passive`, `owo_gem`.
- **Battle-engine JavaScript** — all 84 files under upstream's
  `src/commands/commandList/battle/**` translated Eris→Discord.js +
  CommonJS→ESM via `scripts/translate-owo-battle.mjs`. Translation is
  mechanical (imports, exports, module-level `exports.*` patterns); behavior
  is unchanged. Registry indexes (`weapons/index.js`, `passives/index.js`,
  `buffs/index.js`) replace upstream's `require-dir` pattern.
- **Rank metadata** — rarity % / price / points / essence / XP tables from
  `src/data/animal.json`, baked into `core/owo/catalog.js`.
- **Quest tier/chance tables** — `src/data/quests.json` values for
  hunt / battle / owo / xp quest types ported into
  `core/owo/quests-service.js`.

**What is original to CertiFried:**

- Per-guild isolation (upstream is global-state).
- Economy integration via `core/owo/cowoncy.js` — routes to
  `core/economy-manager.js` so the guild's native currency is the cowoncy.
- `core/owo/manager.js` and everything else in `core/owo/*` (catalog loader,
  teams/weapons/autohunt/luck/ranch/profile services, battle orchestrator).
- Dashboard UI and API routes under `dashboard/**/owo*`.
- Slash + prefix command surfaces.
- Gate system (per-guild enable toggle, per-command enable/disable, channel
  allow-list, role block-list).

## Changes from upstream behavior

- **Currency** — no separate "cowoncy" wallet. Rewards flow through the
  guild's existing economy-manager currency.
- **Catalog** — starts with upstream's 20-animal public seed; admins can add
  more animals via the dashboard catalog editor (Phase 9, pending).
- **Battle engine** — simplified turn loop in `core/owo/battle-engine.js`
  using the full upstream weapon/passive/buff classes for stat math. The
  tuple-based stat shape upstream uses in `WeaponInterface.inflictDamage`
  differs from ours (we use plain numbers); a faithful reimplementation
  using the full weapon-ability chain is a pending refinement.
- **Conditional ranks** (`patreon`, `cpatreon`, `distorted`, `hidden`,
  `fabled`, `gem`, `bot`, `special`) kept as rank values in the catalog but
  disabled in random rolls — activate by editing `RANK_META[rank].conditional`
  in `core/owo/catalog.js`.
- **Scope exclusions** — no monetization features (patreon module skipped),
  no stripped-down gambling duplicates (CertiFried has its own gambling),
  no upstream "alter" (patreon embed customization).

## ShareAlike

Per CC-BY-NC-SA-4.0, every file listed in **Scope** is released as a
derivative work under **CC-BY-NC-SA-4.0**. The module **may not be used for
commercial purposes**, including but not limited to:

- Paid hosting services.
- Donation-funded services (per the CC-BY-NC-SA FAQ, donations count as
  commercial use when the software is the draw).
- Patreon / Ko-fi / "pro tier" paywalls.
- Advertising-revenue placements.
- Any offering where software in this module is part of a revenue stream.

CertiFried Utility as a whole is operated as a **non-commercial community
project** — no paid features, no donations, no revenue of any kind.

## Related: @zuzak/owo

The `/owoify` command uses the [`@zuzak/owo`](https://www.npmjs.com/package/@zuzak/owo)
npm package (MIT-licensed) for text transformation. That package is an
independent work and is **not** subject to OwO Bot's CC-BY-NC-SA license.
