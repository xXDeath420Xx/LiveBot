#!/usr/bin/env bash
# scripts/deploy.sh: the ONLY way CertiFried changes reach production (2026-11-21). See AGENTS.md.
#
#   scripts/deploy.sh ship -m "message" PATH...   commit PATHs (secret gate first), push to Forgejo, wait for CI,
#                                                  deploy that commit to staging, smoke-check it
#   scripts/deploy.sh ship -m "message" --all     same, committing every change in the tree (only if they are all yours)
#   scripts/deploy.sh staging [REF]               deploy REF (default HEAD) to staging + smoke checks
#   scripts/deploy.sh promote [REF]               production = REF: needs green CI + a passed staging smoke for REF,
#                                                  a clean tree at REF, no foreign lock, a quiet window; tags prod-*,
#                                                  restarts only the affected apps, waits for health + all bots
#   scripts/deploy.sh rollback [TAG]              production back to the previous prod-* tag (or TAG) at once
#                                                  (a forward "rollback" commit on main; no quiet-window wait)
#   scripts/deploy.sh status                      prod tag, HEAD, CI state, staging state
#   scripts/deploy.sh ci [REF]                    wait for CI on REF and print the result
# Env: CF_DEPLOY_FORCE_QUIET=1 skips the quiet-window wait for promote (owner-approved hotfix only).
#      CF_DEPLOY_CI_TIMEOUT (s, default 1800), CF_DEPLOY_QUIET_TIMEOUT (s, default 7200; promote waits for quiet).
set -Eeuo pipefail
umask 002
export LC_ALL=C.UTF-8 GIT_TERMINAL_PROMPT=0

PROD=/home/death/CertiFriedUtility
STAGING=/srv/staging/certifried
STATE=/home/death/cf-deploy
TOOLKIT=/home/death/migration
LOCKDIR=$TOOLKIT/state
API=http://127.0.0.1:3300/api/v1
REPO=certifried/CertiFriedUtility
NODE_PROD_DEFAULT=v22.23.5
# directories with their own package-lock.json that the running apps load modules from
NPM_DIRS=". dashboard stream-relay cf-jellyfin"
NPM_DIRS_LOCKS="package-lock.json dashboard/package-lock.json stream-relay/package-lock.json cf-jellyfin/package-lock.json"
# paths the running apps write (owned/writable by the app user; everything else is read-only code)
RUNTIME_DIRS="logs data dashboard/data dashboard/public/api temp_audio uploads transcripts backups archives tmp sounds/default cf-jellyfin/data .secrets"
mkdir -p "$STATE/staging-ok" "$STATE/logs"
LOG="$STATE/logs/deploy.log"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG" >&2; }
die() { log "deploy: ERROR: $*"; exit 1; }
g() { git -C "$PROD" "$@"; }
token() { cat "$HOME/.config/forgejo/token"; }
api() { curl -fsS -H "Authorization: token $(token)" "$API$1"; }

node_bin() { # node for tooling (scan-check etc.)
    for d in /opt/nvm/versions/node/$NODE_PROD_DEFAULT/bin /opt/nvm/versions/node/v20.20.0/bin "$HOME/.nvm/versions/node/v20.20.0/bin"; do
        [ -x "$d/node" ] && { echo "$d"; return; }
    done; die "no node found"
}
export PATH="$(node_bin):$HOME/.local/bin:$PATH"

# pm2 for production: the certifried app user (after the 2026-11 switch) or death's own pm2 (before)
pm2c() {
    if id certifried >/dev/null 2>&1 && [ -x /usr/local/bin/cf-pm2 ] && [ -f /var/lib/certifried/.pm2/dump.pm2 ]; then
        sudo -n -u certifried /usr/local/bin/cf-pm2 "$@"
    else
        /usr/local/bin/pm2 "$@"     # death's own pm2 (symlink to the default node's pm2)
    fi
}

# ---------------------------------------------------------------- checks
resolve() { g rev-parse --verify "${1:-HEAD}^{commit}"; }
ci_state() { # prints success|failure|running|none for the workflow runs of sha $1
    api "/repos/$REPO/actions/tasks?limit=50" | jq -r --arg s "$1" '
        [.workflow_runs[]? | select(.head_sha==$s)] as $r
        | if ($r|length)==0 then "none"
          elif any($r[]; .status=="failure" or .status=="cancelled") then "failure"
          elif all($r[]; .status=="success") then "success" else "running" end'
}
wait_ci() {
    local sha="$1" t0 st; t0=$(date +%s)
    while :; do
        st="$(ci_state "$sha")"
        case "$st" in
            success) log "CI green for ${sha:0:7}"; return 0 ;;
            failure) die "CI FAILED for ${sha:0:7}: https://git.certifriedmultitool.com/$REPO/actions" ;;
        esac
        [ $(( $(date +%s) - t0 )) -lt "${CF_DEPLOY_CI_TIMEOUT:-1800}" ] || die "CI did not finish for ${sha:0:7} (state $st)"
        sleep 15
    done
}
foreign_locks() { find "$LOCKDIR" -maxdepth 1 -name 'LOCK.*' ! -name 'LOCK.prod-switch' -printf '%f\n' 2>/dev/null; }
take_prod_lock() {
    local f="$LOCKDIR/LOCK.prod-switch" fl
    fl="$(foreign_locks)"; [ -z "$fl" ] || die "other agents hold locks: $(echo $fl) (see $LOCKDIR)"
    if [ -e "$f" ]; then die "LOCK.prod-switch already held: $(head -c 300 "$f")"; fi
    printf 'deploy.sh %s by %s pid %s at %s\n' "$1" "$(whoami)" "$$" "$(date -u +%FT%TZ)" > "$f"
    trap 'rm -f "'"$f"'"' EXIT
}
wait_quiet() {
    [ "${CF_DEPLOY_FORCE_QUIET:-0}" = 1 ] && { log "quiet window SKIPPED (CF_DEPLOY_FORCE_QUIET=1)"; return 0; }
    local t0; t0=$(date +%s)
    until (cd "$TOOLKIT" && source lib.sh && source <(sed -n "/^cf_quiet() {/,/^}/p" 33-group-certifried.sh) && need_quiet && cf_quiet) >>"$LOG" 2>&1; do
        [ $(( $(date +%s) - t0 )) -lt "${CF_DEPLOY_QUIET_TIMEOUT:-7200}" ] || die "no quiet window within ${CF_DEPLOY_QUIET_TIMEOUT:-7200}s"
        log "not quiet (owner live?); waiting 5 min"; sleep 300
    done
    log "quiet window: OK"
}
expected_bots() { cat "$LOCKDIR/certifried.expected-bots" 2>/dev/null || echo 43; }
wait_health() { # production: healthy, main bot + all custom bots connected, DB ok
    local want t0 h; want="$(expected_bots)"; t0=$(date +%s)
    while :; do
        h="$(curl -fsS -m 8 http://127.0.0.1:3001/api/health 2>/dev/null || true)"
        if jq -e --argjson w "$want" '.status=="healthy" and .gateway.main.status=="connected" and .gateway.customBots==$w and .gateway.allConnected==true and .database.ok==true' <<<"$h" >/dev/null 2>&1; then
            log "production healthy: main + $want custom bots connected ($((want+1)) bots), DB ok"; return 0
        fi
        [ $(( $(date +%s) - t0 )) -lt "${1:-600}" ] || { log "health now: $(jq -c '{status, customBots: .gateway.customBots, disconnected: .gateway.disconnected, db: .database.ok}' <<<"$h" 2>/dev/null || echo 'no answer')"; return 1; }
        sleep 10
    done
}

# ---------------------------------------------------------------- staging
staging_deploy() {
    local sha; sha="$(resolve "${1:-HEAD}")"
    [ -d "$STAGING/.git" ] || die "no staging checkout at $STAGING"
    log "staging: deploying ${sha:0:7}"
    git -C "$STAGING" fetch -q origin '+refs/heads/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*'
    git -C "$STAGING" cat-file -e "$sha^{commit}" 2>/dev/null || die "${sha:0:7} is not on Forgejo yet (push first)"
    local before; before="$(git -C "$STAGING" rev-parse HEAD)"
    git -C "$STAGING" checkout -q -f --detach "$sha"
    # no `git clean`: untracked runtime dirs (temp_audio/, uploads/...) live in the tree. Re-create any that are
    # missing: group cfstaging comes from the setgid tree, 2770 lets the app write them.
    local d; for d in $RUNTIME_DIRS; do [ -d "$STAGING/$d" ] || install -d -m 2770 "$STAGING/$d"; done
    # dependencies: npm ci when the lockfile or the node version changed
    local nv; nv="$(sed -n 's/^CF_NODE_VERSION=//p' /srv/staging/node-version.env 2>/dev/null)"; nv="${nv:-v20.20.0}"
    local stamp; stamp="$nv $(cd "$STAGING" && sha256sum $NPM_DIRS_LOCKS | sha256sum | cut -c1-16)"
    if [ "$(cat "$STAGING/.deploy-npm-stamp" 2>/dev/null)" != "$stamp" ]; then
        log "staging: npm ci (node $nv)"
        ( export PATH="/opt/nvm/versions/node/$nv/bin:$PATH" PUPPETEER_SKIP_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
          for d in $NPM_DIRS; do (cd "$STAGING/$d" && npm ci --no-audit --no-fund --loglevel=error) || exit 1; done ) >>"$LOG" 2>&1 \
            || die "staging npm ci failed (see $LOG)"
        echo "$stamp" > "$STAGING/.deploy-npm-stamp"
    fi
    sudo -n /usr/bin/systemctl reset-failed cf-staging-bot.service 2>/dev/null || true
    sudo -n /usr/bin/systemctl restart cf-staging.target || die "could not restart staging"
    staging_smoke "$sha" || { log "staging: SMOKE FAILED for ${sha:0:7} (was ${before:0:7})"; return 1; }
    touch "$STATE/staging-ok/$sha"
    log "staging: ${sha:0:7} passed smoke checks"
}
staging_smoke() {
    local sha="$1" ok=1 h t0
    t0=$(date +%s)
    until curl -fsS -m 5 -o /dev/null http://127.0.0.1:13001/api/health 2>/dev/null; do
        [ $(( $(date +%s) - t0 )) -lt 240 ] || { log "smoke: dashboard :13001 not answering after 240s"; ok=0; break; }
        if [ "$(find "$STAGING/logs/cf-staging-bot.out.log" -newer "$STAGING/.git/HEAD" 2>/dev/null)" ] \
           && grep -a 'Failed to start dashboard' "$STAGING/logs/cf-staging-bot.out.log" | tail -1 | grep -q "$(date -u +%Y-%m-%d)"; then
            local last; last="$(grep -a 'Failed to start dashboard' "$STAGING/logs/cf-staging-bot.out.log" | tail -1 | cut -c1-240)"
            [ "$(date -d "$(cut -c2-20 <<<"$last")" +%s 2>/dev/null || echo 0)" -ge "$t0" ] && { log "smoke: $last"; ok=0; break; }
        fi
        sleep 5
    done
    if [ $ok = 1 ]; then
        sleep 45   # let schedulers and late init run; a crash shows up as a restart below
        h="$(curl -fsS -m 8 http://127.0.0.1:13001/api/health 2>/dev/null || true)"
        jq -e '.database.ok==true' <<<"$h" >/dev/null 2>&1 && log "smoke: /api/health answers, DB ok" || { log "smoke: /api/health DB not ok"; ok=0; }
        for p in / /commands /status /legal; do
            c="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:13001$p")"
            case "$c" in 2*|3*) log "smoke: GET $p -> $c" ;; *) log "smoke: GET $p -> $c (FAIL)"; ok=0 ;; esac
        done
        curl -fsS -m 8 http://127.0.0.1:14021/api/v2/health 2>/dev/null | jq -e '.ok==true' >/dev/null \
            && log "smoke: greenhouse :14021 ok" || { log "smoke: greenhouse :14021 FAIL"; ok=0; }
        c="$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:14090/ 2>/dev/null)"
        [ "$c" != 000 ] && log "smoke: relay status :14090 -> $c" || { log "smoke: relay :14090 not answering"; ok=0; }
    fi
    for u in cf-staging-bot cf-staging-greenhouse cf-staging-relay; do
        local st nr; st="$(systemctl is-active $u.service)"; nr="$(systemctl show -p NRestarts --value $u.service)"
        [ "$st" = active ] && [ "$nr" = 0 ] && log "smoke: $u active, 0 restarts" || { log "smoke: $u $st, $nr restarts (FAIL)"; ok=0; }
    done
    if grep -aE 'Fatal error during startup|Unhandled|ERR_MODULE_NOT_FOUND' "$STAGING/logs/cf-staging-bot.err.log" 2>/dev/null | tail -n 3 | grep -q .; then
        local since; since="$(stat -c %Y "$STAGING/.git/HEAD")"
        if [ "$(stat -c %Y "$STAGING/logs/cf-staging-bot.err.log")" -ge "$since" ] && tail -n 200 "$STAGING/logs/cf-staging-bot.err.log" | grep -aqE 'Fatal error during startup|ERR_MODULE_NOT_FOUND'; then
            log "smoke: fatal startup error in cf-staging-bot.err.log"; ok=0
        fi
    fi
    [ $ok = 1 ]
}

# ---------------------------------------------------------------- production
affected_apps() { # $1 old sha, $2 new sha -> pm2 app names to restart
    local files; files="$(g diff --name-only "$1" "$2")"
    local apps=""
    grep -qvE '^(services/cfx/|frontend/greenhouse/|stream-relay/|cf-jellyfin/|windrose-agent/|desktop/|docs/|tests/|\.forgejo/|\.github/|scripts/internal-git/|AGENTS\.md$|[^/]+\.md$)' <<<"$files" && apps="$apps CertiFriedUtility"
    grep -qE '^(services/cfx/|frontend/greenhouse/|utils/|package-lock\.json$)' <<<"$files" && apps="$apps greenhouse-tycoon"
    grep -qE '^stream-relay/' <<<"$files" && apps="$apps certifried-stream"
    grep -qE '^cf-jellyfin/' <<<"$files" && apps="$apps cf-jellyfin-fed"
    echo $apps
}
prod_tags() { g tag -l 'prod-*' --sort=-creatordate; }
prod_node_bin() { dirname "$(readlink -f /usr/local/bin/node)"; }   # the node production's pm2 apps run on
prod_npm_ci() { # $1 old, $2 new: npm ci in each dir whose lockfile changed, with production's node
    local d lf nb; nb="$(prod_node_bin)"
    for d in $NPM_DIRS; do
        lf="package-lock.json"; [ "$d" = . ] || lf="$d/package-lock.json"
        g diff --quiet "$1" "$2" -- "$lf" && continue
        log "npm ci in $d (node $("$nb/node" -v))"
        (cd "$PROD/$d" && PATH="$nb:$PATH" PUPPETEER_SKIP_DOWNLOAD=1 npm ci --no-audit --no-fund --loglevel=error) >>"$LOG" 2>&1 || return 1
    done
}
promote() {
    local sha; sha="$(resolve "${1:-HEAD}")"
    [ "$(g rev-parse HEAD)" = "$sha" ] || die "the production working copy is at $(g rev-parse --short HEAD), not ${sha:0:7}; production runs from $PROD, so commit there"
    [ -z "$(g status --porcelain --untracked-files=no)" ] || die "tracked files have uncommitted changes in $PROD; ship them (or let their owner ship them) first:
$(g status --short --untracked-files=no | head -20)"
    [ "$(ci_state "$sha")" = success ] || die "CI is not green for ${sha:0:7} ($(ci_state "$sha"))"
    [ -e "$STATE/staging-ok/$sha" ] || die "${sha:0:7} has not passed staging (scripts/deploy.sh staging ${sha:0:7})"
    local prev; prev="$(prod_tags | head -1)"
    local base; base="${prev:+$(g rev-parse "$prev^{commit}")}"
    [ "$base" = "$sha" ] && { log "production already at $prev (${sha:0:7})"; return 0; }
    local apps; apps="$(affected_apps "${base:-$sha~1}" "$sha")"
    take_prod_lock "promote ${sha:0:7}"
    wait_quiet
    local tag; tag="prod-$(date -u +%Y%m%d-%H%M%S)"
    g tag -a "$tag" -m "production $(date -u '+%F %T UTC') (previous: ${prev:-none})" "$sha"
    g push -q origin "$tag"
    if [ -n "$base" ] && ! g diff --quiet "$base" "$sha" -- $NPM_DIRS_LOCKS; then
        log "a package-lock.json changed: stopping $apps, npm ci, then start"
        pm2c stop $apps >>"$LOG" 2>&1 || true
        prod_npm_ci "$base" "$sha" || die "npm ci failed; production apps are STOPPED: scripts/deploy.sh rollback"
    fi
    if [ -n "$apps" ]; then
        log "restarting: $apps"
        pm2c restart $apps --update-env >>"$LOG" 2>&1 || die "pm2 restart failed"
        pm2c save >>"$LOG" 2>&1 || true
    else
        log "no running app is affected by this change (docs/tests/desktop only)"
    fi
    if wait_health 900; then
        log "PROMOTED ${sha:0:7} as $tag (previous ${prev:-none}); apps: ${apps:-none}"
    else
        log "health did not recover after promoting $tag. Roll back with: scripts/deploy.sh rollback"
        exit 3
    fi
}
rollback() {
    local cur target; cur="$(prod_tags | head -1)"; target="${1:-$(prod_tags | sed -n 2p)}"
    [ -n "$target" ] || die "no previous prod-* tag to roll back to"
    [ -z "$(g status --porcelain --untracked-files=no)" ] || die "uncommitted tracked changes in $PROD; a rollback would mix them in. Commit or move them aside first:
$(g status --short --untracked-files=no | head -20)"
    local from; from="$(g rev-parse HEAD)"
    take_prod_lock "rollback to $target"
    log "ROLLBACK: production $cur (${from:0:7}) -> $target"
    g restore --source="$target" --staged --worktree -- :/
    g commit -q -m "rollback: production back to $target (from ${cur:-?} ${from:0:7})

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" || log "tree already equals $target"
    local sha apps; sha="$(g rev-parse HEAD)"; apps="$(affected_apps "$from" "$sha")"
    if ! g diff --quiet "$from" "$sha" -- $NPM_DIRS_LOCKS; then
        pm2c stop $apps >>"$LOG" 2>&1 || true
        prod_npm_ci "$from" "$sha" || die "npm ci failed during rollback"
    fi
    [ -n "$apps" ] && pm2c restart $apps --update-env >>"$LOG" 2>&1
    pm2c save >>"$LOG" 2>&1 || true
    local tag; tag="prod-$(date -u +%Y%m%d-%H%M%S)-rollback"
    g tag -a "$tag" -m "rollback to $target" "$sha"; g push -q origin HEAD "$tag" || log "WARN: push of the rollback commit failed; push later"
    wait_health 900 && log "ROLLED BACK to $target as $tag" || { log "health not back after rollback"; exit 3; }
}

# ---------------------------------------------------------------- ship
ship() {
    local msg="" all=0 paths=()
    while [ $# -gt 0 ]; do case "$1" in -m) msg="$2"; shift ;; --all) all=1 ;; *) paths+=("$1") ;; esac; shift; done
    [ -n "$msg" ] || die "ship needs -m \"message\""
    if [ $all = 1 ]; then g add -A; else [ ${#paths[@]} -gt 0 ] || die "name the paths to commit (or --all)"; g add -- "${paths[@]}"; fi
    g diff --cached --quiet && die "nothing staged"
    (cd "$PROD" && CF_SCAN_ENV_ROOT="$PROD" bash scripts/internal-git/scan-check.sh) || die "secret gate failed; nothing committed (unstage with: git -C $PROD reset)"
    g commit -q -m "$msg

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
    local sha; sha="$(g rev-parse HEAD)"
    g push -q origin HEAD:main || die "push to Forgejo failed (pull/rebase first: git -C $PROD pull --rebase origin main)"
    log "shipped ${sha:0:7}: $msg"
    sleep 5; wait_ci "$sha"
    staging_deploy "$sha" || die "staging smoke failed for ${sha:0:7}; do NOT promote"
    log "ready to promote: scripts/deploy.sh promote ${sha:0:7}"
}

status() {
    echo "production tag : $(prod_tags | head -1) -> $(g rev-parse --short "$(prod_tags | head -1)^{commit}" 2>/dev/null)"
    echo "working copy   : $(g rev-parse --short HEAD) on $(g branch --show-current || echo detached); $(g status --porcelain --untracked-files=no | wc -l) tracked file(s) modified"
    echo "CI for HEAD    : $(ci_state "$(g rev-parse HEAD)")"
    echo "staging        : $(git -C "$STAGING" rev-parse --short HEAD 2>/dev/null) ($(systemctl is-active cf-staging-bot.service))"
    echo "staging-ok HEAD: $([ -e "$STATE/staging-ok/$(g rev-parse HEAD)" ] && echo yes || echo no)"
    echo "locks          : $(ls "$LOCKDIR" | grep '^LOCK\.' | tr '\n' ' ')"
}

cmd="${1:-}"; shift || true
case "$cmd" in
    ship) ship "$@" ;;
    staging) staging_deploy "$@" ;;
    promote) promote "$@" ;;
    rollback) rollback "$@" ;;
    status) status ;;
    ci) wait_ci "$(resolve "${1:-HEAD}")" ;;
    *) sed -n '2,20p' "$0"; exit 1 ;;
esac
