# Word Games — Design

**Date:** 2026-06-05
**Status:** Approved (design)
**Scope:** Add four word games to the CertiFried bot codebase (main bot + all custom bots), opt-in per guild.

## Goal

Add four community word games, requested by a user:

1. **Last Letter** — a word-chain in a channel; each new word must start with the previous word's last letter.
2. **One Word Story** — a collaborative story built one word per message.
3. **Coordle** — collaborative/multiplayer Wordle on a shared board in a channel.
4. **WordSeek** — find hidden words in a generated letter grid; solo or competitive with leaderboards.

References: [WordSeek (top.gg)](https://top.gg/bot/1124663464938450984), [better-coordle (GitHub)](https://github.com/thienautran/better-coordle), [Cordle (top.gg)](https://top.gg/bot/952524514879737906).

Note: the original WordSeek bot is forced to collect guesses via a pop-up modal because it cannot read message content. **This bot already reads message content** (the counting game and phishing scanner prove it), so all four games can accept guesses/words typed directly into the channel.

## Decisions (locked with requester)

- **Rollout:** built into the shared codebase so the main bot + every custom bot has the games, but each game stays OFF until a guild admin enables/sets it up (the counting-game model). No game fires in a guild without setup.
- **Session model:** support BOTH a persistent always-on bound channel AND ad-hoc `start`/`end` rounds; admin chooses per channel.
- **Last Letter validation:** must be a real dictionary word, start with the previous word's last letter, and not repeat a recently-used word. No profanity filter — real crude words (e.g. `penis`, `slut`) are in the dictionary and pass, appropriate for 18+ guilds.
- **Stats:** full per-player/per-guild stats + leaderboards, like trivia/counting.

## Approach

One shared **Word Games framework** plus four thin, isolated game-engine modules. All four games share the same plumbing — per-guild opt-in, per-channel binding or ad-hoc rounds, a word dictionary, restart-safe state, and stats — so that plumbing is built once and each game plugs in. This mirrors how CAH / counting / trivia already factor in this codebase, and makes WordSeek (the most complex game) cheap to add once the framework exists.

Rejected alternatives: four fully standalone features (duplicates channel-binding, rehydration, and stats logic 4×, and behavior drifts between games); per-game managers with no shared framework (still duplicative).

## Architecture

```
core/word-bank.js              loads bundled word data into in-memory Sets (offline, deterministic)
core/word-game-manager.js      session registry, channel lookup, rehydration, stats, persistence
core/games/last-letter.js      engine: validate / advance / render
core/games/one-word-story.js   engine
core/games/coordle.js          engine (incl. duplicate-letter coloring)
core/games/wordseek.js         engine (grid placement + find matching)
events/messageCreate.js        + handleWordGameMessage(message) hook (after counting; returns true=consumed)
commands/games/arcade.js       + 4 subcommand groups (lastletter / story / coordle / wordseek)
data/words/*.txt               committed dictionaries (no runtime network)
migrations/122_word_games.js   schema
```

**Message flow:** a channel-typed message → `handleWordGameMessage(message)` looks up an active session for that channel (in-memory map, hydrated from DB) → routes to the bound game's engine → engine validates and reacts (✅/❌) and mutates state → returns `true` when consumed so downstream processing stops. The hook is fully `try/caught`: on any error it logs and returns `false`, so leveling/automod/phishing still run and the message pipeline is never broken.

**Slash-command flow:** `/arcade <game> start` (or `setup`) creates/seeds the session; subsequent typed messages drive it through the same engine.

**Unit boundaries:** each engine module is responsible for exactly one game's rules and rendering, depends only on `word-bank` (for word data) and a session object (plain state), and is unit-testable without Discord. The manager owns persistence, the channel→session index, rehydration, and stats. The command file and the message hook are the only Discord-aware layers.

## Word source (offline, committed)

`core/word-bank.js` loads committed files under `data/words/` into memory once at boot (lazy singleton):

- `english.txt` (~270k words) → `isWord(w)` for Last Letter, valid-guess checks, and length-bucketed word planting for WordSeek.
- `coordle-answers.txt` (~2,300 curated common 5-letter words) → secret Coordle answers. **Valid Coordle guesses** = any 5-letter word present in `english.txt`, so guesses feel fair while answers stay common/guessable.

No profanity filter is applied. Files are generated from public word lists at build/implementation time and committed — no runtime network dependency, deterministic, version-controlled.

`word-bank` API (indicative):
- `isWord(word): boolean`
- `randomAnswer(length=5): string`
- `isValidGuess(word, length=5): boolean`
- `wordsByLength(min, max, count, opts): string[]` (for WordSeek planting)
- `ready(): Promise<void>` / `loaded: boolean`

## Data model (migration 122, idempotent)

```sql
word_game_channels (
  guild_id     VARCHAR(20) NOT NULL,
  channel_id   VARCHAR(20) NOT NULL,
  game_type    VARCHAR(32) NOT NULL,   -- 'last_letter' | 'one_word_story' | 'coordle' | 'wordseek'
  enabled      TINYINT(1) NOT NULL DEFAULT 1,
  config_json  JSON NULL,              -- per-channel options (e.g. story no-double-post, coordle daily)
  created_by   VARCHAR(20) NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (guild_id, channel_id)   -- one persistent bound game per channel
);

word_game_sessions (
  id            VARCHAR(36) PRIMARY KEY,   -- uuid
  guild_id      VARCHAR(20) NOT NULL,
  channel_id    VARCHAR(20) NOT NULL,
  game_type     VARCHAR(32) NOT NULL,
  mode          ENUM('persistent','round') NOT NULL,
  status        ENUM('active','ended','abandoned') NOT NULL DEFAULT 'active',
  host_user_id  VARCHAR(20) NULL,
  state_json    JSON NOT NULL,             -- chain head + used-set, story text, coordle board, wordseek grid+found
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  ended_at      TIMESTAMP NULL,
  INDEX idx_channel (channel_id),
  INDEX idx_active (guild_id, status)
);

word_game_stats (
  guild_id          VARCHAR(20) NOT NULL,
  user_id           VARCHAR(20) NOT NULL,
  game_type         VARCHAR(32) NOT NULL,
  games_played      INT NOT NULL DEFAULT 0,
  wins              INT NOT NULL DEFAULT 0,
  words_contributed INT NOT NULL DEFAULT 0,
  best_score        INT NOT NULL DEFAULT 0,   -- longest chain / WordSeek high / etc.
  current_streak    INT NOT NULL DEFAULT 0,
  best_streak       INT NOT NULL DEFAULT 0,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (guild_id, user_id, game_type)
);
```

`state_json` mirrors CAH's restart-recovery pattern. On boot, `rehydrateWordGames()` reloads all `status='active'` sessions into the in-memory registry and re-arms round timers (round-mode sessions older than a cap are marked `abandoned`, like CAH's 24h sweep). Last Letter's no-repeat set lives in `state_json`, capped to the most recent ~500 words to bound size.

## Per-game mechanics

### Last Letter (persistent or round)
Each message: take the first whitespace token, strip punctuation. It must (a) be a real word via `word-bank.isWord`, (b) start with the prior word's last letter, (c) not be in the recent-used set. Valid → ✅ react; chain head advances to the word's last letter; append to used-set; `words_contributed += 1`; update `best_score` if the chain length is a new max. Invalid → ❌ react plus a brief auto-deleting hint reply; the last good word stands (a single bad message does not reset the chain). A fresh chain accepts any valid word as the seed.

### One Word Story (persistent or round)
The message must be exactly one word (single token; letters/an apostrophe/hyphen allowed). Optional per-channel rule: a user can't post twice in a row (`config_json.no_double_post`). Append the word to the story in `state_json`. `/arcade story show` renders the story so far; `/arcade story end` posts the finished story and archives it (session → ended). `words_contributed += 1` per accepted word.

### Coordle (collaborative Wordle)
`/arcade coordle start` (round) or an auto-rolled puzzle in a bound channel seeds a secret answer via `word-bank.randomAnswer(5)`. Players type 5-letter guesses (or `/arcade coordle guess`). A guess that isn't 5 letters or isn't a valid word → ❌ and does **not** consume a guess. Valid guess → the shared board re-renders with 🟩 (right letter, right spot) / 🟨 (right letter, wrong spot) / ⬛ (absent), implementing the correct **duplicate-letter** rule (a guessed letter only earns yellow up to the count remaining in the answer after greens are assigned — the classic Wordle edge case, explicitly unit-tested). Six shared guesses; the whole channel wins or loses together. Win updates `wins`, `current_streak`/`best_streak`. Bound channels can auto-start a fresh daily puzzle.

### WordSeek (grid find)
`/arcade wordseek start` posts a letter grid (default 10×10, rendered in a monospace code block) with N planted words placed horizontally / vertically / diagonally (forward and reversed), the remaining cells filled with random letters, plus a hint listing remaining count and word lengths. Players type words they spot; a typed word that matches an unfound planted word is marked found and scored (longer = more points; e.g. points = length). The round ends when all words are found or a timer expires, then the bot reveals any unfound words. `best_score` tracks a player's best single-round points; leaderboard ranks by points. Word planting and find-matching are pure and unit-tested.

## Admin surface (per-guild opt-in)

Extends the existing `/arcade` hub (where `counting` already lives). Each game adds a subcommand group with:

- `setup channel:#chan` — bind a persistent always-on game to a channel (writes `word_game_channels`). **Manage Server** only.
- `disable` — unbind / stop the persistent game in a channel. **Manage Server** only.
- `start` / `end` — open/close an ad-hoc round in the current channel.
- `stats` — caller's (or a target user's) stats for the game.
- `leaderboard` — top players in the guild for the game.

Nothing fires in a guild until an admin runs `setup` or `start`. Custom bots inherit the feature automatically (shared codebase; existing per-bot arcade command deployment). Subcommand-group count stays within Discord's limits.

## Error handling & edge cases

- `word-bank` load failure → log and continue: Last Letter degrades to letter-rule-only (no crash); Coordle/WordSeek refuse to start with a clear user-facing message until the bank is available.
- The `messageCreate` hook is fully `try/caught` and consume-or-pass; non-game messages flow on to leveling/automod/phishing unchanged.
- One game per channel (PK on guild+channel) prevents a channel hosting two games at once; `setup` on an already-bound channel returns a clear error.
- Restart-safe via `word_game_sessions` rehydration + re-armed timers; stale round sessions are swept to `abandoned`.
- Reactions and edits are rate-limit-aware (debounced board/status re-renders rather than per-message edits where high-volume).

## Testing

- **Unit** (gitignored `tests/`): `word-bank` lookups; Last Letter validation (letter rule / dictionary / repeats); **Coordle duplicate-letter coloring** (dedicated cases); One Word Story token rules (single-word, double-post); WordSeek grid placement (no overlap conflicts, in-bounds) and find-matching.
- **Integration:** drive `handleWordGameMessage` with stub message objects per game type and assert consume/state transitions, without a live Discord connection.

## Build order (phased plan, one spec)

0. **Framework:** `word-bank` + committed data files + migration 122 + `messageCreate` hook + `/arcade` group skeleton + rehydration.
1. **Last Letter** — simplest; exercises the whole framework end-to-end.
2. **One Word Story.**
3. **Coordle.**
4. **WordSeek** — most complex; cheap once the framework exists.

Each phase is independently shippable.

## Out of scope (YAGNI)

Cross-guild/global leaderboards; ELO/ranked matchmaking; per-user daily-Wordle streak DMs; multilingual dictionaries (English only for v1); achievements/seasonal events; modal-based guessing (we read messages instead).
