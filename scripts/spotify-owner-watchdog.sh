#!/usr/bin/env bash
# spotify-owner-watchdog — restart go-librespot (pm2 spotify-owner) if it pins the CPU.
#
# go-librespot 0.7.4 can enter a tight busy-loop after certain audio-pipe EPIPE +
# websocket-reconnect sequences and never recovers (observed: 99% CPU for 251+ hours).
# This watchdog samples /proc/<pid>/stat every POLL_SEC seconds, computes the per-poll
# CPU%, and when it stays over THRESHOLD% for CONSECUTIVE_FAILS consecutive polls,
# calls `pm2 restart spotify-owner`. The restart clears all state.
#
# Why not pm2's built-in cpu-restart? Because older pm2 (which this host runs) doesn't
# have one. Simple shell is enough.
#
# Why not just restart on a daily cron? Because a stuck process can waste ~24h of CPU
# before it fires. Watching catches it in a few minutes.

set -eu

PROCESS_NAME="${PROCESS_NAME:-spotify-owner}"
POLL_SEC="${POLL_SEC:-30}"
THRESHOLD_PCT="${THRESHOLD_PCT:-70}"   # single core at >70% for several polls = stuck
CONSECUTIVE_FAILS="${CONSECUTIVE_FAILS:-4}"  # 4 * 30s = 2 minutes of pegged CPU
MIN_UPTIME_SEC="${MIN_UPTIME_SEC:-120}"  # don't restart within 2 min of a restart

LOG() { echo "[$(date -u +%FT%TZ)] $*"; }

get_pid() {
    pm2 jlist 2>/dev/null | python3 -c "
import json, sys
for p in json.load(sys.stdin):
    if p.get('name') == '$PROCESS_NAME' and p.get('pm2_env', {}).get('status') == 'online':
        print(p.get('pid'))
        break
" 2>/dev/null
}

get_cpu_time_centisec() {
    # fields 14+15 are utime+stime (jiffies, typically 100Hz)
    awk '{print $14 + $15}' "/proc/$1/stat" 2>/dev/null
}

get_uptime_sec() {
    pm2 jlist 2>/dev/null | python3 -c "
import json, sys, time
for p in json.load(sys.stdin):
    if p.get('name') == '$PROCESS_NAME':
        up = p.get('pm2_env', {}).get('pm_uptime', 0)
        print(int(time.time() * 1000 - up) // 1000 if up else 0)
        break
" 2>/dev/null
}

DUMP_DIR="${DUMP_DIR:-/home/death/CertiFriedUtility/logs}"
ERR_LOG="${ERR_LOG:-/home/death/.pm2/logs/${PROCESS_NAME}-error.log}"

# SIGQUIT makes the Go runtime print every goroutine's stack to stderr and exit; pm2's
# autorestart brings it back. That stack dump is the evidence needed to find the actual spin,
# so it is copied out of the pm2 log into its own file. Falls back to a plain pm2 restart if
# the process is still around (or not back) afterwards.
restart_proc() {
    local pid="$1"
    local dump="$DUMP_DIR/${PROCESS_NAME}-goroutines-$(date -u +%Y%m%dT%H%M%SZ).log"
    local before; before=$(wc -l < "$ERR_LOG" 2>/dev/null || echo 0)
    LOG "sustained >${THRESHOLD_PCT}% CPU: SIGQUIT pid $pid for a goroutine dump, then restart"
    kill -QUIT "$pid" 2>/dev/null || true
    sleep 5
    tail -n +"$((before + 1))" "$ERR_LOG" > "$dump" 2>/dev/null || true
    LOG "goroutine dump saved: $dump ($(wc -l < "$dump" 2>/dev/null || echo 0) lines)"
    if kill -0 "$pid" 2>/dev/null || [ -z "$(get_pid)" ]; then
        LOG "process not cleanly cycled by SIGQUIT; forcing pm2 restart"
        pm2 restart "$PROCESS_NAME" --update-env 2>&1 | tail -2
    fi
}

LOG "watchdog starting: process=$PROCESS_NAME threshold=${THRESHOLD_PCT}% consecutive=$CONSECUTIVE_FAILS poll=${POLL_SEC}s"

prev_pid=""
prev_cpu=""
prev_ts=""
fail_count=0

while true; do
    pid=$(get_pid || true)
    now_ts=$(date +%s)

    if [ -z "$pid" ]; then
        LOG "no online pid for $PROCESS_NAME (pm2 reports stopped/errored); watchdog idle"
        prev_pid=""; fail_count=0
        sleep "$POLL_SEC"
        continue
    fi

    cpu_cs=$(get_cpu_time_centisec "$pid" || true)
    if [ -z "$cpu_cs" ]; then
        LOG "could not read /proc/$pid/stat (process gone?); resetting"
        prev_pid=""; fail_count=0
        sleep "$POLL_SEC"
        continue
    fi

    if [ "$pid" = "$prev_pid" ] && [ -n "$prev_cpu" ]; then
        # delta cpu-centiseconds over delta wall-seconds, as a percentage of one core
        dc=$((cpu_cs - prev_cpu))
        dt=$((now_ts - prev_ts))
        if [ "$dt" -gt 0 ]; then
            # cpu_cs is in jiffies (1/100 s): one core at 100% for dt seconds is dt*100 jiffies.
            pct=$((dc / dt))
            if [ "$pct" -gt "$THRESHOLD_PCT" ]; then
                fail_count=$((fail_count + 1))
                LOG "cpu=${pct}% over ${dt}s (fail $fail_count/$CONSECUTIVE_FAILS)"
                if [ "$fail_count" -ge "$CONSECUTIVE_FAILS" ]; then
                    uptime_sec=$(get_uptime_sec || echo 0)
                    if [ "$uptime_sec" -lt "$MIN_UPTIME_SEC" ]; then
                        LOG "would restart but process was restarted ${uptime_sec}s ago; waiting"
                    else
                        restart_proc "$pid"
                        fail_count=0
                        prev_pid=""; prev_cpu=""
                    fi
                fi
            else
                if [ "$fail_count" -gt 0 ]; then LOG "cpu=${pct}% recovered (reset fail counter)"; fi
                fail_count=0
            fi
        fi
    fi

    prev_pid="$pid"
    prev_cpu="$cpu_cs"
    prev_ts="$now_ts"
    sleep "$POLL_SEC"
done
