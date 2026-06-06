# Word Games — Phase 0 (Framework) + Phase 1 (Last Letter) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared word-games framework (offline dictionary, per-channel sessions, restart-safe state, stats) and the first game, Last Letter, end-to-end.

**Architecture:** A `word-bank` module loads committed word lists into memory. A `word-game-manager` owns an in-memory channel→session registry backed by MySQL for restart recovery, plus stats. Isolated engine modules (`core/games/*.js`) hold each game's pure rules. A `messageCreate` hook routes channel-typed messages to the bound game; a `/wordgame` slash command manages setup/rounds/stats.

**Tech Stack:** Node 20 ESM, discord.js v14, mysql2 (`utils/db.js` default pool), `node:test`/`node:assert` for tests, `node:crypto.randomUUID`.

**Spec:** `docs/superpowers/specs/2026-06-05-word-games-design.md`

**Deviation from spec (flagged):** the spec said extend `/arcade`. `commands/games/arcade.js` already has 33 subcommand entries; adding ~24 more risks Discord's option/size limits and bloats one file. This plan instead creates a dedicated top-level **`/wordgame`** command. Same UX, isolated and testable. Confirm if you'd rather force it into `/arcade`.

**Conventions to follow:**
- Run all scripts/tests from the repo root `/home/death/CertiFriedUtility`.
- Migrations are applied directly (NOT via the buggy `migrations/run.js`): `node -e "import('./migrations/122_word_games.js').then(m=>import('./utils/db.js').then(d=>m.up(d.default).then(()=>process.exit(0))))"`.
- NEVER run scripts using a custom bot token while PM2 is up (gateway-session rule). DB/test/build scripts are fine. Deploy + restart are the last step.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Stage explicit paths (never `git add -A`).

---

## File Structure

| Path | Responsibility |
|------|----------------|
| `scripts/build-word-data.mjs` | Build-time: generate `data/words/*.txt` from `an-array-of-english-words` + fetch Coordle answers. Run once, output committed. |
| `data/words/english.txt` | ~270k lowercase a–z words (committed). Dictionary + length buckets. |
| `data/words/coordle-answers.txt` | ~2.3k common 5-letter answers (committed). |
| `core/word-bank.js` | Loads the data files into in-memory Sets/maps; `isWord`, `isValidGuess`, `randomAnswer`, `wordsByLength`, `load`, `isLoaded`. |
| `migrations/122_word_games.js` | `word_game_channels`, `word_game_sessions`, `word_game_stats` (idempotent). |
| `core/word-game-manager.js` | In-memory channel→session registry + DB persistence, rehydration, stats, and the `handleWordGameMessage` dispatcher. |
| `core/games/last-letter.js` | Pure Last Letter rules: `initState`, `normalize`, `validateMove`. |
| `commands/games/wordgame.js` | `/wordgame lastletter setup|disable|start|end|stats|leaderboard`. |
| `events/messageCreate.js` | + hook calling `handleWordGameMessage`. |
| `index.js` | + boot: `wordBank.load()` and `rehydrateWordGames()` (default bot only). |
| `tests/word-bank.test.js`, `tests/last-letter.test.js` | Unit tests. |

---

## Phase 0 — Framework

### Task 1: Build and commit the word data files

**Files:**
- Create: `scripts/build-word-data.mjs`
- Create (generated, committed): `data/words/english.txt`, `data/words/coordle-answers.txt`
- Modify: `package.json` (add `an-array-of-english-words` devDependency)

- [ ] **Step 1: Install the word-source dependency**

Run: `npm install --save-dev an-array-of-english-words`
Expected: adds `an-array-of-english-words` (an MIT array of ~275k English words) to devDependencies.

- [ ] **Step 2: Write the build script**

Create `scripts/build-word-data.mjs`:

```js
// Build-time generator for data/words/*.txt. Run once; commit the output.
// english.txt  : all lowercase a-z words from an-array-of-english-words
// coordle-answers.txt : common 5-letter answers (fetched; falls back to 5-letter english subset)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import english from 'an-array-of-english-words';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'words');
fs.mkdirSync(OUT, { recursive: true });

const clean = english
  .map(w => String(w).trim().toLowerCase())
  .filter(w => /^[a-z]+$/.test(w));
const uniq = [...new Set(clean)].sort();
fs.writeFileSync(path.join(OUT, 'english.txt'), uniq.join('\n') + '\n');
console.log(`english.txt: ${uniq.length} words`);

const fiveSet = new Set(uniq.filter(w => w.length === 5));
let answers = [];
try {
  const res = await fetch('https://raw.githubusercontent.com/cfreshman/wordle-answers-alphabetical/main/answers.txt');
  if (res.ok) {
    const list = (await res.text()).split('\n').map(s => s.trim().toLowerCase())
      .filter(w => /^[a-z]{5}$/.test(w) && fiveSet.has(w));
    answers = [...new Set(list)].sort();
  }
} catch (err) {
  console.warn('answer fetch failed, falling back to 5-letter english subset:', err.message);
}
if (answers.length < 500) {
  console.warn('using 5-letter english subset as answers');
  answers = [...fiveSet].sort();
}
fs.writeFileSync(path.join(OUT, 'coordle-answers.txt'), answers.join('\n') + '\n');
console.log(`coordle-answers.txt: ${answers.length} words`);
```

- [ ] **Step 3: Generate the data files**

Run: `node scripts/build-word-data.mjs`
Expected: prints `english.txt: ~270000 words` and `coordle-answers.txt: ~2300 words`. Both files exist under `data/words/`.

- [ ] **Step 4: Sanity-check the output**

Run: `wc -l data/words/english.txt data/words/coordle-answers.txt; grep -cx bear data/words/english.txt; grep -cx crane data/words/coordle-answers.txt`
Expected: english line count ≥ 200000; `bear` present (`1`); `crane` present in answers (`1`).

- [ ] **Step 5: Commit**

```bash
git add scripts/build-word-data.mjs data/words/english.txt data/words/coordle-answers.txt package.json package-lock.json
git commit -m "feat(word-games): bundled offline word data + build script

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: word-bank module

**Files:**
- Create: `core/word-bank.js`
- Test: `tests/word-bank.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/word-bank.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as wordBank from '../core/word-bank.js';

test('load: succeeds and reports loaded', () => {
  assert.equal(wordBank.load(), true);
  assert.equal(wordBank.isLoaded(), true);
});

test('isWord: real words true, junk false', () => {
  assert.equal(wordBank.isWord('bear'), true);
  assert.equal(wordBank.isWord('BEAR'), true);
  assert.equal(wordBank.isWord('  rope '), true);
  assert.equal(wordBank.isWord('zzzqqwx'), false);
  assert.equal(wordBank.isWord(''), false);
  assert.equal(wordBank.isWord(null), false);
});

test('isValidGuess: 5-letter dictionary words only', () => {
  assert.equal(wordBank.isValidGuess('crane'), true);
  assert.equal(wordBank.isValidGuess('cran'), false);   // wrong length
  assert.equal(wordBank.isValidGuess('xxxxx'), false);  // not a word
});

test('randomAnswer: returns a 5-letter dictionary word, deterministic via rng', () => {
  const a = wordBank.randomAnswer(5, () => 0);  // first answer
  assert.equal(typeof a, 'string');
  assert.equal(a.length, 5);
  assert.equal(wordBank.isWord(a), true);
});

test('wordsByLength: returns words within the range', () => {
  const ws = wordBank.wordsByLength(4, 4);
  assert.ok(ws.length > 100);
  assert.ok(ws.every(w => w.length === 4));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/word-bank.test.js`
Expected: FAIL — `Cannot find module '../core/word-bank.js'`.

- [ ] **Step 3: Write the module**

Create `core/word-bank.js`:

```js
/**
 * Word bank: loads committed dictionaries (data/words/*.txt) into memory once.
 * Offline + deterministic. Fails soft: on load error, lookups return false and
 * isLoaded() stays false so callers can degrade.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'words');

let english = null;       // Set<string>
let answers = null;       // string[]  (5-letter)
let byLength = null;      // Map<number, string[]>
let loadError = null;

function readLines(file) {
  return fs.readFileSync(path.join(DATA_DIR, file), 'utf8')
    .split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);
}

export function load() {
  if (english) return true;
  if (loadError) return false;
  try {
    const words = readLines('english.txt').filter(w => /^[a-z]+$/.test(w));
    english = new Set(words);
    byLength = new Map();
    for (const w of words) {
      const L = w.length;
      if (!byLength.has(L)) byLength.set(L, []);
      byLength.get(L).push(w);
    }
    answers = readLines('coordle-answers.txt').filter(w => /^[a-z]{5}$/.test(w));
    logger.info('[WordBank] loaded', { english: english.size, answers: answers.length });
    return true;
  } catch (err) {
    loadError = err;
    logger.error('[WordBank] failed to load word data', { error: err.message });
    return false;
  }
}

export function isLoaded() { return Boolean(english) && !loadError; }

export function isWord(word) {
  if (!english && !load()) return false;
  const w = String(word ?? '').trim().toLowerCase();
  return w.length > 0 && english.has(w);
}

export function isValidGuess(word, length = 5) {
  const w = String(word ?? '').trim().toLowerCase();
  if (w.length !== length || !/^[a-z]+$/.test(w)) return false;
  return isWord(w);
}

export function randomAnswer(length = 5, rng = Math.random) {
  if (!english && !load()) return null;
  const pool = (length === 5 && answers && answers.length) ? answers : (byLength.get(length) || []);
  if (!pool.length) return null;
  return pool[Math.floor(rng() * pool.length)];
}

export function wordsByLength(min, max) {
  if (!english && !load()) return [];
  const out = [];
  for (let L = min; L <= max; L++) if (byLength.has(L)) out.push(...byLength.get(L));
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/word-bank.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add core/word-bank.js tests/word-bank.test.js
git commit -m "feat(word-games): word-bank loader with dictionary/answer lookups

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Schema migration 122

**Files:**
- Create: `migrations/122_word_games.js`

- [ ] **Step 1: Write the migration**

Create `migrations/122_word_games.js`:

```js
/**
 * Migration 122: Word games framework.
 *   word_game_channels  — persistent per-channel bindings (one game per channel)
 *   word_game_sessions  — live/in-progress state for rehydration (chain/story/board/grid)
 *   word_game_stats     — per-player/per-guild/per-game counters for leaderboards
 * Idempotent (whitelist table-existence checks).
 */
async function tableExists(db, table) {
  const allowed = new Set(['word_game_channels', 'word_game_sessions', 'word_game_stats']);
  if (!allowed.has(table)) throw new Error(`Refusing to inspect unknown table: ${table}`);
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${table}'`
  );
  return rows[0].n > 0;
}

export async function up(db) {
  if (!(await tableExists(db, 'word_game_channels'))) {
    await db.execute(`
      CREATE TABLE word_game_channels (
        guild_id    VARCHAR(20) NOT NULL,
        channel_id  VARCHAR(20) NOT NULL,
        game_type   VARCHAR(32) NOT NULL,
        enabled     TINYINT(1) NOT NULL DEFAULT 1,
        config_json JSON NULL,
        created_by  VARCHAR(20) NULL,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, channel_id),
        INDEX idx_guild (guild_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }
  if (!(await tableExists(db, 'word_game_sessions'))) {
    await db.execute(`
      CREATE TABLE word_game_sessions (
        id           VARCHAR(36) NOT NULL,
        guild_id     VARCHAR(20) NOT NULL,
        channel_id   VARCHAR(20) NOT NULL,
        game_type    VARCHAR(32) NOT NULL,
        mode         ENUM('persistent','round') NOT NULL,
        status       ENUM('active','ended','abandoned') NOT NULL DEFAULT 'active',
        host_user_id VARCHAR(20) NULL,
        state_json   JSON NOT NULL,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        ended_at     TIMESTAMP NULL,
        PRIMARY KEY (id),
        INDEX idx_channel (channel_id),
        INDEX idx_active (guild_id, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }
  if (!(await tableExists(db, 'word_game_stats'))) {
    await db.execute(`
      CREATE TABLE word_game_stats (
        guild_id          VARCHAR(20) NOT NULL,
        user_id           VARCHAR(20) NOT NULL,
        game_type         VARCHAR(32) NOT NULL,
        games_played      INT NOT NULL DEFAULT 0,
        wins              INT NOT NULL DEFAULT 0,
        words_contributed INT NOT NULL DEFAULT 0,
        best_score        INT NOT NULL DEFAULT 0,
        current_streak    INT NOT NULL DEFAULT 0,
        best_streak       INT NOT NULL DEFAULT 0,
        updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, user_id, game_type),
        INDEX idx_leaderboard (guild_id, game_type, best_score)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS word_game_stats');
  await db.execute('DROP TABLE IF EXISTS word_game_sessions');
  await db.execute('DROP TABLE IF EXISTS word_game_channels');
}
```

- [ ] **Step 2: Apply the migration**

Run: `node -e "import('./migrations/122_word_games.js').then(m=>import('./utils/db.js').then(d=>m.up(d.default).then(()=>{console.log('122 applied');process.exit(0)})))"`
Expected: prints `122 applied`, no error.

- [ ] **Step 3: Verify the tables**

Run: `node -e "import('./utils/db.js').then(async d=>{for(const t of ['word_game_channels','word_game_sessions','word_game_stats']){const [r]=await d.default.execute('SHOW COLUMNS FROM '+t);console.log(t, r.length+' cols')};process.exit(0)})"`
Expected: `word_game_channels 7 cols`, `word_game_sessions 11 cols`, `word_game_stats 10 cols`.

- [ ] **Step 4: Commit**

```bash
git add migrations/122_word_games.js
git commit -m "feat(word-games): migration 122 — channels/sessions/stats tables

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: word-game-manager (registry, persistence, stats, dispatcher skeleton)

**Files:**
- Create: `core/word-game-manager.js`

This task creates the manager with the channel→session registry, DB persistence, rehydration, a stats upsert, and a `handleWordGameMessage` dispatcher that returns `false` until a game is registered (Task 6 plugs Last Letter in). Its DB-touching functions are exercised by the integration check in Step 3 rather than unit tests (they require the live pool).

- [ ] **Step 1: Write the module**

Create `core/word-game-manager.js`:

```js
/**
 * Word-game session manager: in-memory channel->session registry backed by
 * word_game_sessions for restart recovery, plus per-channel bindings
 * (word_game_channels) and stats (word_game_stats). The messageCreate hook
 * calls handleWordGameMessage(); engine routing is registered per game type.
 */
import { randomUUID } from 'node:crypto';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const sessionsByChannel = new Map(); // channelId -> { id, guildId, channelId, gameType, mode, status, hostUserId, state }
const engines = new Map();           // gameType -> async (message, session) => boolean (consumed)

export function registerEngine(gameType, handler) { engines.set(gameType, handler); }
export function getSessionByChannel(channelId) { return sessionsByChannel.get(channelId) || null; }

export async function createSession({ guildId, channelId, gameType, mode, hostUserId, state }) {
  const id = randomUUID();
  const session = { id, guildId, channelId, gameType, mode, status: 'active', hostUserId: hostUserId || null, state };
  sessionsByChannel.set(channelId, session);
  await pool.execute(
    `INSERT INTO word_game_sessions (id, guild_id, channel_id, game_type, mode, status, host_user_id, state_json)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    [id, guildId, channelId, gameType, mode, session.hostUserId, JSON.stringify(state)]
  );
  return session;
}

export async function saveState(session) {
  await pool.execute('UPDATE word_game_sessions SET state_json = ? WHERE id = ?',
    [JSON.stringify(session.state), session.id]);
}

export async function endSession(session, status = 'ended') {
  session.status = status;
  if (sessionsByChannel.get(session.channelId)?.id === session.id) sessionsByChannel.delete(session.channelId);
  await pool.execute('UPDATE word_game_sessions SET status = ?, ended_at = NOW() WHERE id = ?', [status, session.id]);
}

export async function bindChannel({ guildId, channelId, gameType, createdBy, config }) {
  await pool.execute(
    `INSERT INTO word_game_channels (guild_id, channel_id, game_type, enabled, config_json, created_by)
     VALUES (?, ?, ?, 1, ?, ?)
     ON DUPLICATE KEY UPDATE game_type = VALUES(game_type), enabled = 1, config_json = VALUES(config_json)`,
    [guildId, channelId, gameType, config ? JSON.stringify(config) : null, createdBy || null]
  );
}

export async function unbindChannel(guildId, channelId) {
  await pool.execute('DELETE FROM word_game_channels WHERE guild_id = ? AND channel_id = ?', [guildId, channelId]);
  const s = sessionsByChannel.get(channelId);
  if (s) await endSession(s, 'ended');
}

export async function bumpStats(guildId, userId, gameType, { words = 0, played = 0, wins = 0, bestScore = null, streak = null } = {}) {
  await pool.execute(
    `INSERT INTO word_game_stats (guild_id, user_id, game_type, words_contributed, games_played, wins, best_score, current_streak, best_streak)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       words_contributed = words_contributed + VALUES(words_contributed),
       games_played      = games_played + VALUES(games_played),
       wins              = wins + VALUES(wins),
       best_score        = GREATEST(best_score, VALUES(best_score)),
       current_streak    = VALUES(current_streak),
       best_streak       = GREATEST(best_streak, VALUES(current_streak))`,
    [guildId, userId, gameType, words, played, wins, bestScore ?? 0, streak ?? 0]
  );
}

export async function getStats(guildId, userId, gameType) {
  const [rows] = await pool.execute(
    'SELECT * FROM word_game_stats WHERE guild_id = ? AND user_id = ? AND game_type = ?',
    [guildId, userId, gameType]);
  return rows[0] || null;
}

export async function getLeaderboard(guildId, gameType, limit = 10) {
  const [rows] = await pool.execute(
    'SELECT user_id, best_score, words_contributed, wins FROM word_game_stats WHERE guild_id = ? AND game_type = ? ORDER BY best_score DESC, words_contributed DESC LIMIT ?',
    [guildId, gameType, limit]);
  return rows;
}

export async function rehydrateWordGames() {
  const [rows] = await pool.execute("SELECT * FROM word_game_sessions WHERE status = 'active'");
  let n = 0;
  for (const r of rows) {
    let state; try { state = JSON.parse(r.state_json); } catch { state = {}; }
    sessionsByChannel.set(r.channel_id, {
      id: r.id, guildId: r.guild_id, channelId: r.channel_id, gameType: r.game_type,
      mode: r.mode, status: r.status, hostUserId: r.host_user_id, state,
    });
    n++;
  }
  logger.info('[WordGames] rehydrated active sessions', { count: n });
  return n;
}

/** messageCreate hook. Returns true if the message was consumed by a word game. */
export async function handleWordGameMessage(message) {
  try {
    if (message.author?.bot || !message.guild) return false;
    const session = sessionsByChannel.get(message.channel.id);
    if (!session || session.status !== 'active') return false;
    const engine = engines.get(session.gameType);
    if (!engine) return false;
    return await engine(message, session);
  } catch (err) {
    logger.error('[WordGames] message handler error', { error: err.message });
    return false;
  }
}
```

- [ ] **Step 2: Quick integration smoke (DB round-trip)**

Run:
```bash
node -e "
import('./core/word-game-manager.js').then(async m=>{
  const s = await m.createSession({guildId:'1',channelId:'t-chan',gameType:'last_letter',mode:'round',hostUserId:'u1',state:{lastLetter:null,count:0,used:[]}});
  s.state.count=3; await m.saveState(s);
  await m.bumpStats('1','u1','last_letter',{words:3,bestScore:3,streak:3});
  const n = await m.rehydrateWordGames();
  console.log('rehydrated', n, 'session in map:', !!m.getSessionByChannel('t-chan'));
  await m.endSession(s,'ended');
  await import('./utils/db.js').then(d=>d.default.execute(\"DELETE FROM word_game_stats WHERE guild_id='1'\"));
  console.log('ok'); process.exit(0);
});"
```
Expected: prints `rehydrated <N> session in map: true` then `ok`. (Cleans up its own stats row; the ended session row is harmless test data.)

- [ ] **Step 3: Commit**

```bash
git add core/word-game-manager.js
git commit -m "feat(word-games): session manager — registry, persistence, stats, dispatcher

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 1 — Last Letter

### Task 5: Last Letter engine (pure rules)

**Files:**
- Create: `core/games/last-letter.js`
- Test: `tests/last-letter.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/last-letter.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { initState, normalize, validateMove } from '../core/games/last-letter.js';

test('normalize: first token, letters only, lowercased', () => {
  assert.equal(normalize('Bear'), 'bear');
  assert.equal(normalize('  rope! please'), 'rope');
  assert.equal(normalize('123'), '');
});

test('seed: any real word starts the chain', () => {
  const r = validateMove('bear', initState());
  assert.equal(r.ok, true);
  assert.equal(r.nextState.lastLetter, 'r');
  assert.equal(r.nextState.count, 1);
});

test('valid chain: first letter must match previous last letter', () => {
  let s = validateMove('bear', initState()).nextState;     // ends 'r'
  const good = validateMove('rope', s);                    // starts 'r'
  assert.equal(good.ok, true);
  assert.equal(good.nextState.lastLetter, 'e');
});

test('wrong letter is rejected with expected letter', () => {
  const s = validateMove('bear', initState()).nextState;   // ends 'r'
  const bad = validateMove('apple', s);                    // starts 'a'
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'wrong_letter');
  assert.equal(bad.expected, 'r');
});

test('non-word is rejected when dictionary required', () => {
  const bad = validateMove('zzzqq', initState());
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'not_a_word');
});

test('repeat word is rejected', () => {
  let s = validateMove('bear', initState()).nextState;     // ends 'r'
  s = validateMove('rope', s).nextState;                   // ends 'e'
  s = validateMove('echo', s).nextState;                   // ends 'o'
  s = validateMove('open', s).nextState;                   // ends 'n'
  // try to reuse 'rope' later when a word ends in 'r' again... craft: 'nadir' ends 'r'
  s = validateMove('nadir', s).nextState;                  // ends 'r'
  const dup = validateMove('rope', s);                     // already used
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'repeat');
});

test('degraded mode accepts non-words if the letter rule holds', () => {
  const s = validateMove('bear', initState()).nextState;   // ends 'r'
  const r = validateMove('rxqz', s, { requireDictionary: false });
  assert.equal(r.ok, true);
  assert.equal(r.nextState.lastLetter, 'z');
});

test('used-set is capped at 500', () => {
  let s = initState();
  s.used = Array.from({ length: 500 }, (_, i) => 'w' + i);
  s.lastLetter = 'r';
  const r = validateMove('rope', s);
  assert.equal(r.ok, true);
  assert.equal(r.nextState.used.length, 500);
  assert.equal(r.nextState.used.includes('rope'), true);
  assert.equal(r.nextState.used.includes('w0'), false); // oldest dropped
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/last-letter.test.js`
Expected: FAIL — `Cannot find module '../core/games/last-letter.js'`.

- [ ] **Step 3: Write the engine**

Create `core/games/last-letter.js`:

```js
/**
 * Last Letter rules (pure). state = { lastLetter: string|null, count: number, used: string[] }.
 * Each new word must be a real word, start with the previous word's last letter,
 * and not repeat a recently-used word. Dictionary check can be disabled (degraded mode).
 */
import * as wordBank from '../word-bank.js';

const USED_CAP = 500;

export function initState() { return { lastLetter: null, count: 0, used: [] }; }

export function normalize(content) {
  const tok = String(content ?? '').trim().split(/\s+/)[0] || '';
  return tok.toLowerCase().replace(/[^a-z]/g, '');
}

export function validateMove(content, state, opts = {}) {
  const requireDictionary = opts.requireDictionary !== false;
  const word = normalize(content);
  if (!word) return { ok: false, reason: 'empty' };
  if (requireDictionary && !wordBank.isWord(word)) return { ok: false, reason: 'not_a_word' };
  if (state.lastLetter && word[0] !== state.lastLetter) {
    return { ok: false, reason: 'wrong_letter', expected: state.lastLetter };
  }
  if (state.used.includes(word)) return { ok: false, reason: 'repeat' };
  const used = [...state.used, word].slice(-USED_CAP);
  const nextState = { lastLetter: word[word.length - 1], count: state.count + 1, used };
  return { ok: true, word, nextState };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/last-letter.test.js`
Expected: PASS (8 tests). (Uses the real dictionary; the words chosen — bear/rope/echo/open/nadir — are all in `english.txt`.)

- [ ] **Step 5: Commit**

```bash
git add core/games/last-letter.js tests/last-letter.test.js
git commit -m "feat(word-games): Last Letter engine + tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Register Last Letter engine in the manager + Discord I/O

**Files:**
- Create: `core/games/last-letter-runtime.js` (Discord-aware adapter: reactions, stats, state save)
- Modify: `core/word-game-manager.js` (import the runtime so it self-registers — see Step 2)

- [ ] **Step 1: Write the runtime adapter**

Create `core/games/last-letter-runtime.js`:

```js
/**
 * Discord adapter for Last Letter: consumes a channel message, runs the pure
 * engine, reacts ✅/❌, persists state, and credits stats. Registered with the
 * word-game manager under game type 'last_letter'.
 */
import { validateMove } from './last-letter.js';
import * as wordBank from '../word-bank.js';
import { registerEngine, saveState, bumpStats } from '../word-game-manager.js';
import logger from '../../utils/logger.js';

const HINTS = {
  not_a_word: (w) => `❌ \`${w}\` isn't a word I know.`,
  wrong_letter: (w, exp) => `❌ \`${w}\` must start with **${exp.toUpperCase()}**.`,
  repeat: (w) => `❌ \`${w}\` was already used.`,
  empty: () => null,
};

async function react(message, emoji) {
  try { await message.react(emoji); } catch (err) { logger.warn('[LastLetter] react failed', { error: err.message }); }
}

async function handle(message, session) {
  const content = message.content || '';
  // ignore empty/attachment-only messages so they don't break the chain
  if (!content.trim()) return false;
  const res = validateMove(content, session.state, { requireDictionary: wordBank.isLoaded() });
  if (!res.ok) {
    if (res.reason === 'empty') return false; // not a move attempt
    await react(message, '❌');
    const hintFn = HINTS[res.reason];
    const word = (content.trim().split(/\s+/)[0] || '').toLowerCase().replace(/[^a-z]/g, '');
    const hint = hintFn ? hintFn(word, res.expected) : null;
    if (hint) {
      message.channel.send(hint).then(m => setTimeout(() => m.delete().catch(() => {}), 6000)).catch(() => {});
    }
    return true; // consumed (it was a game move, just invalid)
  }
  session.state = res.nextState;
  await saveState(session);
  await react(message, '✅');
  await bumpStats(session.guildId, message.author.id, 'last_letter',
    { words: 1, bestScore: res.nextState.count, streak: res.nextState.count });
  return true;
}

registerEngine('last_letter', handle);
export default handle;
```

- [ ] **Step 2: Ensure the runtime is loaded so it self-registers**

Modify `core/word-game-manager.js` — add this line at the very bottom of the file (after all exports) so importing the manager also wires the Last Letter engine:

```js
// Register built-in game engines (self-register on import).
import './games/last-letter-runtime.js';
```

Note: this is a static import at module end; it executes once when the manager is first imported. (When Coordle/WordSeek land, add their runtime imports here too.)

- [ ] **Step 3: Verify no circular-import breakage**

Run: `node -e "import('./core/word-game-manager.js').then(m=>{console.log('engines ok:', typeof m.handleWordGameMessage==='function'); process.exit(0)})"`
Expected: prints `engines ok: true` with no `ReferenceError`/circular-import crash. (The runtime imports named exports from the manager; Node ESM resolves the live bindings, so the bottom-of-file import is safe.)

- [ ] **Step 4: Commit**

```bash
git add core/games/last-letter-runtime.js core/word-game-manager.js
git commit -m "feat(word-games): wire Last Letter runtime (reactions, stats, persistence)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: messageCreate hook

**Files:**
- Modify: `events/messageCreate.js` (import + call after the counting block at lines ~345-350)

- [ ] **Step 1: Add the import**

In `events/messageCreate.js`, near the other core imports at the top (next to the counting import on line 9), add:

```js
import { handleWordGameMessage } from '../core/word-game-manager.js';
```

- [ ] **Step 2: Add the hook after the counting game block**

In `events/messageCreate.js`, immediately AFTER the counting block (the `if (wasCountingMessage) { ... return; }` around lines 346-350), insert:

```js
      // Word games (Last Letter, etc.) — typed-in-channel games
      const wasWordGame = await handleWordGameMessage(message);
      if (wasWordGame) {
        return; // consumed by an active word game in this channel
      }
```

- [ ] **Step 3: Syntax check**

Run: `node --check events/messageCreate.js && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add events/messageCreate.js
git commit -m "feat(word-games): route channel messages to active word games

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: `/wordgame` command (Last Letter subcommands)

**Files:**
- Create: `commands/games/wordgame.js`

- [ ] **Step 1: Write the command**

Create `commands/games/wordgame.js`:

```js
import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } from 'discord.js';
import { initState } from '../../core/games/last-letter.js';
import {
  createSession, endSession, getSessionByChannel, bindChannel, unbindChannel,
  getStats, getLeaderboard,
} from '../../core/word-game-manager.js';

export default {
  category: 'games',
  data: new SlashCommandBuilder()
    .setName('wordgame')
    .setDescription('Community word games')
    .addSubcommandGroup(g => g
      .setName('lastletter')
      .setDescription('Word-chain: each word starts with the previous word’s last letter')
      .addSubcommand(s => s.setName('setup').setDescription('Bind a persistent Last Letter channel (admin)')
        .addChannelOption(o => o.setName('channel').setDescription('Channel to host the game').addChannelTypes(ChannelType.GuildText).setRequired(true)))
      .addSubcommand(s => s.setName('disable').setDescription('Unbind the Last Letter game from a channel (admin)')
        .addChannelOption(o => o.setName('channel').setDescription('Bound channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
      .addSubcommand(s => s.setName('start').setDescription('Start a Last Letter round in this channel'))
      .addSubcommand(s => s.setName('end').setDescription('End the Last Letter round in this channel'))
      .addSubcommand(s => s.setName('stats').setDescription('Your Last Letter stats')
        .addUserOption(o => o.setName('user').setDescription('Whose stats').setRequired(false)))
      .addSubcommand(s => s.setName('leaderboard').setDescription('Top Last Letter players'))),

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup();
    const sub = interaction.options.getSubcommand();
    if (group !== 'lastletter') return interaction.reply({ content: 'Unknown game.', ephemeral: true });
    const gameType = 'last_letter';
    const guildId = interaction.guildId;

    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

    if (sub === 'setup' || sub === 'disable') {
      if (!isAdmin) return interaction.reply({ content: 'You need **Manage Server** to do that.', ephemeral: true });
      const channel = interaction.options.getChannel('channel');
      if (sub === 'setup') {
        if (getSessionByChannel(channel.id)) return interaction.reply({ content: `A word game is already active in ${channel}.`, ephemeral: true });
        await bindChannel({ guildId, channelId: channel.id, gameType, createdBy: interaction.user.id });
        await createSession({ guildId, channelId: channel.id, gameType, mode: 'persistent', hostUserId: interaction.user.id, state: initState() });
        return interaction.reply(`✅ Last Letter is now live in ${channel}. Post a word to start the chain — each next word must begin with the previous word’s last letter.`);
      }
      await unbindChannel(guildId, channel.id);
      return interaction.reply(`🛑 Last Letter unbound from ${channel}.`);
    }

    if (sub === 'start') {
      if (getSessionByChannel(interaction.channelId)) return interaction.reply({ content: 'A word game is already active in this channel.', ephemeral: true });
      await createSession({ guildId, channelId: interaction.channelId, gameType, mode: 'round', hostUserId: interaction.user.id, state: initState() });
      return interaction.reply('🔤 **Last Letter** round started! Post a word — each next word must begin with the previous word’s last letter. No repeats, real words only.');
    }

    if (sub === 'end') {
      const session = getSessionByChannel(interaction.channelId);
      if (!session || session.gameType !== gameType) return interaction.reply({ content: 'No Last Letter game is active here.', ephemeral: true });
      if (session.mode === 'persistent' && !isAdmin) return interaction.reply({ content: 'This is a persistent game — an admin must `disable` it.', ephemeral: true });
      await endSession(session, 'ended');
      return interaction.reply(`🏁 Last Letter ended after **${session.state.count}** words.`);
    }

    if (sub === 'stats') {
      const user = interaction.options.getUser('user') || interaction.user;
      const st = await getStats(guildId, user.id, gameType);
      const embed = new EmbedBuilder().setTitle(`🔤 Last Letter — ${user.username}`).setColor(0x5865F2)
        .setDescription(st
          ? `Words contributed: **${st.words_contributed}**\nLongest chain: **${st.best_score}**`
          : 'No stats yet — play a round!');
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'leaderboard') {
      const rows = await getLeaderboard(guildId, gameType, 10);
      const lines = rows.length
        ? rows.map((r, i) => `**${i + 1}.** <@${r.user_id}> — ${r.words_contributed} words (best chain ${r.best_score})`).join('\n')
        : 'No one has played yet.';
      const embed = new EmbedBuilder().setTitle('🔤 Last Letter — Leaderboard').setColor(0x5865F2).setDescription(lines);
      return interaction.reply({ embeds: [embed] });
    }
  },
};
```

- [ ] **Step 2: Syntax check + command loads**

Run: `node -e "import('./commands/games/wordgame.js').then(c=>{console.log('cmd:', c.default.data.name, '| group:', c.default.data.toJSON().options[0].name); process.exit(0)})"`
Expected: `cmd: wordgame | group: lastletter`.

- [ ] **Step 3: Commit**

```bash
git add commands/games/wordgame.js
git commit -m "feat(word-games): /wordgame command with Last Letter subcommands

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Boot wiring (word-bank load + rehydration)

**Files:**
- Modify: `index.js` (inside `initializeManagers(client)`, near the CAH block at lines ~317-327)

- [ ] **Step 1: Add word-games boot block**

In `index.js`, inside `initializeManagers(client)`, immediately after the CAH init block (around line 327), add:

```js
  // Word games — load dictionary once; rehydrate active sessions on the default bot only
  try {
    const wordBank = await import('./core/word-bank.js');
    wordBank.load();
    if (client.isDefaultBot) {
      const { rehydrateWordGames } = await import('./core/word-game-manager.js');
      await rehydrateWordGames();
    }
    logger.info('[Core] Word games ready');
  } catch (err) {
    logger.error(`[Core] Word games init failed: ${err.message}`);
  }
```

(Rehydration runs only on the default bot because `sessionsByChannel` is a shared module-global map; custom bots reuse it. `client.isDefaultBot` is the same flag used by `shouldIgnoreGuild` in `events/voiceStateUpdate.js`.)

- [ ] **Step 2: Syntax check**

Run: `node --check index.js && echo OK`
Expected: `OK`.

- [ ] **Step 3: Full test suite still green**

Run: `node --test tests/`
Expected: all tests pass (existing + `word-bank`, `last-letter`).

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat(word-games): load dictionary + rehydrate sessions at boot

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Deploy + live smoke test

**Files:** none (deploy + runtime verification)

- [ ] **Step 1: Deploy commands (main bot global)**

Run: `npm run deploy`
Expected: deploy script lists `wordgame` among registered commands, no errors. (Custom bots redeploy guild-specific on PM2 restart via `bot-manager.js`.)

- [ ] **Step 2: Restart the bot**

Run: `pm2 restart CertiFriedUtility --update-env`
Then: `pm2 logs CertiFriedUtility --lines 60 --nostream | grep -iE "Word games ready|WordBank loaded|error" | tail`
Expected: `[WordBank] loaded ...` and `[Core] Word games ready`; no related errors.

- [ ] **Step 2.5: Confirm boot health**

Run: `pm2 jlist | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const p=JSON.parse(d).find(x=>x.name==='CertiFriedUtility');console.log('status',p.pm2_env.status)})"`
Expected: `status online`.

- [ ] **Step 3: Manual smoke (in a test guild — performed by the user or via a test channel)**

  1. `/wordgame lastletter start` in a channel → bot posts the round-start message.
  2. Type `bear` → bot reacts ✅.
  3. Type `apple` → bot reacts ❌ and posts an auto-deleting hint "must start with **R**".
  4. Type `rope` → ✅. Type `rope` again → ❌ (repeat).
  5. `/wordgame lastletter stats` → shows words contributed ≥ 2.
  6. `/wordgame lastletter end` → "ended after N words".
  7. `/wordgame lastletter setup #some-channel` (as admin) → persistent bind; restart PM2; confirm the chain still validates after restart (rehydration).

- [ ] **Step 4: Record completion**

No commit (verification only). Note any issues for follow-up.

---

## Self-Review

**Spec coverage (Phase 0 + 1 portion):**
- Offline word source → Tasks 1–2 ✓
- Per-guild opt-in / persistent bind + ad-hoc round → Task 8 (`setup`/`start`) ✓
- Restart-safe sessions → Tasks 3, 4, 9 (rehydrate) ✓
- Last Letter rules (dictionary + letter + no-repeat, degraded fallback) → Tasks 5, 6 ✓
- Stats + leaderboard → Tasks 4, 8 ✓
- messageCreate hook, fully guarded → Tasks 4, 7 ✓
- Coordle / One Word Story / WordSeek → **out of this plan**, covered by subsequent plans (each reuses this framework). The spec's remaining games are deferred, not dropped.

**Placeholder scan:** none — every step has runnable code/commands.

**Type/name consistency:** `game_type` string `'last_letter'` is used consistently in the engine registration (Task 6), command (Task 8), manager, and migration. Manager exports referenced by later tasks (`createSession`, `endSession`, `getSessionByChannel`, `bindChannel`, `unbindChannel`, `getStats`, `getLeaderboard`, `bumpStats`, `saveState`, `registerEngine`, `handleWordGameMessage`, `rehydrateWordGames`) all exist in Task 4. Engine exports (`initState`, `normalize`, `validateMove`) used by Tasks 6 and 8 are defined in Task 5.

---

## Subsequent plans (after this lands)

- `2026-06-…-word-games-one-word-story.md` — second persistent/round typed game; reuses manager + hook; adds `story` group + `show`.
- `2026-06-…-word-games-coordle.md` — shared-board Wordle; answer/guess via word-bank; board renderer with duplicate-letter coloring (heavily unit-tested); `coordle` group.
- `2026-06-…-word-games-wordseek.md` — grid generator + find-matching; `wordseek` group.
