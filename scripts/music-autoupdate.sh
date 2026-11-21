#!/usr/bin/env bash
# music-autoupdate — keep yt-dlp, the EJS solver, the bgutil PO-token plugin + server (in lockstep)
# and, where enabled, go-librespot current, with canary validation and automatic rollback.
#
# Config comes from music-autoupdate.env next to this script (per host). Writes a JSON status file
# that the bot's health monitor (and the server2 resolver's /health) surface.
#
# Decision rule: the canary runs BEFORE and AFTER the upgrade on the same targets. Roll back only if
# the new install is strictly worse. (An absolute check would roll back good updates whenever the
# host's IP happens to be bot-walled for a canary video.) If stable fails outright, try nightly.
#
# Test hooks: FORCE_CANARY_FAIL_AFTER=1 makes the post-upgrade canary fail (exercises rollback).
set -uo pipefail
# pm2 for the CertiFried apps: the app user's pm2 (cf-pm2, since 2026-11-21) once it runs the bot, else this user's.
cf_pm2() {
    if [ -x /usr/local/bin/cf-pm2 ] && systemctl is-enabled -q pm2-certifried.service 2>/dev/null; then
        /usr/local/bin/cf-pm2 "$@"
    else
        pm2 "$@"
    fi
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/music-autoupdate.env"
export PATH="$EXTRA_PATH:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$LOG_DIR"
exec 9>"/tmp/music-autoupdate.$(id -u).lock"
flock -n 9 || { echo "another update is running"; exit 0; }
exec >>"$LOG_DIR/music-update-$(date +%F).log" 2>&1

log() { echo "[$(date -u +%FT%TZ)] $*"; }
NOTES=()
note() { NOTES+=("$*"); log "$*"; }

versions_json() {
    "$PYTHON" -c 'import importlib.metadata as m,json
v={}
for p in ("yt-dlp","yt-dlp-ejs","bgutil-ytdlp-pot-provider"):
    try: v[p]=m.version(p)
    except Exception: v[p]=None
print(json.dumps(v))'
}
pkg_version() { "$PYTHON" -c "import importlib.metadata as m; print(m.version('$1'))" 2>/dev/null; }
bgutil_server_version() { "$PYTHON" -c "import json; print(json.load(open('$BGUTIL_DIR/server/package.json'))['version'])" 2>/dev/null; }

# Canary score = number of canary videos that resolve to a signed audio URL + 1 if a search works.
canary() {
    local score=0 ck url
    ck="$(mktemp)"; cp "$COOKIES" "$ck" 2>/dev/null || : > "$ck"
    for url in ${CANARY_URLS//,/ }; do
        if timeout 75 "$YTDLP" --no-update --no-warnings --js-runtimes "$JS_RUNTIME" --remote-components ejs:github \
             --extractor-args youtube:player_client=default --cookies "$ck" \
             -f 'bestaudio[acodec=opus]/bestaudio[ext=m4a]/bestaudio/251/140/18/b' -g --no-playlist "$url" 2>/dev/null \
             | grep -q '^https://'; then score=$((score + 1)); fi
    done
    if timeout 45 "$YTDLP" --no-update --no-warnings --cookies "$ck" --flat-playlist --print '%(id)s' \
         "ytsearch1:$CANARY_SEARCH" 2>/dev/null | grep -qE '^[A-Za-z0-9_-]{11}$'; then score=$((score + 1)); fi
    rm -f "$ck"
    echo "$score"
}

rebuild_bgutil() {  # $1 = git ref: a release tag, or the previous HEAD commit when rolling back
    local ref="$1"
    (
        set -e
        cd "$BGUTIL_DIR"
        # A rollback SHA is already local; a new tag needs fetching (the clones are shallow).
        git cat-file -e "$ref^{commit}" 2>/dev/null || git fetch -q --depth=1 origin tag "$ref"
        # npm rewrites package-lock.json on install, which would block checkout; keep it recoverable.
        git stash push -q -m "music-autoupdate $(date +%F)" -- server/package-lock.json 2>/dev/null || true
        git -c advice.detachedHead=false checkout -q "$ref"
        cd server
        npm ci --no-audit --no-fund --loglevel=error >/dev/null 2>&1
        npx tsc
    ) || return 1
    cf_pm2 restart "$BGUTIL_PM2" >/dev/null 2>&1 || return 1
    for _ in $(seq 1 15); do curl -s -m 2 "$BGUTIL_PING" >/dev/null && return 0; sleep 1; done
    return 1
}

pip_install() { "$PIP" install $PIP_FLAGS --quiet --disable-pip-version-check "$@"; }

# ── yt-dlp / EJS / bgutil ────────────────────────────────────────────────────
log "=== update run on $(hostname) ==="
BEFORE="$(versions_json)"
BG_REF_BEFORE="$(git -C "$BGUTIL_DIR" rev-parse HEAD 2>/dev/null)"
log "before: $BEFORE  bgutil-server=$(bgutil_server_version) ref=${BG_REF_BEFORE:0:10}"

C_BEFORE="$(canary)"
log "canary before: $C_BEFORE"

pip_install --upgrade yt-dlp yt-dlp-ejs bgutil-ytdlp-pot-provider || note "pip upgrade failed"
PLUGIN_V="$(pkg_version bgutil-ytdlp-pot-provider)"
if [ -n "$PLUGIN_V" ] && [ "$PLUGIN_V" != "$(bgutil_server_version)" ]; then
    log "bgutil server $(bgutil_server_version) != plugin $PLUGIN_V — rebuilding server at tag $PLUGIN_V"
    rebuild_bgutil "$PLUGIN_V" && note "bgutil server rebuilt at $PLUGIN_V" || note "bgutil server rebuild at $PLUGIN_V FAILED"
fi
AFTER="$(versions_json)"

C_AFTER="$(canary)"
[ "${FORCE_CANARY_FAIL_AFTER:-0}" = "1" ] && C_AFTER=0 && log "(test hook) forcing post-upgrade canary to 0"
log "after:  $AFTER  canary after: $C_AFTER"

RESULT="unchanged"
[ "$AFTER" != "$BEFORE" ] && RESULT="updated"

if [ "$C_AFTER" -eq 0 ] && [ "$C_BEFORE" -eq 0 ] && [ "${FORCE_CANARY_FAIL_AFTER:-0}" != "1" ]; then
    # Stable is broken outright (YouTube changed something). Nightly usually carries the fix first.
    log "stable fails the canary outright — trying yt-dlp nightly"
    pip_install --upgrade --pre yt-dlp || note "nightly install failed"
    C_NIGHTLY="$(canary)"; log "canary on nightly: $C_NIGHTLY"
    AFTER="$(versions_json)"
    if [ "$C_NIGHTLY" -gt 0 ]; then RESULT="nightly"; C_AFTER="$C_NIGHTLY"; note "switched to nightly $(pkg_version yt-dlp)"
    else RESULT="failed"; note "YouTube extraction failing on both stable and nightly"; fi
elif [ "$C_AFTER" -lt "$C_BEFORE" ]; then
    log "new install is worse ($C_AFTER < $C_BEFORE) — rolling back"
    OLD_YT=$(echo "$BEFORE" | "$PYTHON" -c 'import json,sys; print(json.load(sys.stdin)["yt-dlp"])')
    OLD_EJS=$(echo "$BEFORE" | "$PYTHON" -c 'import json,sys; print(json.load(sys.stdin)["yt-dlp-ejs"] or "")')
    OLD_PLUG=$(echo "$BEFORE" | "$PYTHON" -c 'import json,sys; print(json.load(sys.stdin)["bgutil-ytdlp-pot-provider"])')
    pip_install "yt-dlp==$OLD_YT" "bgutil-ytdlp-pot-provider==$OLD_PLUG" ${OLD_EJS:+"yt-dlp-ejs==$OLD_EJS"} || note "pip rollback failed"
    if [ "$(git -C "$BGUTIL_DIR" rev-parse HEAD 2>/dev/null)" != "$BG_REF_BEFORE" ]; then
        rebuild_bgutil "$BG_REF_BEFORE" && note "bgutil server rolled back" || note "bgutil server rollback FAILED"
    fi
    AFTER="$(versions_json)"
    C_AFTER="$(canary)"
    RESULT="rolled_back"; note "rolled back to $AFTER (canary now $C_AFTER)"
fi

# ── go-librespot (optional) ──────────────────────────────────────────────────
GLR_JSON="null"
if [ "${GLR_ENABLED:-0}" = "1" ]; then
    CUR=$(go version -m "$GLR_BIN" 2>/dev/null | awk '$1=="mod" && $2 ~ /go-librespot$/ {print $3}')
    LATEST=$(curl -s -m 20 https://api.github.com/repos/devgianlu/go-librespot/releases/latest | "$PYTHON" -c 'import json,sys; print(json.load(sys.stdin).get("tag_name",""))' 2>/dev/null)
    GLR_ACTION="none"
    if [ -n "$CUR" ] && [ -n "$LATEST" ] && [ "$CUR" != "$LATEST" ]; then
        cur_mm="${CUR%.*}"; new_mm="${LATEST%.*}"
        if [ "$cur_mm" != "$new_mm" ]; then
            GLR_ACTION="available_minor"; note "go-librespot $LATEST available (current $CUR) — minor/major, not auto-applied"
        else
            STATUS=$(curl -s -m 5 "$GLR_API/status")
            IDLE=$(echo "$STATUS" | "$PYTHON" -c 'import json,sys; d=json.load(sys.stdin); print("yes" if d.get("stopped") or not d.get("track") else "no")' 2>/dev/null)
            if [ "$IDLE" != "yes" ]; then
                GLR_ACTION="deferred_busy"; log "go-librespot $LATEST pending: Spotify is in use, retry next run"
            else
                STAGE="$(mktemp -d)"
                if curl -sSL -m 120 -o "$STAGE/glr.tgz" "https://github.com/devgianlu/go-librespot/releases/download/$LATEST/go-librespot_linux_x86_64.tar.gz" \
                   && tar -xzf "$STAGE/glr.tgz" -C "$STAGE" && [ -x "$STAGE/go-librespot" ] && ! ldd "$STAGE/go-librespot" | grep -q "not found"; then
                    cp -a "$GLR_BIN" "$GLR_BIN-prev"
                    cp "$STAGE/go-librespot" "$GLR_BIN.new" && mv "$GLR_BIN.new" "$GLR_BIN"
                    cf_pm2 restart "$GLR_PM2" >/dev/null 2>&1
                    OKAUTH=no
                    for _ in $(seq 1 30); do
                        U=$(curl -s -m 3 "$GLR_API/status" | "$PYTHON" -c 'import json,sys; print(json.load(sys.stdin).get("username") or "")' 2>/dev/null)
                        [ -n "$U" ] && OKAUTH=yes && break; sleep 1
                    done
                    if [ "$OKAUTH" = yes ]; then GLR_ACTION="updated"; note "go-librespot $CUR -> $LATEST"
                    else
                        mv "$GLR_BIN-prev" "$GLR_BIN"; cf_pm2 restart "$GLR_PM2" >/dev/null 2>&1
                        GLR_ACTION="rolled_back"; note "go-librespot $LATEST failed auth check — rolled back to $CUR"
                    fi
                else GLR_ACTION="download_failed"; note "go-librespot $LATEST download/verify failed"; fi
                rm -rf "$STAGE"
            fi
        fi
    fi
    GLR_JSON=$(printf '{"current":"%s","latest":"%s","action":"%s"}' "$(go version -m "$GLR_BIN" 2>/dev/null | awk '$1=="mod" {print $3; exit}')" "$LATEST" "$GLR_ACTION")
fi

# ── status + housekeeping ───────────────────────────────────────────────────
NOTES_JSON=$(printf '%s\n' "${NOTES[@]:-}" | "$PYTHON" -c 'import json,sys; print(json.dumps([l for l in sys.stdin.read().splitlines() if l]))')
TMP="$STATUS_FILE.tmp"
cat > "$TMP" <<JSON
{"at":"$(date -u +%FT%TZ)","host":"$(hostname)","result":"$RESULT","before":$BEFORE,"after":$AFTER,
 "canary":{"before":$C_BEFORE,"after":$C_AFTER,"max":$(( $(echo "$CANARY_URLS" | tr ',' '\n' | wc -l) + 1 ))},
 "goLibrespot":$GLR_JSON,"notes":$NOTES_JSON}
JSON
"$PYTHON" -c "import json; json.load(open('$TMP'))" && mv "$TMP" "$STATUS_FILE" || log "status JSON invalid, not written"
find "$LOG_DIR" -name 'music-update-*.log' -mtime +"${LOG_RETAIN_DAYS:-30}" -delete 2>/dev/null
log "=== done: $RESULT ==="
