# AGENTS.md: how changes reach CertiFried production

Read this before you change, restart or deploy anything in `/home/death/CertiFriedUtility`.
It applies to every agent and every human working on the server `server.certifriedmultitool.com`.

## The rule

**Every change is committed, tested on staging, then deployed.** Production runs from this
working copy, so "deployed" means: the commit is in Forgejo, CI is green, staging passed its
smoke checks, and `scripts/deploy.sh promote` restarted the affected apps in a quiet window.

Never restart production apps by hand to "try" a change. Never kill processes by name.

## Where things are

| What | Where |
| --- | --- |
| Production working copy | `/home/death/CertiFriedUtility` (branch `main`) |
| Private git (internal history) | Forgejo `http://127.0.0.1:3300/certifried/CertiFriedUtility` (`https://git.certifriedmultitool.com` for the owner) |
| CI | Forgejo Actions, `.forgejo/workflows/ci.yml` (secret gate, `npm ci`, syntax check, `tests/ci-list.txt`), rootless-docker runner, 4 CPUs max |
| Staging | `/srv/staging/certifried`, user `cfstaging`, units `cf-staging-{bot,greenhouse,relay}`, dashboard `127.0.0.1:13001`, `https://staging.certifriedmultitool.com` (basic auth) |
| Deploy tool | `scripts/deploy.sh` |
| Deploy log | `/home/death/cf-deploy/logs/deploy.log` |
| Coordination locks | `/home/death/migration/state/LOCK.*` |

## The workflow

```sh
cd /home/death/CertiFriedUtility
# 1. edit; run the tests that cover your change locally (see "Tests" below)
# 2. commit YOUR files only, push, wait for CI, deploy to staging, smoke-check:
scripts/deploy.sh ship -m "what and why" path/to/file1 path/to/file2
# 3. when it says "ready to promote", and only then:
scripts/deploy.sh promote            # waits for a quiet window, tags prod-YYYYMMDD-HHMMSS, restarts what changed
# if production misbehaves after a promote:
scripts/deploy.sh rollback           # back to the previous prod-* tag at once
scripts/deploy.sh status             # where production, HEAD, CI and staging are
```

- `ship` runs the internal secret gate (`scripts/internal-git/scan-check.sh`) **before** committing.
  A new finding stops it. Review it; if it is not a secret, add its `file rule` line to
  `scripts/internal-git/scan-baseline.txt` in the same commit and say why in the message.
- Commit only your own files. Other agents work in the same tree at the same time;
  `ship --all` is only for when every change in the tree is yours.
- `promote` refuses unless: the working copy HEAD is the commit, no tracked file has uncommitted
  changes, CI is green for it, staging passed it, and no other agent holds a `LOCK.*` file.
  It creates `state/LOCK.prod-switch` while it works and waits for the quiet window
  (`need_quiet && cf_quiet`: the owner is not live).
- `promote` restarts only the affected apps (main bot, greenhouse-tycoon, certifried-stream,
  cf-jellyfin-fed), runs `npm ci` first when a `package-lock.json` changed, then waits for
  `/api/health`: healthy, main bot + all custom bots connected (44 bots), DB ok.
- `rollback` writes a forward commit on `main` that restores the previous tag's tree, restarts,
  tags it `prod-...-rollback` and waits for health. Fix forward afterwards with a normal `ship`.

## Hard rules

- **Never push to GitHub from this working copy.** Its `.git` is internal (Forgejo only; a pre-push
  hook refuses any other remote). The public repo `xXDeath420Xx/LiveBot` is updated only by
  `scripts/publish-github.sh` from its separate publish clone, with its own scan. The pre-2026-11-21
  `.git` (unpurged history) is archived at `/home/death/git-archive/` and must never be pushed anywhere.
- Never commit `.env`, data, dumps, transcripts, member data. `.gitignore` plus
  `scripts/internal-git/exclude.txt` (installed as `.git/info/exclude`) keep them out.
- Staging must never reach Discord, Twitch, Kick, payment APIs or mail. It runs with
  `CF_OFFLINE_MODE=1`, a token-free `.env`, fresh encryption keys and a scrubbed DB copy,
  and an nft egress guard for uid `cfstaging` allows only MariaDB, DNS and its own ports.
  Do not add tokens to staging; a separate test bot would be the owner's decision.
- Use `127.0.0.1`, never `localhost`. Use they/them for people. Never touch CannaFriend code.

## Production processes

The CertiFried apps run under pm2 as the dedicated user `certifried` (no sudo, no login shell,
`PM2_HOME=/var/lib/certifried/.pm2`). `death` is the admin and deploy user; death does not run the bot.
To look at or restart them use the wrapper (it is what `deploy.sh` uses):

```sh
sudo -n -u certifried /usr/local/bin/cf-pm2 ls
sudo -n -u certifried /usr/local/bin/cf-pm2 logs CertiFriedUtility --lines 50 --nostream
```

Restarts outside `deploy.sh` are for emergencies only, and only after the quiet-window check.
Code stays owned by death (group `certifried` reads it). The app writes only its runtime paths
(`logs/`, `data/`, `uploads/`, `temp_audio/`, `transcripts/`, `backups/`, `dashboard/data/`,
`dashboard/public/api/`, `cf-jellyfin/`, `.secrets/`). `.env` is a symlink to `.secrets/.env`.

Staging: `sudo -n systemctl restart cf-staging.target` (allowed for death), logs in
`/srv/staging/certifried/logs/`. Refresh its DB from production with
`sudo -n /usr/local/sbin/cf-staging-db-refresh` (dump, scrub secrets, atomic swap).

## Tests

- CI runs the DB-free subset in `tests/ci-list.txt` under Node 22 on every push.
- Full suite: `npm test` needs a database; run it on staging (as death, with staging's env)
  in groups of files, not all at once. Tests that hang after passing usually hold a timer or a
  pool open; see the notes in `utils/db.js` (`NODE_TEST_CONTEXT`) before "fixing" with timeouts.
- Add a test to `tests/ci-list.txt` once it passes with no database reachable.
