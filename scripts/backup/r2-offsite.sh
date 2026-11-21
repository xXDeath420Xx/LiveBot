#!/bin/bash
# Nightly off-site copy of CertiFried's backup to Cloudflare R2.
#
# Streams the same three archives the workstation backup pulls (scripts/backup/remote.sh modes `db`, `files` and
# `extras`) straight into the R2 bucket, so nothing large is written to this server's disk. Each run writes one folder:
#   r2:<bucket>/backups/<UTC YYYY-MM-DD_HHMM>/db.sql.gz      gzip of mysqldump --single-transaction
#   r2:<bucket>/backups/<UTC YYYY-MM-DD_HHMM>/files.tar.gz   gzip tar of the file set (remote.sh FILESET)
#   r2:<bucket>/backups/<UTC YYYY-MM-DD_HHMM>/extras.tar.gz  YourMafia DBs, /var/vmail, newest mongodump (staged by
#                                                            root's offsite-stage.timer, 09:20 UTC) + Windrose saves
#   r2:<bucket>/backups/<UTC YYYY-MM-DD_HHMM>/manifest.json  sizes, SHA-256, table count, git HEAD, timestamps
# manifest.json is written last, only after all archives are uploaded, their sizes checked with
# `rclone lsjson` and all read back in full with a matching SHA-256, so a night folder is COMPLETE exactly
# when it has manifest.json.
#
# Retention: after a fully verified run, every night folder except the 2 newest complete ones is deleted
# (keeps the bucket inside R2's free tier). A failed run deletes its own partial folder, deletes nothing else
# and sends the owner a Discord DM (remote.sh notify). The bucket also has a lifecycle rule on backups/
# (delete after 3 days) as a backstop.
#
# Credentials: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET are read from the repo .env
# by a small parser (the .env is never sourced). They reach rclone only as environment variables of the rclone
# process (RCLONE_CONFIG_R2_*): never argv, never a config file, never the log. If they are not set yet the run
# logs "R2 keys not set yet; skipping" and exits 0.
#
# Schedule: death's crontab, 0 10 * * * (UTC). Log: logs/r2-offsite.log (rotated at 1 MB, 3 old files kept).
# Run by hand: scripts/backup/r2-offsite.sh   (prints to the terminal as well as the log)
#
# TEST-ONLY environment variables (never set these in cron):
#   R2_OFFSITE_TEST_DIR=/abs/dir     use a local rclone remote (RCLONE_CONFIG_R2_TYPE=local) rooted at this
#                                    directory instead of R2; the "bucket" is <dir>/<R2_BUCKET>
#   R2_OFFSITE_ENV_FILE=/abs/file    read the R2_* keys from this file instead of the repo .env (TEST_DIR only)
#   R2_OFFSITE_TEST_BREAK=db|files|extras   pass remote.sh an invalid mode for that step, to test the failure path
#                                    (TEST_DIR only)
#   R2_OFFSITE_NO_NOTIFY=1           log the failure DM instead of sending it
set -uo pipefail
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin
export LC_ALL=C

VERSION=1.1.0
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
REMOTE_SH="$HERE/remote.sh"
LOG_DIR="$REPO/logs"
LOG="$LOG_DIR/r2-offsite.log"
LOCK="$LOG_DIR/.r2-offsite.lock"
KEEP=2                 # complete nights kept in R2
LOG_MAX=1048576        # rotate the log above this many bytes
LOG_KEEP=3             # rotated logs kept (.1 .. .3)
MIN_DB_BYTES=1048576   # sanity floor: a real dump is ~180 MB compressed
MIN_FILES_BYTES=10485760
MIN_EXTRAS_BYTES=1048576 # staged DBs + Windrose saves are ~100 MB

TEST_DIR="${R2_OFFSITE_TEST_DIR:-}"
ENV_FILE="$REPO/.env"
BREAK=""
if [ -n "$TEST_DIR" ]; then
  case "$TEST_DIR" in /*) ;; *) echo "r2-offsite: R2_OFFSITE_TEST_DIR must be an absolute path" >&2; exit 2 ;; esac
  ENV_FILE="${R2_OFFSITE_ENV_FILE:-$ENV_FILE}"
  BREAK="${R2_OFFSITE_TEST_BREAK:-}"
fi
NO_NOTIFY="${R2_OFFSITE_NO_NOTIFY:-}"

mkdir -p "$LOG_DIR"

# ---------------------------------------------------------------- lock, log
exec 9>"$LOCK"
LOCKED=0
flock -n 9 && LOCKED=1

if [ "$LOCKED" = 1 ] && [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt "$LOG_MAX" ]; then
  i=$LOG_KEEP
  rm -f "$LOG.$i"
  while [ "$i" -gt 1 ]; do
    [ -f "$LOG.$((i - 1))" ] && mv -f "$LOG.$((i - 1))" "$LOG.$i"
    i=$((i - 1))
  done
  mv -f "$LOG" "$LOG.1"
fi
if [ -t 1 ]; then exec > >(tee -a "$LOG") 2>&1; else exec >>"$LOG" 2>&1; fi

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

notify() {
  local msg="$1"
  if [ -n "$NO_NOTIFY" ]; then log "notification suppressed (R2_OFFSITE_NO_NOTIFY): $msg"; return 0; fi
  if bash "$REMOTE_SH" notify "$(printf '%s' "$msg" | base64 -w0)" >/dev/null 2>&1; then
    log "owner notified by Discord DM"
  else
    log "WARNING: the Discord DM to the owner could not be sent"
  fi
}

if [ "$LOCKED" != 1 ]; then
  log "another r2-offsite run is still going; skipping this one"
  notify "CertiFried off-site backup (Cloudflare R2): tonight's copy was skipped because the previous run was still going. Nothing was deleted. Check logs/r2-offsite.log on the server."
  exit 1
fi

# ---------------------------------------------------------------- helpers (python, no secrets in argv)
# PY_R2 modes:
#   check  ENVFILE                     -> "ok <bucket>" (exit 0) | "missing <names>" (4) | "malformed <names>" (5)
#   rclone ENVFILE TESTDIR ARGS...     -> exec rclone ARGS with the r2 remote defined in rclone's environment only
read -r -d '' PY_R2 <<'PY'
import os, re, sys
WANT = ('R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET')
def load(path):
    v = {}
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            m = re.match(r'^\s*(R2_[A-Z_]+)\s*=\s*(.*?)\s*$', line)
            if m and m.group(1) in WANT:
                val = m.group(2)
                if len(val) >= 2 and val[0] == val[-1] and val[0] in '"\'':
                    val = val[1:-1]
                if val:
                    v[m.group(1)] = val
    return v
mode, envfile = sys.argv[1], sys.argv[2]
try:
    v = load(envfile)
except OSError as e:
    sys.stderr.write('r2-offsite: cannot read the env file (%s)\n' % e.__class__.__name__)
    sys.exit(3)
if mode == 'check':
    missing = [k for k in WANT if k not in v]
    if missing:
        print('missing ' + ' '.join(missing)); sys.exit(4)
    bad = []
    if not re.fullmatch(r'[0-9A-Fa-f]{32}', v['R2_ACCOUNT_ID']): bad.append('R2_ACCOUNT_ID')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', v['R2_BUCKET']): bad.append('R2_BUCKET')
    for k in ('R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'):
        if re.search(r'\s', v[k]): bad.append(k)
    if bad:
        print('malformed ' + ' '.join(bad)); sys.exit(5)
    print('ok ' + v['R2_BUCKET']); sys.exit(0)
if mode == 'rclone':
    test_dir, args = sys.argv[3], sys.argv[4:]
    p = 'RCLONE_CONFIG_R2_'
    env = {k: x for k, x in os.environ.items() if not k.startswith(p)}
    if test_dir:
        env[p + 'TYPE'] = 'local'
    else:
        env[p + 'TYPE'] = 's3'
        env[p + 'PROVIDER'] = 'Cloudflare'
        env[p + 'REGION'] = 'auto'
        env[p + 'ENDPOINT'] = 'https://%s.r2.cloudflarestorage.com' % v.get('R2_ACCOUNT_ID', '')
        env[p + 'ACL'] = 'private'
        env[p + 'NO_CHECK_BUCKET'] = 'true'
        # rclone 1.60 HEADs each object after upload with ?versionId=..., which R2 answers 501. no_head skips
        # that HEAD for known-size uploads (manifest.json, purge, ...); streamed rcat still does it (see stream()).
        env[p + 'NO_HEAD'] = 'true'
        env[p + 'CHUNK_SIZE'] = '16M'          # rcat streams in 16 MiB parts: ~220 parts for 3.4 GB
        env[p + 'UPLOAD_CONCURRENCY'] = '4'
    env[p + 'ACCESS_KEY_ID'] = v.get('R2_ACCESS_KEY_ID', '')
    env[p + 'SECRET_ACCESS_KEY'] = v.get('R2_SECRET_ACCESS_KEY', '')
    os.execvpe('rclone', ['rclone'] + args, env)
sys.exit(2)
PY

# Pass-through hasher: stdin -> stdout unchanged; at EOF writes "<bytes> <sha256>" to argv[1].
read -r -d '' PY_HASH <<'PY'
import hashlib, sys
h, n = hashlib.sha256(), 0
i, o = sys.stdin.buffer, sys.stdout.buffer
while True:
    b = i.read(1 << 20)
    if not b:
        break
    h.update(b); n += len(b); o.write(b)
o.flush()
with open(sys.argv[1], 'w') as f:
    f.write('%d %s\n' % (n, h.hexdigest()))
PY

# lsjson verifier: stdin = rclone lsjson of the night folder; args NAME=BYTES ... ; exit 1 on any mismatch.
read -r -d '' PY_VERIFY <<'PY'
import json, sys
got = {e['Name']: e.get('Size') for e in json.load(sys.stdin) if not e.get('IsDir')}
ok = True
for a in sys.argv[1:]:
    name, want = a.split('=', 1)
    if name not in got:
        print('verify: %s is missing' % name); ok = False
    elif want != '*' and got[name] != int(want):
        print('verify: %s is %s bytes, streamed %s' % (name, got[name], want)); ok = False
    else:
        print('verify: %s ok (%s bytes)' % (name, got[name]))
sys.exit(0 if ok else 1)
PY

# Prune planner: stdin = `rclone lsf -R --max-depth 2` of backups/; argv[1] = KEEP, argv[2] = this run's night.
# Prints "keep <night>" / "delete <night>" / "ignore <entry>"; exit 3 if this run's night would not be kept.
read -r -d '' PY_PRUNE <<'PY'
import re, sys
keep_n, current = int(sys.argv[1]), sys.argv[2]
night_re = re.compile(r'^\d{4}-\d{2}-\d{2}_\d{4}$')
nights, complete = set(), set()
for line in sys.stdin.read().splitlines():
    top = line.split('/', 1)[0]
    if not top:
        continue
    if not night_re.match(top):
        print('ignore ' + top); continue
    nights.add(top)
    if line == top + '/manifest.json':
        complete.add(top)
keep = sorted(complete, reverse=True)[:keep_n]
if current not in keep:
    print('error: this run (%s) is not among the %d newest complete nights %s; not pruning' % (current, keep_n, keep))
    sys.exit(3)
for n in sorted(nights, reverse=True):
    print(('keep ' if n in keep else 'delete ') + n)
PY

rcl() { python3 -c "$PY_R2" rclone "$ENV_FILE" "$TEST_DIR" "$@"; }

# ---------------------------------------------------------------- keys
CHECK=$(python3 -c "$PY_R2" check "$ENV_FILE")
case $? in
  0) BUCKET=${CHECK#ok } ;;
  4) log "R2 keys not set yet; skipping (${CHECK#missing } not in .env)"; exit 0 ;;
  5) log "R2 settings in .env look wrong (${CHECK#malformed }); not running"
     notify "CertiFried off-site backup (Cloudflare R2) did not run: the R2 settings in the server's .env look wrong (${CHECK#malformed }). Nothing was uploaded or deleted. Fix them on the dashboard's Service keys page."
     exit 1 ;;
  *) log "could not read the R2 settings from .env; not running"
     notify "CertiFried off-site backup (Cloudflare R2) did not run: the server could not read its .env. Nothing was uploaded or deleted."
     exit 1 ;;
esac

if [ -n "$TEST_DIR" ]; then ROOT="r2:$TEST_DIR/$BUCKET"; else ROOT="r2:$BUCKET"; fi
NIGHT=$(date -u +%Y-%m-%d_%H%M)
DEST="$ROOT/backups/$NIGHT"
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
SECONDS=0
WORK=$(mktemp -d /dev/shm/r2off.XXXXXX)
WROTE=0      # 1 once anything may exist under DEST (a failure then removes the folder)
DONE=0

cleanup() { rm -rf "$WORK"; }
fail() {
  local reason="$1"
  log "FAILED: $reason"
  if [ "$WROTE" = 1 ]; then
    if rcl purge "$DEST" 2>&1 | sed 's/^/  rclone: /'; then :; fi
    if [ -n "$(rcl lsf "$DEST" 2>/dev/null)" ]; then
      log "WARNING: the partial folder backups/$NIGHT could not be removed"
    else
      log "partial folder backups/$NIGHT removed"
    fi
    [ -z "$TEST_DIR" ] && rcl cleanup "$ROOT" >/dev/null 2>&1   # abort leftover multipart uploads (best effort)
  fi
  log "nothing was pruned; older copies are untouched"
  notify "CertiFried off-site backup (Cloudflare R2) failed tonight ($NIGHT UTC): $reason. The partial upload was removed and no older copy was deleted. Note: R2 deletes copies older than 3 days, so if this keeps failing there will soon be no off-site copy. Details: logs/r2-offsite.log on the server."
  log "===== r2-offsite $NIGHT end: FAILED after ${SECONDS}s ====="
  DONE=1
  cleanup
  exit 1
}
# shellcheck disable=SC2329  # invoked by the trap below
on_signal() { [ "$DONE" = 1 ] && exit 1; fail "the run was interrupted"; }
trap cleanup EXIT
trap on_signal INT TERM HUP

log "===== r2-offsite $NIGHT start (tool $VERSION$([ -n "$TEST_DIR" ] && echo ", TEST MODE local remote")) ====="

# A folder for this minute must not exist yet (never overwrite or remove someone else's copy).
if [ -n "$(rcl lsf "$DEST" 2>/dev/null)" ]; then
  fail "a folder for $NIGHT already exists in the bucket"
fi

# ---------------------------------------------------------------- stream one archive
# stream NAME MODE: remote.sh MODE | hasher | rclone rcat DEST/NAME, at low CPU and IO priority.
stream() {
  local name=$1 mode=$2 st
  [ -n "$BREAK" ] && [ "$BREAK" = "${name%%.*}" ] && mode="broken-on-purpose"
  WROTE=1
  ( cd / && nice -n 10 ionice -c2 -n7 bash "$REMOTE_SH" "$mode" ) 2>"$WORK/$name.err" \
    | nice -n 10 ionice -c2 -n7 python3 -c "$PY_HASH" "$WORK/$name.stats" \
    | nice -n 10 python3 -c "$PY_R2" rclone "$ENV_FILE" "$TEST_DIR" rcat "$DEST/$name" 2>"$WORK/$name.rclone"
  st=("${PIPESTATUS[@]}")
  tail -n 5 "$WORK/$name.err" | sed "s/^/  remote.sh $mode: /"
  sed "s/^/  rclone: /" "$WORK/$name.rclone"
  # rclone 1.60 always HEADs a streamed (unknown-size) upload with ?versionId=..., even with no_head, and R2
  # answers 501 Not Implemented, so rcat exits 1 although the object is complete. Accept exactly that case
  # (R2 only, every error line is that 501) and rely on the size check and full SHA-256 re-read in step 4.
  if [ -z "$TEST_DIR" ] && [ "${st[2]}" = 1 ] && grep -q 'status code: 501' "$WORK/$name.rclone" \
     && ! grep -E 'ERROR|Failed|status code' "$WORK/$name.rclone" | grep -qvE 'NotImplemented|status code: 501'; then
    log "$name: rclone reported R2's known 501 on its post-upload HEAD; checking the object by size and SHA-256 instead"
    st[2]=0
  fi
  if [ "${st[0]}" != 0 ] || [ "${st[1]}" != 0 ] || [ "${st[2]}" != 0 ]; then
    log "$name: exit codes remote.sh=${st[0]} hasher=${st[1]} rclone=${st[2]}"
    return 1
  fi
  [ -s "$WORK/$name.stats" ] || { log "$name: no byte count recorded"; return 1; }
  return 0
}

# ---------------------------------------------------------------- 1. table count, git state
TABLES_BEFORE=$(bash "$REMOTE_SH" tablecount 2>"$WORK/tc.err") || { sed 's/^/  /' "$WORK/tc.err"; fail "could not read the database table count"; }
[[ "$TABLES_BEFORE" =~ ^[0-9]+$ ]] || fail "the database table count was not a number"
GIT_HEAD=$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)
GIT_HEAD_DATE=$(git -C "$REPO" log -1 --format=%cI 2>/dev/null || echo unknown)
log "database has $TABLES_BEFORE tables; git HEAD $GIT_HEAD"

# ---------------------------------------------------------------- 2. database
t=$SECONDS
stream db.sql.gz db || fail "the database dump or its upload failed"
DB_SECONDS=$((SECONDS - t))
read -r DB_BYTES DB_SHA < "$WORK/db.sql.gz.stats"
log "db.sql.gz: $DB_BYTES bytes in ${DB_SECONDS}s, sha256 $DB_SHA"
[ "$DB_BYTES" -ge "$MIN_DB_BYTES" ] || fail "the database dump was far too small ($DB_BYTES bytes)"
TABLES_AFTER=$(bash "$REMOTE_SH" tablecount 2>/dev/null || echo "")
[[ "$TABLES_AFTER" =~ ^[0-9]+$ ]] || TABLES_AFTER=""
[ "$TABLES_AFTER" = "$TABLES_BEFORE" ] || log "note: table count changed during the dump ($TABLES_BEFORE -> ${TABLES_AFTER:-unknown})"

# ---------------------------------------------------------------- 3. files
t=$SECONDS
stream files.tar.gz files || fail "the files archive or its upload failed"
FILES_SECONDS=$((SECONDS - t))
read -r FILES_BYTES FILES_SHA < "$WORK/files.tar.gz.stats"
log "files.tar.gz: $FILES_BYTES bytes in ${FILES_SECONDS}s, sha256 $FILES_SHA"
[ "$FILES_BYTES" -ge "$MIN_FILES_BYTES" ] || fail "the files archive was far too small ($FILES_BYTES bytes)"

# ---------------------------------------------------------------- 3b. extras (YourMafia DBs, mail, mongodump, Windrose saves)
t=$SECONDS
stream extras.tar.gz extras || fail "the extras archive (YourMafia DBs, mail, MongoDB, Windrose saves) or its upload failed"
EXTRAS_SECONDS=$((SECONDS - t))
read -r EXTRAS_BYTES EXTRAS_SHA < "$WORK/extras.tar.gz.stats"
log "extras.tar.gz: $EXTRAS_BYTES bytes in ${EXTRAS_SECONDS}s, sha256 $EXTRAS_SHA"
[ "$EXTRAS_BYTES" -ge "$MIN_EXTRAS_BYTES" ] || fail "the extras archive was far too small ($EXTRAS_BYTES bytes)"

# ---------------------------------------------------------------- 4. verify the objects
if ! rcl lsjson "$DEST" 2>"$WORK/ls.err" | python3 -c "$PY_VERIFY" "db.sql.gz=$DB_BYTES" "files.tar.gz=$FILES_BYTES" "extras.tar.gz=$EXTRAS_BYTES"; then
  sed 's/^/  rclone: /' "$WORK/ls.err"
  fail "the uploaded archives could not be verified in the bucket"
fi
# Read every object back from the bucket and compare SHA-256 with what was streamed (R2 egress is free).
for pair in "db.sql.gz:$DB_SHA" "files.tar.gz:$FILES_SHA" "extras.tar.gz:$EXTRAS_SHA"; do
  name=${pair%%:*}; want=${pair#*:}; t=$SECONDS
  rcl cat "$DEST/$name" 2>"$WORK/cat.err" | nice -n 10 python3 -c "$PY_HASH" "$WORK/$name.reread" >/dev/null
  st=("${PIPESTATUS[@]}")
  sed 's/^/  rclone: /' "$WORK/cat.err"
  read -r rb rsha < "$WORK/$name.reread" 2>/dev/null || { rb=""; rsha=""; }
  if [ "${st[0]}" != 0 ] || [ "${st[1]}" != 0 ] || [ "$rsha" != "$want" ]; then
    log "verify: $name read back ${rb:-?} bytes, sha256 ${rsha:-?} (exit codes rclone=${st[0]} hasher=${st[1]})"
    fail "$name in the bucket does not match what was uploaded"
  fi
  log "verify: $name read back from the bucket, sha256 matches ($((SECONDS - t))s)"
done

# ---------------------------------------------------------------- 5. manifest (written last: marks the night complete)
FINISHED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
python3 - "$WORK/manifest.json" <<PY || fail "could not build manifest.json"
import json, socket, sys
m = {
    'kind': 'certifried-r2-offsite',
    'tool_version': '$VERSION',
    'night': '$NIGHT',
    'started_utc': '$STARTED',
    'finished_utc': '$FINISHED',
    'host': socket.gethostname(),
    'database': {'file': 'db.sql.gz', 'bytes': $DB_BYTES, 'sha256': '$DB_SHA', 'seconds': $DB_SECONDS,
                 'table_count': $TABLES_BEFORE, 'table_count_after_dump': ${TABLES_AFTER:-None}},
    'files': {'file': 'files.tar.gz', 'bytes': $FILES_BYTES, 'sha256': '$FILES_SHA', 'seconds': $FILES_SECONDS},
    'extras': {'file': 'extras.tar.gz', 'bytes': $EXTRAS_BYTES, 'sha256': '$EXTRAS_SHA', 'seconds': $EXTRAS_SECONDS,
               'contents': 'offsite-stage/ (YourMafia DBs, vmail.tar.gz, mongodb-kbd.archive.gz, manifest.txt) + windrose/ (R5/Saved, compose files)'},
    'git_head': '$GIT_HEAD',
    'git_head_date': '$GIT_HEAD_DATE',
    'status': 'VERIFIED',
    'verification': 'all three archives streamed without error; their sizes in the bucket equal the streamed byte counts and a full read-back from the bucket has the same SHA-256',
}
open(sys.argv[1], 'w').write(json.dumps(m, indent=2) + '\n')
PY
MANIFEST_BYTES=$(stat -c %s "$WORK/manifest.json")
rcl rcat "$DEST/manifest.json" < "$WORK/manifest.json" 2>&1 | sed 's/^/  rclone: /'
[ "${PIPESTATUS[0]}" = 0 ] || fail "manifest.json could not be uploaded"
if ! rcl lsjson "$DEST" 2>"$WORK/ls.err" | python3 -c "$PY_VERIFY" "db.sql.gz=$DB_BYTES" "files.tar.gz=$FILES_BYTES" "extras.tar.gz=$EXTRAS_BYTES" "manifest.json=$MANIFEST_BYTES"; then
  sed 's/^/  rclone: /' "$WORK/ls.err"
  fail "manifest.json could not be verified in the bucket"
fi
WROTE=0   # the night is complete; from here on a problem must not remove it
log "backups/$NIGHT complete and verified"

# ---------------------------------------------------------------- 6. prune (only after a fully verified run)
if ! LISTING=$(rcl lsf -R --max-depth 2 "$ROOT/backups/" 2>"$WORK/ls.err"); then
  sed 's/^/  rclone: /' "$WORK/ls.err"
  log "WARNING: could not list backups/ to prune; nothing deleted"
  notify "CertiFried off-site backup (Cloudflare R2): tonight's copy ($NIGHT UTC) is safely uploaded, but old copies could not be listed for clean-up. Nothing was deleted."
  log "===== r2-offsite $NIGHT end: OK (prune skipped) after ${SECONDS}s ====="
  DONE=1; exit 0
fi
PLAN=$(printf '%s\n' "$LISTING" | python3 -c "$PY_PRUNE" "$KEEP" "$NIGHT")
PLAN_RC=$?
printf '%s\n' "$PLAN" | sed 's/^/  prune: /'
PRUNE_FAILED=0
if [ "$PLAN_RC" = 0 ]; then
  while read -r action n; do
    [ "$action" = delete ] || continue
    [[ "$n" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}$ ]] || continue
    [ "$n" = "$NIGHT" ] && continue
    if rcl purge "$ROOT/backups/$n" 2>"$WORK/purge.err"; then
      log "pruned backups/$n"
    else
      sed 's/^/  rclone: /' "$WORK/purge.err"; log "WARNING: could not delete backups/$n"; PRUNE_FAILED=1
    fi
  done <<< "$PLAN"
else
  log "WARNING: prune plan refused (see above); nothing deleted"
  PRUNE_FAILED=1
fi
[ "$PRUNE_FAILED" = 1 ] && notify "CertiFried off-site backup (Cloudflare R2): tonight's copy ($NIGHT UTC) is safely uploaded, but clearing out old copies did not fully work, so the bucket may hold more than $KEEP nights. Details: logs/r2-offsite.log on the server."

log "===== r2-offsite $NIGHT end: OK after ${SECONDS}s (db $DB_BYTES bytes, files $FILES_BYTES bytes, extras $EXTRAS_BYTES bytes) ====="
DONE=1
exit 0
