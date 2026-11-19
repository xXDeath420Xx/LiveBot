#!/usr/bin/env bash
# Daily publish wrapper (PROPOSED, not installed). Runs the CI checks against the exact tree that
# would be published, and only then publishes with --push. Any failure DMs the bot owner.
#
#   scripts/publish/publish-cron.sh            check + push
#   scripts/publish/publish-cron.sh --dry-run  check + dry run (no push)
#
# Cron line (see docs/publishing.md):
#   30 4 * * * /home/death/CertiFriedUtility/scripts/publish/publish-cron.sh >> /home/death/CertiFriedUtility/logs/publish-cron.log 2>&1
set -Euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
WORK="${PUBLISH_WORK:-/home/death/certifried-publish/work}"
NODE22="${NODE22_BIN:-$WORK/node22/bin}"   # CI uses Node 22; the server runs Node 20
MODE="--push"; [ "${1:-}" = "--dry-run" ] && MODE="--dry-run"
export PATH="$NODE22:$PATH" PUPPETEER_SKIP_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

fail() {
    echo "$(date -u +%FT%TZ) publish-cron FAILED: $1"
    node "$SRC/scripts/publish/notify-owner.mjs" "GitHub publish skipped: $1. Nothing was pushed. Details: logs/publish-github.log and logs/publish-cron.log on server1." || true
    exit 1
}

# 1. Scan only first: cheap, and it fails before any test run if something private slipped in.
"$SRC/scripts/publish-github.sh" --scan-only || fail "the secret scan found problems"

# 2. Build the published tree in a scratch dir and run the CI steps on it (clean install, Node 22).
T="$WORK/cron-ci"
rm -rf "$T" && mkdir -p "$T"
rsync -a --from0 --files-from="$WORK/publish.z" "$SRC/" "$T/" || fail "could not copy the tree for testing"
(
    cd "$T" &&
    npm ci --no-audit --no-fund > "$WORK/cron-npm.log" 2>&1 &&
    node --experimental-vm-modules --no-warnings scripts/publish/syntax-check.mjs . &&
    env -i PATH="$PATH" HOME="$WORK" CI=true \
        node --test --test-force-exit --test-timeout=60000 $(grep -v '^#' tests/ci-list.txt) > "$WORK/cron-tests.log" 2>&1
) || fail "install, syntax check or the DB-free tests failed (see $WORK/cron-tests.log)"
rm -rf "$T"

# 3. Publish. The script re-syncs and re-scans, so edits made during the test run are scanned too.
"$SRC/scripts/publish-github.sh" "$MODE" --message "Automatic daily publish; DB-free tests passed." \
    || fail "publish-github.sh $MODE failed (exit $?)"
echo "$(date -u +%FT%TZ) publish-cron ok ($MODE)"
