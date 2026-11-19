#!/usr/bin/env bash
# Called over SSH by the sentinels on server2 and the workstation (one per minute each).
#   sentinel-probe.sh <observer-name>          -> key=value health lines; leaves a heartbeat
#   sentinel-probe.sh <observer-name> --creds  -> the bot token + owner id the sentinel uses to DM
#                                                 the owner via Discord REST when server1 is down
set -uo pipefail
BOT_DIR=/home/death/CertiFriedUtility
NAME="${1:?observer name required}"
case "$NAME" in *[!a-z0-9-]*) echo "bad observer name" >&2; exit 2 ;; esac

if [ "${2:-}" = "--creds" ]; then
    # Read without sourcing (.env is not shell syntax-safe); strip optional quotes.
    get() { grep -m1 "^$1=" "$BOT_DIR/.env" | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'; }
    echo "token=$(get DISCORD_TOKEN)"
    echo "owner=$(get BOT_OWNER_ID)"
    exit 0
fi

touch "$BOT_DIR/data/sentinel-$NAME.heartbeat"
now=$(date +%s)
snap=$(stat -c %Y "$BOT_DIR/data/music-health.json" 2>/dev/null || echo 0)
echo "snapshot_age=$((now - snap))"
echo "bot=$(pm2 jlist 2>/dev/null | python3 -c 'import json,sys
try: print(next((p["pm2_env"]["status"] for p in json.load(sys.stdin) if p["name"]=="CertiFriedUtility"), "missing"))
except Exception: print("unknown")')"
echo "uptime_s=$(cut -d. -f1 /proc/uptime)"
