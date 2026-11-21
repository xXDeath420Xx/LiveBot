#!/usr/bin/env bash
# scan-check.sh [GITLEAKS_BIN]: the internal repo's secret gate (CI and deploy.sh).
# Runs scripts/publish/secret-scan.mjs and gitleaks over the files git tracks, reduces each finding to
# "file rule" (no line numbers, never a value) and fails on anything not in scan-baseline.txt.
# Every baseline entry was reviewed by hand (2026-11-21: none is a secret). To accept a new finding,
# review it, then add its "file rule" line to the baseline in the same commit and say why.
#   --update   rewrite the baseline from the current findings (only after review)
set -Eeuo pipefail
cd "$(git rev-parse --show-toplevel)"
UPDATE=0; GL=""
if [ "${1:-}" = --update ]; then UPDATE=1; else GL="${1:-}"; fi
[ -n "$GL" ] || GL="$(command -v gitleaks || echo "$HOME/.local/bin/gitleaks")"
BASE=scripts/internal-git/scan-baseline.txt
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
git ls-files -z > "$T/files.z"
cat scripts/publish/secret-scan-allowlist.txt scripts/internal-git/scan-allowlist-extra.txt > "$T/allow.txt"
set +e
node scripts/publish/secret-scan.mjs --root . --files-from "$T/files.z" --allowlist "$T/allow.txt" \
    ${CF_SCAN_ENV_ROOT:+--env-glob-root "$CF_SCAN_ENV_ROOT"} > "$T/scan.txt" 2> "$T/scan.err"
rc=$?
set -e
[ $rc -le 1 ] || { cat "$T/scan.err" >&2; echo "scan-check: scanner failed to run" >&2; exit 2; }
mkdir "$T/tree"; tar --null -T "$T/files.z" -cf - | tar -xf - -C "$T/tree"
"$GL" dir "$T/tree" --config .gitleaks.toml --redact=100 --no-banner --log-level error --exit-code 0 \
    --report-format json --report-path "$T/gl.json" >/dev/null
{ awk '{split($1,a,":"); print a[1], $2}' "$T/scan.txt"
  node -e 'for (const f of JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")||"[]")) console.log(f.File.replace(process.argv[2]+"/",""), "gitleaks:"+f.RuleID)' "$T/gl.json" "$T/tree"
} | sort -u > "$T/now.txt"
if [ "$UPDATE" = 1 ]; then
    { echo "# Reviewed secret-scan/gitleaks findings (file rule). None is a secret. See scan-check.sh."; cat "$T/now.txt"; } > "$BASE"
    echo "scan-check: baseline rewritten ($(wc -l < "$T/now.txt") entries)"; exit 0
fi
grep -v '^#' "$BASE" | sort -u > "$T/base.txt"
NEW="$(comm -23 "$T/now.txt" "$T/base.txt")"
tail -n1 "$T/scan.err" >&2 || true
if [ -n "$NEW" ]; then
    echo "scan-check: NEW findings (not in $BASE):" >&2; printf '  %s\n' "$NEW" >&2; exit 1
fi
echo "scan-check: clean ($(wc -l < "$T/now.txt") known findings, 0 new)"
