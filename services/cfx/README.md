# Greenhouse Tycoon (cfx v2)

The rewrite of the CertiFried game, as planned in `docs/cfx-overhaul-audit.md` (Part B, owner decisions in
B12). Phase 1 (foundations), phase 2 (the core-loop API), phase 3 (the frontend in `frontend/greenhouse/`,
see "Frontend" below) and phase 4 (quests, achievements, seasons, leaderboards, notifications, Replant,
decorations, the Discord commands, the dashboard pages and the Twitch review save; see "Phase 4") and phase 5
(privacy, retention, the cutover switch `GREENHOUSE_LIVE` and the drop migration; see "Phase 5") are written.
Live since 2026-11-19: the pm2 app `greenhouse-tycoon` runs `server.js` on `127.0.0.1:4021`, migration 437 is
applied, the LiteSpeed blocks below are in place (`/gh-api/api/v2/health` answers) and `GREENHOUSE_LIVE=1` is set.
Migration 438 (dropping the old `cfx_*` tables) waits for the 90 days the privacy policy promises. The cutover
runbook is `docs/greenhouse-cutover.md`.

"Greenhouse Tycoon" is a working title and "CertiFried" the brand. Every display name and player-facing
sentence lives in `config/copy.js`, so names can change in one file.

The old game in `services/certifried-extension/` (tables `cfx_*`) is separate. The game itself never reads or
writes it; only `privacy/legacy.js` does, so /privacy export and delete cover a person's old rows until migration
438 drops those tables (phase 5).

## Layout

```
services/cfx/
  server.js          standalone entry point (own process; see "Running it")
  config/
    env.js           CFX2_* environment variables (sign-in secrets fall back to the bot's names)
    game.js          numbers: 12 h offline cap, 30-day seasons, limits, starter kit, linking, TUNING
    copy.js          every display name and player-facing message
    catalog.js       base varieties (ids 1-12), staff types, boosts, the upgrade tree
    retention.js     phase 5: how long the growing tables are kept (data_retention_policy rows)
  lib/
    errors.js        GameError and the one error shape {error: {code, message, details?}}
    validate.js      the shared validator (no negative, fractional, NaN or string quantity gets through)
  domain/            pure functions, no I/O
    rng.js           seeded random numbers
    growth.js        plant state computed from timestamps (no ticks), yield, quality bands
    economy.js       the one sell formula, XP curve, upgrade costs and effects
    staff.js         closed-form offline earnings, capped at 12 hours
    breeding.js      deterministic hybrids ("Parent A × Parent B")
    season-score.js  daily-capped season score, ranking, weekly-challenge minimum-players rule
    market.js        NPC demand per variety per day (phase 2)
    rules.js         game rules on top of the above: watering, orders, daily reward, hire costs (phase 2)
    meta.js          quests, achievements, season windows and rewards, challenges, Replant (phase 4)
  store/             database access only
    schema.js        the 27 tables (prefix gh_); used by the migration and by the tests
    tx.js            one transaction on one connection, deadlock retry
    ledger.js        EVERY cash and item change
    accounts.js      sign-in, identities, link codes, link and unlink rules, Twitch panel sign-in
    sessions.js      refresh tokens (phase 2)
    game.js          every gameplay action and the state reads (phase 2)
    flags.js         runtime switches in gh_config (job kill switch, review save switch, meta version)
    job-runs.js      job run records and the cross-process job lock (GET_LOCK)
    meta.js          quests, challenges, achievements, season score and rollover, notifications, leaderboards,
                     cosmetics (phase 4)
    review.js        the shared Twitch review save (phase 4)
    index.js         createStore({ db, prefix })
  http/
    app.js           Express app: prefix, helmet, CORS, rate limits, routes under /api/v2
    auth.js          game session tokens (HS256, re-checked against the identity on every request)
    security.js      CORS origins, helmet, rate limiter, client address, public prefix
    middleware.js    body schemas, Idempotency-Key, error handler
    routes/          auth.js (sign-in), account.js (linking), game.js (gameplay), meta.js (phase 4)
  integrations/      twitch-ext.js (panel JWT), oauth.js (website Twitch/Kick), discord.js (dashboard hand-off),
                     bot.js (phase 4: the bridge the Discord bot and the dashboard use),
                     cutover.js (phase 5: GREENHOUSE_LIVE and what the old game's addresses answer)
  realtime/          hints.js (version hints), ws.js (WebSocket hub)
  jobs/              scheduler.js, index.js (link codes, refresh tokens, market day, old orders; phase 4: season
                     rollover, notification sweep, review reset)
  privacy/           index.js: export and delete one save, or one person by a sign-in (wired into /privacy in
                     phase 5); legacy.js: the same for the old game's cfx_ tables while they exist
  sim/               economy.js (the simulator), report.js (prints the curves)
```

## Public paths (live)

The service listens on `127.0.0.1:4021` (the old game is 4020). The front server should send one new prefix
to it, unchanged:

| Public URL | Goes to |
|---|---|
| `https://certifriedmultitool.com/gh-api/api/v2/...` | the API (the app strips `/gh-api`; `/api/v2/...` on loopback is the same route) |
| `wss://certifriedmultitool.com/gh-api/ws` | the WebSocket hints (`/ws` on loopback) |

The Twitch extension's URL allowlist (`https://certifriedmultitool.com`, `wss://certifriedmultitool.com`)
already covers these.

### LiteSpeed blocks

In `/usr/local/lsws/conf/vhosts/certifriedmultitool.com/vhost.conf` (root; back the file up first). The
`extprocessor` and `websocket` blocks go at the top level of the vhost file; the `context` block must sit
**before** the final `context /` (contexts are matched in order, and `/` catches everything). OpenLiteSpeed
proxy contexts do not upgrade connections, so the WebSocket path needs its own `websocket` block.

```
extprocessor greenhouse_v2 {
  type                    proxy
  address                 127.0.0.1:4021
  maxConns                100
  pcKeepAliveTimeout      60
  initTimeout             20
  retryTimeout            0
  respBuffer              0
}

context /gh-api/ {
  type                    proxy
  handler                 greenhouse_v2
  addDefaultCharset       off
}

websocket /gh-api/ws {
  address                 127.0.0.1:4021
}
```

Then `sudo /usr/local/lsws/bin/lswsctrl restart`. Check: `curl -s https://certifriedmultitool.com/gh-api/api/v2/health`
answers `{"ok":true,"service":"Greenhouse Tycoon","version":2}` once the pm2 app runs.

## Routes

All under `/api/v2` (publicly `/gh-api/api/v2`). Every error is `{ error: { code, message, details? } }`
with a 4xx (or 503 for an unconfigured sign-in); nothing returns a stack trace. Every gameplay POST needs
an `Idempotency-Key` header (8-64 of `A-Z a-z 0-9 . _ : -`) and answers `{ result, state }`.

### No session

| Route | Body | |
|---|---|---|
| `GET /health` | | `{ ok, service, version }` |
| `GET /catalog` | | varieties, boosts, staff, upgrade tree, quality bands, rules (cacheable 5 min) |
| `POST /auth/twitch-ext` | `{ token }` | Twitch panel: the `Twitch.ext.onAuthorized` JWT |
| `GET /auth/twitch/start` | | website: 302 to Twitch |
| `GET /auth/twitch/callback` | | website: back from Twitch; HTML page that hands over a one-time ticket |
| `GET /auth/kick/start`, `GET /auth/kick/callback` | | the same for Kick (with PKCE) |
| `POST /auth/ticket` | `{ ticket }` | website: the ticket from the callback page, for tokens |
| `POST /auth/discord` | `{ assertion }` | Discord, with the dashboard's signed assertion |
| `POST /auth/refresh` | `{ refreshToken }` | the next session token and refresh token |
| `POST /auth/logout` | `{ refreshToken }` | revoke that refresh family |
| `POST /auth/dev` | `{ userId, name? }` | tests only: `CFX2_ALLOW_DEV_SIGNIN=1` and a direct loopback call |

Every sign-in answers `{ token, expiresAt, refreshToken, refreshExpiresAt, accountId, identityId,
platform, createdAccount, starterGranted, notice }`. Auth routes do not need an Idempotency-Key.

### With a session (`Authorization: Bearer <token>`)

| Route | Body | Pays once by |
|---|---|---|
| `GET /state?v=<etag>` | | 304 when unchanged; also `If-None-Match` |
| `GET /shop`, `GET /varieties`, `GET /stats`, `GET /market?days=1..30` | | |
| `GET /account` | | phase 1 |
| `POST /account/link-code`, `/account/link`, `/account/unlink` | phase 1 | the link answer now also carries new tokens |
| `POST /account/name` | `{ name }` | phase 3: rename, at most once every 7 days (see "Frontend") |
| `GET /account/export` | | H-641: the save's privacy export as a JSON download (3 an hour); see "Privacy" |
| `POST /account/delete` | `{ confirm: 'DELETE' }` | H-641: delete the save and every linked sign-in, ends the sessions (5 attempts an hour); see "Privacy" |
| `POST /plots/plant` | `{ slot, varietyId }` | Idempotency-Key |
| `POST /plots/water` | `{ slot, plantSeq? }` | once per planting |
| `POST /plots/harvest` | `{ slot, plantSeq? }` | `harvest:<slot>:<planting>`; with `plantSeq` a retry replays |
| `POST /plots/harvest-all` | `{}` | the same, per plot |
| `POST /plots/remove` | `{ slot, plantSeq? }` | |
| `POST /plots/boost` | `{ slot, boostId, plantSeq? }` | once per boost type per planting |
| `POST /sell` | `{ lines: [{ varietyId, quality, quantity }] }` (1-20) | Idempotency-Key |
| `POST /shop/buy` | `{ kind: 'seed'\|'boost', itemId, quantity }` (1-1000) | Idempotency-Key |
| `POST /shop/plot` | `{ level? }` | `upgrade:extra_bench:<level>` (plot expansion is the Extra bench node) |
| `POST /upgrades/buy` | `{ code, level? }` | `upgrade:<code>:<level>` |
| `POST /staff/hire` | `{ code, count? }` | Idempotency-Key; never past the limit |
| `POST /staff/fire` | `{ code, count? }` | |
| `POST /staff/claim` | `{}` | the staff clocks (12 h cap) |
| `POST /breeding/start` | `{ parentA, parentB }` (two different base varieties) | Idempotency-Key |
| `POST /breeding/claim` | `{ breedingId }` | `breedclaim:<id>` |
| `POST /orders/fill` | `{ orderId }` | `order-fill:<id>` |
| `POST /orders/decline` | `{ orderId }` | |
| `POST /daily` | `{}` | `daily:<day>` plus UNIQUE (account, day) and (sign-in, day) |

Phase 4 (`http/routes/meta.js`, and two no-session routes):

| Route | Body / query | Pays once by |
|---|---|---|
| `GET /achievements` | | every achievement with progress, badges |
| `GET /season` | | the season, its challenges, reward tiers, last season's result |
| `GET /leaderboard` | `?board=season\|alltime&page=1..25[&season=<n>]` | 20 a page, cached 60 s, plus your own row |
| `GET /notifications` | `?before=<id>` | 20 a page, newest first, with the unread count |
| `POST /quests/claim` | `{ periodKey, code }` | `quest:<period>:<code>` plus `claimed_at IS NULL` |
| `POST /achievements/claim` | `{ code }` | `ach:<code>` plus `claimed_at IS NULL` |
| `POST /notifications/read` | `{ upToId? }` | (idempotent) |
| `POST /replant` | `{ prestige }` (the count you saw) | the count must match; a retry replays |
| `POST /decorations/buy` | `{ code }` | `decoration:<code>` (one of each, ever) |
| `POST /decorations/place` | `{ code, placed }` | (idempotent) at most 6 shown |
| `GET /review` | (no session) | `{ review: { enabled } }` |
| `POST /auth/review` | `{ token }` (Twitch panel JWT) | a session on the review save (see below) |

`level` / `count` / `plantSeq` are optional "what I expect" values: a double click or retry with the same
value pays nothing more.

### Real time

Poll `GET /state?v=<etag>` every 15 s while visible (60 s hidden); the etag is
`<state version>.<day>.<meta version>`, so a new market day, and a season or challenge change by the season
job (gh_config `meta.version`), also refresh. Optionally open `wss://.../gh-api/ws`, send `{"type":"auth","token":"..."}`
as the first message (never in the URL), and refetch on `{"type":"state","v":N}`. Losing the socket changes
nothing but latency. Close codes: 4001 session expired or stale (sign in or refresh, reconnect), 4003 bad
auth or origin, 1013 too many sockets.

## Sign-in

- **Twitch panel** (`integrations/twitch-ext.js`): HS256 with the extension secret (`CFX2_TWITCH_EXT_SECRET`,
  falling back to `TWITCH_EXT_SECRET`; base64 as shown in the console). `U…` viewers play on the opaque id;
  `A…` (logged out) is refused with `TWITCH_SIGNED_OUT` and nothing is stored. When the token carries
  `user_id`, the real Twitch identity is used and joined to the panel save (`store/accounts.js
  signInTwitchPanel`, same rules as a link code: saves never merged, one sign-in per platform, 7-day
  cooldown). The broadcaster on their own channel plays under the channel id without the identity prompt.
  The panel origin `https://7k7fn5nym3jx13sdl4d56yxlu0cytp.ext-twitch.tv` is in the CORS list.
- **Website Twitch and Kick** (`integrations/oauth.js`): authorisation code with `state` (and PKCE for
  Kick). The callback never puts tokens in a URL or page: it hands a one-time ticket (2 min) by
  `postMessage` to the opener, or redirects to `<CFX2_GAME_PATH>#gh_ticket=…`; the game posts it to
  `/auth/ticket`. To link Twitch or Kick to an existing save, the player creates a link code, signs in with
  the other platform, then posts the code to `/account/link`.
- **Discord** (`integrations/discord.js`): through the dashboard (below).
- **Relinking:** a sign-in that was unlinked and comes back gets an empty account with no starter kit (the
  kit is once per sign-in, ever); the daily reward (115+ cash on day one, enough for ten Sunmoss seeds) gets them going.

### OAuth redirect URLs to register (not registered yet)

| App | Add this redirect URL |
|---|---|
| Twitch app `TWITCH_CLIENT_ID` (the game app, `5qh4…b90r`), dev.twitch.tv console | `https://certifriedmultitool.com/gh-api/api/v2/auth/twitch/callback` |
| Kick app `KICK_CLIENT_ID`, Kick developer settings | `https://certifriedmultitool.com/gh-api/api/v2/auth/kick/callback` |

Keep the old `/cfx-api/api/v1/auth/*/callback` URLs until the flag is on (`docs/greenhouse-cutover.md` step 9).

### Discord sign-in: what the dashboard needs

Done in phase 3 as `GET /greenhouse/session/discord` (`dashboard/routes/greenhouse.js`): under the game page
rather than `/game/*`, which stays the old game until phase 5. Its login link returns to
`/greenhouse?signin=discord`. The sketch below is what the route does.

The game has no Discord OAuth: the dashboard already knows the logged-in Discord user. The dashboard needs
one GET route, mounted after passport where `cfxDiscordSession` is today (`/game/session/discord` stays for
the old game until phase 5), and the shared secret `CFX2_DASHBOARD_SECRET` (32+ characters, in `.env`, read
by both processes):

```js
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
// GET /game/session/discord-v2  (GET because the dashboard's CSRF check covers POST; JSON only same-origin
// scripts can read; no side effect)
export function greenhouseDiscordAssertion() {
    return (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (!req.user?.id) {
            return res.status(401).json({ error: { code: 'LOGIN_REQUIRED', message: 'Log in with Discord first' },
                loginUrl: '/auth/discord?returnTo=' + encodeURIComponent('/game?signin=discord') });
        }
        const secret = process.env.CFX2_DASHBOARD_SECRET || '';
        if (secret.length < 32) return res.status(503).json({ error: { code: 'SIGNIN_UNAVAILABLE', message: 'Discord sign-in is not set up yet.' } });
        const now = Math.floor(Date.now() / 1000);
        const assertion = jwt.sign(
            { name: req.user.globalName || req.user.username, iat: now, exp: now + 60, jti: crypto.randomBytes(18).toString('base64url') },
            secret, { algorithm: 'HS256', issuer: 'certifried-dashboard', audience: 'cfx2-discord', subject: String(req.user.id) });
        res.json({ assertion, exchangeUrl: '/gh-api/api/v2/auth/discord' });
    };
}
```

The game page then posts `{ assertion }` to `exchangeUrl`. The game checks the signature, issuer, audience,
a lifetime of at most 120 s, the snowflake, and that the `jti` was not used before.
(`integrations/discord.js signDiscordAssertion` is the same code, used by the tests.)

### Sessions

`auth.sign` session tokens (1 h, `CFX2_SESSION_TTL_SEC`) plus refresh tokens (30 days,
`CFX2_REFRESH_TTL_SEC`; `gh_sessions` stores only a SHA-256). A refresh rotates the token; presenting a
used token again revokes the family, except within 10 s (`REFRESH_RACE`, two tabs: retry with the newer
token). A link or unlink makes older families stale. The panel can simply exchange the newest Twitch JWT
again instead of refreshing.

## Frontend (phase 3)

One app for the website and the Twitch panel, in `frontend/greenhouse/` (vanilla ES modules, no framework, no
new dependency; esbuild from the repo bundles it). The old game's `frontend/certifried-extension/` is untouched.

```
frontend/greenhouse/
  build.mjs          builds both outputs and checks the panel package (see below)
  src/
    main.js          start-up, sign-in flows, rendering, the countdown ticker, whole-screen states
    config.js        API and WebSocket address (website: same origin; panel: https://certifriedmultitool.com)
    copy.js          every interface sentence (game names come from GET /catalog)
    model.js         read helpers over the catalogue and the state (prices, growth, breeding plan)
    slots.js         places in the tabs that phase 4 fills (phase4.js registers the cards)
    phase4.js        registers the phase 4 cards; the review save switch (panel)
    lib/             dom.js (text nodes only), api.js, session.js, sync.js, twitch.js, format.js
    ui/              dialog.js (native <dialog>, focus kept and returned), toast.js, screens.js, widgets.js,
                     notifications.js (phase 4: the bell and its list)
    views/           greenhouse.js (Grow), market.js, breeding.js, upgrades.js, profile.js; phase 4: goals.js
                     (quests, challenge, season, leaderboard, achievements), endgame.js (Replant, decorations)
    art/             plant.js (SVG plants from parameters; hybrids mix their parents), icons.js, decor.js
                     (phase 4: decorations drawn as SVG)
    fonts/           Geist-Variable.woff2, GeistMono-Variable.woff2 (website only), Geist-OFL.txt (the licence)
    styles/app.css   panel first; the --cf-* tokens are copied from dashboard/public/css/cf-ui.css at build time;
                     fonts-web.css (the website's @font-face)
    web.html, panel.html, config.html, config.css
```

Build (from the repo root; `dist/` is git-ignored, so build after every pull and before the dashboard restart):

```
node frontend/greenhouse/build.mjs           # both
node frontend/greenhouse/build.mjs --web     # dist/web/index.html + dist/web/assets/app.<hash>.js|css, icon
node frontend/greenhouse/build.mjs --panel   # dist/panel/ + dist/greenhouse-panel.zip + dist/PANEL-BUILD.txt
node frontend/greenhouse/build.mjs --check   # re-check dist/panel/ only
```

- **Website**: `https://certifriedmultitool.com/greenhouse`, served by the dashboard (`dashboard/routes/greenhouse.js`):
  the page (no-store, its own CSP: `script-src 'self'`, no inline script or style), `/greenhouse/assets/*`
  (content-hashed, cached a year) and `GET /greenhouse/session/discord`. Assets come from the dashboard, not
  from this service, so the page, its files and its CSP share one origin and owner, this service stays a JSON
  API, and LiteSpeed needs nothing beyond the `/gh-api/` block above. The website build is minified.
- **Twitch panel**: upload `dist/greenhouse-panel.zip` (seven files: panel.html, panel.js, panel.css, config.html,
  config.css, Geist-Variable.woff2, Geist-OFL.txt). Panel Viewer Path `panel.html`, Config Path `config.html`
  ("nothing to set up"). The panel build is NOT minified (guideline 2.5). `build.mjs` refuses to package unless:
  the helper is the first script and the only remote one, no inline script, handler, style or absolute path, no
  remote stylesheet or font host, only listed URLs, no dynamic code or HTML sinks, no native alert/confirm,
  readable (not minified), fonts are woff2 inside the package with their licence, JS within 170 KB, CSS within
  32 KB and fonts within 100 KB. Phase 4 raised the budgets from 120 KB and 25 KB (+50 KB and +7 KB; panel.js is
  about 158 KB and panel.css 29 KB with the phase 4 cards).
- **Fonts** (phase 3 follow-up): Geist ships with the game (from the `geist` npm package 1.9.2, SIL Open Font
  License 1.1, licence text in `src/fonts/Geist-OFL.txt`, copied into both outputs). Nothing is requested from
  Google Fonts; the website's CSP is `font-src 'self'`. Geist Mono is on the website only (the link code).
- **Sign-in**: website Discord through the dashboard assertion; Twitch and Kick by redirect to
  `/gh-api/api/v2/auth/<provider>/start`, back to `/greenhouse#gh_ticket=…` (the default `CFX2_GAME_PATH` is now
  `/greenhouse`), exchanged at `/auth/ticket`. The refresh token is kept in localStorage (`gh.refresh.v1`);
  `REFRESH_RACE` re-reads the newer token another tab stored. Panel: every `Twitch.ext.onAuthorized` is exchanged
  at `/auth/twitch-ext`; nothing is stored; `TWITCH_SIGNED_OUT` shows "Log in to Twitch to play" with a disabled
  action; no answer from Twitch in 10 s shows a timeout screen; `separate_saves` / `link_blocked` show a
  notice; identity sharing is optional (Profile) and the broadcaster gets no prompt.
- **Requests**: one Idempotency-Key per player action, reused on retries (network errors and 500/502/504, at
  most twice); `GET /state?v=<etag>` every 15 s visible / 60 s hidden (Page Visibility and
  `Twitch.ext.onVisibilityChanged`); WebSocket hints with the token in the first message; countdowns run on the
  server clock (`serverTimeMs`).
- **States**: loading, signed out, session expired, Discord sign-in not set up, backend down (retries by
  itself), maintenance (`SERVICE_DISABLED`), rate limited (one notice), offline, polling without a socket,
  Twitch logged out, Twitch auth timeout, helper missing, empty lists, locked features.
- **Rename**: `POST /account/name { name }` (phase 3 backend addition): `lib/validate.js playerName`
  (2-24 characters of letters, digits, spaces and . _ ' -, with a letter), `lib/name-filter.js` (the slur
  floor from `core/hate-terms.js`, the theme words, names that pass for staff or the brand), at most once every
  7 days (`NAMES` in config/game.js; `gh_accounts.name_changed_at`, added to the not-yet-applied migration 437).
  The state's `account.renameAvailableAtMs` says when (null: now). Panel players start as "Grower".
- **Phase 4 cards** (`registerSlot(name, render)`, `src/phase4.js`; still five tabs): Grow `grow.top` (a quest is
  done), `grow.bottom` (quests and the weekly challenge), `grow.benches` (the decorations shown); Upgrades
  `upgrades.top` (Replant) and `upgrades.decor` (the decoration shop, a third section); Profile `profile.season`
  (season card and the leaderboard dialog), `profile.achievements` (achievements and badges). The bell in the top
  bar shows `state.notifications.unread` and opens the list.
- **Link codes** (phase 3 follow-up): making and entering link codes is on the website only. The panel's Profile
  keeps only the optional "share your Twitch identity" card.
- **Desktop** (phase 3 follow-up): the website uses up to 1,440 px: Grow in two columns from 1,000 px (benches left;
  daily, staff and quests right), Profile in two columns, card lists in three columns from 1,280 px. The panel at
  318 x 496 is unchanged.
- **Review save** (panel only): "Try the review save" in Profile appears when Twitch loads the panel with
  `state=testing|hosted_test|ready_for_review|in_review` and `GET /review` is enabled; while on it a banner offers
  "Back to my save", session renewals keep using `/auth/review`, and rename, identity sharing and Replant are off.


## Phase 4

### Quests
Three daily and three weekly quests per account (`config/catalog.js` QUESTS_CATALOG), picked deterministically
from the account id and the day or ISO week (UTC; weeks start on Monday) when the account is first seen in the
period, so there is no reset job. Target and reward are fixed then (`gh_account_quests.target`, `reward_cash`,
`reward_xp`) and grow with the level: daily 8 x level cash and 5 + 2 x level XP, weekly 40 x level cash and 30 +
10 x level XP. Every gameplay action reports what it counts (`store/meta.js progress()`, in the action's
transaction). Finished quests are collected with `POST /quests/claim` (also yesterday's or last week's if they were
finished and not collected). A quest is worth 50 season points (a weekly one 150).

### Achievements
27 in the catalogue, unlocked from lifetime stats (`gh_account_stats`, which a Replant does not reset: harvests,
units sold, cash earned, orders, hybrids, base plants grown, best level, staff claims, quests, best daily streak,
challenges, Replants, decorations) at the end of any action that changed them, with a notification. Collected
with `POST /achievements/claim`; some also give a badge.

### Seasons and weekly challenges
- 30 days from a UTC midnight. The `season-rollover` job starts season 1 the first time it runs and each next
  season when the previous one is closed. Points: harvest 2, every $250 of a sale 1, order 30, new hybrid 40,
  quest 50 (weekly 150, a finished challenge 200), at most 1,000 a day (`domain/season-score.js`). Review saves
  never score.
- When a season ends the job ranks it once (the season row is locked; ties share a rank), marks it `closing`,
  then pays every standing in batches: `UPDATE ... SET reward_claimed_at WHERE reward_claimed_at IS NULL`, then
  the ledger key `season:<id>`, so a crash, a second job or a parallel run never pays twice; then `closed`.
- Rewards (`SEASON_TIERS`, best tier wins): champion $25,000, top 3 $15,000, top 10 $8,000 (these three also get
  the season-only Laurel arch decoration), top quarter $4,000, anyone with 100+ points $1,500, each with a badge
  "Season N: <tier>". The champion's cash is under 2 % of a heavy player's month; badges carry the weight.
- Weekly challenges: weeks 1-4, one catalogue challenge each (fixed targets, the same for everyone). When a week
  starts the job counts players seen in the 7 days before (`gh_accounts.last_seen_at`, written at most hourly by
  `GET /state`; review saves and suspended accounts left out). Below `min_active_players` (3, or gh_config
  `challenges.minActivePlayers`) the week is skipped. Finishing pays $2,000 and 300 XP at once
  (`challenge:<id>`); when the week closes the first three finishers get $5,000 and a podium badge
  (`challenge:<id>:podium`).

### Leaderboards and notifications
`GET /leaderboard`: the season board (score, ties share a rank; a closed season shows its final ranks) and the
all-time board (Replants first, then lifetime XP, so replanting is the long-term race). Review saves and suspended
accounts are left out. Pages of 20, cached 60 s per page; your own row is computed per request (one indexed
COUNT). Notifications (`gh_notifications`, kept 30 days): quest done, achievement, challenge, podium, season reward,
Replant. `state.notifications.unread` (capped at 99).

### Replant (prestige) and decorations
- From level 25, `POST /replant { prestige }` resets cash, XP and level, upgrades, staff, plots (back to two),
  inventory, crosses and open orders, and gives the starter kit again; every cash and item change goes through the
  ledger (`replant:<n>:<part>`, split to the ledger's limits). Kept: the collection, achievements and stats,
  badges, decorations, the season standing. Each Replant adds +10 % to sale prices and +10 % XP, counted for at
  most five. History in `gh_replants`. A plot slot created after a Replant starts its planting counter at
  1,000,000 x Replants, so harvest keys never repeat. Hybrid seeds are sold only from the higher of their parents'
  unlock levels (unchanged for anyone who never replanted).
- Decorations: 11 sold once each for $5k to $10M (unlock levels 3-30), plus the season-only Laurel arch; up to six
  shown in the greenhouse. Cosmetic only. They are the sink for heavy players who finish the upgrade tree.

### Economy with phase 4 (`node services/cfx/sim/report.js --replant`)

| days | profile | phase 2 only | + quests, decorations | + Replant when the tree is done |
|---|---|---|---|---|
| 30 | casual | L9, 88.8k | L10, 96.2k (+8 %) | (no Replant) |
| 30 | regular | L18, 362k | L19, 432k (+19 %) | (no Replant) |
| 30 | heavy | L31, 2.12M | L32, 2.22M (+5 %) | (tree not done yet) |
| 90 | regular | L36, 3.14M | L38, 3.37M (+7 %) | (tree not done yet) |
| 90 | heavy | L61, 14.2M | L62, 14.4M (+1 %), 9 decorations | 2 Replants (days 42, 77), 9.32M |
| 180 | regular | L49, 7.87M | L51, 8.21M (+4 %), 8 decorations | 1 Replant (day 105), 7.22M |
| 180 | heavy | L84, 32.2M | L85, 32.7M (+1 %), all 11 by day 163 | 5 Replants (days 42/77/110/140/168), 21.9M |

- The phase 2 curves are unchanged with the options off (`economy-replant.test.js` checks it; `economy-sim.test.js`
  keeps its bands). Quest rewards were cut from the first draft (which added 37 % for a regular player's first month,
  mostly by compounding early cash) to 8 x level cash.
- Replant never inflates: a heavy player who replants whenever the tree is done earns about two thirds of the cash of
  one who keeps it over six months, and each climb back to level 25 is no slower than the first (42, 34, 33, 31, 27
  days). Replanting at the minimum level every time costs more (12.8M) for a faster loop (cycles 20 -> 12 days).
  Lifetime XP is also lower for replanters, which is why the all-time board ranks Replants first.
- Decorations take a heavy player about four months after the tree to buy out (19.9M in total).

### Discord (`/arcade greenhouse status|daily|link [code]`)
Text commands (the `/arcade` tree is text-only, see docs/command-split-2026-11-18.md), handled by
`commands/games/arcade-greenhouse-handler.js`. They call `integrations/bot.js`, which runs this store and game code
directly on the bot's database pool rather than the HTTP API: the commands work while this service is down, the
daily goes through the same ledger and the same UNIQUE (account, day) and (sign-in, day) rows as the website and
the panel, and there is no service secret to keep in step. When the tables do not exist every call answers
`{ ready: false }` ("not open yet"). Link codes are sent by DM. The `/arcade cfx` commands were removed (H-650);
typed anyway, they answer with the new game's link (`core/retired-commands.js`). Open game tabs see a Discord change on their next poll (no WebSocket hint from the bot).

### Dashboard
- Server page `?page=greenhouse` (the old `?page=cfx` shows it too): the server's members who play (Discord sign-ins
  with a save, resolved against the guild without fetching the whole member list), the season and its challenge,
  the global top 10, the game link.
- Super-admin page, "Greenhouse game": the jobs kill switch (all, none or per job, with last runs) and the review
  save switch (on/off, allowed Twitch channel ids, reset now). Changes record the admin's Discord id in
  `gh_config.updated_by`.

### Twitch review account
Reviewers are real Twitch users whose panel session would start an empty save, so the panel offers a shared,
ready-made mid-game save instead:
- **Who can reach it:** only a viewer of the panel holding a valid extension token for this extension
  (`POST /auth/review { token }`), only while the owner has switched it on (gh_config `review.enabled`, dashboard
  super-admin page), and, if a channel list is set (`review.channelIds`), only on those channels. The panel shows the
  "Try the review save" action only when Twitch loads it with `state=testing|hosted_test|ready_for_review|in_review`
  and `GET /review` says it is open; a released panel never shows it, and the server switch is the real guard.
- **What it is:** one account (`gh_accounts.review = 1`) with one sign-in of platform `review`, a level-12 save with
  six benches (two ready, three growing), stock, upgrades, staff with earnings waiting, a cross nearly done, quests
  half done, achievements to collect and two notifications (`store/review.js REVIEW_SAVE`). Its session has no
  refresh token. The panel's "Back to my save" signs in with the viewer's own token again.
- **Why it cannot be used for anything else:** it is never ranked (no season points; left out of every leaderboard,
  challenge podium and active-player count); it cannot make or redeem link codes, unlink, rename or Replant
  (`REVIEW_ACCOUNT`); it has no Discord, Twitch or Kick sign-in, so nothing earned there can reach another save; and
  it is put back every night after 04:00 UTC (`review-reset`), on demand from the dashboard, and whenever a reviewer
  switches to it after nobody has for 30 minutes (so the growing plants are mid-growth for each new reviewer).
- **How a reviewer signs in:** install the extension (Hosted Test or the review build), open the channel page as any
  logged-in Twitch user, open the panel, choose "Try the review save" in Profile. Put the same steps in the
  Walkthrough Guide. Owner: switch it on (and set the channel id of the test channel) before submitting, off after.

## Phase 5

### Privacy (register H-631)
`/privacy export` and `/privacy delete` in Discord (`core/privacy-manager.js`) call `privacy/index.js
createPersonPrivacy` with the member's Discord id. The person is their Discord sign-in in `gh_identities`, the save it
is on, and every sign-in on that save (Twitch, Kick), so linking is what proves those are the same person.

- **Export**: the account row, every `ACCOUNT_TABLES` table (sign-ins, link history, link codes, refresh tokens,
  ledger, inventory, collection, plots, crosses, upgrades, staff, quests, achievements, stats, orders, season
  standings, notifications, daily claims, decorations and badges, Replants), the hybrids the save bred first, and the
  link history, daily claims and refresh tokens of those sign-ins recorded on other saves. The newest 1,000 rows a
  table, with the full count. Hashes and tokens are shown as `[redacted]` (`core/privacy-tables.js redactRow`).
- **Delete**: one transaction, the account row locked first (the ledger's lock order). Every sign-in on the save,
  their link history, daily claims, refresh tokens and link codes, then the account (its `ON DELETE CASCADE` rows go
  with it). Other sign-ins' link history that pointed at the save loses only the account id (their 7-day rule
  stays); hybrids it bred first stay in the catalogue with `first_bred_by` NULL. The review save is never deleted.
- **Ledger rows are deleted, not anonymised**: a ledger row means something only for its own save, nothing shared
  is computed from it (seasons rank on `gh_season_standings`, the all-time board on `gh_account_stats`), and an
  anonymised row would still be a dated record of one person's play.
- **Season and leaderboard jobs**: a save deleted while a season is being paid is skipped
  (`store/meta.js lockIfPresent` in `payStanding` and the challenge podium); boards join on `gh_accounts`. A board page
  cached in the game service (60 s) can still show the name until it expires.
- **The old game**: while the `cfx_` tables exist, `privacy/legacy.js` exports and deletes the person's old rows by
  platform + platform_user_id (the Discord id and the Twitch and Kick ids on the save). The tables, columns and keys
  are read from information_schema: the players rows, everything with `player_id`, a declared foreign key or one of
  the person columns (sender, receiver, offerer, buyer, leader, bred by), and rows hanging off those
  (`<singular of the table>_id` or a declared key), three levels deep. A NOT NULL link is deleted, a nullable one set to
  NULL. No-op once migration 438 has dropped them.
- **Twitch or Kick only**: the website's Profile has a **Your data** card (register H-641,
  `frontend/greenhouse/src/views/your-data.js`): `GET /api/v2/account/export` and `POST /api/v2/account/delete`
  (`http/routes/account.js`) call `createPersonPrivacy` `exportFor` / `deleteFor` with the session's own sign-in and
  `{ accountId }` (the save the session is on; a sign-in that moved meanwhile is `SESSION_STALE` and nothing is
  deleted). Export answers the same content as the script below, with `Content-Disposition: attachment`. Delete needs
  `{ confirm: 'DELETE' }` (trimmed, upper case; otherwise `400 DELETE_CONFIRM_REQUIRED`), runs in one transaction,
  and ends the session with the save: the sign-ins are gone, so session tokens are stale, and their refresh tokens
  are deleted. A retry with the same Idempotency-Key finds the session ended (`401 SESSION_STALE`). Both refuse the
  review save (`REVIEW_ACCOUNT`) and the tests' dev sign-in (`PLATFORM_NOT_ALLOWED`). Limits: 3 exports and 5 delete
  attempts an hour per save (`http/security.js`). Logged as `[cfx2] privacy export` / `[cfx2] privacy delete` with the
  save id and counts (the privacy module itself does not log; `/privacy` records its own actions in
  `privacy_actions_log`). Under any table prefix other than `gh_` (tests) the old-game part uses `<prefix>legacy_`, which
  has no tables. Website only: the website bundle starts at `src/web-entry.js`, the panel bundle at `src/main.js`, and
  the card's CSS is `src/styles/web.css`, so the Twitch panel package is unchanged (byte-identical).
  For anyone who cannot sign in any more: `node scripts/greenhouse-privacy.mjs export|delete <platform> <id>` (same
  code) for requests sent to support.

### Retention
`config/retention.js` lists every table that grows without end; migration 437 adds them to `data_retention_policy`
and the bot's nightly sweeper (`jobs/retention-sweeper.js`, 04:20) deletes older rows in batches. Every other table
is in `BOUNDED` with the reason it stays small (`tests/cfx/v2/retention.test.js` fails on a table in neither).

| Table | Column | Days |
|---|---|---|
| `gh_ledger` | created_at | 180 |
| `gh_notifications` | created_at | 30 (the game's own sweep also runs every 6 h) |
| `gh_identity_events`, `gh_daily_claims` | created_at | 180 |
| `gh_account_quests` | created_at (added in phase 5) | 90 |
| `gh_breeding` | claimed_at (open crosses are never swept) | 180 |
| `gh_market_days` | day | 400 |
| `gh_orders`, `gh_sessions`, `gh_link_codes` | offered_at, expires_at, expires_at | 60, 1, 1 (backstops for the game's jobs) |

Why the ledger keeps 180 days: nothing that ranks or pays reads old rows (seasons rank on standings, the all-time
board on stats; the payout and podium keys guard a run for minutes to hours), replays need minutes, and 180 days is
six seasons of detail for a dispute. Two rules depended on old ledger rows and were changed: the "fresh save" test
used when linking now also treats a save older than 180 days as not fresh (`store/accounts.js isFresh`), and
`GET /stats` `incomeByReason` now covers the last 180 days (lifetime totals stay in `gh_account_stats`). Each swept
column has an index (phase 5 added `gh_account_quests.created_at`, and indexes on `gh_breeding.claimed_at`,
`gh_orders.offered_at` and `gh_daily_claims.created_at`, all before 437 was applied).

### Cutover switch
`integrations/cutover.js`: `GREENHOUSE_LIVE=1` (exactly; anything else is off), read when asked. Off: nothing
changes. On: `index.js` does not start the old game server or its jobs (and `startJobs` refuses on its own); the
dashboard mounts `oldGameRoutes()` before the old proxy, so `/game`, `/game/*`, `/cfx`, `/cfx/*` and `/cfx-api/*`
pages answer 301 `/greenhouse` (`Cache-Control: max-age=86400`, so a rollback is not stuck in browsers) and the API,
files and WebSockets 410 `{ error: { code: 'MOVED', message, url } }`; the old game server answers every path the same
way if it runs anyway; `/arcade cfx` (removed from /arcade, answered by `core/retired-commands.js`) and `!cfx`
answer once with `config/copy.js oldGameMoved`. The old dashboard
page (`partials/manage/cfx.ejs`) and its API route (`routes/api/features/cfx.js`) are removed; `?page=cfx` opens
`?page=greenhouse`.

### Drop migration
`migrations/438_drop_cfx_v1_tables.js`, prepared and not run. It refuses unless `GREENHOUSE_LIVE=1`, the archive
`backups/cfx-v1-archive/cfx-v1-20261119-0223.sql.gz` exists, is not empty and gunzips to the end, every `cfx_`
object is in it, and no other table has a foreign key into them; then it drops the view and the tables and removes
their retention rows. `down()` explains how to restore from the archive instead.

## Request limits

- **CORS** (exact host matches only, the old game's H-402 rule): the site (`CFX2_PUBLIC_URL`) and its
  `www.` twin, `https://7k7fn5nym3jx13sdl4d56yxlu0cytp.ext-twitch.tv`, `supervisor.ext-twitch.tv`,
  `extension-files.twitch.tv`, `www.twitch.tv`, `dashboard.twitch.tv`, all `https`. No cookies
  (`credentials: false`). A refused origin is `403 CORS_ORIGIN`.
- **helmet**: `default-src 'none'; frame-ancestors 'none'` for the JSON API; the OAuth landing page has its
  own CSP with a nonce.
- **Body size**: 8 KB JSON, strict (`413 PAYLOAD_TOO_LARGE`).
- **Rate limits** (`http/security.js`, token buckets in memory): per address 300 burst / 30 per s; sign-in
  routes per address 20 burst / one per 5 s; per account reads 30 / 3 per s, gameplay writes 10 / 4 per s,
  `GET /account/export` 3 an hour and `POST /account/delete` 5 an hour (H-641).
  `429 RATE_LIMITED` with `Retry-After`. Behind Cloudflare the address is `CF-Connecting-IP`, used only when
  the request came from loopback (LiteSpeed).

## Gameplay rules (phase 2)

- **Growing**: growth is computed from `planted_at_ms`/`ready_at_ms`; nothing ticks. Two starter plots;
  the Extra bench upgrade (also sold as "plot expansion") adds one per level, up to 12.
- **Watering**: once per planting, from half-grown until ready; it halves the time still to go. The mark
  belongs to the planting (`gh_plots.watered_at_ms`, cleared when the plot is cleared), so there is no
  cooldown to get stuck: the old game's "always on cooldown" class cannot happen.
- **Harvest**: the plot is cleared with `UPDATE … WHERE plant_seq = ? AND variety_id IS NOT NULL` in the same
  transaction as the ledger credit keyed `harvest:<slot>:<plant_seq>`.
- **Selling**: only to NPC buyers, through `sellPrice()`, at today's demand (`domain/market.js`): every
  variety moves in its own slow wave, 60-140 %, at most 25 points a day, the same on every server. The
  `market-day` job stores each day's rows (history, and an admin can override a row).
- **Orders**: three NPC orders per account per day (1-3 days to deliver, 135-175 % of the market price,
  bonus XP), produce of at least the asked quality, lowest qualities used first.
- **Shop**: seeds (base by level, hybrids once discovered), boosts (Plant food: +200 quality roll; Growth
  tonic: halves the time still to go; once each per planting), plot expansion.
- **Breeding**: two different base varieties (66 possible hybrids, each stored once per pair), from level 4,
  one cross at a time, timers checked by the server. Hybrids of hybrids are not allowed: repeated crossing
  would raise prices by about 12 % a generation without end.
- **Staff**: Gardener (3 Sunmoss/h), Propagator (2 Ember Coleus seeds/h), Shop assistant (20 cash/h); each
  hire costs 160 % of the previous; the Staff room adds one slot per type per level. Claims pay at most 12 h
  since the last claim; a hire, a fire or a staff upgrade first pays what was earned at the old rate.
- **Daily reward**: one per account per day and per sign-in per day; a streak adds cash up to day 7, and day
  7 adds seeds.

## Economy (audit B3 test 4)

`node services/cfx/sim/report.js 30 90` runs the simulator (`SIM_CURVES=1` adds the curves). It drives the
same domain functions as the server, for one player minute by minute while they play:

- casual: two 5-minute visits a day; regular: four visits, 1 h a day; heavy: 4 h a day;
  idle: one 2-minute visit a day
- balanced (plots, upgrades, staff, orders, breeding), grower (no staff), staff first

Results with the current numbers (seed 1):

| 30 days | level | cash income | staff share | upgrade levels | days to 5/10/20/30/40/50 upgrade levels |
|---|---|---|---|---|---|
| casual | 9 | 88.8k | 60 % | 20 | 7.3 / 15.8 / 29.3 / - / - / - |
| regular | 18 | 362k | 28 % | 33 | 5.8 / 9.5 / 16.3 / 25.9 / - / - |
| heavy | 31 | 2.12M | 8 % | 58 | 2.8 / 4.5 / 7.4 / 11.6 / 15.6 / 22.4 |
| idle, staff first | 2 | 18.1k | 54 % | 8 | 23.8 / - |

| 90 days | level | cash income | staff share | upgrade levels | days to 30/40/50 |
|---|---|---|---|---|---|
| casual | 18 | 695k | 61 % | 46 | 48.8 / 67.8 / - |
| regular | 36 | 3.14M | 20 % | 64 | 25.9 / 36.5 / 51.5 |
| heavy | 61 | 14.2M | 5 % | 68 (all) | 11.6 / 15.6 / 22.4 |
| regular, grower | 37 | 2.77M | 0 % | 53 | 28.8 / 46.5 / 68.8 |
| regular, staff first | 24 | 1.39M | 41 % | 51 | 32.8 / 53.8 / 82.5 |
| idle, staff first | 4 | 118k | 73 % | 25 | - |

- Idle play is bounded: staff earn no XP, so an idle player stays at level 2-4 and earns a fifth (30 days) to a
  sixth (90 days) of what a casual player earns (test: at most 0.35×).
- No strategy dominates: for a regular player the balanced mix beats both specialists; for a casual
  player, leaning on staff is about 1.25× better by day 90 (test: specialists stay within 1.5×).
- The 12 h cap: no claim ever credits more than 12 h. A fully staffed player who visits once a day earns
  12 h of staff output (about 4.4k) and forfeits the rest; two visits a day earn about twice that.
- Heavy players finish the upgrade tree around day 25 and then only bank cash. Phase 4 (seasons, quests,
  prestige) has to give them a sink.

## Tables

Prefix `gh_` (the old game uses `cfx_`; several names would otherwise clash). 27 tables, created by
`migrations/437_greenhouse_v2_schema.js` from `store/schema.js` (phase 2 added `gh_sessions` and
`gh_plots.watered_at_ms`, phase 4 `gh_account_cosmetics`, `gh_replants` and the columns listed under
"Phase 4", all before the migration was ever applied):

| Group | Tables |
|---|---|
| Accounts | `gh_accounts`, `gh_identities`, `gh_identity_events`, `gh_link_codes`, `gh_sessions` |
| Money and items | `gh_ledger`, `gh_inventory` |
| Plants | `gh_varieties` (bred hybrids only, ids from 1000), `gh_account_varieties`, `gh_plots`, `gh_breeding` |
| Progress | `gh_account_upgrades`, `gh_account_staff`, `gh_account_quests`, `gh_account_achievements`, `gh_account_stats` |
| Market | `gh_market_days`, `gh_orders` (NPC orders only) |
| Seasons | `gh_seasons`, `gh_season_standings`, `gh_challenges` |
| Other | `gh_notifications`, `gh_daily_claims`, `gh_config`, `gh_job_runs` |
| Endgame (phase 4) | `gh_account_cosmetics` (decorations and badges), `gh_replants` (Replant history) |

Static catalogues (base varieties, staff types, boosts, upgrade nodes; later quests and achievements) are in
`config/catalog.js`, not in tables, so nothing is seeded or rewritten at boot.

Conventions: game clocks are BIGINT milliseconds in columns ending `_ms`; audit times are `DATETIME(3)`;
money and counts are `BIGINT UNSIGNED`; everything a player owns has `account_id … ON DELETE CASCADE`.

## The ledger

`store.ledger.apply({ accountId, key, reason, ref?, cash?, items? })` is the only way to change cash or
items. `items` is a list of `{ kind: 'seed'|'produce'|'boost', itemId, quality?, delta }`.

- **Validation** (`lib/validate.js`): safe integers only, non-zero, within per-operation caps, known kinds
  and reasons, no item listed twice, at least one change.
- **Concurrency:** the account row is locked first (`SELECT … FOR UPDATE`), so writes to one account run one
  at a time; inventory rows are then touched in sorted order. Debits are conditional
  (`cash = cash - n WHERE cash >= n`, `quantity = quantity - n WHERE quantity >= n`); any failure rolls the
  whole operation back. Columns are UNSIGNED with CHECKs as a last line of defence.
- **Idempotency:** `UNIQUE (account_id, idempotency_key)`. A repeated key returns the first result and
  changes nothing; the same key with a different change is `IDEMPOTENCY_MISMATCH`.
- **Composing** with other writes: `store/game.js action()` opens one transaction, locks the account,
  checks for a replay, makes its writes and calls `ledger.applyInTx`; version hints go out after commit.

## Accounts and linking

One account can hold one sign-in per platform (`twitch`, `twitch_opaque` for the panel's `U…` id, `kick`,
`discord`). Rules (`store/accounts.js`):

- Starter kit once per sign-in, ever (not per account). A sign-in joined to an existing account is marked
  too, so unlinking it later gives an empty account.
- Linking: the account creates a one-time code (10 min, max 3 waiting, only a hash stored); another sign-in
  redeems it and moves onto the account. If that sign-in was alone on an account with progress, the move is
  refused (`SOURCE_HAS_PROGRESS`): saves are never merged. A fresh source account is deleted.
- Unlink only from another sign-in on the same account; never the one in use.
- A sign-in linked or unlinked in the last 7 days cannot move again (`LINK_COOLDOWN`).
- 10 wrong codes per sign-in per hour, then `LINK_TOO_MANY_ATTEMPTS`.
- Daily rewards are unique per account per day and per sign-in per day.

## Running it

Standalone, from the repo root (it reads `.env` there through `utils/db.js`):

```
CFX2_JWT_SECRET=<32+ chars> node services/cfx/server.js
```

It checks that all 27 tables exist and exits if the migration has not been applied. It is meant to run as
its own pm2 app (owner decision); that app has not been created yet. Example entry for
`ecosystem.config.cjs` when the time comes:

```
{ name: 'greenhouse-tycoon', script: 'services/cfx/server.js', cwd: '/home/death/CertiFriedUtility',
  env: { NODE_ENV: 'production', CFX2_PORT: '4021' } }
```

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `CFX2_JWT_SECRET` | (required) | HS256 secret for game sessions, at least 32 characters |
| `CFX2_HOST` | `127.0.0.1` | listen address |
| `CFX2_PORT` | `4021` | listen port (the old game uses 4020) |
| `CFX2_TABLE_PREFIX` | `gh_` | table prefix; `cfx_` is refused |
| `CFX2_SESSION_TTL_SEC` | `3600` | session token lifetime |
| `CFX2_REFRESH_TTL_SEC` | `2592000` | refresh token lifetime (30 days) |
| `CFX2_PUBLIC_URL` | `https://certifriedmultitool.com` | site origin: CORS, OAuth redirect URLs, postMessage target |
| `CFX2_GAME_PATH` | `/greenhouse` | where the OAuth page sends a tab that was not a popup (the v2 game page) |
| `CFX2_TWITCH_EXT_SECRET` | `TWITCH_EXT_SECRET` | panel extension secret (base64, as in the console) |
| `CFX2_TWITCH_EXT_CLIENT_ID` | `7k7fn5nym3jx13sdl4d56yxlu0cytp` | panel extension client id (CORS origin) |
| `CFX2_TWITCH_CLIENT_ID` / `_SECRET` | `TWITCH_CLIENT_ID` / `_SECRET` | website Twitch sign-in app |
| `CFX2_KICK_CLIENT_ID` / `_SECRET` | `KICK_CLIENT_ID` / `_SECRET` | website Kick sign-in app |
| `CFX2_DASHBOARD_SECRET` | (none: Discord sign-in off) | shared with the dashboard for the Discord hand-off, 32+ characters |
| `CFX2_JOBS_DISABLED` | empty | `1`/`all` stops every job; or a comma list of job names |
| `CFX2_ALLOW_DEV_SIGNIN` | off | `1` allows the `dev` platform and `/auth/dev`, only when bound to loopback |
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | from `.env` | through `utils/db.js` |

A sign-in whose secret is missing answers `503 SIGNIN_UNAVAILABLE`; the rest of the game still works.

### Jobs

`link-code-sweep` (hourly), `session-sweep` (6 h), `market-day` (hourly: today's and tomorrow's demand
rows), `order-sweep` (6 h: expire open orders past their deadline, delete closed ones after 30 days).

Phase 4: `season-rollover` (15 min: rank and pay a season that ended, start the next, start/skip/close the
weekly challenges), `notification-sweep` (6 h: older than 30 days), `review-reset` (hourly; resets the review
save once a day after 04:00 UTC).

Kill switches: `CFX2_JOBS_DISABLED=all` (needs a restart), or without a restart from the dashboard's super-admin
page ("Greenhouse game": all, none or per job, with each job's last run), or by hand:
`INSERT INTO gh_config (name, value) VALUES ('jobs.disabled', 'true') ON DUPLICATE KEY UPDATE value = VALUES(value);`
(or a JSON list of job names). Read before every run, cached 15 s.

## Applying the schema

Not applied to production yet. When approved:

```
node -e "import('./migrations/437_greenhouse_v2_schema.js').then(m => import('./utils/db.js').then(d => m.up(d.default))).then(() => process.exit(0))"
```

It also inserts the `gh_` retention rows (phase 5). `down()` removes them and drops the 27 tables. The full order of
the day is `docs/greenhouse-cutover.md`.

## Tests

`tests/cfx/v2/`. Run at most three files at a time with the safe command:

```
timeout -s KILL 180 node --test --test-force-exit --test-reporter=tap tests/cfx/v2/domain.test.js tests/cfx/v2/scheduler.test.js tests/cfx/v2/ledger.test.js | tail -40
timeout -s KILL 180 node --test --test-force-exit --test-reporter=tap tests/cfx/v2/api.test.js tests/cfx/v2/economy-sim.test.js | tail -40
timeout -s KILL 180 node --test --test-force-exit --test-reporter=tap tests/cfx/v2/game-api.test.js | tail -40
timeout -s KILL 180 node --test --test-force-exit --test-reporter=tap tests/cfx/v2/concurrency.test.js tests/cfx/v2/signin.test.js | tail -40
timeout -s KILL 180 node --test --test-force-exit --test-reporter=tap tests/cfx/v2/rename.test.js tests/cfx/v2/frontend-build.test.js | tail -40
timeout -s KILL 180 node --test --test-force-exit --test-reporter=tap tests/cfx/v2/frontend-web.test.js | tail -40
timeout -s KILL 180 node --test --test-force-exit --test-reporter=tap tests/cfx/v2/frontend-panel.test.js | tail -40
timeout -s KILL 180 node --test --test-force-exit --test-reporter=tap tests/cfx/v2/meta-domain.test.js tests/cfx/v2/meta-api.test.js | tail -40
timeout -s KILL 180 node --test --test-force-exit --test-reporter=tap tests/cfx/v2/meta-concurrency.test.js tests/cfx/v2/economy-replant.test.js | tail -40
timeout -s KILL 180 node --test --test-force-exit --test-reporter=tap tests/greenhouse-discord.test.js tests/greenhouse-dashboard.test.js | tail -40
timeout -s KILL 300 node --test --test-force-exit --test-concurrency=1 --test-reporter=tap tests/cfx/v2/privacy.test.js | tail -40
timeout -s KILL 300 node --test --test-force-exit --test-concurrency=1 --test-reporter=tap tests/cfx/v2/retention.test.js tests/cfx/v2/cutover.test.js tests/cfx/v2/drop-migration.test.js | tail -40
```

The browser tests use the repo's puppeteer (headless Chrome, `--no-sandbox` as on this server). Optional:
`GH_SHOTS_DIR=<dir>` saves screenshots, `GH_AXE_PATH=<axe.min.js>` runs axe-core on every screen (both outside
the repo; `npm pack axe-core` gives the file), and `GH_LIGHTHOUSE=<.../lighthouse/core/index.js>` runs
`frontend-lighthouse.test.js` (Lighthouse installed outside the repo).

- `domain.test.js` (B3 test 1): growth, sell formula, XP, upgrade costs, staff 12 h cap, breeding,
  season score caps, the validator, catalogue checks, and a scan for theme-breaking words (the service,
  this README, the migration and the other v2 tests).
- `scheduler.test.js`: overlap guard, cross-process lock, jitter, timeout, all kill switches.
- `ledger.test.js` (B3 test 2): refused inputs, atomic multi-line changes, limits, replays, 50 parallel spends.
- `api.test.js` (B3 test 3, phase 1): account routes, linking rules and races, privacy delete, job lock.
- `account-privacy.test.js` (H-641): `GET /account/export` and `POST /account/delete`: auth, the review save and the
  dev sign-in refused, the DELETE confirmation, the Idempotency-Key, the data really gone (other saves untouched),
  sessions and refresh tokens ended, a moved sign-in, the rate limits, the log lines.
- `frontend-privacy.test.js` (H-641): the website's Your data card in Chrome (keyboard download, the delete dialog,
  a wrong word, DELETE signs out, axe with `GH_AXE_PATH`), no card in the panel, and a fresh panel build
  byte-identical to `dist/panel/` and to the files inside `dist/greenhouse-panel.zip`.
- `game-api.test.js` (phase 2): every gameplay route refuses bad input with the error shape and no 500;
  account A cannot touch account B; the full core loop on a fake clock; 304 polling; CORS; helmet; rate
  limits; latency (p95 of a 304 poll, a full state and a write).
- `concurrency.test.js` (phase 2): double harvest, double sell, double daily, parallel order completion,
  double upgrade, plot, cross and staff claim, hires against the limit: each pays once, and cash and items
  equal the ledger afterwards.
- `signin.test.js` (phase 2): Twitch panel JWTs signed with a test secret (opaque, shared, logged out,
  broadcaster, forged, saves never merged, anti-farming, cooldown), Discord assertions, website OAuth against
  a stubbed provider, refresh tokens, unconfigured sign-ins, WebSocket hints.
- `economy-sim.test.js` (B3 test 4): market bounds, the rules, and the simulation bands above.
- `rename.test.js` (phase 3): the name validator and word rules, the 7-day wait, the state field, "Grower".
- `frontend-build.test.js` (phase 3): the panel package rules (and that each rule catches a broken package),
  the zip contents, the website build, no HTML from strings in the source.
- `frontend-web.test.js`, `frontend-panel.test.js` (phase 3): the built website and panel in headless Chrome
  at 318 x 496 and desktop width against a throwaway server (`_frontend-harness.js`, ghtest_ tables, fake game
  clock, a stub Twitch helper with a test secret): plant, harvest, sell, upgrade, hire, breed, daily, rename;
  every state screen; keyboard use; no sideways scrolling; no console errors; WebSocket hint and polling.
- `frontend-lighthouse.test.js` (phase 3, optional): Lighthouse accessibility of /greenhouse, 90 or more.
- `meta-domain.test.js` (phase 4): periods and ISO weeks, quest generation, targets and rewards, achievements from
  stats, season windows, reward tiers, challenge podium, Replant bonus and inventory clearing, starting names.
- `meta-api.test.js` (phase 4): every phase 4 route over HTTP on a fake clock: quests and challenge progress, the
  daily score cap, claims that replay, achievements, notifications, both leaderboards (ties, paging, review and
  suspended accounts left out), the season job (start, rank, pay, next season, skipped challenge), Replant,
  decorations, the review save, bad input never a 500, the three-part etag.
- `meta-concurrency.test.js` (phase 4): the same quest or achievement claimed 10 times at once, the season payout
  run by several jobs at once, one daily across website, Discord bridge and direct calls at once, parallel Replant
  and decoration purchases; cash equals the ledger after each; the bot bridge.
- `economy-replant.test.js` (phase 4): the phase 2 economy is unchanged with the options off; quests, Replant and
  decorations stay inside the bands above.
- `privacy.test.js` (phase 5): export and delete for one person (the save, every table keyed to it, the linked
  sign-ins, one transaction, other saves untouched), the season payout and boards with a save deleted mid-payout,
  the old game's rows on throwaway copies of its table shapes, and `/privacy` (`core/privacy-manager.js`) end to end.
- `retention.test.js` (phase 5): every table swept or bounded, indexes, the sweeper deleting old rows only, the
  437 rows, and the "fresh save" rule with the ledger window.
- `cutover.test.js` (phase 5): `GREENHOUSE_LIVE` off and on for the dashboard paths, WebSockets, the old game
  server, its jobs, `index.js`, `/arcade cfx` and `!cfx`; the removed old dashboard page.
- `drop-migration.test.js` (phase 5): every refusal of 438, one drop of throwaway tables, and a read-only check that
  the real archive holds every `cfx_` table.
- Outside this folder: `tests/greenhouse-discord.test.js` (the Discord commands) and
  `tests/greenhouse-dashboard.test.js` (the dashboard routes).

The database tests need the live DB credentials in `.env`. The DB user cannot create databases, so each
file creates the 27 tables under its own random prefix `ghtest_<6 hex>_` and drops them at the end. To find
leftovers from a killed run:
`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'ghtest\_%';`
