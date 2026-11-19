#!/bin/bash
# Deploy bundle runner, VIEWS variant: dashboard templates and static files only. NO restart:
# the bots stay connected; the running dashboard reloads its template cache and re-versions its
# css/js links (scripts/reload-dashboard.mjs -> dashboard/services/dashboard-reload.js).
#
# Same bundle layout as run-deploy.sh (copy this script into the bundle dir):
#   stage/<repo path>   new and edited files: ONLY under dashboard/views/ or dashboard/public/
#   delete.list         optional: repo paths to remove (same restriction)
#   orig.sums           sha256 of the LIVE version of every edited and deleted file, made right
#                       before staging: cd ~/CertiFriedUtility && sha256sum <paths> > <bundle>/orig.sums
# Run: bash <bundle>/run-deploy-views.sh   (detaches itself; progress in <bundle>/run.log)
#
# Refuses outright if anything is outside dashboard/views and dashboard/public (routes, core/,
# services/, any .js the server imports need a restart: use run-deploy.sh), if an edited file
# changed since staging, or a new file already exists. After copying: compiles every template,
# syntax-checks staged browser JS, runs the tests that read the views/public files (0 failed,
# 0 cancelled) and the visual smoke check, then asks the dashboard to reload and requires its
# acknowledgement and a 200 from the site. Any failure puts the originals back (and reloads again
# so nothing half-deployed stays cached).
set -u
D=$(cd "$(dirname "$0")" && pwd)
LIVE=$HOME/CertiFriedUtility
R=${DEPLOY_REPO:-$LIVE}   # DEPLOY_REPO: rehearse against a scratch copy
if [ -z "${IN_DETACHED:-}" ]; then
  IN_DETACHED=1 setsid nohup bash "$0" > "$D/run.log" 2>&1 < /dev/null &
  echo "Started in the background. Check: cat $D/run.log"; exit 0
fi
cd "$R" || exit 1
LABEL=$(cat "$D/label" 2>/dev/null || basename "$D")
echo "DEPLOY (views, no restart) $LABEL at $(date '+%F %T')"
mapfile -t STAGED < <(cd "$D/stage" && find . -type f | sed 's|^\./||' | sort)
DELETE=(); [ -f "$D/delete.list" ] && mapfile -t DELETE < <(grep -v '^\s*\(#\|$\)' "$D/delete.list")
[ -f "$D/migrations.list" ] && grep -qv '^\s*\(#\|$\)' "$D/migrations.list" && { echo "migrations.list present: migrations need run-deploy.sh; NOT deployed"; exit 1; }

for f in "${STAGED[@]}" "${DELETE[@]}"; do
  case "$f" in
    dashboard/views/*|dashboard/public/*) ;;
    *) echo "$f is outside dashboard/views and dashboard/public: that needs a restart (run-deploy.sh); NOT deployed"; exit 1;;
  esac
  case "$f" in *..*) echo "$f: '..' in a path; NOT deployed"; exit 1;; esac
done
[ ${#STAGED[@]} -gt 0 ] || [ ${#DELETE[@]} -gt 0 ] || { echo "nothing staged; NOT deployed"; exit 1; }

SUMMED=$(awk '{print $2}' "$D/orig.sums" | sed 's|^\*||')
NEW=(); EDIT=()
for f in "${STAGED[@]}"; do if grep -qxF "$f" <<< "$SUMMED"; then EDIT+=("$f"); else NEW+=("$f"); fi; done
for f in "${DELETE[@]}"; do grep -qxF "$f" <<< "$SUMMED" || { echo "$f is in delete.list but not in orig.sums; NOT deployed"; exit 1; }; done
echo "STEP ${#EDIT[@]} edited, ${#NEW[@]} new, ${#DELETE[@]} deleted"
sha256sum -c --quiet "$D/orig.sums" || { echo "A file changed since staging; NOT deployed"; exit 1; }
for f in "${NEW[@]}"; do [ -e "$f" ] && { echo "$f already exists; NOT deployed"; exit 1; }; done
[ -f scripts/reload-dashboard.mjs ] && [ -f dashboard/services/dashboard-reload.js ] || { echo "the live repo has no reload mechanism yet; use run-deploy.sh; NOT deployed"; exit 1; }

reload() { timeout 60 node scripts/reload-dashboard.mjs --reason "$1" "${@:2}"; }
restore() {
  for f in "${EDIT[@]}" "${DELETE[@]}"; do mkdir -p "$(dirname "$R/$f")"; cp -p "$D/orig/$f" "$R/$f"; done
  for f in "${NEW[@]}"; do rm -f "$R/$f"; done
  reload "restore after a failed views deploy ($LABEL)" >/dev/null 2>&1
  echo "$1; restored the originals"; exit 1
}
for f in "${EDIT[@]}" "${DELETE[@]}"; do mkdir -p "$D/orig/$(dirname "$f")"; cp -p "$f" "$D/orig/$f"; done
for f in "${STAGED[@]}"; do mkdir -p "$(dirname "$f")"; cp "$D/stage/$f" "$f"; done
for f in "${DELETE[@]}"; do rm -f "$f"; done
find dashboard/views -type d -empty -delete 2>/dev/null
echo "STEP files in place (the running dashboard still serves its cached templates)"

CHK=/tmp/deploy-views-check-$$.mjs
for f in "${STAGED[@]}"; do
  case "$f" in
    *.js) node --check "$f" 2>/dev/null || { cp "$f" $CHK; node --check $CHK; } || restore "syntax error in $f";;
    *.json) node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$f" || restore "bad JSON in $f";;
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

# The tests that read templates or static files (the rest of the suite cannot be affected).
mapfile -t TESTS < <(grep -lE "dashboard/(views|public)|views/|cf-ui\.css|cf-manage\.(css|js)|view-engine" tests/*.test.js | sort)
OUT=$(timeout 600 nice -n 10 node --test --test-force-exit --test-timeout=120000 "${TESTS[@]}" 2>&1)
echo "tests: ${#TESTS[@]} files"; echo "$OUT" | grep -E "^# (tests|pass|fail|cancelled)"
echo "$OUT" | grep -q "^# fail 0" && echo "$OUT" | grep -q "^# cancelled 0" || { echo "$OUT" | grep "not ok" | head -20; restore "tests failed"; }
VC=$(timeout 240 node scripts/visual-check.mjs 2>&1); VRC=$?
echo "$VC" | grep -E "^(FAIL|visual-check)" | tail -25
echo "$VC" | grep -c "^WARN" | sed 's/^/visual-check warnings: /'
[ $VRC -eq 0 ] || restore "visual check failed (exit $VRC)"

reload "views deploy $LABEL" --verify "${DEPLOY_VERIFY_URL:-http://127.0.0.1:3001/}" || restore "the dashboard did not reload or did not answer 200"
echo "STEP reloaded (no restart; bots untouched)"
echo "ALL DONE"
