# Backups

CertiFried's server is backed up every night to a machine off the server, the owner's workstation.
The workstation pulls the backup over SSH. A second copy goes to Cloudflare R2 every night (see below); the server
streams it there and keeps no copy on its own disk.

## What is backed up

- **Database**: a full `mysqldump` of the bot's MariaDB database (all tables), taken with
  `--single-transaction` so the live bot is never locked out. Every table is InnoDB, so the dump is one
  consistent snapshot.
- **Files**: the bot's working tree without `node_modules`, `.git`, logs and scratch folders. That covers
  the code, local configuration, uploaded files (`dashboard/public/uploads`), `data/`, the ebook files,
  models and the custom TTS voice, plus the stream bot's sound and overlay media, the pm2 process list and
  the crontab.
- **Left out on purpose**: `node_modules` (`npm ci` rebuilds it), git history, logs, the server's own
  `backups/` folder, stock Piper voices (they can be downloaded again) and Studio installer builds (they can be rebuilt).

## Schedule and retention

- Runs daily at 04:00 workstation time. The GitHub publish job runs at 04:30 UTC on the server and does not overlap.
- Both archives are streamed straight to the workstation, so nothing large is written on the server.
- Each run is checked before it counts:
  - both archives decompress completely;
  - the dump ends with mysqldump's completion marker;
  - the dump holds as many tables as the live database;
  - the file archive lists cleanly and contains the key files.
- If any check fails, the run is marked failed and the owner gets a Discord DM.
- The newest 7 verified daily backups are kept. Older ones are deleted only after the new one has passed its
  checks, so a failed night never removes a good backup.
- The archives contain configuration secrets and member data. The backup folder on the workstation can be read
  only by the owner's account and the system.

## Off-site copy in Cloudflare R2

- `scripts/backup/r2-offsite.sh` runs on the server at 10:00 UTC from cron. It streams the same two archives
  (`scripts/backup/remote.sh`, a copy of the helper the workstation uses) into a private R2 bucket, under
  `backups/<UTC date_time>/`: `db.sql.gz`, `files.tar.gz` and `manifest.json` (sizes, SHA-256, table count, git HEAD).
- Nothing large touches the server's disk, and the dump runs at low CPU and disk priority.
- After both uploads, their sizes in the bucket are checked against the bytes streamed and both are read back in
  full to compare SHA-256. `manifest.json` is written only after that, so a night counts as complete only when it
  has one.
- Only the 2 newest complete nights are kept, which stays inside R2's free storage. Older nights are deleted only
  after a complete, checked upload. A failed run removes its own partial upload, deletes nothing else and sends the
  owner a Discord DM. As a backstop, the bucket also deletes anything under `backups/` after 3 days.
- The R2 keys live in the server's `.env` and are set from the dashboard (Super-admin, Service keys). The script
  reads them with a small parser and hands them to `rclone` only through its environment, never on a command line,
  in a config file or in the log. Until the keys are set, each run logs that and stops.
- Log: `logs/r2-offsite.log` on the server (rotated at about 1 MB, 3 old files kept).

## Restoring

A restore guide is kept next to the backups on the workstation. It covers downloading a night from R2, loading the whole database or a
single table, extracting single files, and rebuilding on a fresh server. A single-table test restore was done
when the backups were set up (2026-11-19): row count and table checksum matched the live table.

The weekly on-server dump (`scripts/db-backup.sh`, Sundays 03:00, last 4 kept in `backups/`) still runs and is
separate from this: it protects against mistakes, not against losing the server.
