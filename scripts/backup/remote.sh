#!/bin/bash
# CertiFried server backup helper (server.certifriedmultitool.com = the OVH Vint Hill server since 2026-11-20).
# Backup-CertiFried.ps1 sends this file over ssh on every run (bash -c "<script>" cfbackup MODE ...),
# so nothing is installed on the server and nothing large is written to the server's disk.
#
# SERVER COPY: scripts/backup/remote.sh in the repo is run on the server by scripts/backup/r2-offsite.sh (nightly R2 copy).
# The workstation backup tool keeps its own copy next to Backup-CertiFried.ps1 and sends that one over ssh.
# Keep the two in sync: apart from these four lines the files are byte-identical.
#
# Modes (all output goes to stdout, diagnostics to stderr):
#   meta              JSON: table count, engines, largest tables with exact row counts, git HEAD, Studio version
#   tablecount        number of base tables in the database (re-checked after the dump)
#   db                gzip stream of mysqldump --single-transaction (no table locks on InnoDB)
#   files             gzip stream of a tar of the file set (see FILESET below)
#   extras            gzip stream of a tar of the root-staged sets in /var/backups/offsite-stage (YourMafia DBs,
#                     /var/vmail, newest mongodump; refreshed daily 09:20 UTC by offsite-stage.timer, refused if
#                     older than 30 h) plus the Windrose saves (/srv/windrose/server-files/R5/Saved without logs)
#                     and the Windrose compose files
#   notify <b64msg>   Discord DM to the owner through scripts/publish/notify-owner.mjs
#   restoretest <table> <b64 of nothing>   load SQL from stdin into _restore_test_<table>, compare, drop
#
# Credentials: only DB_USER / DB_PASSWORD / DB_NAME are read from the repo .env by a small parser (the .env is
# never sourced), written to a 0600 option file on tmpfs (/dev/shm) and passed with --defaults-extra-file.
# The file is removed on exit. The password never appears in argv or on stdout/stderr.
set -euo pipefail
umask 077

MODE="${1:-}"
HOME_DIR=/home/death
REPO="$HOME_DIR/CertiFriedUtility"
DB_EXPECTED=cert_CertiFriedUtility
CNF=""
TMPD=""
cleanup() { [ -n "$CNF" ] && rm -f "$CNF"; [ -n "$TMPD" ] && rm -rf "$TMPD"; return 0; }
trap cleanup EXIT

make_cnf() {
  CNF=$(mktemp /dev/shm/cfbk.XXXXXX)
  python3 - "$CNF" "$REPO/.env" "$DB_EXPECTED" <<'PY'
import re, sys
cnf, envfile, expected = sys.argv[1], sys.argv[2], sys.argv[3]
want = {'DB_USER', 'DB_PASSWORD', 'DB_NAME'}
v = {}
with open(envfile, encoding='utf-8', errors='replace') as f:
    for line in f:
        m = re.match(r'^\s*(DB_[A-Z_]+)\s*=\s*(.*?)\s*$', line)
        if m and m.group(1) in want:
            val = m.group(2)
            if len(val) >= 2 and val[0] == val[-1] and val[0] in '"\'':
                val = val[1:-1]
            v[m.group(1)] = val
missing = sorted(want - set(v))
if missing:
    sys.stderr.write('cfbackup: .env is missing ' + ', '.join(missing) + '\n'); sys.exit(3)
if v['DB_NAME'] != expected:
    sys.stderr.write('cfbackup: DB_NAME in .env is not the expected database\n'); sys.exit(3)
BS = chr(92)
esc = lambda s: s.replace(BS, BS + BS).replace('"', BS + '"')
with open(cnf, 'w') as f:
    f.write('[client]\nhost=127.0.0.1\nuser="%s"\npassword="%s"\n' % (esc(v['DB_USER']), esc(v['DB_PASSWORD'])))
PY
}

case "$MODE" in
  meta)
    make_cnf
    CNF="$CNF" REPO="$REPO" DB="$DB_EXPECTED" python3 - <<'PY'
import json, os, subprocess
cnf, repo, db = os.environ['CNF'], os.environ['REPO'], os.environ['DB']
def q(sql):
    out = subprocess.run(['mysql', '--defaults-extra-file=' + cnf, '-N', '-B', '-e', sql, db],
                         check=True, capture_output=True, text=True).stdout
    return [l.split('\t') for l in out.splitlines() if l.strip()]
def sh(args):
    try: return subprocess.run(args, cwd=repo, capture_output=True, text=True, timeout=60).stdout.strip()
    except Exception: return ''
eng = q("SELECT IFNULL(ENGINE,'-'), TABLE_TYPE, COUNT(*), ROUND(SUM(DATA_LENGTH+INDEX_LENGTH)/1048576,1) "
        "FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() GROUP BY 1,2")
base = sum(int(r[2]) for r in eng if r[1] == 'BASE TABLE')
views = sum(int(r[2]) for r in eng if r[1] == 'VIEW')
top = q("SELECT TABLE_NAME, ROUND((DATA_LENGTH+INDEX_LENGTH)/1048576,1), IFNULL(TABLE_ROWS,0) FROM information_schema.TABLES "
        "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY DATA_LENGTH+INDEX_LENGTH DESC LIMIT 10")
largest = []
for name, mb, est in top:
    exact = int(q('SELECT COUNT(*) FROM `%s`' % name.replace('`', '``'))[0][0])
    largest.append({'table': name, 'size_mb': float(mb), 'rows_exact': exact})
counts = {k: int(q(sql)[0][0]) for k, sql in {
    'routines': "SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()",
    'triggers': "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()",
    'events': "SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE()"}.items()}
studio = ''
try:
    studio = json.load(open(os.path.join(repo, 'desktop/studio/package.json'))).get('version', '')
except Exception: pass
dirty = sh(['git', 'status', '--porcelain'])
print(json.dumps({
    'database': db,
    'table_count': base,
    'view_count': views,
    'engines': [{'engine': r[0], 'type': r[1], 'tables': int(r[2]), 'size_mb': float(r[3] or 0)} for r in eng],
    'non_innodb_tables': [r[0] for r in q("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() "
                                           "AND TABLE_TYPE='BASE TABLE' AND ENGINE<>'InnoDB'")],
    'largest_tables': largest,
    **counts,
    'mysqldump_version': subprocess.run(['mysqldump', '--version'], capture_output=True, text=True).stdout.strip(),
    'git_head': sh(['git', 'rev-parse', 'HEAD']),
    'git_head_date': sh(['git', 'log', '-1', '--format=%cI']),
    'git_uncommitted_paths': len([l for l in dirty.splitlines() if l.strip()]),
    'studio_version': studio,
    'server_time_utc': subprocess.run(['date', '-u', '+%Y-%m-%dT%H:%M:%SZ'], capture_output=True, text=True).stdout.strip(),
}))
PY
    ;;

  tablecount)
    make_cnf
    mysql --defaults-extra-file="$CNF" -N -B -e \
      "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'" "$DB_EXPECTED"
    ;;

  db)
    make_cnf
    # --single-transaction: consistent InnoDB snapshot without table locks (it turns --lock-tables off).
    # --quick: stream rows instead of buffering whole tables. Output is compressed here and streamed to the PC.
    nice -n 10 ionice -c2 -n7 mysqldump --defaults-extra-file="$CNF" \
      --single-transaction --quick --routines --triggers --events --hex-blob \
      --default-character-set=utf8mb4 --max-allowed-packet=1G \
      "$DB_EXPECTED" | pigz -p 4 -6
    ;;

  files)
    TMPD=$(mktemp -d /dev/shm/cfbkf.XXXXXX)
    mkdir "$TMPD/_backup_meta"
    crontab -l > "$TMPD/_backup_meta/crontab.txt" 2>/dev/null || echo '# no crontab for this user' > "$TMPD/_backup_meta/crontab.txt"
    ( cd "$REPO" && echo "HEAD $(git rev-parse HEAD)" && echo "HEAD_DATE $(git log -1 --format=%cI)" \
        && echo "UNCOMMITTED_PATHS $(git status --porcelain | wc -l)" && git remote -v ) > "$TMPD/_backup_meta/git-state.txt" 2>&1 || true
    date -u +%Y-%m-%dT%H:%M:%SZ > "$TMPD/_backup_meta/created-utc.txt"
    cd "$HOME_DIR"
    # FILESET: the whole CertiFriedUtility working tree (the code there is ahead of git, so it is backed up too),
    # ~/certifried-data (stream bot sounds, media, imports) and the pm2 process list. Excluded, with reasons:
    #   node_modules (npm ci rebuilds), .git (3.5 GB, pre-purge history), logs, backups, temp_audio,
    #   scratchpad, .playwright-mcp, .claude/worktrees (agent scratch),
    #   piper_models except the custom en_GB/bear voice and previews (stock voices re-download from piper-voices),
    #   own-voice recordings (certifried-data/voice/<voice>/samples: biometric, kept 30 days at most, never backed up)
    #   and the sidecar socket. Own-voice models ARE backed up, encrypted with a per-voice key that a delete destroys.
    set +e
    find CertiFriedUtility certifried-data .pm2/dump.pm2 \
      \( \( -type d -name node_modules \) \
         -o -path CertiFriedUtility/.git \
         -o -path CertiFriedUtility/logs \
         -o -path CertiFriedUtility/backups \
         -o -path CertiFriedUtility/temp_audio \
         -o -path CertiFriedUtility/scratchpad \
         -o -path CertiFriedUtility/.playwright-mcp \
         -o -path CertiFriedUtility/.claude/worktrees \
         -o -path 'certifried-data/voice/*/samples' \
         -o -path certifried-data/voice/run \
         -o \( -path 'CertiFriedUtility/piper_models/*' \
               ! -path CertiFriedUtility/piper_models/en_GB \
               ! -path 'CertiFriedUtility/piper_models/en_GB/bear*' \
               ! -path 'CertiFriedUtility/piper_models/previews*' \) \
      \) -prune -o -print0 \
    | nice -n 10 tar --create --file=- --format=gnu \
        -C "$TMPD" _backup_meta \
        -C "$HOME_DIR" --no-recursion --null --files-from=- \
    | pigz -p 4 -6
    st=("${PIPESTATUS[@]}")
    set -e
    echo "CFBK_STATUS find=${st[0]} tar=${st[1]} pigz=${st[2]}" >&2
    # tar exit 1 = a file changed while it was read (normal on a live server); 2 = fatal.
    if [ "${st[1]}" -ge 2 ] || [ "${st[2]}" -ne 0 ]; then exit 1; fi
    ;;

  extras)
    STAGE=/var/backups/offsite-stage
    [ -r "$STAGE/manifest.txt" ] || { echo "cfbackup: $STAGE/manifest.txt is missing (offsite-stage.timer has not run)" >&2; exit 1; }
    [ -n "$(find "$STAGE/manifest.txt" -mmin -1800)" ] || { echo "cfbackup: the staged set is older than 30 h (offsite-stage.timer failing?)" >&2; exit 1; }
    TMPD=$(mktemp -d /dev/shm/cfbkx.XXXXXX)
    mkdir "$TMPD/_backup_meta"
    date -u +%Y-%m-%dT%H:%M:%SZ > "$TMPD/_backup_meta/created-utc.txt"
    set +e
    nice -n 10 tar --create --file=- --format=gnu \
        -C "$TMPD" _backup_meta \
        -C /var/backups offsite-stage \
        -C /srv --exclude=windrose/server-files/R5/Saved/Logs --exclude=windrose/server-files/R5/Saved/Crashes \
          windrose/server-files/R5/Saved windrose/docker-compose.yml windrose/docker-compose.override.yml windrose/.env \
    | pigz -p 4 -6
    st=("${PIPESTATUS[@]}")
    set -e
    echo "CFBK_STATUS find=0 tar=${st[0]} pigz=${st[1]}" >&2
    if [ "${st[0]}" -ge 2 ] || [ "${st[1]}" -ne 0 ]; then exit 1; fi
    ;;

  notify)
    msg=$(printf '%s' "${2:-}" | base64 -d)
    cd "$REPO" && node scripts/publish/notify-owner.mjs "$msg"
    ;;

  restoretest)
    # Loads a single-table SQL extract (already renamed to _restore_test_<table>) from stdin, compares its row count
    # with the live table, then drops it. Refuses anything that touches a table other than the test table.
    T="${2:-}"
    [[ "$T" =~ ^[a-z0-9_]{1,48}$ ]] || { echo 'bad table name' >&2; exit 2; }
    TT="_restore_test_$T"
    make_cnf
    TMPD=$(mktemp -d /dev/shm/cfbkr.XXXXXX)
    cat > "$TMPD/in.sql"
    if grep -qE "DROP TABLE|\`$T\`" "$TMPD/in.sql"; then echo 'refusing: input references the live table or drops a table' >&2; exit 2; fi
    grep -q "CREATE TABLE \`$TT\`" "$TMPD/in.sql" || { echo 'refusing: no CREATE TABLE for the test table' >&2; exit 2; }
    pre=$(mysql --defaults-extra-file="$CNF" -N -B -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='$TT'" "$DB_EXPECTED")
    [ "$pre" = 0 ] || { echo "refusing: $TT already exists" >&2; exit 2; }
    mysql --defaults-extra-file="$CNF" --default-character-set=utf8mb4 "$DB_EXPECTED" < "$TMPD/in.sql"
    restored=$(mysql --defaults-extra-file="$CNF" -N -B -e "SELECT COUNT(*) FROM \`$TT\`" "$DB_EXPECTED")
    live=$(mysql --defaults-extra-file="$CNF" -N -B -e "SELECT COUNT(*) FROM \`$T\`" "$DB_EXPECTED")
    cs_r=$(mysql --defaults-extra-file="$CNF" -N -B -e "CHECKSUM TABLE \`$TT\`" "$DB_EXPECTED" | cut -f2)
    cs_l=$(mysql --defaults-extra-file="$CNF" -N -B -e "CHECKSUM TABLE \`$T\`" "$DB_EXPECTED" | cut -f2)
    mysql --defaults-extra-file="$CNF" -N -B -e "DROP TABLE \`$TT\`" "$DB_EXPECTED"
    gone=$(mysql --defaults-extra-file="$CNF" -N -B -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='$TT'" "$DB_EXPECTED")
    echo "{\"table\":\"$T\",\"restored_as\":\"$TT\",\"restored_rows\":$restored,\"live_rows_now\":$live,\"restored_checksum\":\"$cs_r\",\"live_checksum_now\":\"$cs_l\",\"dropped\":$([ "$gone" = 0 ] && echo true || echo false)}"
    ;;

  *)
    echo "cfbackup: unknown mode" >&2; exit 2 ;;
esac
