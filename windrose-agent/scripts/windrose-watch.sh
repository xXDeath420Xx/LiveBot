#!/bin/bash
# Windrose watchdog — backup mirroring + resource alerting.
#
# Runs from cron rather than inside windrose-agent on purpose: its whole job is
# to notice when things are wrong, which includes "the agent is dead". A monitor
# that shares a process with the thing it monitors reports nothing at exactly
# the moment it matters.
#
# Two jobs:
#
#  1. MIRROR snapshots to the other disk array. /srv/windrose lives on /dev/md3;
#     the mirror goes to /home (/dev/md5). That is not off-site backup and is
#     not pretended to be — it survives a single array failure, not loss of the
#     host. Getting a copy truly off-box needs credentials only the owner has.
#
#  2. ALERT on the numbers that actually predict failure here: container memory
#     against the 16G cap, host swap (the early warning that 10 players is too
#     many for this box), and free disk on both arrays.
#
# Output goes to a log and to a JSON status file the panel reads, so warnings
# are visible in the UI rather than only in a file nobody opens.

set -uo pipefail

SRC=/srv/windrose/backups
MIRROR=/home/death/windrose-backups-mirror
STATE_DIR=/srv/windrose/backups
LOG="$STATE_DIR/watchdog.log"
STATUS="$STATE_DIR/watchdog.json"
KEEP_MIRROR=10

# Thresholds. Deliberately conservative: this box also runs 41 Discord bots.
MEM_WARN_PCT=85
SWAP_WARN_GB=5
DISK_WARN_GB=20

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

warnings=()
add_warning() { warnings+=("$1"); log "WARN $1"; }

# ---------------------------------------------------------------- mirror
mkdir -p "$MIRROR"
mirrored=0
if [ -d "$SRC" ]; then
    # Newest first, cap the count — the mirror is a safety net, not an archive.
    while IFS= read -r f; do
        [ -f "$f" ] || continue
        base=$(basename "$f")
        if [ ! -f "$MIRROR/$base" ]; then
            cp -p "$f" "$MIRROR/$base" 2>/dev/null && mirrored=$((mirrored + 1))
        fi
    done < <(ls -t "$SRC"/*.zip 2>/dev/null | head -n "$KEEP_MIRROR")

    # Prune mirror copies beyond the keep count.
    ls -t "$MIRROR"/*.zip 2>/dev/null | tail -n +$((KEEP_MIRROR + 1)) | while IFS= read -r old; do
        rm -f "$old"
    done
fi
[ "$mirrored" -gt 0 ] && log "mirrored $mirrored new snapshot(s) to $MIRROR"

mirror_count=$(ls "$MIRROR"/*.zip 2>/dev/null | wc -l)
[ "$mirror_count" -eq 0 ] && add_warning "no snapshots in the mirror — backups are single-copy"

# ---------------------------------------------------------------- resources
mem_pct=0
container_state="absent"
if command -v docker >/dev/null 2>&1; then
    container_state=$(docker inspect windrose --format '{{.State.Status}}' 2>/dev/null || echo absent)
    if [ "$container_state" = "running" ]; then
        read -r used limit < <(docker stats windrose --no-stream --format '{{.MemUsage}}' 2>/dev/null \
            | sed 's|/| |' | tr -d 'A-Za-z' )
        # docker prints e.g. "1.7GiB / 16GiB"; the sed above leaves "1.7 16".
        if [ -n "${used:-}" ] && [ -n "${limit:-}" ]; then
            mem_pct=$(awk -v u="$used" -v l="$limit" 'BEGIN{ if (l>0) printf "%.0f", (u/l)*100; else print 0 }')
        fi
    fi
fi
[ "$container_state" != "running" ] && add_warning "container is '$container_state', not running"
[ "${mem_pct:-0}" -ge "$MEM_WARN_PCT" ] 2>/dev/null && \
    add_warning "container memory at ${mem_pct}% of the 16G cap — lower MAX_PLAYERS rather than raising the cap"

swap_gb=$(free -g | awk '/^Swap:/{print $3}')
[ "${swap_gb:-0}" -ge "$SWAP_WARN_GB" ] && \
    add_warning "swap at ${swap_gb}G — the box is over-committed; this is the early sign 10 players is too many"

for mount in / /home; do
    free_gb=$(df -BG --output=avail "$mount" 2>/dev/null | tail -1 | tr -dc '0-9')
    [ -n "$free_gb" ] && [ "$free_gb" -le "$DISK_WARN_GB" ] && \
        add_warning "only ${free_gb}G free on $mount"
done

# ---------------------------------------------------------------- status file
{
    printf '{"checkedAt":"%s","containerState":"%s","memPercent":%s,"swapGb":%s,' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$container_state" "${mem_pct:-0}" "${swap_gb:-0}"
    printf '"mirrorCount":%s,"mirrorPath":"%s","warnings":[' "$mirror_count" "$MIRROR"
    for i in "${!warnings[@]}"; do
        [ "$i" -gt 0 ] && printf ','
        printf '%s' "$(printf '%s' "${warnings[$i]}" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')"
    done
    printf ']}'
} > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"

# Keep the log from growing without bound.
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 2000 ]; then
    tail -1000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

exit 0
