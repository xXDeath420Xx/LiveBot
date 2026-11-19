#!/bin/bash
# Launch the agent with the `docker` group active, and die properly when PM2
# says to.
#
# WHY THIS EXISTS: PM2 spawns children with the group set of the shell that
# started the PM2 DAEMON. This daemon predates `death` being added to the
# `docker` group (2026-08-08), so the agent inherits the old set and gets EACCES
# on /var/run/docker.sock — the control API comes up fine and every lifecycle
# call fails. `sg docker` re-execs with the group applied; no password prompt,
# since it only activates a group the user already has.
#
# WHY THE PID DANCE: `sg` FORKS rather than execs, so the tree is
# PM2 → bash → sg → node. PM2 signals bash, bash exits, and node is orphaned
# still holding :4091 — the next start then dies with EADDRINUSE. Observed
# exactly that on the first Phase 6 deploy.
#
# So the inner shell writes its own $$ before `exec node` replaces it: that pid
# IS the node process. The trap forwards SIGTERM/SIGINT there, and we wait for
# it, so PM2's stop and restart actually stop the server.
#
# The proper fix is `pm2 kill` + `pm2 resurrect` from a shell that has the
# group, which makes this wrapper unnecessary — but that bounces every app under
# PM2, including the 41-bot CertiFriedUtility process. This wrapper stays
# correct either way.
set -u

PIDFILE="$(dirname "$0")/.agent.pid"
rm -f "$PIDFILE"

shutdown() {
    local pid
    pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
        kill -TERM "$pid" 2>/dev/null || true
        # Give the agent its graceful-shutdown path, then insist.
        for _ in $(seq 1 20); do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.5
        done
        kill -KILL "$pid" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
    exit 0
}
trap shutdown TERM INT

# The inner shell records its pid, then exec replaces it with node — so the
# recorded pid is node's.
sg docker -c 'echo $$ > '"$PIDFILE"'; exec node src/server.js' &
wrapper_pid=$!

wait "$wrapper_pid"
rm -f "$PIDFILE"
