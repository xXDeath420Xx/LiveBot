#!/usr/bin/env bash
# server1 -> server2 FORWARD tunnel to the residential music resolver.
#   127.0.0.1:49998 (here) -> server2:127.0.0.1:49999
# The listener belongs to this ssh client, so a dead link can always be torn down and rebuilt by
# pm2. (The server2-initiated reverse tunnel on :49999 can be wedged by a stale listener that only
# server1's sshd can reap — this path is independent of that.) The key is restricted on server2 to
# forwarding 127.0.0.1:49999 only: no shell, no other ports.
# The key belongs to the user that runs the CertiFried apps (certifried since 2026-11-21): $HOME/.ssh/music_tunnel.
exec /usr/bin/ssh -NT \
    -i "${MUSIC_TUNNEL_KEY:-$HOME/.ssh/music_tunnel}" \
    -L 127.0.0.1:49998:127.0.0.1:49999 \
    -o BatchMode=yes \
    -o IdentitiesOnly=yes \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    -o ConnectTimeout=15 \
    death@server2.certifriedmultitool.com
