# CertiFried Utility 

Powerful, modular Discord utility bot with a built‑in web dashboard. It provides moderation, leveling, music (optional), giveaways, polls, social/stream integrations, scheduled jobs, and more.

## Overview

- Runtime: Node.js (ES Modules)
- Primary entry point: `index.js`
- Dashboard: Express + EJS templates in `dashboard/`
- Discord SDK: `discord.js@14`
- Optional music: `discord-player` (+ `yt-dlp` binary required)
- Database: MySQL/MariaDB (`mysql2`)
- Cache/queues/locks: Redis (`ioredis`)
- Schedulers: `cron`/`node-cron` jobs under `jobs/`
- Auth: `passport` + `passport-discord`
- Other integrations: Twitch, YouTube, TikTok, Spotify, Google (search/LLMs), Last.fm, TMDb, RAWG, NASA APIs (keys via `.env`)

The bot loads commands dynamically from `commands/`, interactions from `interactions/`, and wires event handlers from `events/`. Many features can be toggled/enabled depending on which managers and jobs are started in `index.js` and which environment variables/credentials are present.


## Requirements

- Node.js 18+ (see `"engines": { "node": ">=18.0.0" }`)
- npm (uses `package-lock.json` → npm is the package manager)
- MySQL or MariaDB instance reachable by the bot
- Redis server (default `127.0.0.1:6379` unless configured otherwise)
- For music features: `discord-player` dependency is installed, and `yt-dlp` binary must be present in PATH
- For scraping/automation features: a Chromium/Chrome executable (path configurable via `CHROME_EXECUTABLE_PATH`)

Optional/Feature‑specific requirements:
- Piper TTS (see `PIPER_PATH` and `piper_models/`)
- API keys for Twitch, YouTube, TikTok, Spotify, Google, Last.fm, TMDb, RAWG, NASA, etc.


## Quick Start

1) Clone and install dependencies

```
git clone https://github.com/xXDeath420Xx/LiveBot.git
cd LiveBot
npm install
```

2) Configure environment

- Create a `.env` file at the project root (do NOT commit secrets).
- See the Environment Variables section below for the full list. Start with the essentials:
  - Discord credentials: `DISCORD_CLIENT_ID`, `DISCORD_TOKEN`, `DISCORD_PUBLIC_KEY`, `BOT_OWNER_ID`
  - Database: `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
  - Redis: `REDIS_HOST`, `REDIS_PORT`
  - Dashboard: `DASHBOARD_PORT`, `DASHBOARD_URL`, `SESSION_SECRET`, `DASHBOARD_CLIENT_ID`, `DASHBOARD_CLIENT_SECRET`, `DASHBOARD_CALLBACK_URL`

3) Run database migrations (if applicable)

```
npm run migrate
```

4) Start the bot

```
# production
npm start

# development (auto‑reload)
npm run dev
```

5) Deploy slash commands to Discord

```
npm run deploy
```


## Scripts

Defined in `package.json`:

- `npm start` → `node index.js`
- `npm run dev` → `nodemon index.js`
- `npm run deploy` → `node deploy-commands.js` (registers slash commands)
- `npm run migrate` → `node migrations/run.js`

Other utility scripts exist in the repository root (e.g., `check-guilds.mjs`, `cleanup-streams.js`, `list-guilds.js`, `deploy-all-commands.js`, etc.) and under `scripts/`. These are typically one‑off maintenance or diagnostics tasks. Review each file before running.


## Environment Variables

Keep secrets out of source control. Use a local `.env` file in development and a secure secret manager in production.

Database
- `DB_HOST`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`

Discord / Bot
- `DISCORD_CLIENT_ID`
- `DISCORD_TOKEN`
- `DISCORD_PUBLIC_KEY`
- `BOT_OWNER_ID`
- `BOT_ENCRYPTION_KEY` (used for sensitive data at rest)

Dashboard (Express/EJS + Discord OAuth)
- `DASHBOARD_CLIENT_ID`
- `DASHBOARD_CLIENT_SECRET`
- `DASHBOARD_CALLBACK_URL`
- `SESSION_SECRET`
- `DASHBOARD_PORT` (e.g., 3001)
- `DASHBOARD_URL` (public base URL used in links/callbacks)

Redis
- `REDIS_HOST` (default `127.0.0.1`)
- `REDIS_PORT` (default `6379`)

Media / Automation / Tools
- `PIPER_PATH` (piper TTS binary)
- `YTDLP_CACHE_DIR` (cache dir for `yt-dlp` if used)
- `CHROME_EXECUTABLE_PATH` (path to Chromium/Chrome for puppeteer/playwright)

External APIs (enable corresponding features/jobs)
- Twitch: `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`
- YouTube: `YOUTUBE_API_KEY`
- TikTok (official): `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`
- Spotify: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`
- Google/GenAI: `GOOGLE_API_KEY`, `GOOGLE_CSE_ID`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`
- Last.fm: `LASTFM_API_KEY`, `LASTFM_SHARED_SECRET`
- NASA: `NASA_API_KEY`
- TMDb: `TMDB_API_KEY`
- RAWG: `RAWG_API_KEY`

Notes
- Not all variables are required to run the bot; provide only those needed for the features you enable.
- Rotate and store credentials securely. Never commit real secrets to Git.


## Project Structure

Top‑level highlights:

```
commands/           # slash & context commands grouped by category
core/               # feature managers (moderation, leveling, music, rpg, stats, etc.)
dashboard/          # Express + EJS dashboard (views/partials)
events/             # Discord event handlers
handlers/           # loaders/wirings for commands, events, interactions
interactions/       # interaction handlers (buttons, modals, select menus)
jobs/               # scheduled tasks (giveaways, polls, social feeds, streams, etc.)
migrations/         # migration runner (npm run migrate)
utils/              # helpers (db pool, logger, uptime tracker, validators)
scripts/            # assorted helper/maintenance scripts
index.js            # main entry point
package.json        # scripts, dependencies, engines
YTDLP_FIX.md        # notes for yt-dlp issues/fixes
```


## Running Tests

There is no conventional automated test suite configured (e.g., Jest/Mocha). Some `test-*.mjs`/`.js` files in the root (e.g., `test-trovo.mjs`, `test_db.js`) are ad‑hoc scripts for manual verification.

TODO
- Add a proper test framework (Jest) and CI workflow.
- Convert critical logic in `core/` and `utils/` to unit‑tested modules.


## Deployment Notes

- Ensure the database and Redis are reachable from the deployed environment.
- Provide required environment variables via your platform’s secret manager or `.env` equivalents.
- For music: install `yt-dlp` on the host and keep it updated. See `YTDLP_FIX.md` for troubleshooting.
- For puppeteer‑based tasks, verify `CHROME_EXECUTABLE_PATH` and any sandbox flags required by your host.
- Use `npm run deploy` to register slash commands after initial setup or when commands change.


## Security

- Do not commit `.env` with real secrets. Add `.env` to `.gitignore` (already present).
- Rotate API keys regularly and use least‑privilege scopes where possible.
- Consider restricting dashboard routes behind Discord roles and session security best practices.


## License

This project declares MIT license in `package.json`.

TODO
- Add a `LICENSE` file to the repository root if it’s missing.


## Troubleshooting

- Music features disabled: Install `discord-player` (already in deps) and ensure `yt-dlp` is installed and in PATH. Clear `YTDLP_CACHE_DIR` if needed.
- Chromium not found: Set `CHROME_EXECUTABLE_PATH` to your Chrome/Chromium binary.
- Commands not visible: Run `npm run deploy` and confirm the bot has the correct application scopes and guild permissions.
- Database errors: Verify `DB_*` variables and run `npm run migrate`.
- Rate limits/API errors: Check that related API keys are valid and active.


## Notes & TODOs

- Some root scripts (`*.mjs`/`*.js`) are operational tools. Document them individually as they stabilize.
- The dashboard routes, authentication flows, and management pages can be documented further (paths, permissions, screenshots).
- Provide production ready Docker/Compose files or systemd templates. TODO.
