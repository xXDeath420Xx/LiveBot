# CertiFried

CertiFried is a Discord bot with a web dashboard, plus a stream bot for Twitch and Kick. It handles
moderation and automod, logging, levels, go-live announcements, social and video feeds, tickets,
music, schedules, games and a lot more, all configured from the dashboard.

- Website and dashboard: <https://certifriedmultitool.com>
- Documentation and guides: <https://certifriedmultitool.com/docs>
- CertiFried Studio (Windows app for OBS, sounds and hotkeys): <https://certifriedmultitool.com/downloads/studio>
- Support server: <https://certifriedmultitool.com/discord>

CertiFried is free. There are no paid tiers and no locked features, and the source is here.

## What's in this repository

| Path | What it is |
|---|---|
| `index.js` | Bot entry point. Loads `commands/`, `interactions/`, `events/` and starts the dashboard. |
| `core/`, `utils/`, `handlers/`, `jobs/` | Feature managers, shared helpers, background jobs. |
| `dashboard/` | Express + EJS dashboard and public site (`dashboard/server.js`). |
| `services/certifried-bot/` | Twitch and Kick stream bot. |
| `services/cfx/`, `frontend/greenhouse/` | Greenhouse Tycoon game server and Twitch extension front end. |
| `desktop/studio/` | CertiFried Studio, the Electron desktop companion. |
| `windrose-agent/`, `stream-relay/`, `cinema/`, `cf-jellyfin/` | Smaller services that run beside the bot. |
| `migrations/` | Database migrations. |
| `tests/` | Tests (`node --test`). |

## Running your own copy

This is the code that runs the hosted bot, so it assumes a similar setup. Expect to read some code
along the way; a fresh install is not a one-command job yet.

You need:

- Node.js 22 and npm
- MySQL or MariaDB
- Redis
- A Discord application with a bot token (Server Members and Message Content intents enabled)
- Optional, per feature: `yt-dlp` and ffmpeg for music, Chrome/Chromium for a few scrapers,
  Piper for text-to-speech, and API keys for the platforms you want (Twitch, YouTube, Kick, and so on)

Steps, roughly:

1. `git clone https://github.com/xXDeath420Xx/LiveBot.git && cd LiveBot && npm ci`
2. Copy `.env.example` to `.env` and fill in the database, Redis and Discord settings. Every other
   integration is optional and stays off until its keys are set.
3. Create the database, then apply the migrations in `migrations/` in numeric order.
   `npm run migrate` lists the ones not yet recorded; `npm run migrate -- <file>` runs one.
4. Register the slash commands with `node deploy-commands.js`.
5. Start the bot with `npm start` (or with pm2, see `ecosystem.config.cjs`). The dashboard starts with it.

Studio is built separately: `cd desktop/studio && npm ci && npm test && npm run build` (Windows).

## Tests

```
npm ci
node --test --test-force-exit $(grep -v '^#' tests/ci-list.txt)
```

`tests/ci-list.txt` lists the tests that run without a database or Discord; CI runs exactly those.
The full suite (`npm test`) expects a configured MySQL database.

## Contributing

Issues and pull requests are welcome. Please:

- target the `dev` branch and keep each pull request to one change;
- add or update a test when you change behaviour, and make sure CI passes;
- never commit secrets, `.env` files, database dumps or anything containing members' data.
  CI runs a secret scan and fails on findings.

For larger changes, open an issue or ask in the support server first so we can agree on the approach.

## Licence

CertiFried is licensed under the GNU Affero General Public License v3.0 or later
(AGPL-3.0-or-later); see [LICENSE](LICENSE). In the spirit of [DBAD.md](DBAD.md).

The AGPL is the GPL plus one clause for network software: if you run a modified CertiFried as a
service that other people use (a public bot, a hosted dashboard), you must offer those users the
source code of your modified version. Running it unmodified, or only for yourself, needs nothing extra.

Some parts come from other projects and keep their own licences. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Two games were written independently of the projects that inspired them: see
[LICENSE-OWO-NOTICE.md](LICENSE-OWO-NOTICE.md) and [LICENSE-CATBOT-NOTICE.md](LICENSE-CATBOT-NOTICE.md).
