#!/usr/bin/env bash
# Publish the live working copy's source to the public GitHub repo (xXDeath420Xx/LiveBot, branch dev).
#
#   scripts/publish-github.sh              dry run (default): sync, scan, commit in the publish clone, push --dry-run
#   scripts/publish-github.sh --push       the same, then a real push (fast-forward only, never forced)
#   scripts/publish-github.sh --scan-only  sync and scan, no commit
#   options: --message "text"       extra line for the commit body
#            --exclude-from FILE    extra gitignore-style patterns to leave out this run (only removes files)
#
# The working copy's own .git (old, unpurged history) is never read for the file list, never committed
# in and never pushed from. All git writes happen in the separate publish clone ($PUBLISH_CLONE).
# The secret scan is mandatory and fail-closed. See docs/publishing.md.
#
# Exit codes: 0 ok / nothing to publish, 1 guard or usage error, 3 scan findings, 4 push failed.
set -Eeuo pipefail
umask 022
export LC_ALL=C.UTF-8 GIT_TERMINAL_PROMPT=0

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEST="${PUBLISH_CLONE:-/home/death/certifried-publish/LiveBot}"
WORK="${PUBLISH_WORK:-$(dirname "$DEST")/work}"
BRANCH=dev
EXPECTED_REMOTE="git@github.com:xXDeath420Xx/LiveBot.git"
ANCHOR=dddaf2f8addcfc44bb34380b76037340d769fb50   # dev tip right after the second 2026-11-19 history rewrite
# Commits that exist only in superseded histories: e99906c (.env.bak with live secrets, never pushed),
# eba7161 (dev tip after the first purge, before the second).
OLD_ONLY_COMMITS="e99906c eba716169ee6f51331eb9018b52d7363756593a9"
GIT_NAME="xXDeath420Xx"
GITLEAKS="${GITLEAKS_BIN:-$(command -v gitleaks || echo "$HOME/.local/bin/gitleaks")}"
LOG="$SRC/logs/publish-github.log"
TOOLS="$SRC/scripts/publish"

MODE=dry-run EXTRA_MSG="" EXTRA_EXCLUDE=""
while [ $# -gt 0 ]; do
    case "$1" in
        --push) MODE=push ;;
        --dry-run) MODE=dry-run ;;
        --scan-only) MODE=scan-only ;;
        --message) EXTRA_MSG="${2:?--message needs text}"; shift ;;
        --exclude-from) EXTRA_EXCLUDE="${2:?--exclude-from needs a file}"; shift ;;
        -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 1 ;;
    esac
    shift
done

mkdir -p "$WORK" "$(dirname "$LOG")"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
log() { printf '%s [%s] %s\n' "$(date -u +%FT%TZ)" "$RUN_ID" "$*" >> "$LOG"; }
say() { printf '%s\n' "$*" >&2; }
die() { say "publish: $1"; log "ABORT $MODE: $1"; exit "${2:-1}"; }
gd() { git -C "$DEST" "$@"; }

exec 9> "$WORK/.publish.lock"
flock -n 9 || die "another publish run holds $WORK/.publish.lock"
log "START mode=$MODE src=$SRC dest=$DEST"

# ---------------------------------------------------------------- guards
[ -d "$DEST/.git" ] || die "publish clone missing: $DEST (git clone --branch $BRANCH $EXPECTED_REMOTE $DEST)"
[ "$(cd "$DEST" && pwd -P)" != "$SRC" ] || die "publish clone must not be the working copy"
case "$(cd "$DEST" && pwd -P)/" in "$SRC"/*) die "publish clone must live outside the working copy" ;; esac
[ "$(gd remote get-url origin)" = "$EXPECTED_REMOTE" ] || die "publish clone origin is not $EXPECTED_REMOTE"
[ "$(gd config --get user.name || true)" = "$GIT_NAME" ] || die "publish clone git user.name must be $GIT_NAME"
[ -n "$(gd config --get user.email || true)" ] || die "publish clone has no git user.email"
for t in secret-scan.mjs build-file-list.mjs pre-push.sh secret-scan-allowlist.txt; do
    [ -f "$TOOLS/$t" ] || die "missing $TOOLS/$t"
done
[ -f "$SRC/.publishignore" ] || die "missing $SRC/.publishignore"
[ -x "$GITLEAKS" ] || die "gitleaks not found (set GITLEAKS_BIN); the scan is mandatory"
command -v rsync >/dev/null || die "rsync not installed"
install -m 755 "$TOOLS/pre-push.sh" "$DEST/.git/hooks/pre-push"
gd config diff.renameLimit 20000

# ---------------------------------------------------------------- 1. start from the remote's dev
gd fetch -q --prune origin || die "git fetch failed"
gd merge-base --is-ancestor "$ANCHOR" "origin/$BRANCH" || die "origin/$BRANCH does not contain the rewritten history anchor"
for c in $OLD_ONLY_COMMITS; do
    if gd rev-parse -q --verify "$c^{commit}" >/dev/null; then
        die "publish clone contains commit $c from a superseded history; re-clone it"
    fi
done
gd checkout -q -B "$BRANCH" "origin/$BRANCH"
gd reset -q --hard "origin/$BRANCH"
gd clean -q -ffdx
BASE="$(gd rev-parse HEAD)"

# ---------------------------------------------------------------- 2. file list (never from the working copy's .git)
[ -d "$WORK/lister/.git" ] || git init -q "$WORK/lister"
cat "$SRC/.publishignore" > "$WORK/excludes.txt"
if [ -n "$EXTRA_EXCLUDE" ]; then
    [ -f "$EXTRA_EXCLUDE" ] || die "--exclude-from: no such file $EXTRA_EXCLUDE"
    { printf '\n# --exclude-from %s\n' "$EXTRA_EXCLUDE"; cat "$EXTRA_EXCLUDE"; } >> "$WORK/excludes.txt"
    log "extra excludes from $EXTRA_EXCLUDE"
    EXTRA_MSG="${EXTRA_MSG:+$EXTRA_MSG }Left out this run: $(grep -v '^[[:space:]]*#' "$EXTRA_EXCLUDE" | grep -v '^[[:space:]]*$' | tr '\n' ' ')"
fi
git --git-dir="$WORK/lister/.git" --work-tree="$SRC" -c core.excludesFile="$WORK/excludes.txt" \
    ls-files -z --others --exclude-standard > "$WORK/candidates.z"
gd ls-files -z > "$WORK/tracked-before.z"
node "$TOOLS/build-file-list.mjs" --src "$SRC" --tracked "$WORK/tracked-before.z" \
    --out "$WORK/publish.z" --report "$WORK/file-list-report.json" < "$WORK/candidates.z" \
    || die "building the file list failed"
[ -s "$WORK/publish.z" ] || die "empty file list"

# ---------------------------------------------------------------- 3. sync into the publish clone's worktree
(cd "$DEST" && git ls-files -z | xargs -0r rm -f --)
find "$DEST" -mindepth 1 -type d -empty -not -path "$DEST/.git" -not -path "$DEST/.git/*" -delete
set +e
rsync -a --from0 --files-from="$WORK/publish.z" "$SRC/" "$DEST/"
rc=$?
set -e
[ $rc -eq 0 ] || [ $rc -eq 24 ] || die "rsync failed ($rc)"
[ $rc -eq 24 ] && say "WARN some files vanished during the copy (other sessions are editing); they are left out"
gd add -A

# ---------------------------------------------------------------- 4. mandatory scan of everything that would be committed
gd ls-files -z > "$WORK/staged.z"
STAGED_N=$(tr -cd '\0' < "$WORK/staged.z" | wc -c)
set +e
node "$TOOLS/secret-scan.mjs" --root "$DEST" --files-from "$WORK/staged.z" \
    --env-glob-root "$SRC" --allowlist "$TOOLS/secret-scan-allowlist.txt" \
    --summary-json "$WORK/scan-summary.json" > "$WORK/scan-findings.txt" 2> "$WORK/scan-stderr.txt"
SCAN_RC=$?
(cd "$DEST" && "$GITLEAKS" dir . --config "$SRC/.gitleaks.toml" --redact=100 --no-banner --log-level error \
    --exit-code 1 --report-format json --report-path "$WORK/gitleaks.json") > /dev/null 2> "$WORK/gitleaks-stderr.txt"
GL_RC=$?
# gitleaks: print file, line and rule only; .git internals are not part of the commit
node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8") || "[]");
  const keep = r.filter((f) => !/^(\.\/)?\.git\//.test(f.File));
  for (const f of keep) console.log(`${f.File.replace(/^\.\//, "")}:${f.StartLine}  gitleaks:${f.RuleID}`);
  process.exit(keep.length ? 1 : 0);
' "$WORK/gitleaks.json" > "$WORK/gitleaks-findings.txt" 2>/dev/null
GL_FOUND=$?
set -e
[ $GL_RC -le 1 ] || { GL_FOUND=1; echo "gitleaks failed to run (exit $GL_RC)" >> "$WORK/gitleaks-findings.txt"; }
rm -f "$WORK/gitleaks.json"
SCAN_SUMMARY="$(tail -n1 "$WORK/scan-stderr.txt")"
say "$SCAN_SUMMARY"
say "gitleaks: $(wc -l < "$WORK/gitleaks-findings.txt") finding(s)"
if [ $SCAN_RC -ne 0 ] || [ $GL_FOUND -ne 0 ]; then
    cat "$WORK/scan-findings.txt" "$WORK/gitleaks-findings.txt" >&2
    log "SCAN FAILED staged=$STAGED_N $SCAN_SUMMARY gitleaks_findings=$(wc -l < "$WORK/gitleaks-findings.txt")"
    sed 's/^/  /' "$WORK/scan-findings.txt" "$WORK/gitleaks-findings.txt" >> "$LOG"
    gd reset -q --hard "$BASE"; gd clean -q -ffdx
    die "secret scan found problems; nothing was committed or pushed" 3
fi
log "SCAN CLEAN staged=$STAGED_N $SCAN_SUMMARY gitleaks_findings=0"

if [ "$MODE" = scan-only ]; then
    gd reset -q --hard "$BASE"; gd clean -q -ffdx
    say "scan-only: clean ($STAGED_N files)"; log "DONE scan-only"; exit 0
fi

# ---------------------------------------------------------------- 5. commit
if gd diff --cached --quiet; then
    say "nothing to publish: the repo already matches the live tree"; log "DONE nothing to publish"; exit 0
fi
read -r ADDED MODIFIED DELETED RENAMED < <(gd diff --cached --name-status -M | awk '
    $1=="A"{a++} $1=="M"{m++} $1=="D"{d++} $1 ~ /^R/{r++} END{print a+0, m+0, d+0, r+0}')
AREAS="$(gd diff --cached --name-only -M | awk -F/ '
    { k = (NF > 2 && ($1=="dashboard" || $1=="core" || $1=="services" || $1=="desktop" || $1=="frontend")) ? $1"/"$2 : (NF > 1 ? $1 : "(root)"); n[k]++ }
    END { for (k in n) printf "%d %s\n", n[k], k }' | sort -rn | head -12 | awk '{printf "  - %s (%d)\n", $2, $1}')"
ver() { node -p "try{require('$1').version}catch(e){'?'}" 2>/dev/null || echo '?'; }
V_APP="$(ver "$DEST/package.json")"
V_STUDIO="$(ver "$DEST/desktop/studio/package.json")"
V_WINDROSE="$(ver "$DEST/windrose-agent/package.json")"
LAST_MIGRATION="$(cd "$DEST/migrations" 2>/dev/null && ls | grep -E '^[0-9]+_' | sort -n | tail -1 || echo '?')"
SNAPSHOT="$(date -u '+%Y-%m-%d %H:%M UTC')"
{
    printf 'Publish live tree %s: +%s ~%s -%s' "$(date -u +%F)" "$ADDED" "$MODIFIED" "$DELETED"
    [ "$RENAMED" != 0 ] && printf ' (%s renamed)' "$RENAMED"
    printf '\n\n'
    [ -n "$EXTRA_MSG" ] && printf '%s\n\n' "$EXTRA_MSG"
    printf 'Snapshot of the live server tree taken %s.\n' "$SNAPSHOT"
    printf '%s files in the tree. Changed areas:\n%s\n\n' "$STAGED_N" "$AREAS"
    printf 'Versions: CertiFried %s, Studio %s, windrose-agent %s; latest migration %s.\n' \
        "$V_APP" "$V_STUDIO" "$V_WINDROSE" "${LAST_MIGRATION%.*}"
    printf 'Secret scan: clean (%s).\n\n' "scripts/publish/secret-scan.mjs + gitleaks"
    printf 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n'
    printf 'Claude-Session: https://claude.ai/code/session_011at6UujsnCHa3pvtfGLqup\n'
} > "$WORK/commit-msg.txt"
gd commit -q -F "$WORK/commit-msg.txt" || die "commit failed"
COMMIT="$(gd rev-parse --short HEAD)"
say "committed $COMMIT in $DEST: +$ADDED ~$MODIFIED -$DELETED ($STAGED_N files)"

# ---------------------------------------------------------------- 6. push (fast-forward only, never forced)
if [ "$MODE" = push ]; then
    gd push origin "$BRANCH:$BRANCH" 2>&1 | sed 's/^/  /' >&2 || true
    [ "$(gd ls-remote origin "refs/heads/$BRANCH" | cut -f1)" = "$(gd rev-parse HEAD)" ] || die "push failed" 4
    log "PUSHED $COMMIT +$ADDED ~$MODIFIED -$DELETED files=$STAGED_N app=$V_APP studio=$V_STUDIO"
    say "pushed $COMMIT to $BRANCH"
else
    gd push --dry-run origin "$BRANCH:$BRANCH" 2>&1 | sed 's/^/  /' >&2 || die "push --dry-run failed" 4
    log "DRY-RUN $COMMIT +$ADDED ~$MODIFIED -$DELETED files=$STAGED_N app=$V_APP studio=$V_STUDIO (not pushed)"
    say "dry run: $COMMIT is committed in $DEST but NOT pushed. Inspect: git -C $DEST show --stat HEAD"
    say "real push: $SRC/scripts/publish-github.sh --push"
fi
printf '%s\n' "$AREAS" | sed 's/^/    /' >> "$LOG"
