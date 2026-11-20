# Critters (`/owo`) Module — Clean-Room Notice

## Summary

CertiFried's `/owo` collecting game is now the **Critters** module. It was rewritten clean-room on
**2026-11-19** and is licensed under CertiFried's own licence, **AGPL-3.0-or-later**, like the rest of
the project. No code, text or data from OwO Bot remains in the published repository.

## Scope

This notice applies to the files that implement the game:

- `core/critters/**` (services, rules, data catalogs, jobs, rendering, privacy plan)
- `core/critters-natural-prefix.js`, `core/critters-startup.js`, `core/text-owoify.js`
- `handlers/critters-actions.js`, `handlers/critters-prefix.js`
- `commands/fun/critters.js`, `critters-extra.js`, `critters-profile.js`, `critters-autohunt.js`,
  `critters-luck.js`, `owoify-text.js`
- `dashboard/routes/api/features/critters.js`, `dashboard/views/partials/manage/critters.ejs`
- `migrations/463_critters_schema.js`
- `tests/critters-*.test.js`

## What was replaced

Until 2026-11-19 the game was an "OwO-style" module **derived from**
[OwO Bot](https://github.com/ChristopherBThai/Discord-OwO-Bot) by Christopher Thai, licensed
CC BY-NC-SA 4.0. Its non-commercial term conflicted with CertiFried's AGPL licence. On 2026-11-19 it
was removed:

- `core/owo/**` (97 files, including the translated battle engine with its weapon, passive and buff
  classes, and the seed catalogs of animals, ranks, weapons, passives and gems)
- the old command files (`commands/fun/owo.js`, `owo2.js`, `owo-profile.js`, `autohunt.js`, `luck.js`,
  `owoify.js`), `handlers/owo-prefix.js`, `handlers/owo-social.js`, `core/owo-natural-prefix.js`
- the old jobs, the guild-boss button handler, the old dashboard route and manage page
- the compatibility shims `utils/mysql.js`, `utils/global.js`, `botHandlers/mysqlHandler.js`
- the scripts that generated, translated or imported upstream schema, code and data
  (`scripts/build-owo-*.mjs`, `scripts/translate-owo-battle.mjs`, `scripts/owo-import-*.mjs`)
- the old tests (`tests/owo-*.test.js`)

The bodies of migrations `087`–`092`, `143`, `154`, `160` and `310`–`314` (`*_owo_*.js`) were removed
as well, including the schema and seed data generated from upstream. They remain as empty historical
stubs because they were already applied. Player progress was copied into the new tables by
`migrations/463_critters_schema.js`.

## How it was rewritten

1. A spec writer read the old module and wrote a functional specification from its behaviour, in their
   own words: what each command does, its inputs, outputs, limits and economy rules. Upstream data
   (rarity tables, prices, the animal and weapon rosters, odds and curves) was described by its shape
   only, never reproduced.
2. Separate implementers built the new module from that specification and CertiFried's own code only.
   They never saw the old code. All names, numbers, data catalogs, message text and art are new: for
   example a 40-species roster across seven tiers, an 18-weapon roster with ten perks, and a new currency
   (acorns).
3. A mechanical comparison of old and new code found shared token sequences only in functional
   interface (command, option and config-key names, database column names used by the data migration),
   library boilerplate (discord.js builders, SQL clauses) and CertiFried's own dashboard conventions.
   No message text is shared.

## What is shared with OwO Bot

Only **functional interface and game ideas**, which are not copyrightable expression (see 17 U.S.C.
§ 102(b) and the idea/expression dichotomy):

- the command names members already type (`/owo`, `owo hunt`, `owoh`, their aliases and options), kept
  so existing players' habits still work;
- the general concepts: hunting collectible animals of different rarities, a zoo, selling or
  sacrificing duplicates, gems, lootboxes and weapon crates, teams of three, battles, daily rewards,
  quests, rings and marriage.

CertiFried is not affiliated with OwO Bot. "OwO" is used only as the command word.

## Related: @zuzak/owo

The `/owoify` command uses the [`@zuzak/owo`](https://www.npmjs.com/package/@zuzak/owo) npm package
(MIT) for text transformation. It is an independent work, listed in `THIRD_PARTY_NOTICES.md`.

## Not in the published repository

- The legacy `owo_*` database tables, kept on the server until the owner confirms the switch, and the
  backups of the old files and tables.
- `docs/Discord-OwO-Bot-master/`, a reference copy of the upstream source (CC BY-NC-SA 4.0), excluded by
  `.publishignore`.

Commits published before 2026-11-19 contain the old derived module under its CC BY-NC-SA 4.0 notice;
those files keep that licence.
