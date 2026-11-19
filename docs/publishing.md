# Publishing to GitHub

CertiFried's source is public at <https://github.com/xXDeath420Xx/LiveBot> (default branch `dev`).
The live code runs from the working copy on server1, `/home/death/CertiFriedUtility`, and is
published from there with one script.

## When

After each release: once a batch of changes is deployed, pm2 has been restarted and the bot is
healthy. Don't publish in the middle of a deploy; the script copies whatever is on disk at that moment.

## How

```
cd /home/death/CertiFriedUtility
scripts/publish-github.sh            # dry run: sync, scan, commit in the publish clone, push --dry-run
git -C /home/death/certifried-publish/LiveBot show --stat HEAD   # look at what would go out
scripts/publish-github.sh --push     # the real thing
```

Options: `--scan-only` (sync and scan, no commit), `--message "text"` (adds a line to the commit body).
Exit codes: 0 done or nothing to publish, 1 setup problem, 3 scan findings, 4 push failed.

What the script does:

1. Resets the publish clone (`/home/death/certifried-publish/LiveBot`) to `origin/dev`, after
   checking that it is a clone of the rewritten history and contains nothing from the old one.
2. Lists the working copy's files with an empty, throwaway git index, honouring `.gitignore` and
   `.publishignore`. Then it drops node_modules, logs, backups, `.env*`, cookie and secret files,
   `*.bak*`, `*.orig`, databases, symlinks, and files over 20 MB (unless already tracked and under 100 MB).
3. Copies those files into the publish clone's worktree, replacing everything that was there, and stages them.
4. Scans every staged file with `scripts/publish/secret-scan.mjs` and gitleaks. Any finding stops the run
   and resets the clone. Only the file, line and rule are printed, never the value.
5. Commits on `dev` (as xXDeath420Xx) with a summary: changed areas, counts, versions, latest migration.
6. Pushes `dev`, fast-forward only. A dry run stops at `git push --dry-run`.

Each run is logged to `logs/publish-github.log` (paths, counts and rules only).

## Rules

- **Never push from the working copy's own `.git`.** It still holds the old, unpurged history
  (including a commit with live secrets). Don't commit, switch branches or touch the index there either;
  other sessions use it. All git work happens in the publish clone.
- **Never push from `/home/death/git-purge/LiveBot-orig.git`.** It is the untouched pre-purge backup.
- **The scan is mandatory.** There is no flag to skip it, and the clone's `pre-push` hook blocks env
  files, cookie jars, key material and database files on top of it.
- **Fix findings, don't allowlist them.** If a scan stops a publish:
  - a real secret in code: move it to `.env` and rotate it if it was ever public;
  - private data (member IDs, dumps, transcripts, screenshots, per-community state): add the path to `.publishignore`;
  - a false positive: add a scoped entry, with a reason, to `scripts/publish/secret-scan-allowlist.txt`
    (and `.gitleaks.toml` if gitleaks reported it). Exact `.env` values can't be allowlisted.
- Never force-push `dev`. If the push is rejected, someone pushed in between: run the script again.

## What is kept out of the public repo

`.gitignore` covers secrets, runtime data, backups, transcripts and evidence. `.publishignore` adds:
scratch and agent folders, backup copies, env-style config files, runtime data under `data/` and
`dashboard/data/`, audit outputs, per-community setup state and one-off scripts aimed at named members,
the private `dashboard/private/` pages, everything under `docs/` except this file, archives and build
artifacts, and artwork CertiFried may not redistribute (Digimon images, Fortnite sprite images).
See `THIRD_PARTY_NOTICES.md` for licences.

## CI

`.github/workflows/ci.yml` runs on pushes and pull requests to `dev` and `main`:

- **Secret scan**: the same scanner and gitleaks, on the checkout.
- **Bot and dashboard** (Node 22): `npm ci` (also in the side services, to prove their lockfiles),
  lint if a `lint` script exists, a syntax check of every `.js`/`.mjs`/`.cjs` file
  (`scripts/publish/syntax-check.mjs`), and the tests in `tests/ci-list.txt`, which need no MySQL,
  Redis or Discord.
- **Studio** (windows-latest): `npm ci`, syntax check and `npm test` in `desktop/studio`.

To add a test to CI, check it passes with no database reachable
(`node --test --test-force-exit tests/<name>.test.js` on a machine with no `.env`), then add it to
`tests/ci-list.txt`.

After changing dependencies, regenerate the dependency tables: `node scripts/publish/third-party-notices.mjs`.

## Daily automatic publish (proposed, not installed)

`scripts/publish/publish-cron.sh` runs the scan, copies the publishable tree to a scratch folder, runs
`npm ci`, the syntax check and the DB-free tests there under Node 22, and only then runs
`publish-github.sh --push`. If any step fails it pushes nothing and DMs the bot owner
(`scripts/publish/notify-owner.mjs`, using the bot token and `BOT_OWNER_ID` from `.env`).

To enable it, add this line with `crontab -e` as `death`:

```
30 4 * * * /home/death/CertiFriedUtility/scripts/publish/publish-cron.sh >> /home/death/CertiFriedUtility/logs/publish-cron.log 2>&1
```

04:30 UTC is outside the busy evening hours. Try it once by hand first with
`scripts/publish/publish-cron.sh --dry-run`. Note that a daily push publishes whatever is on disk,
including half-finished work from other sessions, as long as it passes the scan and the tests.
