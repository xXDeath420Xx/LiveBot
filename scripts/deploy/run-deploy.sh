#!/bin/bash
# Deploy bundle runner, FULL variant: code and/or templates. RESTARTS CertiFriedUtility (every
# bot drops for about a minute). If only dashboard/views and dashboard/public changed, use
# run-deploy-views.sh instead: same bundle layout, no restart.
#
# Bundle layout (copy this script into the bundle dir, e.g. ~/deploy-backups/<date>-<name>/):
#   stage/<repo path>   every new and edited file, at its path in the repo
#   delete.list         optional: repo paths to remove, one per line (backed up first)
#   migrations.list     optional: migration files (repo paths, staged or live) whose up(pool) runs
#   orig.sums           sha256 of the LIVE version of every edited and deleted file, made right
#                       before staging (live changes often):
#                         cd ~/CertiFriedUtility && sha256sum <edited paths> <deleted paths> > <bundle>/orig.sums
#   label               optional: one line, used in the log
# Run: bash <bundle>/run-deploy.sh   (detaches itself; progress in <bundle>/run.log)
#
# Refuses if an edited/deleted file changed since staging or a new file already exists. After
# copying: syntax-checks every staged .js (as ESM), JSON, compiles every template, runs the
# migrations, the full test suite (0 failed, 0 cancelled) and the visual smoke check
# (scripts/visual-check.mjs); on any failure puts every original back. Then restarts and waits for
# the dashboard to answer.
set -u
D=$(cd "$(dirname "$0")" && pwd)
LIVE=$HOME/CertiFriedUtility
R=${DEPLOY_REPO:-$LIVE}   # DEPLOY_REPO: rehearse against a scratch copy
if [ -z "${IN_DETACHED:-}" ]; then
  IN_DETACHED=1 setsid nohup bash "$0" > "$D/run.log" 2>&1 < /dev/null &
  echo "Started in the background. Check: cat $D/run.log"; exit 0
fi
cd "$R" || exit 1
echo "DEPLOY $(cat "$D/label" 2>/dev/null || basename "$D") at $(date '+%F %T')"
mapfile -t STAGED < <(cd "$D/stage" && find . -type f | sed 's|^\./||' | sort)
DELETE=(); [ -f "$D/delete.list" ] && mapfile -t DELETE < <(grep -v '^\s*\(#\|$\)' "$D/delete.list")
MIGS=(); [ -f "$D/migrations.list" ] && mapfile -t MIGS < <(grep -v '^\s*\(#\|$\)' "$D/migrations.list")
SUMMED=$(awk '{print $2}' "$D/orig.sums" | sed 's|^\*||')
NEW=(); EDIT=()
for f in "${STAGED[@]}"; do if grep -qxF "$f" <<< "$SUMMED"; then EDIT+=("$f"); else NEW+=("$f"); fi; done
for f in "${DELETE[@]}"; do grep -qxF "$f" <<< "$SUMMED" || { echo "$f is in delete.list but not in orig.sums; NOT deployed"; exit 1; }; done
echo "STEP ${#EDIT[@]} edited, ${#NEW[@]} new, ${#DELETE[@]} deleted, ${#MIGS[@]} migration(s)"

sha256sum -c --quiet "$D/orig.sums" || { echo "A file changed since staging; NOT deployed"; exit 1; }
for f in "${NEW[@]}"; do [ -e "$f" ] && { echo "$f already exists; NOT deployed"; exit 1; }; done

restore() {
  for f in "${EDIT[@]}" "${DELETE[@]}"; do mkdir -p "$(dirname "$R/$f")"; cp -p "$D/orig/$f" "$R/$f"; done
  for f in "${NEW[@]}"; do rm -f "$R/$f"; done
  echo "$1; restored the originals"; exit 1
}
for f in "${EDIT[@]}" "${DELETE[@]}"; do mkdir -p "$D/orig/$(dirname "$f")"; cp -p "$f" "$D/orig/$f"; done
for f in "${STAGED[@]}"; do mkdir -p "$(dirname "$f")"; cp "$D/stage/$f" "$f"; done
for f in "${DELETE[@]}"; do rm -f "$f"; done
find dashboard/views -type d -empty -delete 2>/dev/null
echo "STEP files in place"

CHK=/tmp/deploy-check-$$.mjs
for f in "${STAGED[@]}"; do
  case "$f" in
    dashboard/public/*.js) node --check "$f" 2>/dev/null || { cp "$f" $CHK; node --check $CHK; } || restore "syntax error in $f";;
    *.js|*.mjs) cp "$f" $CHK; node --check $CHK || restore "syntax error in $f";;
    *.json) node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$f" || restore "bad JSON in $f";;
    *.sh) bash -n "$f" || restore "shell syntax error in $f";;
  esac
done
rm -f $CHK
(cd dashboard && node -e '
const ejs = require("ejs"), fs = require("fs"), path = require("path");
let n = 0;
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const p = path.join(d, e.name);
  if (e.isDirectory()) walk(p);
  else if (p.endsWith(".ejs")) { n++; ejs.compile(fs.readFileSync(p, "utf8"), { filename: p }); }
} })("views");
console.log("templates compile: " + n);') || restore "template error"
echo "STEP syntax ok"

# Migrations: idempotent up(pool), additive; left in place if a later step fails. A bundle that
# needs a stronger check (columns present, ...) adds it after this loop.
for m in "${MIGS[@]}"; do
  cat > .tmp-deploy-mig.mjs <<EOF
process.on('uncaughtException', e => { console.error('MIGRATION FAILED', e.message); process.exit(1); });
process.on('unhandledRejection', e => { console.error('MIGRATION FAILED', e.message); process.exit(1); });
import 'dotenv/config';
const { default: pool } = await import('./utils/db.js');
const { up } = await import('./$m');
await up(pool);
console.log('MIGRATION OK: $m');
process.exit(0);
EOF
  MO=$(timeout 120 node .tmp-deploy-mig.mjs 2>&1); rm -f .tmp-deploy-mig.mjs
  echo "$MO" | grep "MIGRATION"
  grep -q "MIGRATION OK" <<< "$MO" || restore "migration $m failed"
done

# nice: the suite runs ~11 node workers next to the live bots; the bots keep CPU priority.
OUT=$(timeout 900 nice -n 10 npm test 2>&1)
echo "$OUT" | grep -E "^# (tests|pass|fail|cancelled)"
# "cancelled" = a test file killed by --test-timeout (e.g. a runaway regex): as bad as a failure.
echo "$OUT" | grep -q "^# fail 0" && echo "$OUT" | grep -q "^# cancelled 0" || { echo "$OUT" | grep "not ok" | head -20; restore "tests failed"; }
VC=$(timeout 240 node scripts/visual-check.mjs 2>&1); VRC=$?
echo "$VC" | grep -E "^(FAIL|visual-check)" | tail -25
echo "$VC" | grep -c "^WARN" | sed 's/^/visual-check warnings: /'
[ $VRC -eq 0 ] || restore "visual check failed (exit $VRC)"

[ "$R" = "$LIVE" ] || { echo "rehearsal in $R: not restarting anything"; echo "ALL DONE"; exit 0; }
pm2 restart CertiFriedUtility --update-env >/dev/null && echo "STEP restarted CertiFriedUtility"
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3001/)
  [ "$code" = "200" ] && { echo "STEP dashboard answering (200) after $((i * 3))s"; break; }
  sleep 3
done
[ "$code" = "200" ] || echo "WARNING: dashboard not answering 200 yet (last: $code) - check pm2 logs CertiFriedUtility"
echo "ALL DONE"
