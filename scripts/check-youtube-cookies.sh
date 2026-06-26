#!/usr/bin/env bash
# Tell whether cookies.txt is a usable, logged-in YouTube session.
# Usage: bash scripts/check-youtube-cookies.sh [path-to-cookies.txt]
#
# Distinguishes the three states that all look like "music won't play":
#   AUTH_OK        – cookies are a live logged-in session (good)
#   NOT_LOGGED_IN  – jar is logged out / session invalidated (re-export needed)
#   IP_BLOCKED     – cookies may be fine but this IP is bot-flagged (cool down / rotate)
set -uo pipefail

JAR="${1:-$(dirname "$0")/../cookies.txt}"
YTDLP="${YTDLP_PATH:-/home/death/yt-dlp-venv/bin/yt-dlp}"

[ -f "$JAR" ] || { echo "✗ cookies file not found: $JAR"; exit 1; }

echo "== Offline checks =="
miss=0
for c in __Secure-1PSID SAPISID LOGIN_INFO; do
  grep -qw "$c" "$JAR" || { echo "  ✗ missing auth cookie: $c"; miss=1; }
done
[ "$miss" = 0 ] && echo "  ✓ core auth cookies present"
# __Secure-1PSIDTS rotates every few hours; an old file is a staleness red flag.
age_h=$(( ( $(date +%s) - $(stat -c %Y "$JAR") ) / 3600 ))
echo "  • jar last modified ${age_h}h ago $([ "$age_h" -gt 12 ] && echo '(YouTube rotates session cookies ~hourly — re-export if logged-out below)')"

echo "== Live login check =="
# Protect the master jar (yt-dlp rewrites --cookies); test on a copy.
tmp="$(mktemp)"; cp "$JAR" "$tmp"
# /feed/history requires being logged in; capture how it fails.
err="$(timeout 45 "$YTDLP" --cookies "$tmp" --simulate --no-warnings --playlist-items 1 \
  -O "%(channel)s" "https://www.youtube.com/feed/history" 2>&1)"
rm -f "$tmp"

if echo "$err" | grep -qiE "confirm you('|’)?re not a bot|Sign in to confirm you"; then
  echo "  ⚠ IP_BLOCKED — this server IP is bot-flagged right now; can't judge the cookies."
  echo "    Let it cool a few hours (or rely on IPv6 rotation) and re-run."
  exit 2
elif echo "$err" | grep -qiE "login_required|requires you to be logged in|Sign in to view|Private"; then
  echo "  ✗ NOT_LOGGED_IN — jar is logged out / session invalidated. Re-export (incognito →"
  echo "    youtube.com/robots.txt → export → close incognito immediately)."
  exit 3
elif echo "$err" | grep -qvE "ERROR" && [ -n "$err" ]; then
  echo "  ✓ AUTH_OK — logged-in session works. Channel: $(echo "$err" | tail -1)"
  exit 0
else
  echo "  ? Inconclusive. Raw tail:"; echo "$err" | tail -3
  exit 4
fi
