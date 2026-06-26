#!/usr/bin/env bash
# One-time host setup for yt-dlp IPv6 /64 source rotation.
# Run once as root:  sudo bash scripts/setup-ipv6-rotation.sh
# Idempotent — safe to re-run. Persists across reboots.
set -euo pipefail

PREFIX="2604:2dc0:200:163b::/64"   # this server's routed OVH /64

echo "==> 1) net.ipv6.ip_nonlocal_bind=1 (allow bind() to unconfigured addresses)"
sysctl -w net.ipv6.ip_nonlocal_bind=1
echo 'net.ipv6.ip_nonlocal_bind=1' > /etc/sysctl.d/99-ytdlp-ipv6.conf

echo "==> 2) AnyIP: make the whole ${PREFIX} locally deliverable (this boot)"
ip route replace local "$PREFIX" dev lo

echo "==> 3) Persist the AnyIP route across reboots (systemd oneshot)"
cat > /etc/systemd/system/ytdlp-anyip.service <<UNIT
[Unit]
Description=AnyIP local route for yt-dlp IPv6 rotation
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/sbin/ip route replace local ${PREFIX} dev lo
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable ytdlp-anyip.service

echo
echo "DONE."
echo "  nonlocal_bind = $(cat /proc/sys/net/ipv6/ip_nonlocal_bind)"
echo "  AnyIP route   = $(ip -6 route show table local | grep "local ${PREFIX%/*}" | grep '/64' || echo 'MISSING')"
